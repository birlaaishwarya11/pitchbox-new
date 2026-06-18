import type { FileInfo, AnalysisResult } from './CodebaseAnalyzer';

export interface UserFlow {
  id: string;
  name: string;
  description: string;
  steps: string[];
  files: string[];
  type: FlowType;
}

export type FlowType = 'authentication' | 'data-management' | 'ui-interaction' | 'api' | 'general';

export interface Feature {
  name: string;
  description: string;
  files: string[];
  category: string;
}

export interface APIEndpoint {
  method: string;
  path: string;
  file: string;
  description?: string;
}

export interface FlowExtractionResult {
  userFlows: UserFlow[];
  features: Feature[];
  apiEndpoints: APIEndpoint[];
  uiComponents: string[];
  dataModels: string[];
}

export class FlowExtractor {
  extract(analysis: AnalysisResult): FlowExtractionResult {
    const userFlows = this.extractUserFlows(analysis);
    const features = this.extractFeatures(analysis);
    const apiEndpoints = this.extractAPIEndpoints(analysis.keyFiles);
    const uiComponents = this.extractUIComponents(analysis.keyFiles);
    const dataModels = this.extractDataModels(analysis.keyFiles);

    return {
      userFlows,
      features,
      apiEndpoints,
      uiComponents,
      dataModels,
    };
  }

  private extractUserFlows(analysis: AnalysisResult): UserFlow[] {
    const flows: UserFlow[] = [];

    // Detect authentication flow
    const authFlow = this.detectAuthenticationFlow(analysis);
    if (authFlow) flows.push(authFlow);

    // Detect data management flows
    const dataFlows = this.detectDataFlows(analysis);
    flows.push(...dataFlows);

    // Detect UI flows
    const uiFlows = this.detectUIFlows(analysis);
    flows.push(...uiFlows);

    return flows;
  }

  private detectAuthenticationFlow(analysis: AnalysisResult): UserFlow | null {
    const authKeywords = ['auth', 'login', 'signin', 'signup', 'register', 'session', 'jwt', 'token'];
    const authFiles = analysis.keyFiles.filter(f =>
      authKeywords.some(keyword => f.relativePath.toLowerCase().includes(keyword))
    );

    if (authFiles.length === 0) {
      return null;
    }

    const steps: string[] = [];
    const hasLogin = authFiles.some(f => f.relativePath.includes('login') || f.relativePath.includes('signin'));
    const hasSignup = authFiles.some(f => f.relativePath.includes('signup') || f.relativePath.includes('register'));
    const hasSession = authFiles.some(f => f.relativePath.includes('session') || f.relativePath.includes('token'));

    if (hasSignup) steps.push('User creates an account');
    if (hasLogin) steps.push('User logs in with credentials');
    if (hasSession) steps.push('System maintains user session');
    steps.push('User accesses protected features');

    return {
      id: 'auth-flow',
      name: 'User Authentication',
      description: 'How users sign up, log in, and maintain their session',
      steps,
      files: authFiles.map(f => f.relativePath),
      type: 'authentication',
    };
  }

  private detectDataFlows(analysis: AnalysisResult): UserFlow[] {
    const flows: UserFlow[] = [];

    // Look for CRUD patterns
    const crudKeywords = ['create', 'read', 'update', 'delete', 'list', 'get', 'post', 'put', 'patch'];
    const dataFiles = analysis.keyFiles.filter(f =>
      crudKeywords.some(keyword => f.relativePath.toLowerCase().includes(keyword)) &&
      (f.relativePath.includes('api') || f.relativePath.includes('route') || f.relativePath.includes('controller'))
    );

    if (dataFiles.length > 0) {
      flows.push({
        id: 'data-management',
        name: 'Data Management',
        description: 'How the application manages data (CRUD operations)',
        steps: [
          'User views data list',
          'User creates new data entry',
          'User updates existing data',
          'User deletes data',
        ],
        files: dataFiles.map(f => f.relativePath),
        type: 'data-management',
      });
    }

    return flows;
  }

  private detectUIFlows(analysis: AnalysisResult): UserFlow[] {
    const flows: UserFlow[] = [];

    // Detect form flows
    const formFiles = analysis.keyFiles.filter(f =>
      f.relativePath.toLowerCase().includes('form') ||
      (f.content && /form|input|button|submit/i.test(f.content))
    );

    if (formFiles.length > 0) {
      flows.push({
        id: 'form-interaction',
        name: 'Form Interaction',
        description: 'How users interact with forms in the application',
        steps: [
          'User navigates to form',
          'User fills in form fields',
          'User validates input',
          'User submits form',
          'System processes and responds',
        ],
        files: formFiles.map(f => f.relativePath),
        type: 'ui-interaction',
      });
    }

    return flows;
  }

