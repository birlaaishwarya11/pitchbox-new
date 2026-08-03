import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, copyFile, access } from 'node:fs/promises';
import type { SessionStore, PipelineSession, ScriptVersion } from './SessionStore';
import { Planner } from './Planner';
import { Researcher } from './Researcher';
import { Scripter } from './Scripter';
import { Director } from './Director';
import type { SiteScout } from './SiteScout';
import { makeDummyIdentity, type DummyIdentity } from './cinematics/dummyIdentity';
import type { Beat, SiteMap } from './cinematics/types';
import { createLlmClient, type LlmConfig } from './llm/createLlmClient';
import type { LlmClient } from './llm/LlmClient';
import { AudioGenerator } from './AudioGenerator';
import type { Fuser } from './Fuser';
import type { RepositoryCloner } from './RepositoryCloner';
import type { CodebaseAnalyzer, AnalysisResult } from './CodebaseAnalyzer';
import type { FlowExtractor } from './FlowExtractor';
import type { SandboxRecorder } from './SandboxRecorder';
import type { Recorder } from './Recorder';
import type { SlateRenderer } from './SlateRenderer';
import { resolveSelectedStages, type StageId } from './pipelineStages';
import { mediaSemaphore } from './concurrency';

// Recording is the flakiest stage; total attempts = 1 try + (this - 1) retries.
const RECORD_MAX_ATTEMPTS = 2;
/**
 * Sandbox recordings are not retried.
 *
 * A repo run is provision, clone, apt, install, build, start, scout, record —
 * ten minutes or more — and when it fails it is almost always for a reason a
 * second identical attempt will hit again: a missing environment variable, a
 * wrong start command, a port that never opens. Retrying just spends another ten
 * minutes and another sandbox to reach the same error, and delays the diagnostic
 * that would actually help.
 */
const SANDBOX_RECORD_MAX_ATTEMPTS = 1;

/** Duration of a media file in ms, or 0 if it cannot be probed. */
function probeDurationMs(filePath: string): Promise<number> {
  return new Promise((resolve) => {
    const proc = spawn('ffprobe', [
      '-v', 'error', '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1', filePath,
    ]);
    let out = '';
    proc.stdout.on('data', (c) => { out += c.toString(); });
    proc.on('error', () => resolve(0));
    proc.on('exit', () => {
      const sec = Number(out.trim());
      resolve(Number.isFinite(sec) ? Math.round(sec * 1000) : 0);
    });
  });
}

interface SessionAgents {
  planner: Planner;
  researcher: Researcher;
  scripter: Scripter;
  // Plans what the app does on camera and how it is framed, on the run's own key.
  director: Director;
  // The shared client behind all four agents — carries this run's token totals.
  llmClient: LlmClient;
  // Bound per session: voiceover is billed to whoever's ElevenLabs key ran it,
  // so the generator cannot be shared across users the way a stateless helper
  // like Fuser can.
  audioGenerator: AudioGenerator;
}

export interface PipelineDeps {
  store: SessionStore;
  // Operator fallback LLM config (from server env) when a request brings no key.
  defaultLlm?: LlmConfig;
  // Operator fallback voice generator. Optional: a bring-your-own-keys
  // deployment sets no ElevenLabs key at all, and every run supplies its own.
  audioGenerator?: AudioGenerator;
  fuser: Fuser;
  repositoryCloner?: RepositoryCloner;
  codebaseAnalyzer?: CodebaseAnalyzer;
  flowExtractor?: FlowExtractor;
  sandboxRecorder?: SandboxRecorder;
  // Records a plain URL locally (Puppeteer + ffmpeg) — used when a deployed
  // `recordUrl` is supplied instead of a GitHub repo + Daytona sandbox.
  urlRecorder?: Recorder;
  // Explores the app before the camera rolls, so the director has somewhere to
  // point beyond the landing page. Optional: without it, recording degrades to
  // the old scroll-the-front-page behaviour rather than failing.
  siteScout?: SiteScout;
  // Renders a branded slate PNG when there is no screen recording.
  slateRenderer?: SlateRenderer;
  // Public URL prefix for static-served session files. Final URLs become
  // `${publicMediaPrefix}/${sessionId}/<file>`.
  publicMediaPrefix: string;
  /**
   * Fired once a session reaches READY.
   *
   * Token totals are only complete here: the cinematographer plans camera moves
   * during recording, i.e. after approval, so anything recorded at approve time
   * would undercount the run.
   */
  onSessionComplete?: (session: PipelineSession, usage: { inputTokens: number; outputTokens: number; calls: number }) => void;
}

