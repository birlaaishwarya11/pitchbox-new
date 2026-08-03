// MUST be first: populates process.env before any env-reading import runs.
import './loadEnv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type Express, type Request, type Response } from 'express';
import cors from 'cors';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

import { DaytonaDeployer, DaytonaDeploymentError } from './DaytonaDeployer';
import { SandboxRecorder } from './SandboxRecorder';
import { Recorder, RecorderError } from './Recorder';
import { SiteScout } from './SiteScout';
import { RepositoryCloner, RepositoryClonerError } from './RepositoryCloner';
import { CodebaseAnalyzer } from './CodebaseAnalyzer';
import { FlowExtractor } from './FlowExtractor';
import { AudioGenerator, AudioGeneratorError } from './AudioGenerator';
import { Fuser } from './Fuser';
import { SlateRenderer } from './SlateRenderer';
import { SessionStore } from './SessionStore';
import { PipelineOrchestrator } from './PipelineOrchestrator';
import { STAGE_DEFS, type StageId } from './pipelineStages';
import { PROVIDERS } from './llm/providers';
import { validateLlmKey, type LlmConfig } from './llm/createLlmClient';
import helmet from 'helmet';
import { requireUser, supabaseAdmin, isSupabaseConfigured, type AuthedRequest } from './auth/supabaseAuth';
import { UsageLimiter, UsageLimitError, GlobalUsageLimitError } from './usage/UsageLimiter';
import { SessionCapacityError } from './SessionStore';
import { TelemetryRecorder } from './usage/TelemetryRecorder';
import { mintApiKey } from './auth/apiKeys';
import { assertSafeUrl, BlockedUrlError } from './security/urlGuard';
import { parseAppEnv, AppEnvError, describeAppEnv } from './security/appEnv';
import {
  globalLimiter,
  startPipelineLimiter,
  validateKeyLimiter,
  keyMintLimiter,
  sandboxLimiter,
} from './security/rateLimits';

const app: Express = express();
const PORT = process.env.PORT || 3001;
const recorder = new Recorder();
// Explores a target app before the camera rolls, so the recording can show the
// product being used rather than a tour of its front page.
const siteScout = new SiteScout();
const repositoryCloner = new RepositoryCloner();
const codebaseAnalyzer = new CodebaseAnalyzer();
const flowExtractor = new FlowExtractor();

/**
 * Bring-your-own-keys switch.
 *
 * The hosted deployment must never spend the operator's LLM or voice credits on
 * strangers' runs, so server-side ANTHROPIC_API_KEY / ELEVENLABS_API_KEY are
 * IGNORED unless this is explicitly turned on. Self-hosters flip it to true and
 * get the old convenience of env keys back.
 *
 * Opt-in rather than opt-out on purpose: forgetting to set a variable then
 * costs nothing, whereas forgetting to unset one would quietly fund everybody.
 */
const ALLOW_SERVER_KEYS = process.env.PITCHBOX_ALLOW_SERVER_KEYS === 'true';

const serverElevenLabsKey =
  ALLOW_SERVER_KEYS && process.env.ELEVENLABS_API_KEY && !process.env.ELEVENLABS_API_KEY.includes('ADD YOUR')
    ? process.env.ELEVENLABS_API_KEY
    : undefined;

const audioGenerator = serverElevenLabsKey ? new AudioGenerator(serverElevenLabsKey) : null;

// Media output dir. Override with MEDIA_DIR in production to point at a mounted
// persistent volume so generated videos survive restarts/redeploys.
const MEDIA_DIR = process.env.MEDIA_DIR
  ? path.resolve(process.env.MEDIA_DIR)
  : path.resolve(__dirname, '../../../recordings');
const TEST_AUDIO_DIR = path.join(MEDIA_DIR, 'test-audio');
const SESSIONS_DIR = path.join(MEDIA_DIR, 'sessions');

const sessionStore = new SessionStore(SESSIONS_DIR);
sessionStore.start();

// Operator fallback LLM config: used when a request brings no key. Gated on
// ALLOW_SERVER_KEYS so the hosted instance is bring-your-own-key only.
const defaultLlm: LlmConfig | undefined =
  ALLOW_SERVER_KEYS && process.env.ANTHROPIC_API_KEY
    ? { provider: 'anthropic', apiKey: process.env.ANTHROPIC_API_KEY, model: 'claude-sonnet-5' }
    : undefined;

// Daytona sandbox — isolated execution for recording untrusted GitHub repos
// (building/running a stranger's code must never happen on the host). Created
// eagerly when DAYTONA_API_KEY is present; null otherwise.
const daytonaDeployer: DaytonaDeployer | null = process.env.DAYTONA_API_KEY
  ? new DaytonaDeployer(undefined, { defaultWorkspaceDir: process.env.DAYTONA_WORKSPACE_DIR })
  : null;
