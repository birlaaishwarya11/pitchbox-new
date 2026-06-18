import { simpleGit, type SimpleGit, type SimpleGitOptions } from 'simple-git';
import fs from 'fs-extra';
import path from 'node:path';
import os from 'node:os';

export interface CloneOptions {
  githubUrl: string;
  branch?: string;
  commitId?: string;
  depth?: number;
}

export interface CloneResult {
  localPath: string;
  repoName: string;
  repoOwner: string;
  branch?: string;
  commitId?: string;
  cleanup: () => Promise<void>;
}

export class RepositoryClonerError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'RepositoryClonerError';
  }
}

export class RepositoryCloner {
  private readonly baseDir: string;

  constructor(baseDir?: string) {
    this.baseDir = baseDir || path.join(os.tmpdir(), 'repo-analysis');
  }

  async clone(options: CloneOptions): Promise<CloneResult> {
    const { repoOwner, repoName } = this.parseGithubUrl(options.githubUrl);
    const timestamp = Date.now();
    const localPath = path.join(this.baseDir, `${timestamp}-${repoName}`);

    try {
      // Ensure base directory exists
      await fs.ensureDir(this.baseDir);

      // Configure git
      const gitOptions: Partial<SimpleGitOptions> = {
        baseDir: this.baseDir,
        binary: 'git',
        maxConcurrentProcesses: 6,
      };

      const git: SimpleGit = simpleGit(gitOptions);

      // Clone repository
      const cloneOptions: string[] = [];

      if (options.depth !== undefined) {
        cloneOptions.push(`--depth=${options.depth}`);
      } else {
        cloneOptions.push('--depth=1'); // Default shallow clone
      }

      if (options.branch) {
        cloneOptions.push(`--branch=${options.branch}`);
      }

      cloneOptions.push('--single-branch');

      await git.clone(options.githubUrl, localPath, cloneOptions);

      // Checkout specific commit if provided
      if (options.commitId) {
        const repoGit = simpleGit(localPath);
        await repoGit.fetch(['--depth=1', 'origin', options.commitId]);
        await repoGit.checkout(options.commitId);
      }

      // Create cleanup function
      const cleanup = async () => {
        try {
          await fs.remove(localPath);
        } catch (error) {
          console.warn(`Failed to cleanup repository at ${localPath}:`, error);
        }
      };

      return {
        localPath,
        repoName,
        repoOwner,
        branch: options.branch,
        commitId: options.commitId,
        cleanup,
      };
    } catch (error) {
      // Cleanup on failure
      try {
        await fs.remove(localPath);
      } catch {
        // Ignore cleanup errors
      }

      throw new RepositoryClonerError(
        `Failed to clone repository: ${options.githubUrl}`,
        error
      );
    }
  }

  private parseGithubUrl(url: string): { repoOwner: string; repoName: string } {
    // Handle SSH format: git@github.com:owner/repo.git
    if (url.startsWith('git@')) {
      const match = /^git@github\.com:(?<owner>[^/]+)\/(?<repo>.+?)(?:\.git)?$/i.exec(url);
      if (!match?.groups) {
        throw new RepositoryClonerError('Invalid GitHub SSH URL format');
      }
      return {
        repoOwner: match.groups.owner,
        repoName: this.stripGitSuffix(match.groups.repo),
      };
    }

    // Handle HTTPS format: https://github.com/owner/repo or https://github.com/owner/repo.git
    try {
      const parsed = new URL(url);
      if (!parsed.hostname.toLowerCase().includes('github.com')) {
        throw new RepositoryClonerError('Only GitHub URLs are supported');
      }

      const segments = parsed.pathname.split('/').filter(Boolean);
      if (segments.length < 2) {
        throw new RepositoryClonerError('GitHub URL must include owner and repository name');
      }

      return {
        repoOwner: segments[0],
        repoName: this.stripGitSuffix(segments[1]),
      };
    } catch (error) {
      if (error instanceof RepositoryClonerError) {
        throw error;
      }
      throw new RepositoryClonerError('Invalid GitHub URL format');
    }
  }

  private stripGitSuffix(name: string): string {
    return name.replace(/\.git$/i, '');
  }

  async cleanupOldRepositories(maxAgeMs: number = 3600000): Promise<void> {
    try {
      const exists = await fs.pathExists(this.baseDir);
      if (!exists) {
        return;
      }

      const entries = await fs.readdir(this.baseDir, { withFileTypes: true });
      const now = Date.now();

      for (const entry of entries) {
        if (!entry.isDirectory()) {
          continue;
        }

        const fullPath = path.join(this.baseDir, entry.name);
        const stats = await fs.stat(fullPath);
        const age = now - stats.mtimeMs;

        if (age > maxAgeMs) {
          await fs.remove(fullPath);
        }
      }
    } catch (error) {
      console.warn('Failed to cleanup old repositories:', error);
    }
  }
}
