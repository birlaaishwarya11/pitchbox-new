import type { ChatInput, LlmClient } from './LlmClient';
import { LlmError, llmErrorFromStatus } from './LlmClient';

/**
 * Adapter for any provider that implements the OpenAI `chat/completions` API
 * (OpenAI, Google Gemini's compat endpoint, Groq, Mistral, OpenRouter, …).
 * Differentiated only by base URL + model + key.
 */
export class OpenAICompatClient implements LlmClient {
  constructor(
    public readonly providerId: string,
    public readonly providerLabel: string,
    private readonly baseUrl: string,
    private readonly apiKey: string,
    public readonly model: string,
  ) {}

  async chat(input: ChatInput): Promise<string> {
    const url = `${this.baseUrl.replace(/\/$/, '')}/chat/completions`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          // Omit temperature: some models (e.g. OpenAI o1) reject it, and we
          // don't need it. max_completion_tokens is the newer field; max_tokens
          // is still widely accepted — send max_tokens for broad compatibility.
          max_tokens: input.maxTokens,
          messages: [
            { role: 'system', content: input.system },
            { role: 'user', content: input.user },
          ],
        }),
      });
    } catch (err) {
      throw new LlmError('network', `Could not reach ${this.providerLabel}.`, undefined, err);
    }

    if (!res.ok) {
      let providerMessage: string | undefined;
      try {
        const body: any = await res.json();
        providerMessage = body?.error?.message ?? body?.message ?? body?.error;
      } catch {
        providerMessage = await res.text().catch(() => undefined);
      }
      throw llmErrorFromStatus(res.status, providerMessage);
    }

    let body: any;
    try {
      body = await res.json();
    } catch (err) {
      throw new LlmError('unknown', `${this.providerLabel} returned a non-JSON response.`, res.status, err);
    }
    const text: string | undefined = body?.choices?.[0]?.message?.content;
    if (!text || !text.trim()) {
      throw new LlmError('unknown', `${this.providerLabel} returned an empty response.`, res.status);
    }
    return text;
  }
}
