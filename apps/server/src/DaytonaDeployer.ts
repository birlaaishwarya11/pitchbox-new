import path from 'node:path';

import { Daytona, type DaytonaConfig, type Sandbox } from '@daytonaio/sdk';

export type DaytonaDeploymentErrorCode =
  | 'INVALID_GITHUB_URL'
  | 'DAYTONA_CREATE_FAILED'
  | 'SANDBOX_START_FAILED'
  | 'GIT_CLONE_FAILED'
  | 'SANDBOX_SETUP_FAILED';

export interface DeployFromGithubInput {
  githubUrl: string;
  branch?: string;
  commitId?: string;
  workspaceDir?: string;
  skipSetup?: boolean;
}

export interface DeploymentResult {
  sandboxId: string;
  sandboxName: string;
  target: string;
  state?: string;
  githubUrl: string;
  branch?: string;
  commitId?: string;
  repoPath: string;
  repoOwner: string;
  repoName: string;
  labels?: Record<string, string>;
  createdAt?: string;
  setupResults?: SetupCommandResult[];
}

export interface DaytonaDeploymentOptions {
  defaultWorkspaceDir?: string;
  createTimeoutSec?: number;
  startTimeoutSec?: number;
  autoSetup?: boolean;
  setupCommandsFactory?: SetupCommandFactory;
}

const DEFAULT_WORKSPACE_DIR = 'workspace';
const DEFAULT_CREATE_TIMEOUT_SEC = 180;
const DEFAULT_START_TIMEOUT_SEC = 180;

export class DaytonaDeploymentError extends Error {
  public readonly code: DaytonaDeploymentErrorCode;

  public readonly cause?: unknown;

  constructor(code: DaytonaDeploymentErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = 'DaytonaDeploymentError';
    this.code = code;
    if (cause !== undefined) {
      this.cause = cause;
    }
  }
}

interface RepoInfo {
  owner: string;
  name: string;
}

interface DaytonaDeploymentRuntimeOptions {
  defaultWorkspaceDir: string;
  createTimeoutSec: number;
  startTimeoutSec: number;
  autoSetup: boolean;
  setupCommandsFactory: SetupCommandFactory;
}

export interface SetupCommandContext {
  repoPath: string;
}

export interface SetupCommand {
  id: string;
  description: string;
  command: string;
  cwd?: string;
  env?: Record<string, string>;
  timeoutSec?: number;
}

export interface SetupCommandResult extends SetupCommand {
  exitCode: number;
  output: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
}

export type SetupCommandFactory = (context: SetupCommandContext) => SetupCommand[];

const DEFAULT_SETUP_COMMANDS_FACTORY: SetupCommandFactory = ({ repoPath }) => [
  {
    id: 'apt-update',
    description: 'Update apt package index',
    command: 'sudo apt-get update',
    timeoutSec: 300,
  },
  {
    id: 'apt-install-system',
    description: 'Install Xvfb, ffmpeg, and curl',
    command: 'sudo DEBIAN_FRONTEND=noninteractive apt-get install -y xvfb ffmpeg curl',
    timeoutSec: 300,
  },
  {
    id: 'npm-install',
    description: 'Install workspace dependencies',
    command: 'npm install',
    cwd: repoPath,
    timeoutSec: 900,
    env: {
      HUSKY: '0',
    },
  },
];

export class DaytonaDeployer {
  private readonly daytona: Daytona;

  private readonly runtimeOptions: DaytonaDeploymentRuntimeOptions;

  constructor(config?: DaytonaConfig, options?: DaytonaDeploymentOptions) {
    this.daytona = new Daytona(config);
    this.runtimeOptions = {
      defaultWorkspaceDir: options?.defaultWorkspaceDir ?? DEFAULT_WORKSPACE_DIR,
      createTimeoutSec: options?.createTimeoutSec ?? DEFAULT_CREATE_TIMEOUT_SEC,
      startTimeoutSec: options?.startTimeoutSec ?? DEFAULT_START_TIMEOUT_SEC,
      autoSetup: options?.autoSetup ?? true,
      setupCommandsFactory: options?.setupCommandsFactory ?? DEFAULT_SETUP_COMMANDS_FACTORY,
    };
  }

