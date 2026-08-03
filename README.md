# Pitchbox Monorepo

A monorepo containing a Next.js web application and a Node.js TypeScript server.

## Structure

```
pitchbox/
├── apps/
│   ├── web/          # Next.js application
│   └── server/       # Node.js TypeScript server
├── package.json      # Root workspace configuration
└── tsconfig.json     # Base TypeScript configuration
```

## Getting Started

### Install Dependencies

```bash
npm install
```

### Development

Run all apps in development mode:
```bash
npm run dev
```

Run individual apps:
```bash
npm run dev:web      # Next.js app (http://localhost:3000)
npm run dev:server   # Node.js server (http://localhost:3001)
```

### Build

Build all apps:
```bash
npm run build
```

Build individual apps:
```bash
npm run build:web
npm run build:server
```

### Type Checking

Type check all apps:
```bash
npm run type-check
```

## Apps

### Web (Next.js)

Located in `apps/web/`, this is a Next.js 14 application with TypeScript.

- **Port**: 3000 (default)
- **Framework**: Next.js 14
- **Language**: TypeScript

### Server (Node.js)

Located in `apps/server/`, this is an Express.js server with TypeScript.

- **Port**: 3001 (default, configurable via PORT env var)
- **Framework**: Express.js
- **Language**: TypeScript
- **Endpoints**:
  - `GET /health` - Health check endpoint
  - `GET /api/hello` - Example API endpoint
  - `POST /api/record` - Trigger a headless recording for a URL
  - `POST /api/deploy` - Spin up a Daytona sandbox for a GitHub repo

#### Recording API

The `/api/record` endpoint spins up a Puppeteer-driven Chromium instance and records the page session via `ffmpeg`. It has two capture modes:

- **Screenshot capture** (default on macOS/Windows, also works on Linux): headless Puppeteer takes JPEG frames and pipes them into ffmpeg via `image2pipe` — no virtual display required.
- **Xvfb capture** (default on Linux when Xvfb is available): Chromium runs against an Xvfb virtual display and ffmpeg grabs via `x11grab`.

Override the mode explicitly with `RECORDER_CAPTURE_MODE=screenshot|xvfb|auto`. Recordings are persisted to the local `recordings/` directory through a pluggable storage abstraction so cloud uploads can be added later.

**Prerequisites**

- `ffmpeg` installed and available in `$PATH`
- `Xvfb` only needed if you run the Linux path (`RECORDER_CAPTURE_MODE=xvfb`)

**Request**

```bash
curl -X POST http://localhost:3001/api/record \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com"}'
```

**Response**

```json
{
  "status": "completed",
  "recording": {
    "sessionId": "…",
    "url": "https://example.com/",
    "localPath": "/absolute/path/to/recordings/…/…mp4",
    "storage": { "type": "local", "uri": "/absolute/path/to/…mp4" },
    "viewport": { "width": 1280, "height": 720 },
    "startedAt": "2025-11-18T12:00:00.000Z",
    "endedAt": "2025-11-18T12:00:30.000Z",
    "durationMs": 30000
  }
}
```

Set `RECORDER_ENABLE_XVFB` / `RECORDER_DISABLE_XVFB` to override the default auto-detection logic. Additional storage backends can be injected by providing a custom implementation of the `RecordingStorageProvider` interface.

##### GitHub-powered recording

Pass `githubUrl` (plus optional `branch`, `commitId`, `workspaceDir`, `skipSetup`, `sandboxPort`, `sandboxRecordDurationMs`, `appStartCommand`, `appBuildCommand`, `appEnv`) to let the server:

