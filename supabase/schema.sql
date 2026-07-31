-- Pitchbox — Supabase schema
-- Run this once in the Supabase dashboard → SQL Editor → New query → Run.
--
-- Auth users live in Supabase's managed `auth.users` table (created for you).
-- This adds the one table we own: a log of owner-cost runs, used to enforce a
-- per-user daily cap (see apps/server/src/usage/UsageLimiter.ts).

create table if not exists public.pipeline_runs (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users (id) on delete cascade,
  kind       text not null default 'run',   -- 'approve' | 'record' | 'deploy' | 'test-audio'
  created_at timestamptz not null default now()
);

-- Fast "how many runs since midnight for this user" lookups.
create index if not exists pipeline_runs_user_created_idx
  on public.pipeline_runs (user_id, created_at desc);

-- Enable row-level security. The server talks to this table with the
-- service_role / secret key, which BYPASSES RLS — so no policies are needed.
-- With RLS on and no policy, anon/authenticated clients are denied all access,
-- which is exactly what we want (only the trusted server writes here).
alter table public.pipeline_runs enable row level security;


-- ---------------------------------------------------------------------------
-- API keys — headless access (MCP server, CLI) without a browser session.
--
-- MCP clients are configured from a static file and cannot run an OAuth flow,
-- so they authenticate with a long-lived token instead of a Supabase JWT.
-- Only the SHA-256 hash is stored: a database leak must not yield usable keys,
-- and the plaintext is shown to the user exactly once at creation.
-- `prefix` is the first few plaintext characters, kept solely so the owner can
-- tell their keys apart in the UI.
-- ---------------------------------------------------------------------------
create table if not exists public.api_keys (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users (id) on delete cascade,
  name         text not null default 'MCP key',
  key_hash     text not null unique,          -- sha256(plaintext), hex
  prefix       text not null,                 -- e.g. 'pbx_live_a1b2c3' (display only)
  created_at   timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at   timestamptz
);

-- Every authenticated request looks a key up by hash, so this index is on the
-- hot path. Partial: revoked keys are never a valid lookup target.
create index if not exists api_keys_hash_idx
  on public.api_keys (key_hash) where revoked_at is null;

create index if not exists api_keys_user_idx
  on public.api_keys (user_id, created_at desc);

alter table public.api_keys enable row level security;


-- ---------------------------------------------------------------------------
-- Usage events — the "heartbeat".
--
-- Recorded SERVER-side, never by the client: this repo is public, so telemetry
-- shipped in the MCP server could simply be deleted by anyone who forked it.
-- Writing events here, keyed off the credential that authenticated the request,
-- is the only counting that cannot be opted out of by editing client code.
--
-- Deliberately stores NO user content. Prompts are never recorded, and repo /
-- target URLs are stored only as a SHA-256 hash, which still supports
-- "how many distinct projects" and "how often is one revisited" without
-- holding private repository names.
-- ---------------------------------------------------------------------------
create table if not exists public.usage_events (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users (id) on delete cascade,
  -- Which credential was used. Null when the request came from the web UI
  -- (Supabase JWT); set when it came from an API key, which is what makes
  -- "web vs MCP" splittable. Keys are kept on delete so history survives.
  api_key_id     uuid references public.api_keys (id) on delete set null,

  event          text not null,               -- 'pipeline.start' | 'pipeline.complete' | 'pipeline.error' | 'record' | 'deploy' | 'test-audio'
  surface        text not null default 'web', -- 'web' | 'mcp' | 'api'
  client         text,                        -- e.g. 'pitchbox-mcp'
  client_version text,

  -- What they built with (never the key itself).
  provider       text,                        -- 'anthropic' | 'openai' | …
  model          text,
  byo_llm        boolean,                     -- did the caller bring their own LLM key?
  byo_audio      boolean,                     -- …and their own ElevenLabs key?

  -- What they built ON. Hash only — see note above.
  target_hash    text,                        -- sha256(githubUrl | recordUrl)
  target_kind    text,                        -- 'repo' | 'url' | null

  stages         text[],                      -- selected pipeline stages
  skip_recording boolean,
  duration_ms    integer,
  status         text,                        -- 'ok' | 'error'
  error_code     text,

  created_at     timestamptz not null default now()
);

-- Dashboard queries are overwhelmingly "recent events, newest first".
create index if not exists usage_events_created_idx
  on public.usage_events (created_at desc);

create index if not exists usage_events_user_created_idx
  on public.usage_events (user_id, created_at desc);

-- Supports "distinct projects" counts without a full scan.
create index if not exists usage_events_target_idx
  on public.usage_events (target_hash) where target_hash is not null;

alter table public.usage_events enable row level security;