  async deployFromGithub(input: DeployFromGithubInput): Promise<DeploymentResult> {
    const trimmedUrl = input.githubUrl?.trim();
    if (!trimmedUrl) {
      throw new DaytonaDeploymentError('INVALID_GITHUB_URL', 'A GitHub repository URL is required.');
    }

    const repoInfo = parseGithubUrl(trimmedUrl);
    const sandbox = await this.createSandbox();

    try {
      await sandbox.waitUntilStarted(this.runtimeOptions.startTimeoutSec);
    } catch (error) {
      throw new DaytonaDeploymentError('SANDBOX_START_FAILED', 'Failed to start Daytona sandbox.', error);
    }

    await this.applyRepoLabels(sandbox, repoInfo);

    const repoPath = this.buildRepoPath(repoInfo, input.workspaceDir);

    await this.ensureParentDirectories(sandbox, repoPath);

    try {
      await sandbox.git.clone(trimmedUrl, repoPath, input.branch, input.commitId);
    } catch (error) {
      throw new DaytonaDeploymentError('GIT_CLONE_FAILED', 'Failed to clone repository inside sandbox.', error);
    }

    const shouldRunSetup = this.runtimeOptions.autoSetup && !input.skipSetup;
    const setupResults = shouldRunSetup ? await this.runSetupCommands(sandbox, repoPath) : undefined;

    return {
      sandboxId: sandbox.id,
      sandboxName: sandbox.name,
      target: sandbox.target,
      state: sandbox.state,
      githubUrl: trimmedUrl,
      branch: input.branch,
      commitId: input.commitId,
      repoPath,
      repoOwner: repoInfo.owner,
      repoName: repoInfo.name,
      labels: sandbox.labels,
      createdAt: sandbox.createdAt,
      setupResults,
    };
  }

  private async createSandbox(): Promise<Sandbox> {
    try {
      return await this.daytona.create(undefined, {
        timeout: this.runtimeOptions.createTimeoutSec,
      });
    } catch (error) {
      throw new DaytonaDeploymentError('DAYTONA_CREATE_FAILED', 'Unable to create Daytona sandbox.', error);
    }
  }

  private buildRepoPath(repo: RepoInfo, workspaceOverride?: string): string {
    const workspaceSegments = this.sanitisePathSegments(
      workspaceOverride ?? this.runtimeOptions.defaultWorkspaceDir,
      DEFAULT_WORKSPACE_DIR,
    );

    const segments = [
      ...workspaceSegments,
      sanitiseSegment(repo.owner, 'owner'),
      sanitiseSegment(repo.name, 'repo'),
    ];

    return path.posix.join(...segments);
  }

  private sanitisePathSegments(pathValue: string, fallback: string): string[] {
    const rawValue = pathValue.trim() || fallback;
    const pieces = rawValue.split('/').filter(Boolean);
    if (pieces.length === 0) {
      return [fallback];
    }

    return pieces.map((piece, index) => sanitiseSegment(piece, index === 0 ? fallback : `seg${index}`));
  }

  private async ensureParentDirectories(sandbox: Sandbox, repoPath: string): Promise<void> {
    const pathWithoutTrailingSlash = repoPath.replace(/\/+$/u, '');
    const segments = pathWithoutTrailingSlash.split('/').filter(Boolean);

    if (segments.length <= 1) {
      return;
    }

    let partial = '';
    for (let index = 0; index < segments.length - 1; index += 1) {
      partial = partial ? `${partial}/${segments[index]}` : segments[index];
      await this.createFolderIfMissing(sandbox, partial);
    }
  }

