import { glob } from 'glob';
import fs from 'fs-extra';
import path from 'node:path';

export interface FileInfo {
  path: string;
  relativePath: string;
  content?: string;
  size: number;
  extension: string;
  category: FileCategory;
}

export type FileCategory =
  | 'documentation'
  | 'configuration'
  | 'source'
  | 'test'
  | 'asset'
  | 'dependency'
  | 'other';

export interface AnalysisResult {
  rootPath: string;
  totalFiles: number;
  totalSize: number;
  structure: DirectoryStructure;
  techStack: TechStackInfo;
  keyFiles: FileInfo[];
  entryPoints: string[];
  dependencies: DependencyInfo;
}

export interface DirectoryStructure {
  name: string;
  path: string;
  type: 'file' | 'directory';
  children?: DirectoryStructure[];
  size?: number;
}

export interface TechStackInfo {
  languages: string[];
  frameworks: string[];
  buildTools: string[];
  packageManager?: string;
  hasDocker: boolean;
  hasCI: boolean;
}

export interface DependencyInfo {
  production: string[];
  development: string[];
  total: number;
}

const IGNORE_PATTERNS = [
  '**/node_modules/**',
  '**/.git/**',
  '**/dist/**',
  '**/build/**',
  '**/.next/**',
  '**/out/**',
  '**/.cache/**',
  '**/coverage/**',
  '**/*.log',
  '**/package-lock.json',
  '**/yarn.lock',
  '**/pnpm-lock.yaml',
];

const KEY_FILE_PATTERNS = [
  '**/README.md',
  '**/README.txt',
  '**/package.json',
  '**/tsconfig.json',
  '**/docker-compose.yml',
  '**/Dockerfile',
  '**/.env.example',
  '**/index.{ts,tsx,js,jsx}',
  '**/main.{ts,tsx,js,jsx}',
  '**/app.{ts,tsx,js,jsx}',
  '**/server.{ts,tsx,js,jsx}',
];

const MAX_FILE_SIZE = 100 * 1024; // 100KB

export class CodebaseAnalyzer {
  async analyze(repoPath: string): Promise<AnalysisResult> {
    const allFiles = await this.scanFiles(repoPath);
    const keyFiles = await this.extractKeyFiles(repoPath, allFiles);
    const techStack = await this.detectTechStack(repoPath, keyFiles);
    const entryPoints = this.findEntryPoints(keyFiles);
    const dependencies = await this.extractDependencies(repoPath);
    const structure = await this.buildDirectoryStructure(repoPath);

    const totalSize = allFiles.reduce((sum, file) => sum + file.size, 0);

    return {
      rootPath: repoPath,
      totalFiles: allFiles.length,
      totalSize,
      structure,
      techStack,
      keyFiles,
      entryPoints,
      dependencies,
    };
  }

  private async scanFiles(repoPath: string): Promise<FileInfo[]> {
    const patterns = '**/*';
    const files = await glob(patterns, {
      cwd: repoPath,
      ignore: IGNORE_PATTERNS,
      nodir: true,
      dot: true,
    });

    const fileInfos: FileInfo[] = [];

    for (const file of files) {
      const fullPath = path.join(repoPath, file);
      try {
        const stats = await fs.stat(fullPath);

        if (stats.size > 10 * 1024 * 1024) { // Skip files > 10MB
          continue;
        }

        fileInfos.push({
          path: fullPath,
          relativePath: file,
          size: stats.size,
          extension: path.extname(file),
          category: this.categorizeFile(file),
        });
      } catch (error) {
        // Skip files that can't be read
        continue;
      }
    }

    return fileInfos;
  }

