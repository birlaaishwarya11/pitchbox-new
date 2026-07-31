import crypto from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AuthSurface } from '../auth/supabaseAuth';

/**
 * Records what people do with Pitchbox — the "heartbeat".
 *
 * Two properties matter more than the schema:
 *
 * 1. It runs SERVER-side. This repo is public, so any counting done inside the
 *    MCP client could be deleted by whoever forked it. Recording here, keyed to
 *    the credential that authenticated the request, is the only measurement
 *    that survives contact with users.
 *
 * 2. It records no user content. Prompts are never stored, and repo/target URLs
 *    are hashed. That still answers "how many distinct projects" and "is one
 *    revisited" without holding private repository names — a real concern when
 *    users bring their own keys and reasonably assume their work stays theirs.
 */

export type UsageEventName =
  | 'pipeline.start'
  | 'pipeline.complete'
  | 'pipeline.error'
  | 'record'
  | 'deploy'
  | 'test-audio';

export interface UsageEventInput {
  userId: string;
  apiKeyId?: string;
  event: UsageEventName;
  surface?: AuthSurface;
  client?: string;
  clientVersion?: string;
  provider?: string;
  model?: string;
  byoLlm?: boolean;
  byoAudio?: boolean;
  /** Raw URL — hashed here, never stored in the clear. */
  target?: string;
  targetKind?: 'repo' | 'url';
  stages?: string[];
  skipRecording?: boolean;
  durationMs?: number;
  status?: 'ok' | 'error';
  errorCode?: string;
}

/**
 * One-way hash of a repo or target URL.
 *
 * Normalised first so the same project counts once however it was typed:
 * casing, a trailing `.git`, and a trailing slash are all noise.
 */
export function hashTarget(url: string): string {
  const normalised = url
    .trim()
    .toLowerCase()
    .replace(/\.git$/, '')
    .replace(/\/+$/, '');
  return crypto.createHash('sha256').update(normalised, 'utf8').digest('hex');
}

export class TelemetryRecorder {
  constructor(private readonly supabase: SupabaseClient) {}

  /**
   * Write one event. Never throws and never blocks the caller: telemetry
   * failing must not take a user's pipeline run down with it.
   */
  record(input: UsageEventInput): void {
    const row = {
      user_id: input.userId,
      api_key_id: input.apiKeyId ?? null,
      event: input.event,
      surface: input.surface ?? 'web',
      client: input.client ?? null,
      client_version: input.clientVersion ?? null,
      provider: input.provider ?? null,
      model: input.model ?? null,
      byo_llm: input.byoLlm ?? null,
      byo_audio: input.byoAudio ?? null,
      target_hash: input.target ? hashTarget(input.target) : null,
      target_kind: input.targetKind ?? null,
      stages: input.stages ?? null,
      skip_recording: input.skipRecording ?? null,
      duration_ms: input.durationMs ?? null,
      status: input.status ?? null,
      error_code: input.errorCode ?? null,
    };

    void this.supabase
      .from('usage_events')
      .insert(row)
      .then(({ error }) => {
        // Logged, not thrown: a dropped analytics row is an acceptable loss,
        // a failed user request is not.
        if (error) console.warn('[telemetry] insert failed:', error.message);
      });
  }
}
