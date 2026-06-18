import Anthropic from '@anthropic-ai/sdk';
import type { PlanArtifact } from './SessionStore';

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

const MODEL = 'claude-opus-4-7';

export class Planner {
  private readonly client: Anthropic;

  constructor(apiKey: string) {
    if (!apiKey) throw new PlannerError('Anthropic API key required');
    this.client = new Anthropic({ apiKey });
  }

  async plan(input: PlannerInput): Promise<PlanArtifact> {
    const defaultDuration = input.defaultDurationSec ?? 90;

    try {
      const response = await this.client.messages.create({
        model: MODEL,
        max_tokens: 1024,
        temperature: 0.4,
        system: SYSTEM,
        messages: [
          {
            role: 'user',
            content: [
              `# User purpose / instructions`,
              input.userPrompt.trim(),
              ``,
              input.repoSummary ? `# Repository summary\n${input.repoSummary.trim()}\n` : '',
              `# Default duration if user didn't specify`,
              `${defaultDuration} seconds`,
              ``,
              `Output JSON only, matching the schema in the system prompt.`,
            ]
              .filter(Boolean)
              .join('\n'),
          },
        ],
      });

      const block = response.content[0];
      if (!block || block.type !== 'text') {
        throw new PlannerError('Unexpected response format from Claude');
      }

      const json = extractJson(block.text);
      return validatePlan(json);
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

function extractJson(text: string): unknown {
  const trimmed = text.trim();
  // Strip ```json fences if the model adds them despite instructions.
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1].trim() : trimmed;
  try {
    return JSON.parse(candidate);
  } catch (e) {
    throw new PlannerError(`Planner returned non-JSON: ${candidate.slice(0, 200)}`);
  }
}

function validatePlan(value: unknown): PlanArtifact {
  if (!value || typeof value !== 'object') throw new PlannerError('Plan must be an object');
  const v = value as Record<string, unknown>;
  const must = (k: string, t: 'string' | 'number') => {
    if (typeof v[k] !== t) throw new PlannerError(`Plan field ${k} must be ${t}`);
  };
  const arr = (k: string) => {
    if (!Array.isArray(v[k])) throw new PlannerError(`Plan field ${k} must be array`);
  };
  must('audience', 'string');
  must('primaryGoal', 'string');
  must('toneAndStyle', 'string');
  must('targetDurationSec', 'number');
  arr('mustCover');
  arr('avoid');
  must('openingHook', 'string');
  must('closingMove', 'string');
  must('notes', 'string');
  return {
    audience: v.audience as string,
    primaryGoal: v.primaryGoal as string,
    toneAndStyle: v.toneAndStyle as string,
    targetDurationSec: v.targetDurationSec as number,
    mustCover: (v.mustCover as unknown[]).map(String),
    avoid: (v.avoid as unknown[]).map(String),
    openingHook: v.openingHook as string,
    closingMove: v.closingMove as string,
    notes: v.notes as string,
  };
}
