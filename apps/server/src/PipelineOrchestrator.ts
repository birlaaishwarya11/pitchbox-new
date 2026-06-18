import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import type { SessionStore, PipelineSession, ScriptVersion } from './SessionStore';
import type { Planner } from './Planner';
import type { Researcher } from './Researcher';
import type { Scripter } from './Scripter';
import type { AudioGenerator } from './AudioGenerator';
import type { Fuser } from './Fuser';
import type { RepositoryCloner } from './RepositoryCloner';
import type { CodebaseAnalyzer, AnalysisResult } from './CodebaseAnalyzer';
import type { FlowExtractor } from './FlowExtractor';
import type { SandboxRecorder } from './SandboxRecorder';

export interface PipelineDeps {
  store: SessionStore;
  planner: Planner;
  researcher: Researcher;
  scripter: Scripter;
  audioGenerator: AudioGenerator;
  fuser: Fuser;
  repositoryCloner?: RepositoryCloner;
  codebaseAnalyzer?: CodebaseAnalyzer;
  flowExtractor?: FlowExtractor;
  sandboxRecorder?: SandboxRecorder;
  // Public URL prefix for static-served session files. Final URLs become
  // `${publicMediaPrefix}/${sessionId}/<file>`.
  publicMediaPrefix: string;
}

export interface StartInput {
  githubUrl?: string;
  branch?: string;
  userPrompt: string;
  targetDurationSec?: number;
  // If true, skip the screen-recording leg even if Daytona is configured.
  skipRecording?: boolean;
}

export class PipelineOrchestrator {
  constructor(private readonly deps: PipelineDeps) {}

  /** Creates a session and kicks off plan + research + first script in the background. */
  start(input: StartInput): PipelineSession {
    const session = this.deps.store.create({
      githubUrl: input.githubUrl,
      branch: input.branch,
      userPrompt: input.userPrompt,
      targetDurationSec: input.targetDurationSec ?? 90,
    });

    void this.runScriptStages(session.id, { skipRecording: input.skipRecording }).catch((err) => {
      console.error(`[pipeline ${session.id}] script-stage failure:`, err);
      this.deps.store.setError(session.id, this.deps.store.get(session.id)?.status ?? 'PLANNING', String(err?.message ?? err));
    });

    return session;
  }

  /** Re-run the scripter with new feedback, producing a new script version. */
  async iterateScript(sessionId: string, feedback: string): Promise<ScriptVersion> {
    const session = this.requireSession(sessionId);
    if (!session.plan || !session.research) {
      throw new Error('Cannot iterate before plan + research are complete');
    }
    const previous = session.scriptVersions[session.scriptVersions.length - 1];
    const repoSummary = (session as any)._repoSummary as string | undefined;

    const result = await this.deps.scripter.write({
      userPrompt: session.input.userPrompt,
      plan: session.plan,
      research: session.research,
      repoSummary,
      feedback,
      previousScript: previous,
    });

    return this.deps.store.appendScriptVersion(sessionId, {
      fullScript: result.fullScript,
      estimatedDurationSec: result.estimatedDurationSec,
      wordCount: result.wordCount,
      feedbackUsed: feedback,
    });
  }

  /** Approve the latest script and start audio + video + fusion (background). */
  approve(sessionId: string, options: { skipRecording?: boolean } = {}): PipelineSession {
    const session = this.requireSession(sessionId);
    const latest = session.scriptVersions[session.scriptVersions.length - 1];
    if (!latest) throw new Error('No script to approve');

    this.deps.store.update(sessionId, (s) => {
      s.approvedVersionId = latest.id;
      s.status = 'GENERATING';
      s.error = undefined;
    });

    void this.runMediaStages(sessionId, latest, options).catch((err) => {
      console.error(`[pipeline ${sessionId}] media-stage failure:`, err);
      this.deps.store.setError(sessionId, this.deps.store.get(sessionId)?.status ?? 'GENERATING', String(err?.message ?? err));
    });

    return this.requireSession(sessionId);
  }

