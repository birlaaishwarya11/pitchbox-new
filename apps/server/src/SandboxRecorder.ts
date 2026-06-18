import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';

import { type Sandbox } from '@daytonaio/sdk';

import {
  DaytonaDeploymentError,
  DaytonaDeployer,
  type DeployFromGithubInput,
  type DeploymentResult,
} from './DaytonaDeployer';
import { type RecordingResult } from './Recorder';
import { getRemoteRecorderBundle } from './remoteRecorderBundle';

export interface SandboxRecordingRequest extends DeployFromGithubInput {
  appPort?: number;
  recordDurationMs?: number;
  appStartCommand?: string;
  appBuildCommand?: string;
}

export interface SandboxRecordingResult {
  deployment: DeploymentResult;
  recording: RecordingResult;
  previewUrl: string;
}

const DEFAULT_APP_PORT = 4300;
const DEFAULT_RECORDING_DURATION_MS = 5_000;
const PID_FILE = '/tmp/pitchbox-app.pid';
const RECORDER_RUNTIME_DIR = '/tmp/pitchbox-recorder-runtime';
const RECORDER_SCRIPT_NAME = 'recorder.mjs';
const RECORDER_LOG_FILE = '/tmp/pitchbox-recorder.log';
const RECORDINGS_DIR = path.resolve(process.cwd(), 'recordings');

export class SandboxRecorder {
  constructor(private readonly deployer: DaytonaDeployer) {}

  async recordRepository(request: SandboxRecordingRequest): Promise<SandboxRecordingResult> {
    const deployment = await this.deployer.deployFromGithub(request);
    const sandbox = await this.deployer.getSandboxById(deployment.sandboxId);
    const repoPath = deployment.repoPath;
    const appPort = request.appPort ?? DEFAULT_APP_PORT;

    await this.buildAppInSandbox(sandbox, repoPath, request.appBuildCommand);
    await this.startAppInSandbox(sandbox, repoPath, appPort, request.appStartCommand);

    try {
      await this.waitForLocalHttp(sandbox, appPort);
      const preview = await sandbox.getPreviewLink(appPort);
      const remoteRecording = await this.captureRecordingInSandbox(
        sandbox,
        preview.url,
        request.recordDurationMs ?? DEFAULT_RECORDING_DURATION_MS,
      );
      const recording = await this.persistSandboxRecording(sandbox, remoteRecording);

      return {
        deployment,
        recording,
        previewUrl: preview.url,
      };
    } finally {
      await this.stopAppInSandbox(sandbox);
    }
  }

  private async buildAppInSandbox(sandbox: Sandbox, repoPath: string, appBuildCommand?: string): Promise<void> {
    const command = appBuildCommand ?? 'npm run build:web';
    const trimmed = command.trim();

    if (!trimmed) {
      return;
    }

    const buildScript = ['bash -lc', `'set -euo pipefail; ${trimmed}'`].join(' ');

    try {
      await sandbox.process.executeCommand(buildScript, repoPath, undefined, 600);
    } catch (error) {
      throw new DaytonaDeploymentError(
        'SANDBOX_SETUP_FAILED',
        'Failed to build app inside Daytona sandbox.',
        error,
      );
    }
  }

  private async startAppInSandbox(
    sandbox: Sandbox,
    repoPath: string,
    port: number,
    appStartCommand?: string,
  ): Promise<void> {
    const command = appStartCommand ?? 'npm run dev:web';
    const envPrefix = `PORT=${port} VITE_PORT=${port} HOST=0.0.0.0`;
    const startScript = [
      'bash -lc',
      `'set -euo pipefail; ${envPrefix} ${command} >/tmp/pitchbox-app.log 2>&1 & echo $! > ${PID_FILE}'`,
    ].join(' ');

    try {
      await sandbox.process.executeCommand(startScript, repoPath, { PORT: `${port}` }, 120);
    } catch (error) {
      throw new DaytonaDeploymentError('SANDBOX_SETUP_FAILED', 'Failed to start app inside Daytona sandbox.', error);
    }
  }

