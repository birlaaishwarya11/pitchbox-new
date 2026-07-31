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
  -e SUPABASE_URL=... \
  -e SUPABASE_SERVICE_ROLE_KEY=... \
  -e DAYTONA_API_KEY=...          # required for repo (sandbox) recording \
  -e CORS_ORIGIN=https://your-web.vercel.app \
  -e MEDIA_DIR=/data \
  -v pitchbox-media:/data \
  pitchbox-server

# Self-hosting and want the server's own LLM/voice keys used as a fallback?
# Add: -e PITCHBOX_ALLOW_SERVER_KEYS=true -e ANTHROPIC_API_KEY=... -e ELEVENLABS_API_KEY=...
```

### Environment variables
| Var | Required | Purpose |
|---|---|---|
| `SUPABASE_URL` | **yes** | Supabase project URL — required for auth + usage limits. |
| `SUPABASE_SERVICE_ROLE_KEY` | **yes** | Supabase service_role/secret key. Server-only — protected routes return 503 without it. |
| `DAYTONA_API_KEY` | for repo recording | Sandboxed recording of GitHub repos. The operator's only per-run cost. |
| `RUN_LIMIT_PER_DAY` | no | **Daytona-backed** runs per user per day. Defaults to 5. Voiceover/LLM are uncapped. |
| `CORS_ORIGIN` | prod | Comma-separated allowed web origin(s). Lock to your Vercel domain. |
| `MEDIA_DIR` | prod | Path for generated media; point at a **mounted persistent volume**. |
| `PORT` | no | Defaults to 3001. |
| `PITCHBOX_ALLOW_SERVER_KEYS` | **leave unset in prod** | See below. |
| `ANTHROPIC_API_KEY`, `ELEVENLABS_API_KEY` | self-host only | Ignored unless the flag above is `true`. |
| `VOICE_ID`, `BLOB_READ_WRITE_TOKEN` | optional | Override ElevenLabs voice / future blob mirror. |

### Bring-your-own-keys (important)

Pitchbox is BYOK by default: every run supplies its own LLM and ElevenLabs key,
so a public deployment costs you nothing but Daytona. `ANTHROPIC_API_KEY` and
`ELEVENLABS_API_KEY` are **ignored** unless `PITCHBOX_ALLOW_SERVER_KEYS=true`.

Leave that flag unset on any deployment strangers can reach. It is opt-in
precisely so that forgetting it is free — the opposite default would quietly
fund every visitor. Self-hosters set it to `true` to use env keys as before.

See [ADR 0006](adr/0006-headless-access-byok-and-usage-telemetry.md).

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
curl https://your-server.example.com/api/providers     # providers + capabilities
```
`/api/providers` also reports `hasServerAudio` and `hasSandboxRecording`. On a
correctly configured public deployment `hasServerAudio` and `hasServerDefault`
should both be **false** — if either is true, you are paying for your users.

Then open the Vercel URL → **Launch the pipeline** → paste your own LLM and
ElevenLabs keys → run a no-recording job and confirm you get a final MP4.

## 4. Headless access (MCP)

Users can drive Pitchbox from Claude Code / Claude Desktop instead of the web UI.
They generate an API key at `/settings/keys` and configure the MCP server in
[`skills/pitchbox/INSTALL.md`](../skills/pitchbox/INSTALL.md).

Nothing extra to deploy — the MCP server runs on the user's machine and talks to
this same HTTP API. Just make sure `CORS_ORIGIN` does not block it: CORS applies
to browsers only, so MCP traffic is unaffected.

## 5. Usage telemetry

The server records a usage event per action into `usage_events`: what ran, when,
web vs MCP, provider/model, outcome, and a **SHA-256 hash** of the repo/target
URL. Prompts, scripts and API keys are never stored.

Recording happens server-side deliberately — this repo is public, so telemetry
in the MCP client could simply be removed by a forker. See
[ADR 0006](adr/0006-headless-access-byok-and-usage-telemetry.md).

## 6. Security note
Recording a **GitHub repo** builds and runs untrusted code — this happens
**only** inside a Daytona sandbox, never on the server host. Recording a
**public URL** just visits the page with headless Chromium on the host, which is
safe. Keep `DAYTONA_API_KEY` set so repo recording stays sandboxed.
