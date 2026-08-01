import type { PlanArtifact, ResearchArtifact } from './SessionStore';
import type { LlmClient } from './llm/LlmClient';
import { parseJsonObject } from './llm/jsonParse';

export interface ResearcherInput {
  userPrompt: string;
  plan: PlanArtifact;
}

export class ResearcherError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'ResearcherError';
  }
}

export class Researcher {
  constructor(private readonly client: LlmClient) {}

  async research(input: ResearcherInput): Promise<ResearchArtifact> {
    try {
      const text = await this.client.chat({
        system: SYSTEM,
        maxTokens: 4096,
        user: buildUserMessage(input),
      });
      const json = parseJsonObject(text);
      if (!json) throw new ResearcherError(`Researcher returned non-JSON: ${text.slice(0, 200)}`);
      return normalizeResearch(json);
    } catch (error) {
      if (error instanceof ResearcherError) throw error;
      throw new ResearcherError(
        error instanceof Error ? `Researcher failed: ${error.message}` : 'Researcher failed',
        error,
      );
    }
  }
}

const SYSTEM = `You are a research agent for demo-video scripts. Use your knowledge of demo-video best practices for hackathons, marketing landing pages, LinkedIn launches, YouTube, and Twitter/X.

Give concrete, actionable guidance specific to the user's use case (audience + goal + tone), not generic video advice. Keep each list to at most 6 short items.

Output strictly this JSON shape, no prose, no markdown fences. Citations may be empty:
{
  "summary": string,
  "dos": string[],
  "donts": string[],
  "examplesOrPatterns": string[],
  "citations": [{ "title": string, "url": string }]
}`;

function normalizeResearch(input: any): ResearchArtifact {
  const v = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const arr = (k: string): string[] => (Array.isArray(v[k]) ? (v[k] as unknown[]).map(String) : []);
  return {
    summary: typeof v.summary === 'string' ? v.summary : '',
    dos: arr('dos'),
    donts: arr('donts'),
    examplesOrPatterns: arr('examplesOrPatterns'),
    citations: Array.isArray(v.citations)
      ? (v.citations as any[])
          .filter((c) => c && typeof c.url === 'string')
          .map((c) => ({ title: String(c.title ?? ''), url: String(c.url) }))
      : [],
  };
}

function buildUserMessage(input: ResearcherInput): string {
  return [
    `# User purpose / instructions`,
    input.userPrompt.trim(),
    ``,
    `# Plan from upstream agent`,
    `audience: ${input.plan.audience}`,
    `primaryGoal: ${input.plan.primaryGoal}`,
    `tone: ${input.plan.toneAndStyle}`,
    `targetDurationSec: ${input.plan.targetDurationSec}`,
    `mustCover: ${input.plan.mustCover.join('; ')}`,
    `avoid: ${input.plan.avoid.join('; ')}`,
    ``,
    `Research dos and don'ts for THIS specific use case (audience + goal + tone), not generic video advice. Be concrete and actionable.`,
  ].join('\n');
}
