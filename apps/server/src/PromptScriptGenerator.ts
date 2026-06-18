import Anthropic from '@anthropic-ai/sdk';

export interface PromptScriptInput {
  userPrompt: string;
  projectContext?: string;
  targetDurationSec?: number;
  feedback?: string;
  previousScript?: string;
}

export interface PromptScriptResult {
  fullScript: string;
  estimatedDurationSec: number;
  wordCount: number;
  model: string;
}

export class PromptScriptGeneratorError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'PromptScriptGeneratorError';
  }
}

const MODEL = 'claude-opus-4-7';

export class PromptScriptGenerator {
  private readonly client: Anthropic;

  constructor(apiKey?: string) {
    if (!apiKey) {
      throw new PromptScriptGeneratorError('Anthropic API key is required');
    }
    this.client = new Anthropic({ apiKey });
  }

  async generate(input: PromptScriptInput): Promise<PromptScriptResult> {
    const targetDurationSec = input.targetDurationSec ?? 90;

    if (!input.userPrompt?.trim()) {
      throw new PromptScriptGeneratorError('userPrompt is required');
    }

    try {
      const response = await this.client.messages.create({
        model: MODEL,
        max_tokens: 2048,
        temperature: 0.7,
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: 'user',
            content: buildUserPrompt(input, targetDurationSec),
          },
        ],
      });

      const block = response.content[0];
      if (!block || block.type !== 'text') {
        throw new PromptScriptGeneratorError('Unexpected response format from Claude');
      }

      const script = block.text.trim();
      const wordCount = script.split(/\s+/).filter(Boolean).length;

      return {
        fullScript: script,
        wordCount,
        estimatedDurationSec: Math.round(wordCount / 2.5),
        model: MODEL,
      };
    } catch (error) {
      if (error instanceof PromptScriptGeneratorError) throw error;
      throw new PromptScriptGeneratorError(
        error instanceof Error ? `Anthropic call failed: ${error.message}` : 'Anthropic call failed',
        error,
      );
    }
  }
}

const SYSTEM_PROMPT = `You write voiceover scripts for software demo videos. The script you produce will be read aloud by a text-to-speech system, so:

- Write spoken English. Short sentences. Active voice.
- No headings, no markdown formatting, no stage directions like "[pause]".
- No emojis. No bullet points. No URLs read aloud.
- Hook in the first 5 seconds. Close with the value proposition.
- Pace target: 150 words per minute (~2.5 words per second).
- Adapt tone, focus, and length to the user's stated purpose (marketing, hackathon submission, YouTube demo, LinkedIn post, etc.).`;

function buildUserPrompt(input: PromptScriptInput, targetDurationSec: number): string {
  const targetWords = Math.round(targetDurationSec * 2.5);

  const parts: string[] = [];
  parts.push(`# Purpose / instructions from user`);
  parts.push(input.userPrompt.trim());
  parts.push('');

  if (input.projectContext?.trim()) {
    parts.push(`# Project context`);
    parts.push(input.projectContext.trim());
    parts.push('');
  }

  parts.push(`# Target length`);
  parts.push(`${targetDurationSec} seconds (~${targetWords} words). Stay within ±15%.`);
  parts.push('');

  if (input.previousScript && input.feedback) {
    parts.push(`# Previous script`);
    parts.push(input.previousScript.trim());
    parts.push('');
    parts.push(`# User feedback on the previous script`);
    parts.push(input.feedback.trim());
    parts.push('');
    parts.push(
      `Revise the script to incorporate the feedback. Keep what was working; change only what the feedback asks for.`,
    );
  } else {
    parts.push(`Write the full voiceover script as plain prose. Output only the script, nothing else.`);
  }

  return parts.join('\n');
}
