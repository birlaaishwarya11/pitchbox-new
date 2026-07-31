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
import { requireUser, supabaseAdmin, isSupabaseConfigured, type AuthedRequest } from './auth/supabaseAuth';
import { UsageLimiter, UsageLimitError } from './usage/UsageLimiter';

const app: Express = express();
const PORT = process.env.PORT || 3001;
const recorder = new Recorder();
const repositoryCloner = new RepositoryCloner();
const codebaseAnalyzer = new CodebaseAnalyzer();
const flowExtractor = new FlowExtractor();
const audioGenerator = process.env.ELEVENLABS_API_KEY && !process.env.ELEVENLABS_API_KEY.includes('ADD YOUR')
  ? new AudioGenerator(process.env.ELEVENLABS_API_KEY)
  : null;

// Media output dir. Override with MEDIA_DIR in production to point at a mounted
// persistent volume so generated videos survive restarts/redeploys.
const MEDIA_DIR = process.env.MEDIA_DIR
  ? path.resolve(process.env.MEDIA_DIR)
  : path.resolve(__dirname, '../../../recordings');
const TEST_AUDIO_DIR = path.join(MEDIA_DIR, 'test-audio');
const SESSIONS_DIR = path.join(MEDIA_DIR, 'sessions');

const sessionStore = new SessionStore(SESSIONS_DIR);
sessionStore.start();

// Operator fallback LLM config: used when a request brings no key. Users can
// override per-run with their own provider + key + model (BYO).
const defaultLlm: LlmConfig | undefined = process.env.ANTHROPIC_API_KEY
  ? { provider: 'anthropic', apiKey: process.env.ANTHROPIC_API_KEY, model: 'claude-opus-4-8' }
  : undefined;

// Daytona sandbox — isolated execution for recording untrusted GitHub repos
// (building/running a stranger's code must never happen on the host). Created
// eagerly when DAYTONA_API_KEY is present; null otherwise.
const daytonaDeployer: DaytonaDeployer | null = process.env.DAYTONA_API_KEY
  ? new DaytonaDeployer(undefined, { defaultWorkspaceDir: process.env.DAYTONA_WORKSPACE_DIR })
  : null;
const sandboxRecorder: SandboxRecorder | null = daytonaDeployer ? new SandboxRecorder(daytonaDeployer) : null;

const orchestrator = audioGenerator
  ? new PipelineOrchestrator({
      store: sessionStore,
      defaultLlm,
      audioGenerator,
      fuser: new Fuser(),
      slateRenderer: new SlateRenderer(),
      repositoryCloner,
      codebaseAnalyzer,
      flowExtractor,
      // Records a deployed/public URL directly (no Daytona required).
      urlRecorder: recorder,
      // Records a GitHub repo by building + running it inside a Daytona sandbox.
      sandboxRecorder: sandboxRecorder ?? undefined,
      publicMediaPrefix: '/sessions',
    })
  : null;

// Auth: every protected route requires a valid Supabase access token.
const auth = requireUser();

// Per-user daily cap on owner-cost actions (voiceover + sandbox recording).
const RUN_LIMIT_PER_DAY = Number.parseInt(process.env.RUN_LIMIT_PER_DAY ?? '5', 10) || 5;
const usageLimiter = supabaseAdmin ? new UsageLimiter(supabaseAdmin, RUN_LIMIT_PER_DAY) : null;

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
    if (e instanceof UsageLimitError) {
      res.status(429).json({ error: e.message, code: 'RATE_LIMITED', limit: e.limit, used: e.used });
      return false;
    }
    console.error('usage check failed:', e);
    res.status(500).json({ error: 'Usage check failed.', code: 'USAGE_CHECK_FAILED' });
    return false;
  }
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
};

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

