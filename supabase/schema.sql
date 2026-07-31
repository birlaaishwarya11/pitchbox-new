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