  private extractFeatures(analysis: AnalysisResult): Feature[] {
    const features: Feature[] = [];

    // Extract features from frameworks
    if (analysis.techStack.frameworks.includes('Next.js') || analysis.techStack.frameworks.includes('React')) {
      const routeFiles = analysis.keyFiles.filter(f =>
        f.relativePath.includes('page') || f.relativePath.includes('route')
      );

      if (routeFiles.length > 0) {
        features.push({
          name: 'Routing & Navigation',
          description: 'Page routing and navigation system',
          files: routeFiles.map(f => f.relativePath),
          category: 'Core',
        });
      }
    }

    // API features
    const apiFiles = analysis.keyFiles.filter(f =>
      f.relativePath.includes('api') || f.relativePath.includes('route')
    );

    if (apiFiles.length > 0) {
      features.push({
        name: 'API Layer',
        description: 'Backend API endpoints and data handling',
        files: apiFiles.map(f => f.relativePath),
        category: 'Backend',
      });
    }

    // UI Components
    const componentFiles = analysis.keyFiles.filter(f =>
      f.relativePath.includes('component') ||
      (f.extension === '.tsx' || f.extension === '.jsx')
    );

    if (componentFiles.length > 0) {
      features.push({
        name: 'UI Components',
        description: 'Reusable user interface components',
        files: componentFiles.slice(0, 10).map(f => f.relativePath),
        category: 'Frontend',
      });
    }

    // Database/Storage
    if (analysis.dependencies.production.some(dep =>
      ['prisma', 'mongoose', 'sequelize', 'typeorm', 'pg', 'mysql'].includes(dep)
    )) {
      features.push({
        name: 'Database Integration',
        description: 'Data persistence and database operations',
        files: analysis.keyFiles
          .filter(f => f.relativePath.includes('model') || f.relativePath.includes('schema'))
          .map(f => f.relativePath),
        category: 'Backend',
      });
    }

    return features;
  }

  private extractAPIEndpoints(keyFiles: FileInfo[]): APIEndpoint[] {
    const endpoints: APIEndpoint[] = [];

    for (const file of keyFiles) {
      if (!file.content) continue;

      // Express-style routes
      const expressMatches = file.content.matchAll(/(?:router|app)\.(get|post|put|patch|delete|all)\(['"`]([^'"`]+)['"`]/g);
      for (const match of expressMatches) {
        endpoints.push({
          method: match[1].toUpperCase(),
          path: match[2],
          file: file.relativePath,
        });
      }

      // Next.js App Router (export async function GET, POST, etc.)
      const nextMatches = file.content.matchAll(/export\s+async\s+function\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)/g);
      if (nextMatches) {
        for (const match of nextMatches) {
          // Extract route from file path for Next.js
          const routePath = this.extractNextRoute(file.relativePath);
          endpoints.push({
            method: match[1],
            path: routePath,
            file: file.relativePath,
          });
        }
      }
    }

    return endpoints;
  }

  private extractNextRoute(filePath: string): string {
    // Convert app/api/users/route.ts -> /api/users
    const match = filePath.match(/app\/(.+?)\/(?:route|page)\.(ts|tsx|js|jsx)$/);
    if (match) {
      return '/' + match[1];
    }
    return filePath;
  }

  private extractUIComponents(keyFiles: FileInfo[]): string[] {
    const components = new Set<string>();

    for (const file of keyFiles) {
      if (!file.content) continue;

      // React/Next.js components
      const componentMatches = file.content.matchAll(/(?:export\s+(?:default\s+)?(?:function|const)\s+|class\s+)([A-Z][a-zA-Z0-9]+)/g);
      for (const match of componentMatches) {
        if (match[1] && match[1].length > 1) {
          components.add(match[1]);
        }
      }
    }

    return Array.from(components).slice(0, 50);
  }

  private extractDataModels(keyFiles: FileInfo[]): string[] {
    const models = new Set<string>();

    for (const file of keyFiles) {
      if (!file.content) continue;

      // TypeScript interfaces and types
      const interfaceMatches = file.content.matchAll(/(?:interface|type)\s+([A-Z][a-zA-Z0-9]+)/g);
      for (const match of interfaceMatches) {
        if (match[1] && !match[1].includes('Props') && !match[1].includes('State')) {
          models.add(match[1]);
        }
      }

      // Database models
      const modelMatches = file.content.matchAll(/(?:model|schema|entity)\s+([A-Z][a-zA-Z0-9]+)/g);
      for (const match of modelMatches) {
        models.add(match[1]);
      }
    }

    return Array.from(models).slice(0, 30);
  }
}