  private async createFolderIfMissing(sandbox: Sandbox, folderPath: string): Promise<void> {
    try {
      await sandbox.fs.createFolder(folderPath, '755');
    } catch (error) {
      if (!isAlreadyExistsError(error)) {
        throw error;
      }
    }
  }

  private async applyRepoLabels(sandbox: Sandbox, repo: RepoInfo): Promise<void> {
    try {
      await sandbox.setLabels({
        ...(sandbox.labels ?? {}),
        'pitchbox.repoOwner': repo.owner,
        'pitchbox.repoName': repo.name,
      });
    } catch (error) {
      console.warn('Failed to set Daytona sandbox labels', error);
    }
  }

  private async runSetupCommands(sandbox: Sandbox, repoPath: string): Promise<SetupCommandResult[]> {
    const commands = this.runtimeOptions.setupCommandsFactory({ repoPath });
    if (!commands.length) {
      return [];
    }

    const results: SetupCommandResult[] = [];

    for (const command of commands) {
      const startedAt = new Date();
      let execution;

      try {
        execution = await sandbox.process.executeCommand(
          command.command,
          command.cwd ?? undefined,
          command.env,
          command.timeoutSec,
        );
      } catch (error) {
        throw new DaytonaDeploymentError(
          'SANDBOX_SETUP_FAILED',
          `Setup step "${command.description}" failed to execute.`,
          error,
        );
      }

      const endedAt = new Date();
      const output = execution.artifacts?.stdout ?? execution.result ?? '';
      const durationMs = endedAt.getTime() - startedAt.getTime();

      const result: SetupCommandResult = {
        ...command,
        exitCode: execution.exitCode ?? 0,
        output,
        startedAt: startedAt.toISOString(),
        endedAt: endedAt.toISOString(),
        durationMs,
      };

      results.push(result);

      if (result.exitCode !== 0) {
        throw new DaytonaDeploymentError(
          'SANDBOX_SETUP_FAILED',
          `Setup step "${command.description}" exited with code ${result.exitCode}.`,
          result,
        );
      }
    }

    return results;
  }

  async getSandboxById(sandboxId: string): Promise<Sandbox> {
    return this.daytona.get(sandboxId);
  }
}

function parseGithubUrl(url: string): RepoInfo {
  if (url.startsWith('git@')) {
    const match = /^git@github\.com:(?<owner>[^/]+)\/(?<repo>.+?)(?:\.git)?$/iu.exec(url);
    if (!match?.groups) {
      throw new DaytonaDeploymentError('INVALID_GITHUB_URL', 'GitHub SSH URL is malformed.');
    }

    return {
      owner: match.groups.owner,
      name: stripGitSuffix(match.groups.repo),
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new DaytonaDeploymentError('INVALID_GITHUB_URL', 'GitHub URL could not be parsed.');
  }

  const hostname = parsed.hostname.toLowerCase();
  if (hostname !== 'github.com' && hostname !== 'www.github.com') {
    throw new DaytonaDeploymentError('INVALID_GITHUB_URL', 'Only github.com URLs are supported.');
  }

  const segments = parsed.pathname.split('/').filter(Boolean);
  if (segments.length < 2) {
    throw new DaytonaDeploymentError('INVALID_GITHUB_URL', 'GitHub URL must include owner and repo.');
  }

  return {
    owner: segments[0],
    name: stripGitSuffix(segments[1]),
  };
}

function stripGitSuffix(value: string): string {
  return value.replace(/\.git$/iu, '');
}

function sanitiseSegment(value: string, fallback: string): string {
  const trimmed = value.trim();
  const sanitised = trimmed.replace(/[^a-zA-Z0-9._-]/gu, '-');
  return sanitised || fallback;
}

function isAlreadyExistsError(error: unknown): boolean {
  if (error instanceof Error) {
    return /exists/i.test(error.message);
  }
  return false;
}