const sandboxRecorder: SandboxRecorder | null = daytonaDeployer ? new SandboxRecorder(daytonaDeployer) : null;

// Usage heartbeat. Null when Supabase is unconfigured; recording is always
// best-effort and never blocks a request.
const telemetry = supabaseAdmin ? new TelemetryRecorder(supabaseAdmin) : null;

// Always constructed now: with bring-your-own-keys, a run supplies its own LLM
// and ElevenLabs credentials, so the pipeline is available even when the server
// itself holds no keys at all.
const orchestrator = new PipelineOrchestrator({
  store: sessionStore,
  defaultLlm,
  audioGenerator: audioGenerator ?? undefined,
  fuser: new Fuser(),
  slateRenderer: new SlateRenderer(),
  repositoryCloner,
  codebaseAnalyzer,
  flowExtractor,
  // Records a deployed/public URL directly (no Daytona required).
  urlRecorder: recorder,
  siteScout,
  // Records a GitHub repo by building + running it inside a Daytona sandbox.
  sandboxRecorder: sandboxRecorder ?? undefined,
  publicMediaPrefix: '/sessions',
  // Fires when a run actually finishes, which is the only point where the token
  // totals include every stage (the director runs after approval).
  onSessionComplete: (session, usage) => {
    telemetry?.record({
      userId: session.userId,
      event: 'pipeline.complete',
      target: session.input.githubUrl || session.input.recordUrl,
      targetKind: session.input.githubUrl ? 'repo' : session.input.recordUrl ? 'url' : undefined,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      llmCalls: usage.calls,
      durationMs: Date.parse(session.updatedAt) - Date.parse(session.createdAt),
      status: 'ok',
    });
  },
});

// Auth: accepts a Supabase session token (web) or a `pbx_live_…` API key (MCP).
const auth = requireUser();
// Key management must never be reachable with an API key — see requireUser.
const authJwtOnly = requireUser({ jwtOnly: true });


/** Client identification headers sent by the MCP server (untrusted; labels only). */
function clientInfo(req: Request): { client?: string; clientVersion?: string } {
  const client = req.headers['x-pitchbox-client'];
  const version = req.headers['x-pitchbox-client-version'];
  return {
    client: typeof client === 'string' ? client.slice(0, 64) : undefined,
    clientVersion: typeof version === 'string' ? version.slice(0, 32) : undefined,
  };
}

// Per-user daily cap. Since Phase 6 this guards ONLY Daytona-backed actions
// (sandbox recording + deploy) — the operator's remaining cost. Voiceover and
// LLM calls are billed to the user's own keys, so they are not capped.
const RUN_LIMIT_PER_DAY = Number.parseInt(process.env.RUN_LIMIT_PER_DAY ?? '5', 10) || 5;
// Ceiling across everyone. Signup is open, so the per-user cap above bounds one
// account, not the bill — N accounts get N times the allowance. This is the
// number that actually limits what the operator can be charged in a day.
const RUN_LIMIT_GLOBAL_PER_DAY = Number.parseInt(process.env.RUN_LIMIT_GLOBAL_PER_DAY ?? '50', 10) || 50;
const usageLimiter = supabaseAdmin
  ? new UsageLimiter(supabaseAdmin, RUN_LIMIT_PER_DAY, RUN_LIMIT_GLOBAL_PER_DAY)
  : null;

/**
 * Check + record one owner-cost run for the requesting user. Returns true if
 * the caller may proceed; on the daily cap it responds 429 and returns false.
 */
async function enforceLimit(req: AuthedRequest, res: Response, kind: string): Promise<boolean> {
  if (!usageLimiter || !req.user) return true; // unreachable behind `auth`, but fail-open here
  try {
    await usageLimiter.consume(req.user.id, kind);
    return true;
  } catch (e) {
    if (e instanceof GlobalUsageLimitError) {
      res.status(429).json({ error: e.message, code: 'GLOBAL_RATE_LIMITED', limit: e.limit, used: e.used });
      return false;
    }
    if (e instanceof UsageLimitError) {
      res.status(429).json({ error: e.message, code: 'RATE_LIMITED', limit: e.limit, used: e.used });
      return false;
    }
    console.error('usage check failed:', e);
    res.status(500).json({ error: 'Usage check failed.', code: 'USAGE_CHECK_FAILED' });
    return false;
  }
}

/**
 * Fetch a session only if the authenticated caller started it.
 *
 * Responds 404 (not 403) when the session exists but belongs to someone else:
 * a 403 would confirm the id is real, turning these routes into an existence
 * oracle. The caller gets the same answer either way.
 */
