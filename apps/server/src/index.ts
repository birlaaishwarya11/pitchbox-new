import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import express, { type Express, type Request, type Response } from 'express';
import cors from 'cors';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Load the repo-root .env first (shared keys), then apps/server/.env so
// server-scoped values win if the same key is defined in both.
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });
dotenv.config({ path: path.resolve(__dirname, '../.env'), override: true });

import { DaytonaDeployer, DaytonaDeploymentError } from './DaytonaDeployer';
import { SandboxRecorder } from './SandboxRecorder';
import { Recorder, RecorderError } from './Recorder';
import { RepositoryCloner, RepositoryClonerError } from './RepositoryCloner';
import { CodebaseAnalyzer } from './CodebaseAnalyzer';
import { FlowExtractor } from './FlowExtractor';
import { AudioGenerator, AudioGeneratorError } from './AudioGenerator';
import { Planner } from './Planner';
import { Researcher } from './Researcher';
import { Scripter } from './Scripter';
import { Fuser } from './Fuser';
import { SlateRenderer } from './SlateRenderer';
import { SessionStore } from './SessionStore';
import { PipelineOrchestrator } from './PipelineOrchestrator';
import { STAGE_DEFS, type StageId } from './pipelineStages';

const app: Express = express();
const PORT = process.env.PORT || 3001;
const recorder = new Recorder();
const repositoryCloner = new RepositoryCloner();
const codebaseAnalyzer = new CodebaseAnalyzer();
const flowExtractor = new FlowExtractor();
const audioGenerator = process.env.ELEVENLABS_API_KEY && !process.env.ELEVENLABS_API_KEY.includes('ADD YOUR')
  ? new AudioGenerator(process.env.ELEVENLABS_API_KEY)
  : null;

const TEST_AUDIO_DIR = path.resolve(__dirname, '../../../recordings/test-audio');
const SESSIONS_DIR = path.resolve(__dirname, '../../../recordings/sessions');

const sessionStore = new SessionStore(SESSIONS_DIR);
sessionStore.start();

const orchestrator = process.env.ANTHROPIC_API_KEY && audioGenerator
  ? new PipelineOrchestrator({
      store: sessionStore,
      planner: new Planner(process.env.ANTHROPIC_API_KEY),
      researcher: new Researcher(process.env.ANTHROPIC_API_KEY),
      scripter: new Scripter(process.env.ANTHROPIC_API_KEY),
      audioGenerator,
      fuser: new Fuser(),
      slateRenderer: new SlateRenderer(),
      repositoryCloner,
      codebaseAnalyzer,
      flowExtractor,
      // Records a deployed/public URL directly (no Daytona required).
      urlRecorder: recorder,
      // sandboxRecorder is wired lazily via getSandboxRecorder() to avoid
      // requiring DAYTONA_API_KEY at boot. We pass undefined here and the
      // orchestrator will fall back to the slate path when undefined.
      sandboxRecorder: undefined,
      publicMediaPrefix: '/sessions',
    })
  : null;

// Lazy-initialize Daytona services so the server can boot without credentials
let daytonaDeployer: DaytonaDeployer | null = null;
let sandboxRecorder: SandboxRecorder | null = null;

function getDaytonaDeployer(): DaytonaDeployer {
  if (!daytonaDeployer) {
    daytonaDeployer = new DaytonaDeployer(undefined, {
      defaultWorkspaceDir: process.env.DAYTONA_WORKSPACE_DIR,
    });
    sandboxRecorder = new SandboxRecorder(daytonaDeployer);
  }
  return daytonaDeployer;
}

function getSandboxRecorder(): SandboxRecorder {
  getDaytonaDeployer();
  return sandboxRecorder!;
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
app.use(cors());
app.use('/test-audio', express.static(TEST_AUDIO_DIR));
app.use('/sessions', express.static(SESSIONS_DIR));

app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', message: 'Server is running' });
});

app.get('/api/hello', (_req: Request, res: Response) => {
  res.json({ message: 'Hello from the server!' });
});

app.post('/api/record', async (req: Request, res: Response) => {
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

  if (githubUrl && typeof githubUrl === 'string') {
    try {
      const sandboxResult = await getSandboxRecorder().recordRepository({
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

app.post('/api/deploy', async (req: Request, res: Response) => {
  const { githubUrl, branch, commitId, workspaceDir, skipSetup } = req.body as DeployRequestBody;

  if (!githubUrl || typeof githubUrl !== 'string') {
    res
      .status(400)
      .json({ error: 'A `githubUrl` field is required in the request body.', code: 'INVALID_GITHUB_URL' });
    return;
  }

  try {
    const deployment = await getDaytonaDeployer().deployFromGithub({
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

app.post('/api/test/audio', async (req: Request, res: Response) => {
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

app.post('/api/pipeline/start', (req: Request, res: Response) => {
  if (!orchestrator) {
    res.status(503).json({
      error: 'Pipeline unavailable. Configure ANTHROPIC_API_KEY and ELEVENLABS_API_KEY in .env.',
      code: 'PIPELINE_UNAVAILABLE',
    });
    return;
  }
  const { githubUrl, branch, recordUrl, userPrompt, targetDurationSec, selectedStages, skipRecording } =
    (req.body ?? {}) as {
      githubUrl?: string;
      branch?: string;
      recordUrl?: string;
      userPrompt?: string;
      targetDurationSec?: number;
      selectedStages?: string[];
      skipRecording?: boolean;
    };

  if (!userPrompt || typeof userPrompt !== 'string' || !userPrompt.trim()) {
    res.status(400).json({ error: 'A `userPrompt` field is required.' });
    return;
  }

  const session = orchestrator.start({
    githubUrl: typeof githubUrl === 'string' && githubUrl.trim() ? githubUrl.trim() : undefined,
    branch: typeof branch === 'string' && branch.trim() ? branch.trim() : undefined,
    recordUrl: typeof recordUrl === 'string' && recordUrl.trim() ? recordUrl.trim() : undefined,
    userPrompt: userPrompt.trim(),
    targetDurationSec:
      typeof targetDurationSec === 'number' && Number.isFinite(targetDurationSec) ? targetDurationSec : undefined,
    selectedStages: Array.isArray(selectedStages) ? (selectedStages as StageId[]) : undefined,
    skipRecording: skipRecording === true,
  });
  res.status(202).json({ sessionId: session.id, status: session.status });
});

app.get('/api/pipeline/stages', (_req: Request, res: Response) => {
  res.json({ stages: STAGE_DEFS });
});

app.get('/api/pipeline/:id/status', (req: Request, res: Response) => {
  const session = sessionStore.get(req.params.id);
  if (!session) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  res.json(redactSession(session));
});

app.post('/api/pipeline/:id/feedback', async (req: Request, res: Response) => {
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

app.post('/api/pipeline/:id/approve', (req: Request, res: Response) => {
  if (!orchestrator) {
    res.status(503).json({ error: 'Pipeline unavailable.', code: 'PIPELINE_UNAVAILABLE' });
    return;
  }
  const { skipRecording } = (req.body ?? {}) as { skipRecording?: boolean };
  try {
    const session = orchestrator.approve(req.params.id, { skipRecording: skipRecording === true });
    res.status(202).json(redactSession(session));
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

app.get('/api/pipeline/:id/result', (req: Request, res: Response) => {
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

app.post('/api/pipeline/:id/reiterate', (req: Request, res: Response) => {
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
    console.warn('⚠️  Full pipeline disabled — needs both ANTHROPIC_API_KEY and ELEVENLABS_API_KEY.');
  }
});