  private async extractKeyFiles(repoPath: string, allFiles: FileInfo[]): Promise<FileInfo[]> {
    const keyFiles: FileInfo[] = [];

    // Find files matching key patterns
    for (const pattern of KEY_FILE_PATTERNS) {
      const matches = await glob(pattern, {
        cwd: repoPath,
        ignore: IGNORE_PATTERNS,
        nodir: true,
      });

      for (const match of matches) {
        const fileInfo = allFiles.find(f => f.relativePath === match);
        if (fileInfo && fileInfo.size <= MAX_FILE_SIZE) {
          try {
            const content = await fs.readFile(fileInfo.path, 'utf-8');
            keyFiles.push({ ...fileInfo, content });
          } catch (error) {
            // Skip files that can't be read as text
          }
        }
      }
    }

    // Also include main source files (limited number)
    const sourceFiles = allFiles
      .filter(f => f.category === 'source' && f.size <= MAX_FILE_SIZE)
      .sort((a, b) => {
        // Prioritize files in src/, app/, or root
        const aPriority = this.getFilePriority(a.relativePath);
        const bPriority = this.getFilePriority(b.relativePath);
        return bPriority - aPriority;
      })
      .slice(0, 20);

    for (const file of sourceFiles) {
      if (!keyFiles.find(f => f.path === file.path)) {
        try {
          const content = await fs.readFile(file.path, 'utf-8');
          keyFiles.push({ ...file, content });
        } catch (error) {
          // Skip files that can't be read
        }
      }
    }

    return keyFiles;
  }