function getOwnedSession(req: Request, res: Response) {
  const authed = req as AuthedRequest;
  const session = sessionStore.get(req.params.id);
  if (!session || session.userId !== authed.user?.id) {
    // Deliberately the same answer whether it never existed or is not yours —
    // see above. The added sentence is true in both cases and leaks nothing,
    // and it names the cause people actually hit: sessions live in memory, so a
    // server restart takes them with it.
    res.status(404).json({
      error:
        'Session not found. Sessions are held in memory, so they are lost if the server restarts, ' +
        'and they expire after two hours. Start a new run.',
      code: 'SESSION_NOT_FOUND',
    });
    return null;
  }
  return session;
}

type DeployRequestBody = {
  githubUrl?: string;
  branch?: string;
  commitId?: string;
  workspaceDir?: string;
  skipSetup?: boolean;
};

type RecordRequestBody = {
  url?: string;
  githubUrl?: string;
  branch?: string;
  commitId?: string;
  workspaceDir?: string;
  skipSetup?: boolean;
  sandboxRecordDurationMs?: number;
  sandboxPort?: number;
  appStartCommand?: string;
  appBuildCommand?: string;
  /** Environment the repo needs to boot: object, or `.env`-style text. */
  appEnv?: Record<string, string> | string;
};

// Behind Caddy, so the client IP arrives in X-Forwarded-For. Without this every
// request looks like it came from the proxy and per-IP rate limits collapse into
// one shared bucket. `1` = trust exactly one hop (our own reverse proxy) — the
// value matters: `true` would let a client spoof its own IP via the header.
app.set('trust proxy', 1);

// Security headers. contentSecurityPolicy is off because this server only
// returns JSON and static media — it renders no HTML of its own, so a CSP here
// protects nothing while risking breakage of media playback.
app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.disable('x-powered-by');

// Blanket ceiling before anything else does work.
app.use(globalLimiter);

app.use(express.json({ limit: '2mb' }));
// CORS: in production set CORS_ORIGIN to your web origin(s), comma-separated;
// defaults to permissive for local dev.
const corsOrigins = process.env.CORS_ORIGIN?.split(',').map((s) => s.trim()).filter(Boolean);
app.use(cors(corsOrigins && corsOrigins.length ? { origin: corsOrigins } : undefined));
app.use('/test-audio', express.static(TEST_AUDIO_DIR));
app.use('/sessions', express.static(SESSIONS_DIR));

app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', message: 'Server is running' });
});

app.get('/api/hello', (_req: Request, res: Response) => {
  res.json({ message: 'Hello from the server!' });
});

