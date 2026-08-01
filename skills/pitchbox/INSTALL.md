# Using Pitchbox without the web UI

Drive Pitchbox from Claude Code or Claude Desktop: describe the video you want,
approve the script in chat, get an MP4 back.

Pitchbox is **bring-your-own-keys**. You supply the LLM and voiceover keys and
pay for your own usage; nothing is billed to the Pitchbox operator, and your
keys are sent per-request and never stored.

## 1. Get a Pitchbox API key

MCP clients are launched from a static config file and cannot complete a browser
sign-in, so they authenticate with a long-lived key instead of a session.

1. Sign in at <https://pitchbox-gold.vercel.app>.
2. Go to **Settings → API keys**.
3. **Create key**, then copy it. It starts with `pbx_live_`.

The key is shown **once** — it is stored hashed, so it cannot be displayed
again. Lost it? Revoke it and create another.

## 2. Get your provider keys

| Key | Needed for | Where |
|---|---|---|
| LLM key | Planning, research, script writing | [Anthropic](https://console.anthropic.com/settings/keys), [OpenAI](https://platform.openai.com/api-keys), [Groq](https://console.groq.com/keys) (free), [Google AI Studio](https://aistudio.google.com/app/apikey) (free) |
| ElevenLabs key | Voiceover | [elevenlabs.io](https://elevenlabs.io) |

Run `pitchbox_capabilities` after setup to see exactly which providers and
models your server accepts.

## 3. Install the MCP server

The package is not published to npm, so install it from a clone:

```bash
git clone https://github.com/birlaaishwarya11/pitchbox-new.git
cd pitchbox-new
npm install
npm run build --workspace=apps/mcp
```

That produces `apps/mcp/dist/index.js`, which is what you point the client at.

### Claude Code

```bash
claude mcp add pitchbox \
  --env PITCHBOX_API_KEY=pbx_live_xxx \
  --env PITCHBOX_SERVER_BASE=https://3.90.117.18.sslip.io \
  --env PITCHBOX_LLM_PROVIDER=anthropic \
  --env PITCHBOX_LLM_KEY=sk-ant-xxx \
  --env PITCHBOX_LLM_MODEL=claude-sonnet-5 \
  --env ELEVENLABS_API_KEY=xxx \
  -- node /absolute/path/to/pitchbox-new/apps/mcp/dist/index.js
```

### Claude Desktop

Edit `claude_desktop_config.json` (macOS:
`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "pitchbox": {
      "command": "node",
      "args": ["/absolute/path/to/pitchbox-new/apps/mcp/dist/index.js"],
      "env": {
        "PITCHBOX_API_KEY": "pbx_live_xxx",
        "PITCHBOX_SERVER_BASE": "https://3.90.117.18.sslip.io",
        "PITCHBOX_LLM_PROVIDER": "anthropic",
        "PITCHBOX_LLM_KEY": "sk-ant-xxx",
        "PITCHBOX_LLM_MODEL": "claude-sonnet-5",
        "ELEVENLABS_API_KEY": "xxx"
      }
    }
  }
}
```

Restart the client afterwards. Use **absolute paths** — the client does not run
from your project directory.

### Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `PITCHBOX_API_KEY` | **yes** | Your `pbx_live_…` key |
| `PITCHBOX_SERVER_BASE` | **yes** in practice | Pitchbox server URL. Defaults to `http://localhost:3001` |
| `PITCHBOX_LLM_PROVIDER` | yes* | `anthropic`, `openai`, `google`, `groq`, `mistral`, `openrouter` |
| `PITCHBOX_LLM_KEY` | yes* | Your provider key |
| `PITCHBOX_LLM_MODEL` | yes* | Exact model id, e.g. `claude-sonnet-5` |
| `ELEVENLABS_API_KEY` | yes* | Voiceover |

\* Required unless the server is self-hosted with `PITCHBOX_ALLOW_SERVER_KEYS=true`.
Set all three `PITCHBOX_LLM_*` together or none — a partial config is rejected
at startup with an explicit error rather than silently ignored.

## 4. Install the skill (optional)

The MCP tools work on their own. The skill teaches Claude the *workflow* —
especially to show you the script and wait for approval before spending credits.

```bash
mkdir -p ~/.claude/skills
cp -r skills/pitchbox ~/.claude/skills/
```

Use `.claude/skills/` inside a project instead to scope it to that project.

## Try it

> Make me a 60-second demo video of this repo for first-time users.

Claude starts a session, waits for the script, shows it to you, and only builds
the video once you approve.

## Troubleshooting

**Tools don't appear.** Check the client's MCP logs. The server writes
diagnostics to stderr and exits with a clear message if a variable is missing.
Verify the path in your config is absolute and that `dist/index.js` exists.

**"Your Pitchbox API key was rejected."** The key is wrong or revoked. Create a
new one in the web app.

**"Daily limit reached."** Only GitHub-repo recording is capped, because it runs
a sandbox on the operator's account. Recording a deployed URL and
`skipRecording: true` are uncapped.

**Video URL 404s.** Sessions expire about **two hours** after their last update,
and expiry deletes the generated media with them. The files survive server
restarts (they live on a persistent volume), but not that two-hour window — so
download the MP4 reasonably promptly.

## What is recorded about your usage

The server records, per request: which action ran, when, whether it succeeded,
the provider/model name, and a **SHA-256 hash** of the repo or target URL.

It does **not** record your prompts, your scripts, your API keys, or the actual
repo/target URL. The hash allows counting distinct projects without revealing
what they are.