  private getFilePriority(filePath: string): number {
    if (filePath.match(/^(src|app|pages)\//)) return 10;
    if (filePath.match(/^(index|main|app|server)\./)) return 9;
    if (filePath.match(/\/(index|main|app|server)\./)) return 8;
    if (filePath.includes('route')) return 7;
    if (filePath.includes('component')) return 6;
    if (filePath.includes('api')) return 7;
    return 5;
  }

  private categorizeFile(filePath: string): FileCategory {
    const lower = filePath.toLowerCase();
    const ext = path.extname(lower);

    if (lower.includes('readme') || lower.includes('contributing') || ext === '.md') {
      return 'documentation';
    }

    if (
      lower.includes('package.json') ||
      lower.includes('tsconfig') ||
      lower.includes('config') ||
      lower.includes('.yml') ||
      lower.includes('.yaml') ||
      lower.includes('.json') ||
      lower.includes('dockerfile')
    ) {
      return 'configuration';
    }

    if (lower.includes('test') || lower.includes('spec') || lower.includes('__tests__')) {
      return 'test';
    }

    if (lower.includes('node_modules') || lower.includes('vendor')) {
      return 'dependency';
    }

    if (['.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.woff', '.woff2', '.ttf'].includes(ext)) {
      return 'asset';
    }

    if (['.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.java', '.rs', '.c', '.cpp'].includes(ext)) {
      return 'source';
    }

    return 'other';
  }

  private async detectTechStack(repoPath: string, keyFiles: FileInfo[]): Promise<TechStackInfo> {
    const languages = new Set<string>();
    const frameworks = new Set<string>();
    const buildTools = new Set<string>();
    let packageManager: string | undefined;
    let hasDocker = false;
    let hasCI = false;

    // Check for package.json
    const packageJson = keyFiles.find(f => f.relativePath === 'package.json');
    if (packageJson && packageJson.content) {
      try {
        const pkg = JSON.parse(packageJson.content);
        const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };

        // Detect frameworks
        if (allDeps['next']) frameworks.add('Next.js');
        if (allDeps['react']) frameworks.add('React');
        if (allDeps['vue']) frameworks.add('Vue');
        if (allDeps['angular']) frameworks.add('Angular');
        if (allDeps['express']) frameworks.add('Express');
        if (allDeps['fastify']) frameworks.add('Fastify');
        if (allDeps['nestjs']) frameworks.add('NestJS');
        if (allDeps['svelte']) frameworks.add('Svelte');

        // Detect build tools
        if (allDeps['webpack']) buildTools.add('Webpack');
        if (allDeps['vite']) buildTools.add('Vite');
        if (allDeps['rollup']) buildTools.add('Rollup');
        if (allDeps['esbuild']) buildTools.add('esbuild');
        if (allDeps['turbo']) buildTools.add('Turborepo');

        languages.add('JavaScript');
        if (allDeps['typescript']) languages.add('TypeScript');
      } catch (error) {
        // Invalid JSON
      }
    }

    // Detect package manager
    if (await fs.pathExists(path.join(repoPath, 'package-lock.json'))) {
      packageManager = 'npm';
    } else if (await fs.pathExists(path.join(repoPath, 'yarn.lock'))) {
      packageManager = 'yarn';
    } else if (await fs.pathExists(path.join(repoPath, 'pnpm-lock.yaml'))) {
      packageManager = 'pnpm';
    }

    // Check for Docker
    hasDocker = keyFiles.some(f =>
      f.relativePath.includes('Dockerfile') || f.relativePath.includes('docker-compose')
    );

    // Check for CI
    hasCI = await fs.pathExists(path.join(repoPath, '.github', 'workflows')) ||
            await fs.pathExists(path.join(repoPath, '.gitlab-ci.yml')) ||
            await fs.pathExists(path.join(repoPath, '.circleci'));

    // Detect other languages
    if (keyFiles.some(f => f.extension === '.py')) languages.add('Python');
    if (keyFiles.some(f => f.extension === '.go')) languages.add('Go');
    if (keyFiles.some(f => f.extension === '.java')) languages.add('Java');
    if (keyFiles.some(f => f.extension === '.rs')) languages.add('Rust');

    return {
      languages: Array.from(languages),
      frameworks: Array.from(frameworks),
      buildTools: Array.from(buildTools),
      packageManager,
      hasDocker,
      hasCI,
    };
  }

  private findEntryPoints(keyFiles: FileInfo[]): string[] {
    const entryPoints: string[] = [];

    const patterns = [
      /^(index|main|app|server)\.(ts|tsx|js|jsx)$/,
      /^src\/(index|main|app|server)\.(ts|tsx|js|jsx)$/,
      /^app\/(page|layout)\.(ts|tsx|js|jsx)$/,
      /^pages\/_app\.(ts|tsx|js|jsx)$/,
    ];

    for (const file of keyFiles) {
      for (const pattern of patterns) {
        if (pattern.test(file.relativePath)) {
          entryPoints.push(file.relativePath);
          break;
        }
      }
    }

    return entryPoints;
  }

  private async extractDependencies(repoPath: string): Promise<DependencyInfo> {
    try {
      const packageJsonPath = path.join(repoPath, 'package.json');
      const content = await fs.readFile(packageJsonPath, 'utf-8');
      const pkg = JSON.parse(content);

      const production = Object.keys(pkg.dependencies || {});
      const development = Object.keys(pkg.devDependencies || {});

      return {
        production,
        development,
        total: production.length + development.length,
      };
    } catch (error) {
      return {
        production: [],
        development: [],
        total: 0,
      };
    }
  }

  private async buildDirectoryStructure(repoPath: string, maxDepth: number = 3): Promise<DirectoryStructure> {
    const buildTree = async (dirPath: string, currentDepth: number): Promise<DirectoryStructure> => {
      const stats = await fs.stat(dirPath);
      const name = path.basename(dirPath);

      if (stats.isFile()) {
        return {
          name,
          path: dirPath,
          type: 'file',
          size: stats.size,
        };
      }

      const children: DirectoryStructure[] = [];

      if (currentDepth < maxDepth) {
        try {
          const entries = await fs.readdir(dirPath, { withFileTypes: true });

          for (const entry of entries) {
            // Skip ignored directories
            if (IGNORE_PATTERNS.some(pattern => {
              const simple = pattern.replace(/\*\*/g, '').replace(/\*/g, '');
              return entry.name.includes(simple.trim().replace(/\//g, ''));
            })) {
              continue;
            }

            const childPath = path.join(dirPath, entry.name);
            const child = await buildTree(childPath, currentDepth + 1);
            children.push(child);
          }
        } catch (error) {
          // Skip directories we can't read
        }
      }

      return {
        name,
        path: dirPath,
        type: 'directory',
        children: children.length > 0 ? children : undefined,
      };
    };

    return buildTree(repoPath, 0);
  }
}
