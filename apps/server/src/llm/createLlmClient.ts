import type { LlmClient } from './LlmClient';
import { LlmError } from './LlmClient';
import { AnthropicClient } from './AnthropicClient';
import { OpenAICompatClient } from './OpenAICompatClient';
import { getProvider } from './providers';

export interface LlmConfig {
  provider: string;
  apiKey: string;
  model: string;
}

export function createLlmClient(config: LlmConfig): LlmClient {
  const provider = getProvider(config.provider);
  if (!provider) {
    throw new LlmError('bad_request', `Unknown provider: ${config.provider}`);
  }
  if (!config.apiKey || !config.apiKey.trim()) {
    throw new LlmError('invalid_key', 'An API key is required.');
  }
  if (!config.model || !config.model.trim()) {
    throw new LlmError('bad_request', 'A model is required.');
  }

  if (provider.adapter === 'anthropic') {
    return new AnthropicClient(config.apiKey, config.model);
  }
  if (!provider.baseUrl) {
    throw new LlmError('bad_request', `Provider ${provider.id} is missing a base URL.`);
  }
  return new OpenAICompatClient(provider.id, provider.label, provider.baseUrl, config.apiKey, config.model);
}

export interface ValidateResult {
  ok: boolean;
  kind?: string;
  message?: string;
}

/**
 * Validate a key + model with a tiny live request. Returns a structured result
 * rather than throwing, so the endpoint can report a clean pass/fail.
 */
export async function validateLlmKey(config: LlmConfig): Promise<ValidateResult> {
  let client: LlmClient;
  try {
    client = createLlmClient(config);
  } catch (err) {
    if (err instanceof LlmError) return { ok: false, kind: err.kind, message: err.message };
    return { ok: false, kind: 'unknown', message: String((err as any)?.message ?? err) };
  }

  try {
    await client.chat({ system: 'You are a connectivity check.', user: 'Reply with "ok".', maxTokens: 5 });
    return { ok: true };
  } catch (err) {
    if (err instanceof LlmError) return { ok: false, kind: err.kind, message: err.message };
    return { ok: false, kind: 'unknown', message: String((err as any)?.message ?? err) };
  }
}
