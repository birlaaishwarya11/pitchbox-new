# Deploying Pitchbox

Two pieces: the **web app** (Next.js → Vercel) and the **server** (Express +
ffmpeg + Puppeteer + Daytona → a container host). See
[ADR 0004](adr/0004-media-storage-and-hosting.md) for the rationale.

## 1. Server (container host: Render / Railway / Fly)

The server can't run on serverless — it needs ffmpeg, a real Chromium, and
long-running jobs. A `Dockerfile` is at the repo root.

### Build & run locally
```bash
docker build -t pitchbox-server .
docker run --rm -p 3001:3001 \
  -e ELEVENLABS_API_KEY=... \
  -e ANTHROPIC_API_KEY=...        # optional: server default LLM (users can BYO) \
  -e DAYTONA_API_KEY=...          # required for repo (sandbox) recording \
  -e CORS_ORIGIN=https://your-web.vercel.app \
  -e MEDIA_DIR=/data \
  -v pitchbox-media:/data \
  pitchbox-server
```

### Environment variables
| Var | Required | Purpose |
|---|---|---|
| `ELEVENLABS_API_KEY` | **yes** | Voiceover. The pipeline is disabled without it. |
| `ANTHROPIC_API_KEY` | optional | Server-default LLM. Users can bring their own key per run instead. |
| `DAYTONA_API_KEY` | for repo recording | Sandboxed recording of GitHub repos. |
| `CORS_ORIGIN` | prod | Comma-separated allowed web origin(s). Lock to your Vercel domain. |
| `MEDIA_DIR` | prod | Path for generated media; point at a **mounted persistent volume**. |
| `PORT` | no | Defaults to 3001. |
| `VOICE_ID`, `BLOB_READ_WRITE_TOKEN` | optional | Override ElevenLabs voice / future blob mirror. |

### Host notes
- **Render:** Web Service from the Dockerfile; add a **Disk** mounted at `/data`
  and set `MEDIA_DIR=/data`.
- **Railway:** deploy the Dockerfile; add a **Volume** at `/data`; set `MEDIA_DIR`.
- **Fly:** `fly launch` (uses the Dockerfile); `fly volumes create` and mount at
  `/data`; set `MEDIA_DIR`.
- Without a persistent volume, generated videos are lost on restart (fine for a
  quick demo, not for production).

## 2. Web (Vercel)

- Project root: `apps/web` (or set the Vercel "Root Directory" to `apps/web`).
- Build command: `next build` (default). Output: `.next`.
- Env var: `NEXT_PUBLIC_SERVER_BASE=https://your-server.onrender.com` (the
  deployed server URL).
- Redeploy after the server URL is known.

## 3. Smoke test the deployment
```bash
curl https://your-server.example.com/health           # {"status":"ok"}
curl https://your-server.example.com/api/providers     # provider list
```
Then open the Vercel URL → **Launch the pipeline** → run a no-recording job
(uses the server default key) and confirm you get a final MP4.

## 4. Security note
Recording a **GitHub repo** builds and runs untrusted code — this happens
**only** inside a Daytona sandbox, never on the server host. Recording a
**public URL** just visits the page with headless Chromium on the host, which is
safe. Keep `DAYTONA_API_KEY` set so repo recording stays sandboxed.