app.post('/api/record', auth, async (req: Request, res: Response) => {
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
  } = req.body as RecordRequestBody;

  if (!(await enforceLimit(req as AuthedRequest, res, 'record'))) return;

  if (githubUrl && typeof githubUrl === 'string') {
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

  try {
    const recording = await recorder.record(url);
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

app.post('/api/deploy', auth, async (req: Request, res: Response) => {
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

  if (!(await enforceLimit(req as AuthedRequest, res, 'deploy'))) return;

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
};

app.post('/api/test/audio', auth, async (req: Request, res: Response) => {
  if (!(await enforceLimit(req as AuthedRequest, res, 'test-audio'))) return;
  if (!audioGenerator) {
    res.status(503).json({
      error: 'ELEVENLABS_API_KEY is not configured. Add it to .env and restart the server.',
      code: 'ELEVENLABS_NOT_CONFIGURED',
    });
    return;
  }

  const { text, voiceId } = req.body as TestAudioRequest;
  if (!text || typeof text !== 'string' || !text.trim()) {
    res.status(400).json({ error: 'A `text` field is required.' });
    return;
  }

  try {
    const result = await audioGenerator.generate(text.trim(), {
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

app.post('/api/pipeline/start', auth, (req: Request, res: Response) => {
  if (!orchestrator) {
    res.status(503).json({
      error: 'Pipeline unavailable. ELEVENLABS_API_KEY must be set on the server; an LLM key can be brought per-request or set as ANTHROPIC_API_KEY.',
      code: 'PIPELINE_UNAVAILABLE',
    });
    return;
  }
  const {
    githubUrl,
    branch,
    recordUrl,
    appStartCommand,
    appBuildCommand,
    sandboxPort,
    userPrompt,
    targetDurationSec,
    selectedStages,
    skipRecording,
    llm,
  } = (req.body ?? {}) as {
    githubUrl?: string;
    branch?: string;
    recordUrl?: string;
    appStartCommand?: string;
    appBuildCommand?: string;
    sandboxPort?: number;
    userPrompt?: string;
    targetDurationSec?: number;
    selectedStages?: string[];
    skipRecording?: boolean;
    llm?: { provider?: string; apiKey?: string; model?: string };
  };

  if (!userPrompt || typeof userPrompt !== 'string' || !userPrompt.trim()) {
    res.status(400).json({ error: 'A `userPrompt` field is required.' });
    return;
  }

  // Bring-your-own LLM, if a complete config is supplied; else the server default.
  const llmConfig: LlmConfig | undefined =
    llm && llm.provider && llm.apiKey && llm.model
      ? { provider: llm.provider, apiKey: llm.apiKey, model: llm.model }
      : undefined;

  try {
    const session = orchestrator.start({
      githubUrl: typeof githubUrl === 'string' && githubUrl.trim() ? githubUrl.trim() : undefined,
      branch: typeof branch === 'string' && branch.trim() ? branch.trim() : undefined,
      recordUrl: typeof recordUrl === 'string' && recordUrl.trim() ? recordUrl.trim() : undefined,
      appStartCommand: typeof appStartCommand === 'string' && appStartCommand.trim() ? appStartCommand.trim() : undefined,
      appBuildCommand: typeof appBuildCommand === 'string' && appBuildCommand.trim() ? appBuildCommand.trim() : undefined,
      sandboxPort: typeof sandboxPort === 'number' && Number.isInteger(sandboxPort) ? sandboxPort : undefined,
      userPrompt: userPrompt.trim(),
      targetDurationSec:
        typeof targetDurationSec === 'number' && Number.isFinite(targetDurationSec) ? targetDurationSec : undefined,
      selectedStages: Array.isArray(selectedStages) ? (selectedStages as StageId[]) : undefined,
      skipRecording: skipRecording === true,
      llm: llmConfig,
    });
    res.status(202).json({ sessionId: session.id, status: session.status });
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e), code: 'LLM_CONFIG_INVALID' });
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
  });
});

// Validate a key + model with a tiny live request, mapping errors to clear text.
app.post('/api/validate-key', async (req: Request, res: Response) => {
  const { provider, apiKey, model } = (req.body ?? {}) as { provider?: string; apiKey?: string; model?: string };
  if (!provider || !apiKey || !model) {
    res.status(400).json({ ok: false, message: '`provider`, `apiKey`, and `model` are all required.' });
    return;
  }
  const result = await validateLlmKey({ provider, apiKey, model });
  res.status(result.ok ? 200 : 200).json(result);
});

app.get('/api/pipeline/:id/status', auth, (req: Request, res: Response) => {
  const session = sessionStore.get(req.params.id);
  if (!session) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  res.json(redactSession(session));
});

app.post('/api/pipeline/:id/feedback', auth, async (req: Request, res: Response) => {
  if (!orchestrator) {
    res.status(503).json({ error: 'Pipeline unavailable.', code: 'PIPELINE_UNAVAILABLE' });
    return;
  }
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
  if (!orchestrator) {
    res.status(503).json({ error: 'Pipeline unavailable.', code: 'PIPELINE_UNAVAILABLE' });
    return;
  }
  // Approve kicks off the owner-cost media stage (voiceover + recording), so
  // this is where the per-user daily cap is enforced.
  if (!(await enforceLimit(req as AuthedRequest, res, 'approve'))) return;
  const { skipRecording } = (req.body ?? {}) as { skipRecording?: boolean };
  try {
    const session = orchestrator.approve(req.params.id, { skipRecording: skipRecording === true });
    res.status(202).json(redactSession(session));
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

app.get('/api/pipeline/:id/result', auth, (req: Request, res: Response) => {
  const session = sessionStore.get(req.params.id);
  if (!session) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
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

app.post('/api/pipeline/:id/reiterate', auth, (req: Request, res: Response) => {
  if (!orchestrator) {
    res.status(503).json({ error: 'Pipeline unavailable.', code: 'PIPELINE_UNAVAILABLE' });
    return;
  }
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
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn('⚠️  ANTHROPIC_API_KEY not configured. Script generation will be unavailable.');
  }
  if (!audioGenerator) {
    console.warn('⚠️  ELEVENLABS_API_KEY not configured. Audio generation will be unavailable.');
  }
  if (!orchestrator) {
    console.warn('⚠️  Full pipeline disabled — ELEVENLABS_API_KEY is required (LLM key can be brought per-request).');
  }
  if (!isSupabaseConfigured) {
    console.warn('⚠️  Supabase not configured (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY). Protected routes will return 503.');
  } else {
    console.log(`🔐 Auth on. Per-user cap: ${RUN_LIMIT_PER_DAY} owner-cost runs/day.`);
  }
});