app.post('/api/record', auth, sandboxLimiter, async (req: Request, res: Response) => {
  const {
    url,
    githubUrl,
    branch,
    commitId,
    workspaceDir,
    skipSetup,
    sandboxRecordDurationMs,
    sandboxPort,
    appStartCommand,
    appBuildCommand,
    appEnv,
  } = req.body as RecordRequestBody;

  // Validated before anything is spent. A rejected variable should cost the
  // caller a 400, not a ten-minute sandbox that fails at the end.
  let parsedAppEnv: Record<string, string>;
  try {
    parsedAppEnv = parseAppEnv(appEnv);
  } catch (error) {
    if (error instanceof AppEnvError) {
      res.status(400).json({ error: error.message, code: 'INVALID_APP_ENV' });
      return;
    }
    throw error;
  }

  const authed = req as AuthedRequest;
  telemetry?.record({
    userId: authed.user!.id,
    apiKeyId: authed.apiKeyId,
    event: 'record',
    surface: authed.authSurface,
    ...clientInfo(req),
    target: githubUrl || url,
    targetKind: githubUrl ? 'repo' : url ? 'url' : undefined,
  });

  if (githubUrl && typeof githubUrl === 'string') {
    // Only the repo path spends a Daytona sandbox, so only it is capped.
    // Recording a plain URL runs on this host with Puppeteer and costs nothing
    // metered.
    if (!(await enforceLimit(authed, res, 'record'))) return;
    if (!sandboxRecorder) {
      res.status(503).json({ error: 'Daytona is not configured (set DAYTONA_API_KEY).', code: 'DAYTONA_UNAVAILABLE' });
      return;
    }
    try {
      const sandboxResult = await sandboxRecorder.recordRepository({
        githubUrl,
        branch: typeof branch === 'string' && branch.trim().length > 0 ? branch.trim() : undefined,
        commitId: typeof commitId === 'string' && commitId.trim().length > 0 ? commitId.trim() : undefined,
        workspaceDir: typeof workspaceDir === 'string' && workspaceDir.trim().length > 0 ? workspaceDir : undefined,
        skipSetup: typeof skipSetup === 'boolean' ? skipSetup : undefined,
        recordDurationMs:
          typeof sandboxRecordDurationMs === 'number' && Number.isFinite(sandboxRecordDurationMs)
            ? sandboxRecordDurationMs
            : undefined,
        appPort: typeof sandboxPort === 'number' && Number.isInteger(sandboxPort) ? sandboxPort : undefined,
        appStartCommand:
          typeof appStartCommand === 'string' && appStartCommand.trim().length > 0
            ? appStartCommand.trim()
            : undefined,
        appBuildCommand:
          typeof appBuildCommand === 'string' && appBuildCommand.trim().length > 0
            ? appBuildCommand.trim()
            : undefined,
        appEnv: parsedAppEnv,
      });

      res.status(202).json({
        status: 'completed',
        recording: sandboxResult.recording,
        deployment: sandboxResult.deployment,
        previewUrl: sandboxResult.previewUrl,
      });
      return;
    } catch (error) {
      if (error instanceof DaytonaDeploymentError) {
        const statusCode = error.code === 'INVALID_GITHUB_URL' ? 400 : 502;
        res.status(statusCode).json({ error: error.message, code: error.code });
        return;
      }

      res.status(500).json({ error: 'Unexpected Daytona recording failure.' });
      return;
    }
  }

  if (!url || typeof url !== 'string') {
    res.status(400).json({ error: 'A `url` field is required in the request body.' });
    return;
  }

  // Same SSRF gate as the pipeline path — this route records a URL too.
  let safeUrl: string;
  try {
    safeUrl = await assertSafeUrl(url);
  } catch (e) {
    if (e instanceof BlockedUrlError) {
      res.status(400).json({ error: e.message, code: 'URL_NOT_ALLOWED' });
      return;
    }
    throw e;
  }

  try {
    const recording = await recorder.record(safeUrl);
    res.status(202).json({
      status: 'completed',
      recording,
    });
  } catch (error) {
    if (error instanceof RecorderError) {
      const statusCode = error.code === 'INVALID_URL' ? 400 : 500;
      res.status(statusCode).json({ error: error.message, code: error.code });
      return;
    }

    res.status(500).json({ error: 'Unexpected recording failure.' });
  }
});

app.post('/api/deploy', auth, sandboxLimiter, async (req: Request, res: Response) => {
  const { githubUrl, branch, commitId, workspaceDir, skipSetup } = req.body as DeployRequestBody;

  if (!githubUrl || typeof githubUrl !== 'string') {
    res
      .status(400)
      .json({ error: 'A `githubUrl` field is required in the request body.', code: 'INVALID_GITHUB_URL' });
    return;
  }
  if (!daytonaDeployer) {
    res.status(503).json({ error: 'Daytona is not configured (set DAYTONA_API_KEY).', code: 'DAYTONA_UNAVAILABLE' });
    return;
  }

  // Deploy always spends a Daytona sandbox — the operator's cost, so capped.
  if (!(await enforceLimit(req as AuthedRequest, res, 'deploy'))) return;

  const authedDeploy = req as AuthedRequest;
  telemetry?.record({
    userId: authedDeploy.user!.id,
    apiKeyId: authedDeploy.apiKeyId,
    event: 'deploy',
    surface: authedDeploy.authSurface,
    ...clientInfo(req),
    target: githubUrl,
    targetKind: 'repo',
  });

  try {
    const deployment = await daytonaDeployer.deployFromGithub({
      githubUrl,
      branch: typeof branch === 'string' && branch.trim().length > 0 ? branch.trim() : undefined,
      commitId: typeof commitId === 'string' && commitId.trim().length > 0 ? commitId.trim() : undefined,
      workspaceDir: typeof workspaceDir === 'string' && workspaceDir.trim().length > 0 ? workspaceDir : undefined,
      skipSetup: typeof skipSetup === 'boolean' ? skipSetup : undefined,
    });

    res.status(202).json({
      status: 'started',
      deployment,
    });
  } catch (error) {
    if (error instanceof DaytonaDeploymentError) {
      const statusCode = error.code === 'INVALID_GITHUB_URL' ? 400 : 502;
      res.status(statusCode).json({ error: error.message, code: error.code });
      return;
    }

    res.status(500).json({ error: 'Unexpected Daytona deployment failure.' });
  }
});

// --- Test endpoint --------------------------------------------------------
//   POST /api/test/audio  → ElevenLabs TTS for arbitrary text (stateless).

type TestAudioRequest = {
  text?: string;
  voiceId?: string;
  /** Bring-your-own ElevenLabs key. Used for this request only, never stored. */
  elevenLabsApiKey?: string;
};

