// Unified interface the pipeline agents use, so they are provider-agnostic.

export interface ChatInput {
  system: string;
  user: string;
  maxTokens: number;
}

export interface LlmClient {
  readonly providerId: string;
  readonly providerLabel: string;
  readonly model: string;
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
  ) {
    super(message);
    this.name = 'LlmError';
  }
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
