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

const MODEL = 'claude-opus-4-8';
const MAX_TOKENS = 2500;

// Structured-output tool. Forcing the model to answer via this tool means the
// SDK returns a parsed object — no brittle JSON-from-text parsing, and no
// truncation-induced parse failures.
const RESEARCH_TOOL: Anthropic.Tool = {
  name: 'submit_research',
  description: 'Submit the demo-video research findings as structured data.',
  input_schema: {
    type: 'object',
    properties: {
      summary: { type: 'string', description: '2-4 sentence summary of the winning approach for this use case.' },
      dos: { type: 'array', items: { type: 'string' }, description: 'Up to 6 concrete dos.' },
      donts: { type: 'array', items: { type: 'string' }, description: 'Up to 6 concrete donts.' },
      examplesOrPatterns: { type: 'array', items: { type: 'string' }, description: 'Up to 5 patterns or examples.' },
      citations: {
        type: 'array',
        items: {
          type: 'object',
          properties: { title: { type: 'string' }, url: { type: 'string' } },
          required: ['url'],
        },
        description: 'Optional sources; may be empty.',
      },
    },
    required: ['summary', 'dos', 'donts', 'examplesOrPatterns', 'citations'],
  },
};

const SYSTEM = `You are a research agent for demo-video scripts. Use your knowledge of demo-video best practices for hackathons, marketing landing pages, LinkedIn launches, YouTube, and Twitter/X.

Give concrete, actionable guidance specific to the user's use case (audience + goal + tone), not generic video advice. Keep each list to at most 6 short items. Submit your findings by calling the submit_research tool.`;

export class Researcher {
  private readonly client: Anthropic;

  constructor(apiKey: string) {
    if (!apiKey) throw new ResearcherError('Anthropic API key required');
    this.client = new Anthropic({ apiKey });
  }

  async research(input: ResearcherInput): Promise<ResearchArtifact> {
    try {
      const response = await this.client.messages.create({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: SYSTEM,
        tools: [RESEARCH_TOOL],
        tool_choice: { type: 'tool', name: RESEARCH_TOOL.name },
        messages: [{ role: 'user', content: buildUserMessage(input) }],
      });

      const toolUse = response.content.find(
        (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === RESEARCH_TOOL.name,
      );
      if (!toolUse) {
        throw new ResearcherError('Researcher did not return structured output');
      }
      return normalizeResearch(toolUse.input as Record<string, unknown>);
    } catch (error) {
      if (error instanceof ResearcherError) throw error;
      throw new ResearcherError(
        error instanceof Error ? `Researcher failed: ${error.message}` : 'Researcher failed',
        error,
      );
    }
  }
}

function normalizeResearch(input: Record<string, unknown>): ResearchArtifact {
  const arr = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => String(x)) : []);
  return {
    summary: typeof input.summary === 'string' ? input.summary : '',
    dos: arr(input.dos),
    donts: arr(input.donts),
    examplesOrPatterns: arr(input.examplesOrPatterns),
    citations: Array.isArray(input.citations)
      ? (input.citations as any[])
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