app.post('/api/test/audio', auth, async (req: Request, res: Response) => {
  // No daily cap here: the voiceover is billed to the caller's own ElevenLabs
  // key, so it costs the operator nothing.
  const { text, voiceId, elevenLabsApiKey } = req.body as TestAudioRequest;

  // Bring-your-own key wins; the server generator exists only when a
  // self-hoster set PITCHBOX_ALLOW_SERVER_KEYS.
  const generator =
    typeof elevenLabsApiKey === 'string' && elevenLabsApiKey.trim()
      ? new AudioGenerator(elevenLabsApiKey.trim())
      : audioGenerator;

  if (!generator) {
    res.status(400).json({
      error: 'No ElevenLabs key. Send `elevenLabsApiKey` with this request (get one at https://elevenlabs.io).',
      code: 'ELEVENLABS_KEY_REQUIRED',
    });
    return;
  }

  if (!text || typeof text !== 'string' || !text.trim()) {
    res.status(400).json({ error: 'A `text` field is required.' });
    return;
  }

  const authed = req as AuthedRequest;
  telemetry?.record({
    userId: authed.user!.id,
    apiKeyId: authed.apiKeyId,
    event: 'test-audio',
    surface: authed.authSurface,
    ...clientInfo(req),
    byoAudio: !!elevenLabsApiKey,
  });

  try {
    const result = await generator.generate(text.trim(), {
      voiceId: typeof voiceId === 'string' && voiceId.trim().length > 0 ? voiceId.trim() : undefined,
      outputDir: TEST_AUDIO_DIR,
    });
    res.json({
      status: 'ok',
      audio: {
        url: `/test-audio/${result.fileName}`,
        fileName: result.fileName,
        bytes: result.bytes,
        voiceId: result.voiceId,
        modelId: result.modelId,
        durationEstimateMs: result.durationEstimateMs,
      },
    });
  } catch (error) {
    if (error instanceof AudioGeneratorError) {
      res.status(500).json({ error: error.message, code: 'AUDIO_FAILED' });
      return;
    }
    console.error('Unexpected /api/test/audio error:', error);
    res.status(500).json({ error: 'Unexpected audio-generation failure.' });
  }
});

// --- Phase B pipeline endpoints ------------------------------------------
// All endpoints assume a single Express process and an in-memory SessionStore.
// Sessions live ~2 hours by default and are evicted by SessionStore's sweeper.