  /** "Reiterate" from the result page: rewinds to SCRIPT_DRAFT preserving plan + research. */
  reiterate(sessionId: string): PipelineSession {
    return this.deps.store.update(sessionId, (s) => {
      s.status = 'SCRIPT_DRAFT';
      s.approvedVersionId = undefined;
      s.audio = undefined;
      s.video = undefined;
      s.finalVideo = undefined;
      s.error = undefined;
    });
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private async runScriptStages(sessionId: string, opts: { skipRecording?: boolean }): Promise<void> {
    const session = this.requireSession(sessionId);
    await mkdir(session.workDir, { recursive: true });

    // 1. Optional repo summary (clone + analyze) when a github url was supplied.
    let repoSummary: string | undefined;
    if (session.input.githubUrl && this.deps.repositoryCloner && this.deps.codebaseAnalyzer && this.deps.flowExtractor) {
      try {
        this.deps.store.setStatus(sessionId, 'PLANNING');
        const clone = await this.deps.repositoryCloner.clone({
          githubUrl: session.input.githubUrl,
          branch: session.input.branch,
          depth: 1,
        });
        const analysis = await this.deps.codebaseAnalyzer.analyze(clone.localPath);
        const flows = this.deps.flowExtractor.extract(analysis);
        repoSummary = summariseRepo(analysis, flows);
        await clone.cleanup();
      } catch (err) {
        console.warn(`[pipeline ${sessionId}] repo summary failed, proceeding without:`, err);
      }
    }

    // Stash repoSummary for later iterations without re-cloning.
    this.deps.store.update(sessionId, (s) => {
      (s as any)._repoSummary = repoSummary;
    });

    // 2. Plan
    this.deps.store.setStatus(sessionId, 'PLANNING');
    const plan = await this.deps.planner.plan({
      userPrompt: session.input.userPrompt,
      repoSummary,
      defaultDurationSec: session.input.targetDurationSec,
    });
    this.deps.store.update(sessionId, (s) => {
      s.plan = plan;
    });

    // 3. Research
    this.deps.store.setStatus(sessionId, 'RESEARCHING');
    const research = await this.deps.researcher.research({
      userPrompt: session.input.userPrompt,
      plan,
    });
    this.deps.store.update(sessionId, (s) => {
      s.research = research;
    });

    // 4. First script
    const draft = await this.deps.scripter.write({
      userPrompt: session.input.userPrompt,
      plan,
      research,
      repoSummary,
    });
    this.deps.store.appendScriptVersion(sessionId, {
      fullScript: draft.fullScript,
      estimatedDurationSec: draft.estimatedDurationSec,
      wordCount: draft.wordCount,
    });
    // Status is already SCRIPT_DRAFT after appendScriptVersion.
  }

  private async runMediaStages(
    sessionId: string,
    approvedScript: ScriptVersion,
    options: { skipRecording?: boolean },
  ): Promise<void> {
    const session = this.requireSession(sessionId);
    const sessionDir = session.workDir;
    await mkdir(sessionDir, { recursive: true });

    // 1. Audio + (optional) video in parallel.
    const audioPromise = this.deps.audioGenerator
      .generate(approvedScript.fullScript, { outputDir: sessionDir })
      .then((res) => {
        this.deps.store.update(sessionId, (s) => {
          s.audio = {
            url: `${this.deps.publicMediaPrefix}/${sessionId}/${res.fileName}`,
            fileName: res.fileName,
            bytes: res.bytes,
            durationEstimateMs: res.durationEstimateMs,
          };
        });
        return res;
      });

    const recordingEnabled =
      !options.skipRecording && !!session.input.githubUrl && !!this.deps.sandboxRecorder;

    const videoPromise: Promise<{ filePath: string } | null> = recordingEnabled
      ? this.deps.sandboxRecorder!
          .recordRepository({
            githubUrl: session.input.githubUrl!,
            branch: session.input.branch,
            recordDurationMs: Math.min(approvedScript.estimatedDurationSec, 120) * 1000,
          })
          .then((res) => {
            this.deps.store.update(sessionId, (s) => {
              s.video = {
                url: `${this.deps.publicMediaPrefix}/${sessionId}/${path.basename(res.recording.localPath)}`,
                fileName: path.basename(res.recording.localPath),
              };
            });
            return { filePath: res.recording.localPath };
          })
          .catch((err) => {
            console.warn(`[pipeline ${sessionId}] recording failed, falling back to slate:`, err);
            return null;
          })
      : Promise.resolve(null);

    const [audio, video] = await Promise.all([audioPromise, videoPromise]);

    // 2. Fuse
    this.deps.store.setStatus(sessionId, 'FUSING');
    const fused = await this.deps.fuser.fuse({
      audioPath: audio.filePath,
      videoPath: video?.filePath,
      outputDir: sessionDir,
      slateTitle: session.plan?.audience ? `Pitchbox · ${session.plan.audience}` : 'Pitchbox demo',
    });
    this.deps.store.update(sessionId, (s) => {
      s.finalVideo = {
        url: `${this.deps.publicMediaPrefix}/${sessionId}/${fused.fileName}`,
        fileName: fused.fileName,
      };
      s.status = 'READY';
    });
  }

  private requireSession(id: string): PipelineSession {
    const s = this.deps.store.get(id);
    if (!s) throw new Error(`Session ${id} not found`);
    return s;
  }
}

function summariseRepo(analysis: AnalysisResult, flows: any): string {
  const parts: string[] = [];
  parts.push(`Languages: ${analysis.techStack.languages.join(', ') || 'n/a'}`);
  parts.push(`Frameworks: ${analysis.techStack.frameworks.join(', ') || 'n/a'}`);
  parts.push(`Total files: ${analysis.totalFiles}`);
  if (flows.features?.length) {
    parts.push(`Features: ${flows.features.slice(0, 8).map((f: any) => f.name).join(', ')}`);
  }
  if (flows.userFlows?.length) {
    parts.push(`User flows: ${flows.userFlows.slice(0, 5).map((f: any) => f.name).join(', ')}`);
  }
  const readme = analysis.keyFiles.find((f) => f.relativePath.toLowerCase().includes('readme'));
  if (readme?.content) {
    parts.push(`README excerpt: ${readme.content.slice(0, 600)}`);
  }
  return parts.join('\n');
}
