import Anthropic from '@anthropic-ai/sdk';
import type { ChatInput, LlmClient } from './LlmClient';
import { LlmError, llmErrorFromStatus } from './LlmClient';

export class AnthropicClient implements LlmClient {
  readonly providerId = 'anthropic';
  readonly providerLabel = 'Anthropic (Claude)';
  private readonly client: Anthropic;

  constructor(apiKey: string, public readonly model: string) {
    this.client = new Anthropic({ apiKey });
  }

  async chat(input: ChatInput): Promise<string> {
    try {
      // Note: current Opus models reject `temperature`, so we omit it.
      const res = await this.client.messages.create({
        model: this.model,
        max_tokens: input.maxTokens,
        system: input.system,
        messages: [{ role: 'user', content: input.user }],
      });
      const text = res.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('');
      if (!text.trim()) throw new LlmError('unknown', 'Empty response from Anthropic.');
      return text;
    } catch (err) {
      throw toLlmError(err);
    }
  }
}

function toLlmError(err: unknown): LlmError {
  if (err instanceof LlmError) return err;
  const status = (err as any)?.status as number | undefined;
  const message = (err as any)?.error?.error?.message ?? (err as any)?.message;
  if (typeof status === 'number') return llmErrorFromStatus(status, message);
  return new LlmError('network', message ? `Anthropic request failed: ${message}` : 'Anthropic request failed', undefined, err);
}
