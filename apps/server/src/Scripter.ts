import Anthropic from '@anthropic-ai/sdk';
import type { PlanArtifact, ResearchArtifact, ScriptVersion } from './SessionStore';

export interface ScripterInput {
  userPrompt: string;
  plan: PlanArtifact;
  research: ResearchArtifact;
  repoSummary?: string;
  feedback?: string;
  previousScript?: ScriptVersion;
}

export interface ScripterResult {
  fullScript: string;
  estimatedDurationSec: number;
  wordCount: number;
}

export class ScripterError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'ScripterError';
  }
}

const MODEL = 'claude-opus-4-7';

export class Scripter {
  private readonly client: Anthropic;

  constructor(apiKey: string) {
    if (!apiKey) throw new ScripterError('Anthropic API key required');
    this.client = new Anthropic({ apiKey });
  }

  async write(input: ScripterInput): Promise<ScripterResult> {
    try {
      const response = await this.client.messages.create({
        model: MODEL,
        max_tokens: 2048,
        temperature: 0.7,
        system: SYSTEM,
        messages: [{ role: 'user', content: buildUserMessage(input) }],
      });

      const block = response.content[0];
      if (!block || block.type !== 'text') {
        throw new ScripterError('Unexpected response format from Claude');
      }

      const script = block.text.trim();
      const wordCount = script.split(/\s+/).filter(Boolean).length;
      return {
        fullScript: script,
        wordCount,
        estimatedDurationSec: Math.round(wordCount / 2.5),
      };
    } catch (error) {
      if (error instanceof ScripterError) throw error;
      throw new ScripterError(
        error instanceof Error ? `Scripter failed: ${error.message}` : 'Scripter failed',
        error,
      );
    }
  }
}

const SYSTEM = `You write voiceover scripts for software demo videos. The script will be read aloud by a TTS engine, so:

- Spoken English. Short sentences. Active voice.
- No headings, markdown, bullets, emojis, stage directions, or URLs read aloud.
- Hook in the first 5 seconds. Close with the value proposition or CTA.
- Pace: 150 words per minute (~2.5 words per second). Stay within ±15% of target length.

You are given an upstream plan (audience, must-cover, avoid), researched dos/don'ts for the use case, optional repo summary, and possibly a previous script + user feedback. Honor the plan and the research. When user feedback exists, change only what the feedback asks for.

Output ONLY the script text — no preamble, no headings, no closing notes.`;

function buildUserMessage(input: ScripterInput): string {
  const parts: string[] = [];

  parts.push(`# User purpose / instructions`);
  parts.push(input.userPrompt.trim());
  parts.push('');

  parts.push(`# Plan`);
  parts.push(`Audience: ${input.plan.audience}`);
  parts.push(`Primary goal: ${input.plan.primaryGoal}`);
  parts.push(`Tone: ${input.plan.toneAndStyle}`);
  parts.push(`Target duration: ${input.plan.targetDurationSec}s (~${Math.round(input.plan.targetDurationSec * 2.5)} words)`);
  parts.push(`Must cover: ${input.plan.mustCover.join(' | ')}`);
  parts.push(`Avoid: ${input.plan.avoid.join(' | ')}`);
  parts.push(`Opening hook idea: ${input.plan.openingHook}`);
  parts.push(`Closing move: ${input.plan.closingMove}`);
  if (input.plan.notes) parts.push(`Notes: ${input.plan.notes}`);
  parts.push('');

  parts.push(`# Use-case research (dos and don'ts)`);
  parts.push(input.research.summary);
  if (input.research.dos.length) parts.push(`DOs: ${input.research.dos.map((d) => `• ${d}`).join('  ')}`);
  if (input.research.donts.length) parts.push(`DON'Ts: ${input.research.donts.map((d) => `• ${d}`).join('  ')}`);
  if (input.research.examplesOrPatterns.length) {
    parts.push(`Patterns: ${input.research.examplesOrPatterns.map((p) => `• ${p}`).join('  ')}`);
  }
  parts.push('');

  if (input.repoSummary) {
    parts.push(`# Repository summary`);
    parts.push(input.repoSummary.trim());
    parts.push('');
  }

  if (input.previousScript && input.feedback) {
    parts.push(`# Previous script (version ${input.previousScript.versionNumber})`);
    parts.push(input.previousScript.fullScript);
    parts.push('');
    parts.push(`# User feedback on the previous script`);
    parts.push(input.feedback.trim());
    parts.push('');
    parts.push(`Revise the script. Keep what was working; change only what the feedback asks for.`);
  } else {
    parts.push(`Write the full voiceover script as plain prose. Output only the script, nothing else.`);
  }

  return parts.join('\n');
}
