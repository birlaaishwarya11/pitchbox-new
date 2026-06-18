# Pitchbox Server

AI-powered repository analysis and demo script generation server.

## Features

- **Repository Analysis**: Clone and analyze GitHub repositories
- **AI-Powered Insights**: Extract features, user flows, and API endpoints
- **Demo Script Generation**: Generate professional product demo scripts using Claude AI
- **Daytona Integration**: Deploy repositories to Daytona sandboxes
- **Screen Recording**: Record application demos

## Getting Started

### Prerequisites

- Node.js 20+
- Git
- Anthropic API key (for script generation)

### Installation

```bash
npm install
```

### Configuration

Copy `.env.example` to `.env` and configure:

```bash
cp .env.example .env
```

Required environment variables:

```env
# Required for AI-powered script generation
ANTHROPIC_API_KEY=your_anthropic_api_key_here

# Optional: Daytona configuration
DAYTONA_API_KEY=your_daytona_api_key
DAYTONA_API_URL=https://api.daytona.io
DAYTONA_WORKSPACE_DIR=workspace

# Optional: Server configuration
PORT=3001
```

### Running the Server

```bash
# Development mode (with hot reload)
npm run dev

# Production mode
npm run build
npm start
```

## API Endpoints

### 1. Health Check

**GET** `/health`

Returns server health status.

**Response:**
```json
{
  "status": "ok",
  "message": "Server is running"
}
```

---

### 2. Analyze Repository

**POST** `/api/analyze`

Analyzes a GitHub repository and generates a demo script.

**Request Body:**
```json
{
  "githubUrl": "https://github.com/username/repository",
  "branch": "main",                    // optional
  "commitId": "abc123",                // optional
  "style": "business",                 // optional: "technical" | "business" | "casual"
  "targetDuration": 180,               // optional: seconds (default: 180)
  "focusAreas": ["authentication"],   // optional: string array
  "includeCodeExamples": false        // optional: boolean
}
```

**Response:**
```json
{
  "status": "success",
  "repository": {
    "url": "https://github.com/username/repository",
    "name": "repository",
    "owner": "username",
    "branch": "main",
    "commitId": null
  },
  "analysis": {
    "techStack": {
      "languages": ["JavaScript", "TypeScript"],
      "frameworks": ["Next.js", "React"],
      "buildTools": ["Webpack"],
      "packageManager": "npm",
      "hasDocker": true,
      "hasCI": true
    },
    "features": [
      {
        "name": "API Layer",
        "description": "Backend API endpoints and data handling",
        "files": ["src/api/route.ts"],
        "category": "Backend"
      }
    ],
    "userFlows": [
      {
        "id": "auth-flow",
        "name": "User Authentication",
        "description": "How users sign up, log in, and maintain their session",
        "steps": ["User creates an account", "User logs in"],
        "files": ["src/auth/login.ts"],
        "type": "authentication"
      }
    ],
    "apiEndpoints": [
      {
        "method": "GET",
        "path": "/api/users",
        "file": "src/api/users/route.ts"
      }
    ],
    "uiComponents": ["Button", "Form", "Modal"],
    "dataModels": ["User", "Post", "Comment"],
    "totalFiles": 150,
    "totalSize": 2048576,
    "entryPoints": ["src/index.ts"],
    "dependencies": {
      "production": ["react", "next"],
      "development": ["typescript"],
      "total": 50
    }
  },
  "demoScript": {
    "fullScript": "## INTRODUCTION\n\nWelcome to...",
    "sections": [
      {
        "title": "INTRODUCTION",
        "content": "Welcome to our application...",
        "duration": 30,
        "type": "introduction"
      }
    ],
    "estimatedDuration": 180,
    "keywords": ["React", "Next.js", "API Layer"],
    "metadata": {
      "style": "business",
      "generatedAt": "2025-11-18T18:00:00.000Z",
      "repository": "https://github.com/username/repository"
    }
  }
}
```

**Error Responses:**

- `400 Bad Request`: Invalid GitHub URL or missing required field
- `503 Service Unavailable`: ANTHROPIC_API_KEY not configured
- `500 Internal Server Error`: Analysis or script generation failed

---

### 3. Deploy Repository

**POST** `/api/deploy`

Deploys a GitHub repository to Daytona.

**Request Body:**
```json
{
  "githubUrl": "https://github.com/username/repository",
  "branch": "main",           // optional
  "commitId": "abc123",       // optional
  "workspaceDir": "workspace", // optional
  "skipSetup": false          // optional
}
```

---

### 4. Record Repository

**POST** `/api/record`

Records a repository running in a Daytona sandbox or a live URL.

**Request Body:**
```json
{
  "githubUrl": "https://github.com/username/repository",
  "branch": "main",                      // optional
  "commitId": "abc123",                  // optional
  "sandboxPort": 3000,                   // optional
  "sandboxRecordDurationMs": 30000,     // optional
  "appStartCommand": "npm start",       // optional
  "appBuildCommand": "npm run build"    // optional
}
```

## Architecture

### Components

1. **RepositoryCloner**: Handles git clone operations with automatic cleanup
2. **CodebaseAnalyzer**: Scans and analyzes repository structure, tech stack, and files
3. **FlowExtractor**: Identifies user flows, features, API endpoints, and components
4. **ScriptGenerator**: Uses Claude AI to generate professional demo scripts

### Analysis Flow

```
GitHub URL
    ↓
Clone Repository (temporary)
    ↓
Analyze Codebase
    ↓
Extract Features & Flows
    ↓
Generate Script with AI
    ↓
Return Results + Cleanup
```

## Script Styles

### Business (Default)
Focus on business value, ROI, and problem-solving aspects. Best for stakeholder presentations.

### Technical
Focus on architecture, implementation details, and developer-facing aspects. Best for technical demos.

### Casual
Friendly, conversational tone. Best for informal presentations or social media.

## Usage Example

```bash
curl -X POST http://localhost:3001/api/analyze \
  -H "Content-Type: application/json" \
  -d '{
    "githubUrl": "https://github.com/vercel/next.js",
    "style": "business",
    "targetDuration": 120,
    "focusAreas": ["routing", "data-fetching"]
  }'
```

## Development

### Type Checking

```bash
npm run type-check
```

### Building

```bash
npm run build
```

## Notes

- Cloned repositories are stored temporarily in `/tmp/repo-analysis`
- Old repositories are automatically cleaned up (>1 hour old)
- Maximum file size analyzed: 100KB per file
- Maximum repository size: No hard limit, but large repos may take longer

## Troubleshooting

### Script generation returns 503

Make sure `ANTHROPIC_API_KEY` is set in your `.env` file.

### Git clone fails

- Check that the GitHub URL is valid and publicly accessible
- For private repositories, you'll need to configure git credentials

### Analysis takes too long

Large repositories with many files may take several minutes to analyze. Consider:
- Using a specific branch with fewer files
- Optimizing the analysis depth