app.post('/api/pipeline/start', auth, startPipelineLimiter, async (req: Request, res: Response) => {
  const {
    githubUrl,
    branch,
    recordUrl,
    appStartCommand,
    appBuildCommand,
    sandboxPort,
    appEnv,
    userPrompt,
    targetDurationSec,
    selectedStages,
    skipRecording,
    llm,
    elevenLabsApiKey,
  } = (req.body ?? {}) as {
    githubUrl?: string;
    branch?: string;
    recordUrl?: string;
    appStartCommand?: string;
    appBuildCommand?: string;
    sandboxPort?: number;
    appEnv?: Record<string, string> | string;
    userPrompt?: string;
    targetDurationSec?: number;
    selectedStages?: string[];
    skipRecording?: boolean;
    llm?: { provider?: string; apiKey?: string; model?: string };
    elevenLabsApiKey?: string;
  };

  // Same as /api/record: fail the request, not the run, on a bad variable.
  let parsedAppEnv: Record<string, string>;
  try {
    parsedAppEnv = parseAppEnv(appEnv);
  } catch (error) {
    if (error instanceof AppEnvError) {
      res.status(400).json({ error: error.message, code: 'INVALID_APP_ENV' });
      return;
    }
    throw error;
  }

  if (!userPrompt || typeof userPrompt !== 'string' || !userPrompt.trim()) {
    res.status(400).json({ error: 'A `userPrompt` field is required.' });
    return;
  }

  // Bring-your-own LLM, if a complete config is supplied; else the server default.
  const llmConfig: LlmConfig | undefined =
    llm && llm.provider && llm.apiKey && llm.model
      ? { provider: llm.provider, apiKey: llm.apiKey, model: llm.model }
      : undefined;

  const audioKey =
    typeof elevenLabsApiKey === 'string' && elevenLabsApiKey.trim() ? elevenLabsApiKey.trim() : undefined;

  // SSRF gate. The recorder points a real browser at this URL and returns the
  // frames as a video, so an internal address here is directly viewable by the
  // requester. Checked before the session exists so nothing is spent on a
  // request that was never going to be allowed.
  let safeRecordUrl: string | undefined;
  if (typeof recordUrl === 'string' && recordUrl.trim()) {
    try {
      safeRecordUrl = await assertSafeUrl(recordUrl.trim());
    } catch (e) {
      if (e instanceof BlockedUrlError) {
        res.status(400).json({ error: e.message, code: 'URL_NOT_ALLOWED' });
        return;
      }
      throw e;
    }
  }

  try {
    const session = orchestrator.start({
      userId: (req as AuthedRequest).user!.id,
      githubUrl: typeof githubUrl === 'string' && githubUrl.trim() ? githubUrl.trim() : undefined,
      branch: typeof branch === 'string' && branch.trim() ? branch.trim() : undefined,
      recordUrl: safeRecordUrl,
      appStartCommand: typeof appStartCommand === 'string' && appStartCommand.trim() ? appStartCommand.trim() : undefined,
      appBuildCommand: typeof appBuildCommand === 'string' && appBuildCommand.trim() ? appBuildCommand.trim() : undefined,
      sandboxPort: typeof sandboxPort === 'number' && Number.isInteger(sandboxPort) ? sandboxPort : undefined,
      appEnv: parsedAppEnv,
      userPrompt: userPrompt.trim(),
      targetDurationSec:
        typeof targetDurationSec === 'number' && Number.isFinite(targetDurationSec) ? targetDurationSec : undefined,
      selectedStages: Array.isArray(selectedStages) ? (selectedStages as StageId[]) : undefined,
      skipRecording: skipRecording === true,
      llm: llmConfig,
      elevenLabsApiKey: audioKey,
    });

    if (Object.keys(parsedAppEnv).length) {
      console.log(`[pipeline ${session.id}] app environment: ${describeAppEnv(parsedAppEnv)}`);
    }

    // Heartbeat: what was built, on what, with which provider — no prompt text,
    // and the target only as a hash (see TelemetryRecorder).
    const authed = req as AuthedRequest;
    const target = githubUrl?.trim() || recordUrl?.trim();
    telemetry?.record({
      userId: authed.user!.id,
      apiKeyId: authed.apiKeyId,
      event: 'pipeline.start',
      surface: authed.authSurface,
      ...clientInfo(req),
      provider: llmConfig?.provider ?? defaultLlm?.provider,
      model: llmConfig?.model ?? defaultLlm?.model,
      byoLlm: !!llmConfig,
      byoAudio: !!audioKey,
      target,
      targetKind: githubUrl?.trim() ? 'repo' : recordUrl?.trim() ? 'url' : undefined,
      stages: Array.isArray(selectedStages) ? selectedStages : undefined,
      skipRecording: skipRecording === true,
      status: 'ok',
    });

    res.status(202).json({ sessionId: session.id, status: session.status });
  } catch (e) {
    if (e instanceof SessionCapacityError) {
      res.status(503).json({ error: e.message, code: 'AT_CAPACITY' });
      return;
    }
    const message = e instanceof Error ? e.message : String(e);
    const authed = req as AuthedRequest;
    telemetry?.record({
      userId: authed.user!.id,
      apiKeyId: authed.apiKeyId,
      event: 'pipeline.error',
      surface: authed.authSurface,
      ...clientInfo(req),
      status: 'error',
      errorCode: 'START_REJECTED',
    });
    res.status(400).json({ error: message, code: 'LLM_CONFIG_INVALID' });
  }
});

app.get('/api/pipeline/stages', (_req: Request, res: Response) => {
  res.json({ stages: STAGE_DEFS });
});

// List available providers + their model options (for the BYO-key UI).
app.get('/api/providers', (_req: Request, res: Response) => {
  res.json({
    providers: PROVIDERS.map((p) => ({
      id: p.id,
      label: p.label,
      free: !!p.free,
      keysUrl: p.keysUrl,
      models: p.models,
    })),
    hasServerDefault: !!defaultLlm,
    // False on the hosted instance: users must bring an ElevenLabs key. The UI
    // uses this to decide whether the key field is required or optional.
    hasServerAudio: !!audioGenerator,
    // Whether repo (Daytona) recording is available at all on this instance.
    hasSandboxRecording: !!sandboxRecorder,
  });
});

// --- API keys (headless access) -------------------------------------------
// `authJwtOnly`: reachable only with a browser session. An API key must not be
// able to mint or revoke keys, or a single leaked key would be self-renewing.

app.get('/api/keys', authJwtOnly, async (req: Request, res: Response) => {
  if (!supabaseAdmin) {
    res.status(503).json({ error: 'Supabase is not configured.', code: 'AUTH_UNAVAILABLE' });
    return;
  }
  const authed = req as AuthedRequest;
  const { data, error } = await supabaseAdmin
    .from('api_keys')
    .select('id, name, prefix, created_at, last_used_at, revoked_at')
    .eq('user_id', authed.user!.id)
    .order('created_at', { ascending: false });

  if (error) {
    res.status(500).json({ error: 'Could not list keys.', code: 'KEY_LIST_FAILED' });
    return;
  }
  res.json({ keys: data ?? [] });
});

