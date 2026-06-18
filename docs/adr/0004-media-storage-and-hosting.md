# ADR 0004: Media storage and hosting topology

- Status: Accepted
- Date: 2026-06-18
- Deciders: aishwaryabirla, Claude

## Context

Generated media (voiceover mp3, screen-capture mp4, slate png, final mp4) is
written to a local `recordings/` directory and served as static files under
`/sessions`. For hosting we must decide:

1. **Where the server runs.** It shells out to `ffmpeg`, drives **Puppeteer
   Chromium**, runs long (minutes-long) jobs, and calls **Daytona**. None of
   that fits Vercel/Netlify serverless functions.
2. **Where generated media lives.** A container's local disk is **ephemeral** —
   files vanish on restart/redeploy, and don't exist across multiple instances.

## Decision

**Hosting topology (per ADR direction):**
- **Web (Next.js) → Vercel.**
- **Server (Express + ffmpeg + Puppeteer + Daytona) → a container host**
  (Render / Railway / Fly). A `Dockerfile` is provided at the repo root. The
  server runs via `tsx` (not a `tsc` build) because it bundles its in-sandbox
  recorder from `.ts` source at runtime via esbuild — a `dist/`-only image would
  drop those files.

**Media storage (v1):** serve from the container's filesystem, but make the
directory configurable via **`MEDIA_DIR`** so it can point at a **mounted
persistent volume** (Render Disk / Railway Volume / Fly Volume). This keeps v1
dependency-free and works for a single instance.

**Upgrade path (documented, not yet built):** for multi-instance or
durable-across-redeploy storage, mirror finished media to **Vercel Blob**
(`BLOB_READ_WRITE_TOKEN` is already referenced) or S3, and return the blob URL as
`finalVideo.url`. This is a clean follow-up because the orchestrator already
centralises the place where media URLs are produced.

## Consequences

- A single containerised server instance with a persistent volume is sufficient
  for v1; set `MEDIA_DIR` to the mounted path.
- Horizontal scaling or guaranteed durability across redeploys requires the blob
  upgrade — call it out before scaling past one instance.
- Prod config knobs: `MEDIA_DIR`, `CORS_ORIGIN` (lock to the Vercel web origin),
  `PORT`, plus the existing keys (`ELEVENLABS_API_KEY`, `ANTHROPIC_API_KEY` or
  per-request BYO, `DAYTONA_API_KEY`). The web app sets `NEXT_PUBLIC_SERVER_BASE`
  to the deployed server URL.
- Security: recording untrusted GitHub repos happens **only** inside Daytona
  sandboxes, never on the host (see [ADR 0002](0002-pipeline-architecture.md)).
