import path from 'node:path';
import { mkdir, copyFile } from 'node:fs/promises';
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
import type { Recorder } from './Recorder';
import type { SlateRenderer } from './SlateRenderer';
import { resolveSelectedStages, type StageId } from './pipelineStages';

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
  // Records a plain URL locally (Puppeteer + ffmpeg) — used when a deployed
  // `recordUrl` is supplied instead of a GitHub repo + Daytona sandbox.
  urlRecorder?: Recorder;
  // Renders a branded slate PNG when there is no screen recording.
  slateRenderer?: SlateRenderer;
  // Public URL prefix for static-served session files. Final URLs become
  // `${publicMediaPrefix}/${sessionId}/<file>`.
  publicMediaPrefix: string;
}

export interface StartInput {
  githubUrl?: string;
  branch?: string;
  // A deployed/public URL to screen-record directly (no Daytona).
  recordUrl?: string;
  userPrompt: string;
  targetDurationSec?: number;
  // Which optional stages to run. Required stages always run; dependencies are
  // resolved automatically. Undefined = run everything.
  selectedStages?: StageId[];
  // If true, skip the screen-recording leg even if a target is available.
  skipRecording?: boolean;
}

export class PipelineOrchestrator {
  constructor(private readonly deps: PipelineDeps) {}