1. Provision a Daytona sandbox via [`@daytonaio/sdk`](https://www.daytona.io/docs/en/typescript-sdk/)
2. Clone and auto-configure the repo (installs `xvfb`, `ffmpeg`, `curl`, runs `npm install`)
3. Launch the app inside the sandbox (`npm run dev:web` by default, port `4300`)
4. **Upload our recorder runtime into the same sandbox, install `puppeteer`/`xvfb`, and run the recording there** (Puppeteer renders via Xvfb + ffmpeg, so all headless capture happens inside Daytona)
5. Download the MP4 back to the server and expose it via the usual response payload

**Request**

```bash
curl -X POST http://localhost:3001/api/record \
  -H "Content-Type: application/json" \
  -d '{
        "githubUrl":"https://github.com/daytonaio/daytona",
        "branch":"main",
        "sandboxRecordDurationMs":5000
      }'
```

**Response**

```json
{
  "status": "completed",
  "recording": {
    "sessionId": "…",
    "url": "https://preview.daytona.dev/...",
    "localPath": "/absolute/path/to/recordings/…/…mp4",
    "storage": { "type": "local", "uri": "/absolute/path/to/…mp4" },
    "viewport": { "width": 1280, "height": 720 },
    "startedAt": "2025-11-18T12:05:00.000Z",
    "endedAt": "2025-11-18T12:05:05.000Z",
    "durationMs": 5000
  },
  "deployment": {
    "sandboxId": "sbx_123",
    "sandboxName": "pitchbox-2025-11-18",
    "githubUrl": "https://github.com/daytonaio/daytona",
    "repoPath": "workspace/daytonaio/daytona",
    "setupResults": [
      { "id": "apt-update", "exitCode": 0, "durationMs": 1234 },
      { "id": "apt-install-system", "exitCode": 0, "durationMs": 4567 },
      { "id": "npm-install", "exitCode": 0, "durationMs": 8910 }
    ]
  },
  "previewUrl": "https://preview.daytona.dev/..."
}
```

Use `skipSetup` if the repository already contains all dependencies, `sandboxPort` to override the default preview port, `appBuildCommand` to customize the pre-start build step (defaults to `npm run build:web`), and `appStartCommand` to launch a custom process (defaults to `npm run dev:web`). Recorder logs live inside the sandbox (`/tmp/pitchbox-app.log` for the app, `/tmp/pitchbox-recorder.log` for the remote recorder) so you can SSH in and tail them while a run is in progress. Raw MP4s are staged under `/tmp/pitchbox-recorder-runtime/` until the server downloads them.

###### Environment variables for the app under test (`appEnv`)

Most projects will not boot without configuration, and an app that never starts cannot be recorded. Pass `appEnv` as either an object or `.env`-style text:

```jsonc
{
  "githubUrl": "https://github.com/owner/repo",
  "appStartCommand": "npm run dev",
  "sandboxPort": 3000,
  "appEnv": {
    "DATABASE_URL": "postgres://…",
    "NEXT_PUBLIC_API_URL": "https://api.example.com"
  }
}
```

They are written to `.env.local` in the cloned repo (never overwriting a committed `.env`) *and* passed to the build and start commands, so both file-based loaders and `process.env` readers see them.

**Handling and limits**

| | |
|---|---|
| Storage | Held in memory for the life of the run only. Never written to the session, so `GET /api/pipeline/:id` cannot return them. |
| Logging | Names only, never values — a boot failure reports `3 (DATABASE_URL, …)`. |
| LLM | Never sent to any model. The director sees the site map, not the environment. |
| Count | 40 variables maximum |
| Value size | 4096 characters each |
| Total size | 16 KB |
| Names | `[A-Za-z_][A-Za-z0-9_]*` |
| Reserved | `PORT`, `HOST`, `HOSTNAME`, `VITE_PORT`, `PATH`, `NODE_OPTIONS`, `LD_PRELOAD`, `LD_LIBRARY_PATH`, `BASH_ENV`, `SHELL`, `IFS`, and the `RECORDER_*` / `PUPPETEER_*` / `DAYTONA_*` / `PBX_*` prefixes are rejected — the recorder sets them, and use `sandboxPort` to change the port. |

Anything rejected fails the request with `400 INVALID_APP_ENV` and a message naming the variable, so a bad value costs a round trip rather than a ten-minute sandbox.

###### When a repo will not start

The readiness check waits up to 120s for the app to answer on its port. If it never does, the error carries the last 40 lines of `/tmp/pitchbox-app.log`, the names supplied via `appEnv`, and a guess at the cause read out of the log (a named missing variable, `EADDRINUSE`, a missing module, an unreachable database).

A dev server also answers HTTP 200 while rendering its *own* error overlay, so a status check alone calls a completely broken app ready. The scout therefore checks whether the entry page is a Next.js / Vite / Remix error overlay before exploring, and a repo run fails with that overlay's text rather than recording 40 seconds of a stack trace.

Sandboxes are deleted when a run succeeds. A failed run keeps its sandbox for 60 minutes so the logs can be read, then auto-deletes; `PITCHBOX_KEEP_SANDBOX=true` keeps every sandbox, and `PITCHBOX_FAILED_SANDBOX_TTL_MIN` changes the window. Repo recordings are **not** retried: the run is long and its failures are deterministic, so a second attempt only delays the diagnostic.

#### Daytona Deployment API

`POST /api/deploy` provisions a Daytona sandbox (via [`@daytonaio/sdk`](https://www.daytona.io/docs/en/typescript-sdk/)), optionally pins it to a branch/commit, clones the target GitHub repository, and **auto-configures the sandbox** so it's ready to run Pitchbox (installs `xvfb`, `ffmpeg`, and runs `npm install` in the repo). Pass `skipSetup: true` if you only need the clone.

**Prerequisites**

- `DAYTONA_API_KEY` (or compatible auth env such as `DAYTONA_JWT_TOKEN` + `DAYTONA_ORGANIZATION_ID`)
- `DAYTONA_API_URL` *(optional — defaults to Daytona Cloud)*
- `DAYTONA_TARGET` *(optional — lets you pin a specific runner target)*
- `DAYTONA_WORKSPACE_DIR` *(optional — base folder used for clones, defaults to `workspace`)*
- `PITCHBOX_KEEP_SANDBOX` *(optional — `true` keeps every sandbox instead of deleting it after a successful run)*
- `PITCHBOX_FAILED_SANDBOX_TTL_MIN` *(optional — minutes a failed run's sandbox is kept for inspection, default `60`)*
- `DAYTONA_SANDBOX_TTL_MIN` *(optional — auto-delete interval set at creation so a sandbox cannot outlive a crashed server, default `120`)*
- `DAYTONA_SANDBOX_IMAGE` *(optional — create sandboxes from this image instead of the default snapshot; **required** before any resource override below has an effect, because only image-based sandboxes accept a resource allocation)*
- `DAYTONA_SANDBOX_CPU`, `DAYTONA_SANDBOX_MEMORY_GIB`, `DAYTONA_SANDBOX_DISK_GIB` *(optional — resource allocation; use these when a repo's `npm install` is killed with exit 137, which is the out-of-memory killer)*

**Request**

```bash
curl -X POST http://localhost:3001/api/deploy \
  -H "Content-Type: application/json" \
  -d '{
        "githubUrl":"https://github.com/daytonaio/daytona",
        "branch":"main"
      }'
```

**Response**

```json
{
  "status": "started",
  "deployment": {
    "sandboxId": "sbx_123",
    "sandboxName": "pitchbox-2025-11-18",
    "target": "us",
    "state": "started",
    "githubUrl": "https://github.com/daytonaio/daytona",
    "branch": "main",
    "repoOwner": "daytonaio",
    "repoName": "daytona",
    "repoPath": "workspace/daytonaio/daytona",
    "setupResults": [
      { "id": "apt-update", "description": "Update apt package index", "exitCode": 0, "durationMs": 1234, "output": "..." },
      { "id": "apt-install-system", "description": "Install Xvfb and ffmpeg", "exitCode": 0, "durationMs": 4567, "output": "..." },
      { "id": "npm-install", "description": "Install workspace dependencies", "exitCode": 0, "durationMs": 8910, "output": "..." }
    ]
  }
}
```

Use optional `commitId` to pin to a specific SHA, `workspaceDir` to override the default clone root, and `skipSetup` to opt out of automatic dependency installation. The endpoint responds once the sandbox boots, the repo is cloned, and setup commands succeed; failures are surfaced with structured Daytona error codes.

## Workspace Scripts

All scripts can be run from the root:

- `npm run dev` - Start all apps in development mode
- `npm run build` - Build all apps
- `npm run type-check` - Type check all apps
- `npm run dev:web` - Start only the web app
- `npm run dev:server` - Start only the server
- `npm run build:web` - Build only the web app
- `npm run build:server` - Build only the server

