import Anthropic from '@anthropic-ai/sdk';
import type { ChatInput, LlmClient, LlmUsage } from './LlmClient';
import { LlmError, llmErrorFromStatus, parseRetryAfter, withRetry } from './LlmClient';

export class AnthropicClient implements LlmClient {
  readonly providerId = 'anthropic';
  readonly providerLabel = 'Anthropic (Claude)';
  private readonly client: Anthropic;
  readonly usage: LlmUsage = { inputTokens: 0, outputTokens: 0, calls: 0 };

  constructor(apiKey: string, public readonly model: string) {
    // The SDK retries 429/5xx itself; withRetry below adds another layer so
    // behaviour matches the OpenAI-compatible client, which has none of its own.
    this.client = new Anthropic({ apiKey });
  }

  chat(input: ChatInput): Promise<string> {
    return withRetry(() => this.chatOnce(input), { label: `anthropic/${this.model}` });
  }

  private async chatOnce(input: ChatInput): Promise<string> {
    try {
      // Note: current Opus models reject `temperature`, so we omit it.
      const res = await this.client.messages.create({
        model: this.model,
        max_tokens: input.maxTokens,
        system: input.system,
        messages: [{ role: 'user', content: input.user }],
      });
      this.usage.calls += 1;
      this.usage.inputTokens += res.usage?.input_tokens ?? 0;
      this.usage.outputTokens += res.usage?.output_tokens ?? 0;

      const text = res.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('');
      if (!text.trim()) {
        // Current models think by default, and max_tokens caps thinking AND
        // text together — so a budget sized for the answer alone comes back
        // empty with stop_reason 'max_tokens'. Say that, rather than the
        // useless 'empty response' this used to report.
        if (res.stop_reason === 'max_tokens') {
          throw new LlmError(
            'bad_request',
            `The model used its entire ${input.maxTokens}-token budget on reasoning and returned no text. ` +
              'Raise maxTokens for this stage.',
          );
        }
        throw new LlmError('unknown', 'Empty response from Anthropic.');
      }
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
  if (typeof status === 'number') {
    const mapped = llmErrorFromStatus(status, message);
    const retryAfter = parseRetryAfter((err as any)?.headers?.['retry-after']);
    return retryAfter === undefined
      ? mapped
      : new LlmError(mapped.kind, mapped.message, mapped.status, mapped.cause, retryAfter);
  }
  return new LlmError('network', message ? `Anthropic request failed: ${message}` : 'Anthropic request failed', undefined, err);
}
