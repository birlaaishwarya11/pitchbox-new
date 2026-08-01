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
 * Thrown when the deployment as a whole has hit its daily cap.
 *
 * Distinct from {@link UsageLimitError} because the cause is different and so is
 * the honest message: the user has done nothing wrong and waiting a day is the
 * only remedy available to them.
 */
export class GlobalUsageLimitError extends Error {
  constructor(
    public readonly limit: number,
    public readonly used: number,
  ) {
    super(
      `This Pitchbox instance has reached its shared daily limit for sandbox recording (${used}/${limit}). ` +
        'Try again tomorrow, or record a deployed URL instead — that path is not capped.',
    );
    this.name = 'GlobalUsageLimitError';
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
    /**
     * Ceiling across ALL users per day.
     *
     * The per-user cap alone does not bound the operator's bill: signup is open,
     * so anyone willing to create N accounts gets N times the per-user
     * allowance. This is the limit that actually caps spend.
     */
    private readonly perDayGlobal: number,
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

  /** How many runs everyone combined has recorded since 00:00 UTC today. */
  async usedTodayGlobal(): Promise<number> {
    const { count, error } = await this.supabase
      .from('pipeline_runs')
      .select('id', { count: 'exact', head: true })
      .gte('created_at', this.startOfUtcDayIso());
    if (error) throw new Error(`global usage lookup failed: ${error.message}`);
    return count ?? 0;
  }

  /**
   * Verify both the global and per-user caps, then record one run. Throws
   * without recording anything if either cap is already reached.
   *
   * The global check runs first: when the instance is saturated, telling one
   * user they personally have runs left would be misleading.
   */
  async consume(userId: string, kind: string): Promise<{ used: number; limit: number }> {
    const globalUsed = await this.usedTodayGlobal();
    if (globalUsed >= this.perDayGlobal) throw new GlobalUsageLimitError(this.perDayGlobal, globalUsed);

    const used = await this.usedToday(userId);
    if (used >= this.perDay) throw new UsageLimitError(this.perDay, used);

    const { error } = await this.supabase.from('pipeline_runs').insert({ user_id: userId, kind });
    if (error) throw new Error(`usage record failed: ${error.message}`);
    return { used: used + 1, limit: this.perDay };
  }
}
