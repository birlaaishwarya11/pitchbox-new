# Deploying Pitchbox

Two pieces: the **web app** (Next.js → Vercel) and the **server** (Express +
ffmpeg + Puppeteer + Daytona → a container host). See
[ADR 0004](adr/0004-media-storage-and-hosting.md) for the rationale.

## 0. Supabase (auth + usage limits)

Sign-in and the per-user run cap are backed by Supabase (see
[ADR 0005](adr/0005-auth-and-usage-limits.md)). Set this up first.

1. Create a project at [supabase.com](https://supabase.com). From
   **Settings → API** copy: the **Project URL**, the **anon / publishable**
   key (browser-safe), and the **service_role / secret** key (server-only).
2. In **SQL Editor → New query**, paste and run [`supabase/schema.sql`](../supabase/schema.sql)
   to create the `pipeline_runs` table.
3. (Optional) enable **GitHub** under **Authentication → Providers** if you want
   the "Continue with GitHub" button; add the callback
   `https://<your-web-domain>/auth/callback`.
4. For a smooth demo you can turn **off** email confirmation under
   **Authentication → Providers → Email** (otherwise new sign-ups must confirm
   via email before they can sign in).

⚠️ The **service_role / secret** key must only ever live in the **server** env.
Never put it in a `NEXT_PUBLIC_*` variable — those ship to every browser.

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
| `SUPABASE_URL` | **yes** | Supabase project URL — required for auth + usage limits. |
| `SUPABASE_SERVICE_ROLE_KEY` | **yes** | Supabase service_role/secret key. Server-only — protected routes return 503 without it. |
| `RUN_LIMIT_PER_DAY` | no | Owner-cost runs per user per day. Defaults to 5. |
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
- Env vars:
  - `NEXT_PUBLIC_SERVER_BASE=https://your-server.onrender.com` (the deployed server URL)
  - `NEXT_PUBLIC_SUPABASE_URL=https://<ref>.supabase.co`
  - `NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon / publishable key>` (browser-safe; never the service_role key)
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