app.post('/api/keys', authJwtOnly, keyMintLimiter, async (req: Request, res: Response) => {
  if (!supabaseAdmin) {
    res.status(503).json({ error: 'Supabase is not configured.', code: 'AUTH_UNAVAILABLE' });
    return;
  }
  const { name } = (req.body ?? {}) as { name?: string };
  const authed = req as AuthedRequest;
  const minted = mintApiKey();

  const { data, error } = await supabaseAdmin
    .from('api_keys')
    .insert({
      user_id: authed.user!.id,
      name: typeof name === 'string' && name.trim() ? name.trim().slice(0, 64) : 'MCP key',
      key_hash: minted.hash,
      prefix: minted.prefix,
    })
    .select('id, name, prefix, created_at')
    .single();

  if (error || !data) {
    res.status(500).json({ error: 'Could not create key.', code: 'KEY_CREATE_FAILED' });
    return;
  }

  // The only time the plaintext ever leaves the server. It is not stored, so it
  // cannot be shown again — the UI must make that clear to the user.
  res.status(201).json({ ...data, key: minted.plaintext });
});

app.delete('/api/keys/:id', authJwtOnly, async (req: Request, res: Response) => {
  if (!supabaseAdmin) {
    res.status(503).json({ error: 'Supabase is not configured.', code: 'AUTH_UNAVAILABLE' });
    return;
  }
  const authed = req as AuthedRequest;
  // Revoked, not deleted: usage_events reference the key, and the history of
  // what a key did is worth more than the row it occupies.
  const { error } = await supabaseAdmin
    .from('api_keys')
    .update({ revoked_at: new Date().toISOString() })
    .eq('id', req.params.id)
    .eq('user_id', authed.user!.id); // scoping to the owner prevents revoking someone else's key

  if (error) {
    res.status(500).json({ error: 'Could not revoke key.', code: 'KEY_REVOKE_FAILED' });
    return;
  }
  res.json({ status: 'revoked' });
});

// Validate a key + model with a tiny live request, mapping errors to clear text.
app.post('/api/validate-key', validateKeyLimiter, async (req: Request, res: Response) => {
  const { provider, apiKey, model } = (req.body ?? {}) as { provider?: string; apiKey?: string; model?: string };
  if (!provider || !apiKey || !model) {
    res.status(400).json({ ok: false, message: '`provider`, `apiKey`, and `model` are all required.' });
    return;
  }
  const result = await validateLlmKey({ provider, apiKey, model });
  res.status(result.ok ? 200 : 200).json(result);
});

app.get('/api/pipeline/:id/status', auth, (req: Request, res: Response) => {
  const session = getOwnedSession(req, res);
  if (!session) return;
  res.json(redactSession(session));
});