  private async waitForLocalHttp(sandbox: Sandbox, port: number): Promise<void> {
    const waitScript = [
      'bash -lc',
      `'set -euo pipefail; for attempt in {1..60}; do if curl -fsS http://127.0.0.1:${port} >/dev/null 2>&1; then exit 0; fi; sleep 2; done; exit 1'`,
    ].join(' ');

    try {
      await sandbox.process.executeCommand(waitScript, undefined, undefined, 180);
    } catch (error) {
      throw new DaytonaDeploymentError('SANDBOX_SETUP_FAILED', 'App did not become ready inside Daytona sandbox.', error);
    }
  }

  private async stopAppInSandbox(sandbox: Sandbox): Promise<void> {
    const stopScript = [
      'bash -lc',
      `'(test -f ${PID_FILE} && kill "$(cat ${PID_FILE})" && rm -f ${PID_FILE}) || true'`,
    ].join(' ');

    try {
      await sandbox.process.executeCommand(stopScript, undefined, undefined, 30);
    } catch (error) {
      console.warn('Failed to stop sandbox app process', error);
    }
  }

  private async captureRecordingInSandbox(
    sandbox: Sandbox,
    previewUrl: string,
    recordDurationMs: number,
  ): Promise<RecordingResult> {
    const duration = Math.max(1_000, recordDurationMs);
    await this.prepareRecorderRuntime(sandbox);

    const execution = await sandbox.process.executeCommand(
      `node ${RECORDER_SCRIPT_NAME}`,
      RECORDER_RUNTIME_DIR,
      {
        RECORDER_ENABLE_XVFB: 'true',
        RECORDER_TARGET_URL: previewUrl,
        RECORDER_DURATION_MS: `${duration}`,
        RECORDER_LOG_PATH: RECORDER_LOG_FILE,
      },
      600,
    );

    const stdout = execution.artifacts?.stdout ?? execution.result ?? '';

    try {
      return this.reviveRecording(JSON.parse(stdout));
    } catch (error) {
      throw new DaytonaDeploymentError('SANDBOX_SETUP_FAILED', 'Failed to parse sandbox recording output.', error);
    }
  }

  private reviveRecording(payload: RecordingResult): RecordingResult {
    return {
      ...payload,
      startedAt: new Date(payload.startedAt),
      endedAt: new Date(payload.endedAt),
    };
  }

  private async persistSandboxRecording(
    sandbox: Sandbox,
    remoteRecording: RecordingResult,
  ): Promise<RecordingResult> {
    const remotePath = remoteRecording.localPath;
    const buffer = await sandbox.fs.downloadFile(remotePath);
    const localPath = await this.writeRecordingFile(remoteRecording.sessionId, buffer);

    await sandbox.fs.deleteFile(remotePath, false).catch(() => undefined);

    return {
      ...remoteRecording,
      localPath,
      storage: {
        type: 'local',
        uri: localPath,
        metadata: remoteRecording.storage?.metadata,
      },
    };
  }

  private async writeRecordingFile(sessionId: string, buffer: Buffer): Promise<string> {
    const sessionDir = path.join(RECORDINGS_DIR, sessionId);
    await mkdir(sessionDir, { recursive: true });
    const destination = path.join(sessionDir, `${sessionId}.mp4`);
    await writeFile(destination, buffer);
    return destination;
  }

  private async prepareRecorderRuntime(sandbox: Sandbox): Promise<void> {
    await sandbox.process.executeCommand(`mkdir -p ${RECORDER_RUNTIME_DIR}`, undefined, undefined, 30);
    await this.installRecorderDependencies(sandbox);
    await this.uploadRecorderScript(sandbox);
  }

  private async installRecorderDependencies(sandbox: Sandbox): Promise<void> {
    const installScript = [
      'bash -lc',
      `'cd ${RECORDER_RUNTIME_DIR} && set -euo pipefail; ` +
        'if [ ! -f package.json ]; then npm init -y >/dev/null 2>&1; fi; ' +
        'npm install --silent puppeteer xvfb' +
        "'",
    ].join(' ');

    await sandbox.process.executeCommand(installScript, undefined, undefined, 600);
  }

  private async uploadRecorderScript(sandbox: Sandbox): Promise<void> {
    const bundle = await getRemoteRecorderBundle();
    const remotePath = path.posix.join(RECORDER_RUNTIME_DIR, RECORDER_SCRIPT_NAME);
    await sandbox.fs.uploadFile(Buffer.from(bundle, 'utf-8'), remotePath);
  }
}