interface PlannedWalkthrough {
  beats: Beat[];
  identity: DummyIdentity;
}

export interface StartInput {
  githubUrl?: string;
  branch?: string;
  // A deployed/public URL to screen-record directly (no Daytona).
  recordUrl?: string;
  // Daytona sandbox recording config (when recording a GitHub repo).
  appStartCommand?: string;
  appBuildCommand?: string;
  sandboxPort?: number;
  /**
   * Environment the repo needs to boot. Held off the session object on purpose —
   * see `appEnvBySession` — so it never reaches an API response or a log.
   */
  appEnv?: Record<string, string>;
  userPrompt: string;
  targetDurationSec?: number;
  // Which optional stages to run. Required stages always run; dependencies are
  // resolved automatically. Undefined = run everything.
  selectedStages?: StageId[];
  // If true, skip the screen-recording leg even if a target is available.
  skipRecording?: boolean;
  // Bring-your-own LLM: provider + key + model. Falls back to the operator's
  // default config when omitted.
  llm?: LlmConfig;
  // Bring-your-own ElevenLabs key for voiceover. Falls back to the operator's
  // generator when omitted — which a BYOK deployment does not configure, so
  // omitting both is a clear error rather than a silent charge to the operator.
  elevenLabsApiKey?: string;
  /** Authenticated caller. Recorded on the session so routes can authorise. */
  userId: string;
}

export class PipelineOrchestrator {
  // Per-session LLM agents, built from the run's chosen provider/key/model.
  private readonly agentsBySession = new Map<string, SessionAgents>();
  // Scouting drives a real browser around the app for up to two minutes. The
  // map it produces depends on the app, not on the script, so it is kept across
  // retries and script iterations; only the director re-runs when the words
  // change, since the beats are timed against them.
  private readonly siteMapBySession = new Map<string, SiteMap>();
  /**
   * Environment for the app being recorded, kept beside the session rather than
   * on it.
   *
   * These are the caller's real credentials. `PipelineSession` is serialised
   * wholesale into every `GET /api/pipeline/:id` response, so a field on
   * `session.input` would hand them back over HTTP and put them in any log line
   * that dumps a session. Off to the side, only the recording stage can see them.
   */
  private readonly appEnvBySession = new Map<string, Record<string, string>>();

  constructor(private readonly deps: PipelineDeps) {}

  private buildAgents(llm: LlmConfig, audioGenerator: AudioGenerator): SessionAgents {
    const client = createLlmClient(llm);
    return {
      planner: new Planner(client),
      researcher: new Researcher(client),
      scripter: new Scripter(client),
      director: new Director(client),
      llmClient: client,
      audioGenerator,
    };
  }

