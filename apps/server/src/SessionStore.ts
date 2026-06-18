import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import path from 'node:path';

export type PipelineStatus =
  | 'CREATED'
  | 'PLANNING'
  | 'RESEARCHING'
  | 'SCRIPT_DRAFT'
  | 'GENERATING'
  | 'FUSING'
  | 'READY'
  | 'ERROR';

export interface PlanArtifact {
  audience: string;
  primaryGoal: string;
  toneAndStyle: string;
  targetDurationSec: number;
  mustCover: string[];
  avoid: string[];
  openingHook: string;
  closingMove: string;
  notes: string;
}

export interface ResearchArtifact {
  summary: string;
  dos: string[];
  donts: string[];
  examplesOrPatterns: string[];
  citations: { title: string; url: string }[];
}

export interface ScriptVersion {
  id: string;
  versionNumber: number;
  createdAt: string;
  fullScript: string;
  estimatedDurationSec: number;
  wordCount: number;
  feedbackUsed?: string;
  parentVersionId?: string;
}

export interface PipelineSession {
  id: string;
  createdAt: string;
  updatedAt: string;
  status: PipelineStatus;
  input: {
    githubUrl?: string;
    branch?: string;
    userPrompt: string;
    targetDurationSec: number;
  };
  plan?: PlanArtifact;
  research?: ResearchArtifact;
  scriptVersions: ScriptVersion[];
  approvedVersionId?: string;
  audio?: { url: string; fileName: string; bytes: number; durationEstimateMs: number };
  video?: { url: string; fileName: string };
  finalVideo?: { url: string; fileName: string };
  workDir: string;
  error?: { stage: PipelineStatus; message: string };
}

const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 30 * 60 * 1000;

export class SessionStore {
  private readonly sessions = new Map<string, PipelineSession>();
  private readonly rootDir: string;
  private sweeperHandle: NodeJS.Timeout | null = null;

  constructor(rootDir: string) {
    this.rootDir = rootDir;
  }

  start(): void {
    if (this.sweeperHandle) return;
    this.sweeperHandle = setInterval(() => {
      this.evictExpired().catch((err) => console.warn('Session sweeper failed:', err));
    }, SWEEP_INTERVAL_MS);
    this.sweeperHandle.unref?.();
  }

  stop(): void {
    if (this.sweeperHandle) {
      clearInterval(this.sweeperHandle);
      this.sweeperHandle = null;
    }
  }

  create(input: PipelineSession['input']): PipelineSession {
    const id = randomUUID();
    const workDir = path.join(this.rootDir, id);
    const now = new Date().toISOString();
    const session: PipelineSession = {
      id,
      createdAt: now,
      updatedAt: now,
      status: 'CREATED',
      input,
      scriptVersions: [],
      workDir,
    };
    this.sessions.set(id, session);
    return session;
  }

  get(id: string): PipelineSession | undefined {
    return this.sessions.get(id);
  }

  update(id: string, mutate: (s: PipelineSession) => void): PipelineSession {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`Session ${id} not found`);
    mutate(session);
    session.updatedAt = new Date().toISOString();
    return session;
  }

  appendScriptVersion(
    id: string,
    payload: { fullScript: string; estimatedDurationSec: number; wordCount: number; feedbackUsed?: string },
  ): ScriptVersion {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`Session ${id} not found`);
    const last = session.scriptVersions[session.scriptVersions.length - 1];
    const version: ScriptVersion = {
      id: randomUUID(),
      versionNumber: (last?.versionNumber ?? 0) + 1,
      createdAt: new Date().toISOString(),
      parentVersionId: last?.id,
      ...payload,
    };
    session.scriptVersions.push(version);
    session.status = 'SCRIPT_DRAFT';
    session.updatedAt = version.createdAt;
    return version;
  }

  setStatus(id: string, status: PipelineStatus): void {
    this.update(id, (s) => {
      s.status = status;
    });
  }

  setError(id: string, stage: PipelineStatus, message: string): void {
    this.update(id, (s) => {
      s.status = 'ERROR';
      s.error = { stage, message };
    });
  }

  async destroy(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) return;
    this.sessions.delete(id);
    await rm(session.workDir, { recursive: true, force: true }).catch(() => {});
  }

  private async evictExpired(): Promise<void> {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (now - new Date(session.updatedAt).getTime() > TWO_HOURS_MS) {
        await this.destroy(id);
      }
    }
  }
}
