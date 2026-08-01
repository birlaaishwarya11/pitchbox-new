// Unified interface the pipeline agents use, so they are provider-agnostic.

export interface ChatInput {
  system: string;
  user: string;
  maxTokens: number;
}

/**
 * Running token totals for one client instance.
 *
 * A client is built per pipeline session, so these totals are the cost of that
 * run. Accumulating here rather than changing `chat()`'s return type keeps the
 * agents unchanged — none of them care about tokens.
 */
export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  calls: number;
}

export interface LlmClient {
  readonly providerId: string;
  readonly providerLabel: string;
  readonly model: string;
  /** Mutated in place as calls complete. Zeroes if the provider reports nothing. */
  readonly usage: LlmUsage;
  chat(input: ChatInput): Promise<string>;
}

export type LlmErrorKind =
  | 'invalid_key' // 401/403
  | 'model_not_found' // 404 / unknown model
  | 'rate_limited' // 429
  | 'bad_request' // 400
  | 'server_error' // 5xx
  | 'network' // could not reach provider
  | 'unknown';

export class LlmError extends Error {
  constructor(
    public readonly kind: LlmErrorKind,
    message: string,
    public readonly status?: number,
    public readonly cause?: unknown,
    /** From a Retry-After header, when the provider sent one. */
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'LlmError';
  }
}

/** Transient failures worth retrying; everything else is the caller's problem. */
const RETRYABLE: ReadonlySet<LlmErrorKind> = new Set(['rate_limited', 'server_error', 'network']);

/** Parse a Retry-After header, which may be seconds or an HTTP date. */
export function parseRetryAfter(header: string | null | undefined): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined;
}

/**
 * Retry a provider call through transient failures.
 *
 * Free tiers — which this app steers users towards — rate-limit aggressively,
 * and a pipeline makes four calls per video. Without this, one 429 fails a
 * whole run and the user loses the work rather than waiting two seconds.
 *
 * Honours Retry-After when the provider sends one, since a guessed backoff is
 * either too short (immediately limited again) or needlessly slow.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: { attempts?: number; baseDelayMs?: number; label?: string } = {},
): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const base = opts.baseDelayMs ?? 1_000;

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const kind = err instanceof LlmError ? err.kind : undefined;
      if (!kind || !RETRYABLE.has(kind) || attempt === attempts) throw err;

      // Exponential backoff with jitter, so concurrent runs don't retry in
      // lockstep and re-trigger the same limit together.
      const backoff = base * 2 ** (attempt - 1);
      const jitter = Math.random() * base;
      const wait = (err as LlmError).retryAfterMs ?? backoff + jitter;
      console.warn(
        `[llm]${opts.label ? ` ${opts.label}` : ''} ${kind} (attempt ${attempt}/${attempts}); retrying in ${Math.round(wait)}ms`,
      );
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastError;
}

/** Map an HTTP status + provider message to a friendly LlmError. */
export function llmErrorFromStatus(status: number, providerMessage: string | undefined): LlmError {
  const msg = providerMessage?.trim();
  if (status === 401 || status === 403) {
    return new LlmError('invalid_key', 'Invalid API key for this provider.', status);
  }
  if (status === 404) {
    return new LlmError('model_not_found', msg || 'Model not found or not available for this key.', status);
  }
  if (status === 429) {
    return new LlmError('rate_limited', msg || 'Rate limited or quota exceeded.', status);
  }
  if (status >= 500) {
    return new LlmError('server_error', msg || 'Provider server error. Try again shortly.', status);
  }
  if (status === 400) {
    // Common shape: unknown model arrives as a 400 on some providers.
    if (msg && /model/i.test(msg) && /(not|unknown|does not|invalid)/i.test(msg)) {
      return new LlmError('model_not_found', msg, status);
    }
    return new LlmError('bad_request', msg || 'Bad request to provider.', status);
  }
  return new LlmError('unknown', msg || `Provider returned HTTP ${status}.`, status);
}
