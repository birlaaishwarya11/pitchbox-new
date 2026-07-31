# ADR 0005: Authentication and per-user usage limits

- Status: Accepted
- Date: 2026-07-01
- Deciders: aishwaryabirla, Claude

## Context

Pitchbox is being opened up as a public showcase so anyone can generate a demo
video. Two problems appear the moment the link is public:

1. **Anyone can trigger owner-cost work.** Even though users bring their own LLM
   key (ADR 0002 / Phase 2), voiceover runs on the operator's **ElevenLabs**
   key and sandbox recording runs on the operator's **Daytona** account. An open
   endpoint is an open tab on the operator's bill.
2. **The API is bypassable.** The pipeline lives in an Express server separate
   from the Next.js web app. Gating only the UI does nothing — anyone can `curl`
   `/api/pipeline/*` directly.

We need sign-in (to attribute and limit usage) and enforcement in the server
(not just the browser).

## Decision Drivers

- Protect the operator's ElevenLabs/Daytona spend on a public link.
- Enforce auth where the cost is incurred (the server), not only in the UI.
- Keep the existing bring-your-own-LLM-key model unchanged.
- Minimise new infrastructure and operational surface.

## Considered Options

- **Supabase Auth + Postgres** — managed auth (`auth.users`) plus a DB we can
  use for usage counting, one dashboard, generous free tier.
- **Auth.js (NextAuth)** — free, in-repo, but only lives in the Next app; we'd
  still need a separate store for usage and separate server-side token
  verification wiring.
- **Clerk** — fastest drop-in, but another paid third-party and no DB for the
  usage table.
- **Simple shared password** — trivial, but no per-user attribution, so no way
  to enforce per-user limits.

## Decision

Use **Supabase Auth** for sign-in and a single **`pipeline_runs`** table for
usage counting.

- **Web (Next.js):** `@supabase/ssr` client + `middleware.ts` gate on
  `/pipeline` and `/test`; a `/login` page (email/password + optional GitHub
  OAuth) and an `/auth/callback` route. The browser attaches the Supabase
  access token as `Authorization: Bearer <jwt>` on every server call.
- **Server (Express):** a `requireUser` middleware verifies the token via
  `supabase.auth.getUser(token)` using the **service-role** client on every
  `/api/pipeline/*`, `/api/record`, `/api/deploy`, and `/api/test/audio`
  route. Public config routes (`/health`, `/api/providers`,
  `/api/pipeline/stages`, `/api/validate-key`) stay open.
- **Usage limits:** enforced only on **owner-cost** actions — pipeline
  **approve** (voiceover + recording), `/api/record`, `/api/deploy`,
  `/api/test/audio`. Plan/research/script (the user's own LLM key) are
  uncapped. Cap defaults to `RUN_LIMIT_PER_DAY=5`, counted per user per UTC day.
- The server uses the service-role/secret key, which bypasses row-level
  security; `pipeline_runs` has RLS enabled with **no policies**, so no other
  client can read or write it.

## Consequences

- **Good:** operator spend is bounded by a per-user daily cap; the server is the
  authoritative enforcement point, so the UI can't be bypassed; BYO-LLM-key is
  untouched; one managed service covers both auth and the usage store.
- **Cost:** a new external dependency (Supabase) and three new env vars
  (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `RUN_LIMIT_PER_DAY`); the server
  now verifies a token on each protected request (one extra Supabase call).
- **Limits:** the cap counts `count → insert` without a transaction, so a burst
  of simultaneous requests could slip 1–2 over the cap — acceptable for a
  showcase. The `pipeline_runs` row is written at approve time regardless of
  whether generation later falls back to a slate (the ElevenLabs cost is already
  incurred by then).
- **Follow-up:** email confirmation is left to the Supabase project's setting;
  GitHub OAuth requires enabling the provider in the Supabase dashboard.

## References

- ADR 0002 (pipeline architecture, BYO key), ADR 0004 (hosting topology)
- `apps/web/src/lib/supabase/*`, `apps/web/src/middleware.ts`
- `apps/server/src/auth/supabaseAuth.ts`, `apps/server/src/usage/UsageLimiter.ts`
- `supabase/schema.sql`
