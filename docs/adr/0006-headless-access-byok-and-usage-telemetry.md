# ADR 0006: Headless access (MCP), full bring-your-own-keys, and usage telemetry

- Status: Accepted
- Date: 2026-07-31
- Deciders: aishwaryabirla, Claude

## Context

Three pressures arrived together, and they turn out to be one decision.

1. **People want Pitchbox without the UI.** Generating a demo video is a natural
   thing to ask for from inside an editor — "make a demo of this repo" — where
   the codebase is already open. That means an MCP server and a Claude skill.

2. **The operator's keys cannot fund a public tool.** ADR 0005 capped runs to
   protect the operator's ElevenLabs and Daytona spend, but a cap is a ceiling
   on the bill, not an elimination of it. With the app publicly deployed, the
   operator does not want to give away Anthropic or ElevenLabs credits at all.

3. **There is no visibility into usage.** `pipeline_runs` records only
   `user_id, kind, created_at` — enough to enforce a cap, useless for learning
   what people build, which providers they choose, or where runs fail.

These interact. Opening a headless surface widens who can spend the operator's
keys, which forces the BYOK question; and a headless surface is invisible unless
usage is recorded deliberately.

A fourth constraint shapes the telemetry answer: **this repository is public.**

## Decision Drivers

- Zero marginal cost per user on the hosted deployment.
- Headless clients cannot run a browser OAuth flow.
- Usage data must be trustworthy, and must not compromise users who bring their
  own keys and reasonably expect their work to stay private.
- Keep self-hosting pleasant — a local instance should still be able to use env
  keys without ceremony.

## Considered Options

### Headless authentication

- **Long-lived API keys** — a `pbx_live_…` token generated in the web UI and
  pasted into the MCP config. Familiar (Stripe/OpenAI), revocable, and a natural
  join key for per-user telemetry.
- **Paste a Supabase refresh token** — no new table, but tokens are awkward to
  find, cannot be revoked individually, and leak Supabase internals to users.
- **Remote MCP with OAuth** — best eventual UX, no token pasting, but
  substantially more work and narrower client support today.

### Key ownership

- **LLM only from the user** — status quo; operator keeps paying for voice.
- **LLM + ElevenLabs from the user** — operator cost approaches zero.
- **Tiered free allowance** — best adoption curve, most branching logic.

### Telemetry depth

- **Metadata only** — how the tool is used, nothing about what is built.
- **Metadata + hashed identifiers** — adds a SHA-256 of the repo/target URL.
- **Full content** — store prompts and repo URLs verbatim.

## Decision

**Headless auth: API keys.** A new `api_keys` table stores only
`sha256(plaintext)`; the key is displayed once at creation and is not
recoverable. Keys are *revoked*, never deleted, because `usage_events` reference
them and the history of what a key did outlives the key.

API keys are explicitly **barred from managing API keys** (`requireUser({ jwtOnly: true })`
on `/api/keys`). Otherwise one leaked key would be self-renewing, and revocation
would not actually revoke anything.

A plain SHA-256 is used rather than bcrypt/argon2. These are 256 bits of CSPRNG
output, so there is no dictionary to attack; the deliberate slowness of a
password hash would buy nothing and would rule out an indexed lookup.

**Key ownership: users bring both LLM and ElevenLabs keys.** Server-side
`ANTHROPIC_API_KEY` / `ELEVENLABS_API_KEY` are ignored unless
`PITCHBOX_ALLOW_SERVER_KEYS=true`.

The flag is **opt-in, not opt-out**, and this is the whole point: forgetting to
set it costs nothing, whereas forgetting to unset a key on a public deployment
would quietly fund every stranger who found the link. The failure mode of the
safe default is a clear error; the failure mode of the unsafe default is a
silent bill.

Because voiceover is now billed per user, `AudioGenerator` moves from a
process-wide singleton into the orchestrator's existing per-session agents map.

**Daytona stays on the operator's key**, capped. It is the highest-friction key
for a user to obtain, and requiring it would make the tool unusable for most
people. Consequently the daily cap is **rescoped to Daytona-backed actions only**
(repo recording and deploy). Voiceover, LLM calls, and plain-URL recording are
paid for by the user or cost only host CPU, so capping them punished users for
spending their own money.

**Telemetry: metadata plus hashed identifiers, recorded server-side.**

Server-side is not an implementation detail — it is the decision. This repo is
public, so any counting done inside the MCP client can be deleted by whoever
forks it, and the resulting numbers would under-count in exactly the population
worth understanding. Recording in the server, keyed to the credential that
authenticated the request, is the only measurement that survives contact with
users.

`usage_events` stores the action, timestamp, surface (web vs MCP), provider and
model, whether keys were brought, selected stages, outcome, and error code. Repo
and target URLs are stored **only as SHA-256**, normalised so the same project
hashes identically however it was typed. Prompts, scripts, and keys are never
stored.

The hash is what makes "how many distinct projects" and "is one revisited"
answerable without holding private repository names — which matters because
users bringing their own keys are, in effect, being told their work is theirs.

## Consequences

**Good**

- Hosted Pitchbox costs the operator nothing but Daytona.
- Pitchbox is usable from Claude Code / Desktop, where the code already is.
- Usage is measurable, and the measurement cannot be silently disabled.
- Self-hosting keeps the old convenience behind one explicit flag.

**Bad / accepted**

- Higher setup friction: users now need three keys (Pitchbox, LLM, ElevenLabs)
  before their first video. The MCP server fails fast with an explicit message
  naming the missing variable, but this is real friction and will cost adopters.
- Hashed targets are one-way. If a future question needs the actual URLs, the
  historical data cannot answer it — deliberately.
- API keys are long-lived. Rotation is manual, and a leaked key is valid until
  someone notices and revokes it. Mitigated by `last_used_at` and by keys being
  unable to mint more keys.
- `usage_events` grows unboundedly; it will eventually need retention.
- No admin dashboard yet — data is being collected before anything surfaces it.
  This is the intended order: collection is the irreversible part (data not
  captured today cannot be recovered), visualisation is not.

**Neutral**

- `zod` is pinned to `^4` in `apps/mcp` to match the MCP SDK's own copy. With
  `^3.23`, npm deduped to the 3.23.8 that puppeteer's `chromium-bidi` requires,
  which predates Standard Schema and fails to typecheck against `registerTool`.

## References

- ADR 0005 — the auth and cap model this revises
- `supabase/schema.sql` — `api_keys`, `usage_events`
- `apps/server/src/usage/TelemetryRecorder.ts` — why counting is server-side
- `apps/mcp/` — the MCP server
- `skills/pitchbox/` — the Claude skill and install guide