  /** Creates a session and kicks off plan + research + first script in the background. */
  start(input: StartInput): PipelineSession {
    const selected = resolveSelectedStages(input.selectedStages);
    const llm = input.llm ?? this.deps.defaultLlm;
    if (!llm) {
      throw new Error('No LLM configured. Provide an API key (provider + model), or set a server default.');
    }
    // Voiceover is the one owner-cost stage, so resolve its key up front and
    // fail loudly rather than starting a run that dies at the media stage.
    const audioGenerator = input.elevenLabsApiKey
      ? new AudioGenerator(input.elevenLabsApiKey)
      : this.deps.audioGenerator;
    if (!audioGenerator) {
      throw new Error('No ElevenLabs key configured. Provide `elevenLabsApiKey` to generate the voiceover.');
    }
    // Build eagerly so an invalid provider/model fails fast with a clear error.
    const agents = this.buildAgents(llm, audioGenerator);

    const session = this.deps.store.create(
      {
        githubUrl: input.githubUrl,
        branch: input.branch,
        recordUrl: input.recordUrl,
        appStartCommand: input.appStartCommand,
        appBuildCommand: input.appBuildCommand,
        sandboxPort: input.sandboxPort,
        userPrompt: input.userPrompt,
        targetDurationSec: input.targetDurationSec ?? 90,
      },
      input.userId,
      selected,
    );
    this.agentsBySession.set(session.id, agents);
    if (input.appEnv && Object.keys(input.appEnv).length) {
      this.appEnvBySession.set(session.id, input.appEnv);
    }

    void this.runScriptStages(session.id, selected, agents).catch((err) => {
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
    const agents = this.agentsBySession.get(sessionId);
    if (!agents) {
      throw new Error('This session has expired (server restarted). Start a new one.');
    }

    const result = await agents.scripter.write({
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
      // `s.audio` is deliberately kept. It carries the hash of the script it
      // was read from, so the next approval reuses it when the words end up
      // unchanged and re-records when they don't — either way, nobody pays
      // twice for the same sentences.
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

  private async runScriptStages(sessionId: string, selected: Set<StageId>, agents: SessionAgents): Promise<void> {
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
    const plan = await agents.planner.plan({
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
      research = await agents.researcher.research({ userPrompt: session.input.userPrompt, plan });
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
    const draft = await agents.scripter.write({
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

  /**
   * Gate on the media semaphore, then run the real work.
   *
   * The wait happens here rather than at the HTTP layer so approve() still
   * returns immediately and the UI keeps showing progress — the run simply sits
   * in 'GENERATING' until a slot frees, instead of failing outright.
   */
  private async runMediaStages(
    sessionId: string,
    approvedScript: ScriptVersion,
    options: { skipRecording?: boolean },
  ): Promise<void> {
    const release = await mediaSemaphore.acquire();
    const { active, queued } = mediaSemaphore.stats;
    if (queued > 0) console.log(`[pipeline ${sessionId}] media slot acquired (${active} active, ${queued} queued)`);
    try {
      await this.runMediaStagesInner(sessionId, approvedScript, options);
    } finally {
      release();
    }
  }

  private async runMediaStagesInner(
    sessionId: string,
    approvedScript: ScriptVersion,
    options: { skipRecording?: boolean },
  ): Promise<void> {
    const session = this.requireSession(sessionId);
    const sessionDir = session.workDir;
    const store = this.deps.store;
    await mkdir(sessionDir, { recursive: true });

    const audioGenerator = this.agentsBySession.get(sessionId)?.audioGenerator;
    if (!audioGenerator) {
      throw new Error('This session has expired (server restarted). Start a new one.');
    }

    // 1. Record FIRST, then voice — deliberately sequential.
    //
    // Recording costs only CPU; the voiceover costs the user real money. Running
    // them in parallel meant a failed or wrong-length recording had already been
    // paid for in ElevenLabs credit by the time anyone noticed. Doing video
    // first also lets us check the footage actually matches the script before
    // committing to the spend.
    const recordSelected = session.stages.find((s) => s.id === 'record')?.status !== 'skipped';
    const recordDurationMs = Math.min(approvedScript.estimatedDurationSec, 120) * 1000;

    let video: { filePath: string } | null = null;
    if (!options.skipRecording && recordSelected) {
      video = await this.recordTarget(sessionId, session, recordDurationMs);
      if (video) {
        const actualMs = await probeDurationMs(video.filePath);
        const shortfall = recordDurationMs - actualMs;
        // Informational: the fuser loops short footage, so this is a quality
        // signal rather than a failure. Worth logging because a large gap means
        // the capture stopped early and the loop will be obvious to a viewer.
        if (actualMs > 0 && shortfall > 5_000) {
          console.warn(
            `[pipeline ${sessionId}] recording is ${Math.round(actualMs / 1000)}s but the script needs ` +
              `${Math.round(recordDurationMs / 1000)}s — the fuser will loop the footage to cover the gap.`,
          );
        }
        store.setStage(sessionId, 'record', {
          status: 'done',
          message: `${Math.round(actualMs / 1000)}s captured (target ${Math.round(recordDurationMs / 1000)}s)`,
        });
      }
    } else {
      store.skipStage(sessionId, 'record');
    }

    // 2. Voiceover, now that the footage is known good.
    //
    // Reuse it when the script has not changed a character. This is the only
    // stage billed per run, and re-cutting the video after an unchanged script
    // — a new take, a retry, a reiterate that ended up back where it started —
    // would otherwise buy the identical audio a second time.
    store.setStage(sessionId, 'voiceover', { status: 'running' });
    const scriptHash = hashScript(approvedScript.fullScript);
    const reusable = await this.reusableAudio(session, scriptHash, sessionDir);

    let audioPath: string;
    if (reusable) {
      audioPath = reusable;
      store.setStage(sessionId, 'voiceover', { status: 'done', message: 'reused — script unchanged' });
      console.log(`[pipeline ${sessionId}] reusing the existing voiceover; the script is unchanged.`);
    } else {
      try {
        const audio = await audioGenerator.generate(approvedScript.fullScript, { outputDir: sessionDir });
        audioPath = audio.filePath;
        store.update(sessionId, (s) => {
          s.audio = {
            url: `${this.deps.publicMediaPrefix}/${sessionId}/${audio.fileName}`,
            fileName: audio.fileName,
            bytes: audio.bytes,
            durationEstimateMs: audio.durationEstimateMs,
            scriptHash,
          };
        });
        store.setStage(sessionId, 'voiceover', { status: 'done', message: `${Math.round(audio.bytes / 1024)} KB` });
      } catch (err) {
        store.setStage(sessionId, 'voiceover', { status: 'failed', message: String((err as any)?.message ?? err) });
        throw err;
      }
    }

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
      audioPath,
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

    const finished = store.get(sessionId);
    const usage = this.agentsBySession.get(sessionId)?.llmClient.usage;
    if (finished && usage) {
      try {
        this.deps.onSessionComplete?.(finished, { ...usage });
      } catch (err) {
        // Telemetry must never fail a finished run.
        console.warn(`[pipeline ${sessionId}] completion hook failed:`, err);
      }
    }
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

    const hasTarget =
      (session.input.recordUrl && this.deps.urlRecorder) ||
      (session.input.githubUrl && this.deps.sandboxRecorder);
    if (!hasTarget) {
      store.skipStage(sessionId, 'record');
      return null;
    }

    store.setStage(sessionId, 'record', { status: 'running' });
    // Hard ceiling so a wedged recorder can never stall the pipeline — on
    // timeout we abandon the capture and fall back to a slate. The Daytona path
    // (provision → clone → install → build → run → record) needs far longer than
    // a direct URL capture.
    const isSandbox = !session.input.recordUrl && !!session.input.githubUrl;
    // The sandbox leg now scouts the app before recording it, and that time
    // sits inside this ceiling: provision, clone, install, build, start, wait
    // for HTTP, explore, direct, record. Twelve minutes covered the old
    // sequence with little to spare, so a scouted run would have started
    // timing out and falling back to a slate — a regression dressed up as
    // flakiness. Sized to leave room for a slow `npm install` on top.
    const recordCeilingMs = isSandbox ? 18 * 60_000 : Math.max(recordDurationMs, 60_000) + 60_000;
    const label = session.input.recordUrl ? session.input.recordUrl : 'sandbox capture';

    // Recording is the flakiest leg, so retry once before giving up — except in
    // a sandbox, where a failure is deterministic and a retry is very expensive.
    const maxAttempts = isSandbox ? SANDBOX_RECORD_MAX_ATTEMPTS : RECORD_MAX_ATTEMPTS;
    let lastErr: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const localPath = await this.recordOnce(session, recordDurationMs, recordCeilingMs);
        const filePath = await this.stageRecordedFile(sessionId, session, localPath);
        store.setStage(sessionId, 'record', {
          status: 'done',
          message: attempt > 1 ? `${label} (retry ${attempt - 1})` : label,
        });
        return { filePath };
      } catch (err) {
        lastErr = err;
        console.warn(`[pipeline ${sessionId}] recording attempt ${attempt}/${maxAttempts} failed:`, err);
        if (attempt < maxAttempts) {
          store.setStage(sessionId, 'record', {
            status: 'running',
            message: `attempt ${attempt} failed — retrying…`,
          });
        }
      }
    }

    console.warn(`[pipeline ${sessionId}] recording failed after ${maxAttempts} attempt(s), falling back to slate.`);
    store.setStage(sessionId, 'record', {
      status: 'failed',
      message: `failed after ${maxAttempts} attempt(s) — using slate.\n${String((lastErr as any)?.message ?? lastErr)}`,
    });
    return null;
  }

  /**
   * Path to an existing voiceover that was read from this exact script, or
   * undefined if there isn't one.
   *
   * Both halves have to hold: the hash has to match, and the file has to still
   * be on disk. The session sweeper deletes work directories, and a session
   * that outlives its own audio must re-record rather than hand the fuser a
   * path to nothing.
   */
  private async reusableAudio(
    session: PipelineSession,
    scriptHash: string,
    sessionDir: string,
  ): Promise<string | undefined> {
    const existing = session.audio;
    if (!existing?.scriptHash || existing.scriptHash !== scriptHash) return undefined;
    const filePath = path.join(sessionDir, existing.fileName);
    try {
      await access(filePath);
      return filePath;
    } catch {
      return undefined;
    }
  }

  /**
   * Scout the app, then have the director turn it into a timed walkthrough.
   *
   * Returns empty beats on any failure. That is deliberate: a run that cannot
   * be scouted should still produce the old scroll-the-landing-page video
   * rather than no video at all.
   */
  private async planWalkthrough(
    session: PipelineSession,
    recordUrl: string,
    script: string | undefined,
    recordDurationMs: number,
  ): Promise<PlannedWalkthrough> {
    // Two personas from one seed. The scout signs up to find out what is behind
    // the login, which means that account already exists by the time the camera
    // rolls — so the take needs its own, or the signup performed on screen
    // collides with the one scouting just created.
    const identity = makeDummyIdentity(`${session.id}:take`);

    const director = this.agentsBySession.get(session.id)?.director;
    const scout = this.deps.siteScout;
    if (!scout || !director || !script) return { beats: [], identity };

    const store = this.deps.store;
    try {
      let siteMap = this.siteMapBySession.get(session.id);
      if (!siteMap) {
        store.setStage(session.id, 'record', { status: 'running', message: 'exploring the app…' });
        siteMap = await scout.explore(recordUrl, makeDummyIdentity(`${session.id}:scout`));
        this.siteMapBySession.set(session.id, siteMap);
        console.log(
          `[pipeline ${session.id}] scouted ${siteMap.screens.length} screen(s): ` +
            siteMap.screens.map((s) => s.path).join(', '),
        );
        for (const note of siteMap.notes) console.log(`[pipeline ${session.id}] scout: ${note}`);
      }

      // If the scout signed in rather than registered, only its account exists —
      // so the take has to be that persona. Recording with the other one puts
      // "Invalid login credentials" in the finished video.
      const takeIdentity =
        siteMap.authUsed === 'signed-in' ? makeDummyIdentity(`${session.id}:scout`) : identity;
      if (siteMap.authUsed) {
        console.log(`[pipeline ${session.id}] scout ${siteMap.authUsed}; recording as the ${
          takeIdentity === identity ? 'take' : 'scout'
        } persona`);
      }

      store.setStage(session.id, 'record', { status: 'running', message: 'planning the walkthrough…' });
      const walkthrough = await director.plan({
        script,
        durationSec: recordDurationMs / 1000,
        siteMap,
        identity: takeIdentity,
      });
      const actions = walkthrough.beats.filter((b) => b.action !== 'hold' && b.action !== 'scrollTo').length;
      console.log(
        `[pipeline ${session.id}] directed ${walkthrough.beats.length} beats (${actions} interactions)`,
      );

      return { beats: walkthrough.beats, identity: takeIdentity };
    } catch (err) {
      console.warn(
        `[pipeline ${session.id}] walkthrough planning failed, the recording will scroll instead:`,
        err,
      );
      return { beats: [], identity };
    }
  }

  /** A single recording attempt against the configured target. Throws on failure. */
  private async recordOnce(
    session: PipelineSession,
    recordDurationMs: number,
    recordCeilingMs: number,
  ): Promise<string> {
    if (session.input.recordUrl && this.deps.urlRecorder) {
      const approved =
        session.scriptVersions.find((v) => v.id === session.approvedVersionId) ??
        session.scriptVersions[session.scriptVersions.length - 1];

      const { beats, identity } = await this.planWalkthrough(
        session,
        session.input.recordUrl,
        approved?.fullScript,
        recordDurationMs,
      );

      this.deps.store.setStage(session.id, 'record', {
        status: 'running',
        message: beats.length ? `capturing ${beats.length}-beat walkthrough…` : 'capturing…',
      });

      const rec = await withTimeout(
        this.deps.urlRecorder.record(session.input.recordUrl, {
          targetDurationMs: recordDurationMs,
          // Empty beats fall back to scrolling inside the recorder — a worse
          // video, not a broken one.
          beats,
          identity,
        }),
        recordCeilingMs,
        'URL recording',
      );
      return rec.localPath;
    }
    if (session.input.githubUrl && this.deps.sandboxRecorder) {
      const director = this.agentsBySession.get(session.id)?.director;
      const approved =
        session.scriptVersions.find((v) => v.id === session.approvedVersionId) ??
        session.scriptVersions[session.scriptVersions.length - 1];
      const identity = makeDummyIdentity(`${session.id}:take`);

      const res = await withTimeout(
        this.deps.sandboxRecorder.recordRepository({
          githubUrl: session.input.githubUrl,
          branch: session.input.branch,
          recordDurationMs,
          appStartCommand: session.input.appStartCommand,
          appBuildCommand: session.input.appBuildCommand,
          appPort: session.input.sandboxPort,
          appEnv: this.appEnvBySession.get(session.id),
          // The sandbox scouts the app itself — only it can reach the app over
          // localhost — and hands the map back here to be directed, because the
          // run's LLM key stays on this side and never enters the sandbox.
          scoutIdentity: makeDummyIdentity(`${session.id}:scout`),
          planWalkthrough:
            director && approved
              ? async (siteMap) => {
                  const { beats } = await director.plan({
                    script: approved.fullScript,
                    durationSec: recordDurationMs / 1000,
                    siteMap,
                    identity,
                  });
                  console.log(`[pipeline ${session.id}] directed ${beats.length} beats for the sandbox`);
                  return { beats, identity };
                }
              : undefined,
        }),
        recordCeilingMs,
        'sandbox recording',
      );
      return res.recording.localPath;
    }
    throw new Error('No recording target available');
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

/** Identity of a script's text, used to decide whether its audio can be reused. */
function hashScript(script: string): string {
  return createHash('sha256').update(script.trim()).digest('hex');
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
