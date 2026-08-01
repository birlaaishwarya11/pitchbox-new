import type { PlanArtifact } from './SessionStore';
import type { LlmClient } from './llm/LlmClient';
import { parseJsonObject } from './llm/jsonParse';
import { wrapUntrusted } from './security/untrustedContent';

export interface PlannerInput {
  userPrompt: string;
  repoSummary?: string;
  defaultDurationSec?: number;
}

export class PlannerError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'PlannerError';
  }
}

export class Planner {
  constructor(private readonly client: LlmClient) {}

  async plan(input: PlannerInput): Promise<PlanArtifact> {
    const defaultDuration = input.defaultDurationSec ?? 90;
    try {
      const text = await this.client.chat({
        system: SYSTEM,
        maxTokens: 4096,
        user: [
          `# User purpose / instructions`,
          input.userPrompt.trim(),
          ``,
          input.repoSummary ? wrapUntrusted('Repository summary', input.repoSummary) : '',
          `# Default duration if user didn't specify`,
          `${defaultDuration} seconds`,
          ``,
          `Output JSON only, matching the schema in the system prompt.`,
        ]
          .filter(Boolean)
          .join('\n'),
      });

      const json = parseJsonObject(text);
      if (!json) throw new PlannerError(`Planner returned non-JSON: ${text.slice(0, 200)}`);
      return coercePlan(json, defaultDuration);
    } catch (error) {
      if (error instanceof PlannerError) throw error;
      throw new PlannerError(
        error instanceof Error ? `Planner failed: ${error.message}` : 'Planner failed',
        error,
      );
    }
  }
}

const SYSTEM = `You are a video-strategy agent. Given a free-form user purpose and (optionally) a repo summary, produce a JSON plan that downstream agents will use to research and write a script.

Decide the audience, primary goal, tone, target duration, must-cover beats, things to avoid, opening hook, closing move, and any judgment-call notes.

Calibrate by purpose:
- "hackathon submission" → 90–180s, judges-skim-fast tone, lead with the magic moment.
- "marketing"/"landing page" → 60–90s, value-prop-first, confident but not jargon-heavy.
- "LinkedIn"/"Twitter" → 30–60s, first-person, ends on a question or invite.
- "YouTube demo" → 120–300s, structured walkthrough, deeper technical detail OK.
- If purpose is ambiguous, pick the most likely audience and say so in notes.

Output strictly this JSON shape, no prose, no markdown fences:
{
  "audience": string,
  "primaryGoal": string,
  "toneAndStyle": string,
  "targetDurationSec": number,
  "mustCover": string[],
  "avoid": string[],
  "openingHook": string,
  "closingMove": string,
  "notes": string
}`;

// Lenient coercion (rather than strict reject) so weaker / non-Anthropic models
// that omit a field still produce a usable plan.
function coercePlan(value: any, defaultDuration: number): PlanArtifact {
  const v = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const str = (k: string, fallback = '') => (typeof v[k] === 'string' ? (v[k] as string) : fallback);
  const arr = (k: string) => (Array.isArray(v[k]) ? (v[k] as unknown[]).map(String) : []);
  const dur = typeof v.targetDurationSec === 'number' && Number.isFinite(v.targetDurationSec)
    ? (v.targetDurationSec as number)
    : defaultDuration;
  return {
    audience: str('audience', 'General audience'),
    primaryGoal: str('primaryGoal', 'Explain what this does and why it matters'),
    toneAndStyle: str('toneAndStyle', 'Clear and confident'),
    targetDurationSec: dur,
    mustCover: arr('mustCover'),
    avoid: arr('avoid'),
    openingHook: str('openingHook'),
    closingMove: str('closingMove'),
    notes: str('notes'),
  };
}