app.post('/api/pipeline/:id/feedback', auth, async (req: Request, res: Response) => {
  if (!getOwnedSession(req, res)) return;
  const { feedback } = (req.body ?? {}) as { feedback?: string };
  if (!feedback || typeof feedback !== 'string' || !feedback.trim()) {
    res.status(400).json({ error: 'A `feedback` field is required.' });
    return;
  }
  try {
    const version = await orchestrator.iterateScript(req.params.id, feedback.trim());
    res.json({ status: 'ok', version });
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

app.post('/api/pipeline/:id/approve', auth, async (req: Request, res: Response) => {
  const { skipRecording } = (req.body ?? {}) as { skipRecording?: boolean };
  const existing = getOwnedSession(req, res);
  if (!existing) return;

  // Approve starts the media stage. Voiceover is billed to the caller's own
  // ElevenLabs key, so the only operator cost left is a Daytona sandbox — which
  // is used solely to record a GitHub repo. Cap that case and nothing else.
  const willUseSandbox = !!existing?.input.githubUrl && skipRecording !== true;
  if (willUseSandbox && !(await enforceLimit(req as AuthedRequest, res, 'approve'))) return;

  try {
    const session = orchestrator.approve(req.params.id, { skipRecording: skipRecording === true });
    const authed = req as AuthedRequest;
    telemetry?.record({
      userId: authed.user!.id,
      apiKeyId: authed.apiKeyId,
      event: 'pipeline.approve',
      surface: authed.authSurface,
      ...clientInfo(req),
      target: existing?.input.githubUrl || existing?.input.recordUrl,
      targetKind: existing?.input.githubUrl ? 'repo' : existing?.input.recordUrl ? 'url' : undefined,
      skipRecording: skipRecording === true,
      status: 'ok',
    });
    res.status(202).json(redactSession(session));
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

app.get('/api/pipeline/:id/result', auth, (req: Request, res: Response) => {
  const session = getOwnedSession(req, res);
  if (!session) return;
  if (session.status !== 'READY') {
    res.status(409).json({ status: session.status, error: 'Result not ready yet' });
    return;
  }
  res.json({
    status: 'ready',
    finalVideo: session.finalVideo,
    audio: session.audio,
    video: session.video,
  });
});

/**
 * The walkthrough review gate.
 *
 * `PATCH`-like semantics on one route: a body with `feedback` asks the planner to
 * revise, a body with `text` records the caller's own wording verbatim. Both
 * append a version rather than overwriting, so approving is always approving
 * something specific.
 */
app.post('/api/pipeline/:id/flow', auth, async (req: Request, res: Response) => {
  const session = sessionStore.get(req.params.id);
  if (!session) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  if (session.userId !== (req as AuthedRequest).user!.id) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }

  const { feedback, text } = (req.body ?? {}) as { feedback?: string; text?: string };
  try {
    if (typeof text === 'string' && text.trim()) {
      const version = orchestrator.editFlowPlan(req.params.id, text.trim());
      res.json({ version, session: sessionStore.get(req.params.id) });
      return;
    }
    if (typeof feedback === 'string' && feedback.trim()) {
      const version = await orchestrator.iterateFlowPlan(req.params.id, feedback.trim());
      res.json({ version, session: sessionStore.get(req.params.id) });
      return;
    }
    res.status(400).json({ error: 'Provide `text` to save your own wording, or `feedback` to ask for changes.' });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

/** Approve the walkthrough and start recording, voiceover and fusion. */
app.post('/api/pipeline/:id/flow/approve', auth, async (req: Request, res: Response) => {
  const session = sessionStore.get(req.params.id);
  if (!session) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  if (session.userId !== (req as AuthedRequest).user!.id) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }

  const { skipRecording } = (req.body ?? {}) as { skipRecording?: boolean };
  // Same cost gate as approving a script: this is the point where a sandbox and
  // a voiceover actually get spent.
  const willUseSandbox = !!session.input.githubUrl && !session.input.recordUrl && skipRecording !== true;
  if (willUseSandbox && !(await enforceLimit(req as AuthedRequest, res, 'approve'))) return;

  try {
    const updated = orchestrator.approveFlowPlan(req.params.id, { skipRecording: skipRecording === true });
    res.status(202).json({ session: updated });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post('/api/pipeline/:id/reiterate', auth, (req: Request, res: Response) => {
  if (!getOwnedSession(req, res)) return;
  try {
    const session = orchestrator.reiterate(req.params.id);
    res.json(redactSession(session));
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

function redactSession(session: ReturnType<SessionStore['get']>) {
  if (!session) return null;
  // Strip the private _repoSummary stash before sending to the client.
  const { ...rest } = session as any;
  delete rest._repoSummary;
  return rest;
}

app.listen(PORT, () => {
  console.log(`🚀 Server is running on http://localhost:${PORT}`);

  if (ALLOW_SERVER_KEYS) {
    console.log('🔓 PITCHBOX_ALLOW_SERVER_KEYS=true — server env keys are in use (self-host mode).');
    if (!process.env.ANTHROPIC_API_KEY) {
      console.warn('⚠️  ANTHROPIC_API_KEY not set. Runs must bring their own LLM key.');
    }
    if (!audioGenerator) {
      console.warn('⚠️  ELEVENLABS_API_KEY not set. Runs must bring their own voice key.');
    }
  } else {
    console.log('🔑 Bring-your-own-keys mode: every run supplies its own LLM + ElevenLabs key.');
    if (process.env.ANTHROPIC_API_KEY || process.env.ELEVENLABS_API_KEY) {
      console.warn('⚠️  Server LLM/voice keys are present but IGNORED (set PITCHBOX_ALLOW_SERVER_KEYS=true to use them).');
    }
  }

  if (!sandboxRecorder) {
    console.warn('⚠️  DAYTONA_API_KEY not set. Recording a GitHub repo will be unavailable.');
  }
  if (!isSupabaseConfigured) {
    console.warn('⚠️  Supabase not configured (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY). Protected routes will return 503.');
  } else {
    console.log(
      `🔐 Auth on (session or API key). Daytona cap: ${RUN_LIMIT_PER_DAY}/user/day, ${RUN_LIMIT_GLOBAL_PER_DAY}/day across all users.`,
    );
  }
});

