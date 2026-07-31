import type { SupabaseClient } from '@supabase/supabase-js';

/** Thrown when a user has hit their daily run cap. */
export class UsageLimitError extends Error {
  constructor(
    public readonly limit: number,
    public readonly used: number,
  ) {
    super(`Daily limit reached (${used}/${limit} runs today). Try again tomorrow.`);
    this.name = 'UsageLimitError';
  }
}

/**
 * Enforces a per-user daily cap on owner-cost actions (voiceover + sandbox
 * recording). Backed by the `pipeline_runs` table in Supabase; the server uses
 * the service-role client so writes bypass row-level security.
 */
export class UsageLimiter {
  constructor(
    private readonly supabase: SupabaseClient,
    private readonly perDay: number,
  ) {}

  private startOfUtcDayIso(): string {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
  }

  /** How many runs the user has recorded since 00:00 UTC today. */
  async usedToday(userId: string): Promise<number> {
    const { count, error } = await this.supabase
      .from('pipeline_runs')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .gte('created_at', this.startOfUtcDayIso());
    if (error) throw new Error(`usage lookup failed: ${error.message}`);
    return count ?? 0;
  }

  /**
   * Verify the user is under the daily cap, then record one run. Throws
   * {@link UsageLimitError} when already at/over the cap (nothing recorded).
   */
  async consume(userId: string, kind: string): Promise<{ used: number; limit: number }> {
    const used = await this.usedToday(userId);
    if (used >= this.perDay) throw new UsageLimitError(this.perDay, used);
    const { error } = await this.supabase.from('pipeline_runs').insert({ user_id: userId, kind });
    if (error) throw new Error(`usage record failed: ${error.message}`);
    return { used: used + 1, limit: this.perDay };
  }
}