  /** Creates a session and kicks off plan + research + first script in the background. */
  start(input: StartInput): PipelineSession {
    const selected = resolveSelectedStages(input.selectedStages);
    const session = this.deps.store.create(
      {
        githubUrl: input.githubUrl,
        branch: input.branch,
        recordUrl: input.recordUrl,
        userPrompt: input.userPrompt,
        targetDurationSec: input.targetDurationSec ?? 90,
      },
      selected,
    );

    void this.runScriptStages(session.id, selected).catch((err) => {
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
      // Reset the media-phase stages so the board reflects a fresh run.
      for (const stage of s.stages) {
        if ((stage.id === 'record' || stage.id === 'voiceover' || stage.id === 'fuse') && stage.status !== 'skipped') {
          stage.status = 'pending';
          stage.message = undefined;
          stage.startedAt = undefined;
          stage.endedAt = undefined;
        }
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private async runScriptStages(sessionId: string, selected: Set<StageId>): Promise<void> {
    const session = this.requireSession(sessionId);
    await mkdir(session.workDir, { recursive: true });
    const store = this.deps.store;

    // 1. Optional repo summary (clone + analyze) when selected and a github url was supplied.
    let repoSummary: string | undefined;
    const canAnalyze =
      selected.has('analyze') &&
      session.input.githubUrl &&
      this.deps.repositoryCloner &&
      this.deps.codebaseAnalyzer &&
      this.deps.flowExtractor;
    if (canAnalyze) {
      store.setStage(sessionId, 'analyze', { status: 'running' });
      store.setStatus(sessionId, 'PLANNING');
      try {
        const clone = await this.deps.repositoryCloner!.clone({
          githubUrl: session.input.githubUrl!,
          branch: session.input.branch,
          depth: 1,
        });
        const analysis = await this.deps.codebaseAnalyzer!.analyze(clone.localPath);
        const flows = this.deps.flowExtractor!.extract(analysis);
        repoSummary = summariseRepo(analysis, flows);
        await clone.cleanup();
        store.setStage(sessionId, 'analyze', { status: 'done', message: summaryHeadline(analysis) });
      } catch (err) {
        console.warn(`[pipeline ${sessionId}] repo summary failed, proceeding without:`, err);
        store.setStage(sessionId, 'analyze', { status: 'failed', message: String((err as any)?.message ?? err) });
      }
    } else {
      store.skipStage(sessionId, 'analyze');
    }

    // Stash repoSummary for later iterations without re-cloning.
    store.update(sessionId, (s) => {
      (s as any)._repoSummary = repoSummary;
    });

    // 2. Plan
    store.setStage(sessionId, 'plan', { status: 'running' });
    store.setStatus(sessionId, 'PLANNING');
    const plan = await this.deps.planner.plan({
      userPrompt: session.input.userPrompt,
      repoSummary,
      defaultDurationSec: session.input.targetDurationSec,
    });
    store.update(sessionId, (s) => {
      s.plan = plan;
    });
    store.setStage(sessionId, 'plan', { status: 'done', message: plan.audience });

    // 3. Research (optional)
    let research;
    if (selected.has('research')) {
      store.setStage(sessionId, 'research', { status: 'running' });
      store.setStatus(sessionId, 'RESEARCHING');
      research = await this.deps.researcher.research({ userPrompt: session.input.userPrompt, plan });
      store.setStage(sessionId, 'research', {
        status: 'done',
        message: `${research.dos.length} dos · ${research.donts.length} don'ts`,
      });
    } else {
      store.skipStage(sessionId, 'research');
      research = { summary: '', dos: [], donts: [], examplesOrPatterns: [], citations: [] };
    }
    store.update(sessionId, (s) => {
      s.research = research;
    });

    // 4. First script
    store.setStage(sessionId, 'script', { status: 'running' });
    const draft = await this.deps.scripter.write({
      userPrompt: session.input.userPrompt,
      plan,
      research,
      repoSummary,
    });
    store.appendScriptVersion(sessionId, {
      fullScript: draft.fullScript,
      estimatedDurationSec: draft.estimatedDurationSec,
      wordCount: draft.wordCount,
    });
    store.setStage(sessionId, 'script', {
      status: 'done',
      message: `${draft.wordCount} words · ~${draft.estimatedDurationSec}s`,
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
    const store = this.deps.store;
    await mkdir(sessionDir, { recursive: true });

    // 1. Audio + (optional) video in parallel.
    store.setStage(sessionId, 'voiceover', { status: 'running' });
    const audioPromise = this.deps.audioGenerator
      .generate(approvedScript.fullScript, { outputDir: sessionDir })
      .then((res) => {
        store.update(sessionId, (s) => {
          s.audio = {
            url: `${this.deps.publicMediaPrefix}/${sessionId}/${res.fileName}`,
            fileName: res.fileName,
            bytes: res.bytes,
            durationEstimateMs: res.durationEstimateMs,
          };
        });
        store.setStage(sessionId, 'voiceover', { status: 'done', message: `${Math.round(res.bytes / 1024)} KB` });
        return res;
      })
      .catch((err) => {
        store.setStage(sessionId, 'voiceover', { status: 'failed', message: String(err?.message ?? err) });
        throw err;
      });

    const recordSelected = session.stages.find((s) => s.id === 'record')?.status !== 'skipped';
    const recordDurationMs = Math.min(approvedScript.estimatedDurationSec, 120) * 1000;
    const videoPromise = !options.skipRecording && recordSelected
      ? this.recordTarget(sessionId, session, recordDurationMs)
      : Promise.resolve(null).then((v) => {
          store.skipStage(sessionId, 'record');
          return v;
        });

    const [audio, video] = await Promise.all([audioPromise, videoPromise]);

    // 2. Fuse
    store.setStage(sessionId, 'fuse', { status: 'running' });
    store.setStatus(sessionId, 'FUSING');

    // When there is no recording, render a branded slate image to use as the
    // background (instead of a black frame from ffmpeg drawtext).
    let slateImagePath: string | undefined;
    if (!video && this.deps.slateRenderer) {
      try {
        slateImagePath = path.join(sessionDir, 'slate.png');
        await this.deps.slateRenderer.render(
          {
            title: session.plan?.primaryGoal || 'Your demo, narrated.',
            subtitle: session.plan?.audience,
            wordmark: 'Pitchbox',
          },
          slateImagePath,
        );
      } catch (err) {
        console.warn(`[pipeline ${sessionId}] slate render failed, using ffmpeg fallback:`, err);
        slateImagePath = undefined;
      }
    }

    const fused = await this.deps.fuser.fuse({
      audioPath: audio.filePath,
      videoPath: video?.filePath,
      outputDir: sessionDir,
      slateTitle: session.plan?.audience ? `Pitchbox · ${session.plan.audience}` : 'Pitchbox demo',
      slateImagePath,
    });
    store.update(sessionId, (s) => {
      s.finalVideo = {
        url: `${this.deps.publicMediaPrefix}/${sessionId}/${fused.fileName}`,
        fileName: fused.fileName,
      };
      s.status = 'READY';
    });
    store.setStage(sessionId, 'fuse', { status: 'done', message: video ? 'with screen capture' : 'slate' });
  }

  /**
   * Record the configured target: a deployed `recordUrl` via the local URL
   * recorder, or a GitHub repo via the Daytona sandbox recorder. Returns the
   * captured file path, or null on failure (the pipeline falls back to a slate).
   */
  private async recordTarget(
    sessionId: string,
    session: PipelineSession,
    recordDurationMs: number,
  ): Promise<{ filePath: string } | null> {
    const store = this.deps.store;
    store.setStage(sessionId, 'record', { status: 'running' });
    // Hard ceiling so a wedged recorder can never stall the pipeline — on
    // timeout we abandon the capture and fall back to a slate.
    const recordCeilingMs = Math.max(recordDurationMs, 60_000) + 60_000;
    try {
      if (session.input.recordUrl && this.deps.urlRecorder) {
        const rec = await withTimeout(
          this.deps.urlRecorder.record(session.input.recordUrl),
          recordCeilingMs,
          'URL recording',
        );
        const filePath = await this.stageRecordedFile(sessionId, session, rec.localPath);
        store.setStage(sessionId, 'record', { status: 'done', message: session.input.recordUrl });
        return { filePath };
      }
      if (session.input.githubUrl && this.deps.sandboxRecorder) {
        const res = await withTimeout(
          this.deps.sandboxRecorder.recordRepository({
            githubUrl: session.input.githubUrl,
            branch: session.input.branch,
            recordDurationMs,
          }),
          recordCeilingMs,
          'sandbox recording',
        );
        const filePath = await this.stageRecordedFile(sessionId, session, res.recording.localPath);
        store.setStage(sessionId, 'record', { status: 'done', message: 'sandbox capture' });
        return { filePath };
      }
      // Nothing to record against.
      store.skipStage(sessionId, 'record');
      return null;
    } catch (err) {
      console.warn(`[pipeline ${sessionId}] recording failed, falling back to slate:`, err);
      store.setStage(sessionId, 'record', { status: 'failed', message: String((err as any)?.message ?? err) });
      return null;
    }
  }

  /**
   * Copy a captured file into the session dir so it is served under
   * `${publicMediaPrefix}/${sessionId}/...`, record it on the session, and
   * return the in-session path (used as the fusion input).
   */
  private async stageRecordedFile(
    sessionId: string,
    session: PipelineSession,
    localPath: string,
  ): Promise<string> {
    const fileName = path.basename(localPath);
    const dest = path.join(session.workDir, fileName);
    try {
      if (path.resolve(localPath) !== path.resolve(dest)) {
        await copyFile(localPath, dest);
      }
    } catch (err) {
      console.warn(`[pipeline ${sessionId}] could not stage capture into session dir:`, err);
      return localPath; // fall back to the original path for fusion
    }
    this.deps.store.update(sessionId, (s) => {
      s.video = {
        url: `${this.deps.publicMediaPrefix}/${sessionId}/${fileName}`,
        fileName,
      };
    });
    return dest;
  }

  private requireSession(id: string): PipelineSession {
    const s = this.deps.store.get(id);
    if (!s) throw new Error(`Session ${id} not found`);
    return s;
  }
}

/** Reject if `promise` does not settle within `ms`. Used to bound the recorder. */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms);
    timer.unref?.();
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
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

function summaryHeadline(analysis: AnalysisResult): string {
  const fw = analysis.techStack.frameworks.slice(0, 2).join(', ');
  const lang = analysis.techStack.languages.slice(0, 2).join(', ');
  return [fw, lang].filter(Boolean).join(' · ') || `${analysis.totalFiles} files`;
}
