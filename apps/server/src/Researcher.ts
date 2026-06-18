import Anthropic from '@anthropic-ai/sdk';
import type { PlanArtifact, ResearchArtifact } from './SessionStore';

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

const MODEL = 'claude-opus-4-7';

export class Researcher {
  private readonly client: Anthropic;

  constructor(apiKey: string) {
    if (!apiKey) throw new ResearcherError('Anthropic API key required');
    this.client = new Anthropic({ apiKey });
  }

  async research(input: ResearcherInput): Promise<ResearchArtifact> {
    const userMessage = buildUserMessage(input);

    // First try with Anthropic's native server-side web_search tool.
    // If unavailable on this account / SDK version, fall back to library knowledge.
    try {
      return await this.researchWithWebSearch(userMessage);
    } catch (error) {
      console.warn(
        '[Researcher] web_search tool unavailable, falling back to library knowledge:',
        error instanceof Error ? error.message : error,
      );
      return await this.researchFromLibrary(userMessage);
    }
  }

  private async researchWithWebSearch(userMessage: string): Promise<ResearchArtifact> {
    // Cast to any: the typed Anthropic SDK may not yet expose web_search; the API accepts it.
    const response: any = await (this.client.messages.create as any)({
      model: MODEL,
      max_tokens: 1500,
      temperature: 0.3,
      system: SYSTEM_WITH_SEARCH,
      tools: [
        {
          type: 'web_search_20250305',
          name: 'web_search',
          max_uses: 4,
        },
      ],
      messages: [{ role: 'user', content: userMessage }],
    });

    return parseFinalJson(response, /* expectCitations */ true);
  }

  private async researchFromLibrary(userMessage: string): Promise<ResearchArtifact> {
    const response = await this.client.messages.create({
      model: MODEL,
      max_tokens: 1200,
      temperature: 0.3,
      system: SYSTEM_LIBRARY,
      messages: [{ role: 'user', content: userMessage }],
    });

    return parseFinalJson(response, /* expectCitations */ false);
  }
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

const SYSTEM_WITH_SEARCH = `You are a research agent for demo-video scripts. Use the web_search tool to find current (2026) patterns for the user's specific use case — hackathon submissions, marketing landing pages, LinkedIn launches, YouTube demos, etc.

Search for things like:
- "hackathon demo video tips 2026"
- "<platform> demo video best practices"
- "demo video first 5 seconds hook"

After at most 4 searches, output strictly this JSON shape, no prose, no markdown fences:
{
  "summary": string,
  "dos": string[],
  "donts": string[],
  "examplesOrPatterns": string[],
  "citations": [{ "title": string, "url": string }]
}`;

const SYSTEM_LIBRARY = `You are a research agent for demo-video scripts. Web search is unavailable, so use your training knowledge of demo-video best practices for hackathons, marketing, LinkedIn, YouTube, and Twitter/X.

Be concrete. Output strictly this JSON shape, no prose, no markdown fences. Citations may be empty:
{
  "summary": string,
  "dos": string[],
  "donts": string[],
  "examplesOrPatterns": string[],
  "citations": [{ "title": string, "url": string }]
}`;

function parseFinalJson(response: any, expectCitations: boolean): ResearchArtifact {
  // Find the last text block — when web_search runs, the assistant emits tool_use / tool_result
  // blocks in between, and the final structured answer is the trailing text block.
  const blocks: any[] = response.content || [];
  const lastText = [...blocks].reverse().find((b) => b?.type === 'text');
  if (!lastText || typeof lastText.text !== 'string') {
    throw new ResearcherError('Researcher produced no text block');
  }

  const trimmed = lastText.text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1].trim() : trimmed;

  let parsed: any;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    throw new ResearcherError(`Researcher returned non-JSON: ${candidate.slice(0, 200)}`);
  }

  return {
    summary: String(parsed.summary || ''),
    dos: Array.isArray(parsed.dos) ? parsed.dos.map(String) : [],
    donts: Array.isArray(parsed.donts) ? parsed.donts.map(String) : [],
    examplesOrPatterns: Array.isArray(parsed.examplesOrPatterns) ? parsed.examplesOrPatterns.map(String) : [],
    citations: Array.isArray(parsed.citations)
      ? parsed.citations
          .filter((c: any) => c && typeof c.url === 'string')
          .map((c: any) => ({ title: String(c.title || ''), url: String(c.url) }))
      : [],
  };
}
