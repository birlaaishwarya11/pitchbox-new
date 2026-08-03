import type { LlmClient } from './llm/LlmClient';
import { wrapUntrusted } from './security/untrustedContent';
import type { SiteMap } from './cinematics/types';
import type { DummyIdentity } from './cinematics/dummyIdentity';

/**
 * Works out what the product is for, and proposes the flow to demonstrate.
 *
 * The director already turns a site map into camera moves, but it does that
 * silently and in terms of selectors — so nobody saw what the demo was going to
 * *do* until the video existed, and nobody could change the search term it had
 * invented. Pointing it at Google Search makes the gap obvious: knowing there is
 * a text input and a button says nothing about the fact that a search engine
 * demo means searching for something plausible and opening a result.
 *
 * So this proposes the flow in prose, for a human to read and edit. Prose rather
 * than a step table on purpose: "scroll to the end and then back up" is a
 * sentence anyone can write and a form nobody wants to fill in. The edited text
 * then becomes the brief the director works from.
 */

export class FlowPlannerError extends Error {}

const SYSTEM = `You are planning what a screen-recorded product demo will DO. A human will read your answer, edit it, and approve it, so write for them — not for a machine.

Work out, from the screens you are given:

1. WHAT THIS PRODUCT IS. One line. Name it if you recognise it.
2. WHO IT IS FOR AND THE JOB IT DOES. One or two lines.
3. THE FLOW TO DEMONSTRATE. A numbered list of concrete steps, in order. Each step is one action a person would take. Say what gets typed and what gets clicked, in plain words — not selectors.
4. THE INPUTS IT WILL USE. Every value that will be typed, listed as "label: value", so the reader can change any of them.

Rules:

- Demonstrate the product's PURPOSE, not its furniture. A search engine demo means searching for something a real person would search for and opening a result. A todo app means adding tasks and completing one. A dashboard means looking at the thing it monitors. Do not plan a tour of a navigation bar.
- Choose inputs a real user would plausibly type. They appear on camera, so they must read naturally and must not be placeholder gibberish.
- Only plan steps that the screens you were given can actually support. If the product's obvious flow is not reachable, say so in one line under the flow rather than inventing a step.
- Keep it to the number of steps that fits the runtime, at roughly one step every 4-6 seconds.
- Credentials are supplied automatically; refer to them as "the demo account", never as literal values.

Output EXACTLY this shape, as plain text, no markdown fences, no preamble:

What this is: <one line>
Who it is for: <one or two lines>

Flow to demonstrate:
1. <step>
2. <step>

Inputs it will use:
- <label>: <value>`;

export interface FlowPlannerInput {
  /** What the caller asked for overall. */
  userPrompt: string;
  /** The approved voiceover, so the flow matches what will be said. */
  script: string;
  /** Total runtime, to size the number of steps. */
  durationSec: number;
  /** Everywhere the scout reached. */
  siteMap: SiteMap;
  /** The persona whose values will be typed, for context only. */
  identity: DummyIdentity;
  /** The plan being revised, when the caller asked for changes. */
  previous?: string;
  /** What the caller wants different. Free text, in their words. */
  feedback?: string;
}

export class FlowPlanner {
  constructor(private readonly client: LlmClient) {}

  async propose(input: FlowPlannerInput): Promise<string> {
    const parts: string[] = [
      `# What the demo is for`,
      input.userPrompt.trim(),
      ``,
      `# Runtime`,
      `${Math.round(input.durationSec)} seconds.`,
      ``,
      `# The approved voiceover the flow has to match`,
      input.script.trim(),
      ``,
      // The app is a third party's content, fenced like any other untrusted
      // input — a page could otherwise put instructions in its own copy.
      wrapUntrusted('Screens available in this product', describeScreens(input.siteMap)),
      ``,
    ];

    if (input.previous && input.feedback) {
      parts.push(
        `# The plan you proposed last time`,
        input.previous.trim(),
        ``,
        `# What the human wants changed`,
        input.feedback.trim(),
        ``,
        `Rewrite the plan. Change what they asked for and leave the rest alone. If they describe`,
        `steps directly — "scroll to the end then back up, then update the search" — those steps are`,
        `the flow; map them onto the screens you have and keep their order.`,
        ``,
      );
    }

    parts.push(`Output the plan in the exact shape from the system prompt, nothing else.`);

    const text = await this.client.chat({
      system: SYSTEM,
      // Prose for a human, so this stays small; the budget is generous only
      // because current models reason before answering.
      maxTokens: 8_000,
      user: parts.join('\n'),
    });

    const plan = text.trim();
    if (!plan) throw new FlowPlannerError('The flow planner returned nothing.');
    return plan;
  }
}

/** Compact description of what is reachable, for the planner to reason over. */
function describeScreens(siteMap: SiteMap): string {
  const lines: string[] = [`Entry: ${siteMap.entryUrl}`];
  if (siteMap.authUsed) lines.push(`The demo account is already ${siteMap.authUsed === 'signed-in' ? 'signed in' : 'registered'}.`);
  if (siteMap.notes.length) lines.push(`Notes from exploring: ${siteMap.notes.join(' | ')}`);

  for (const screen of siteMap.screens) {
    lines.push('', `## ${screen.path} — "${screen.title}"`);

    const headings = screen.targets.filter((t) => t.kind === 'heading').slice(0, 6);
    if (headings.length) lines.push(`Headings: ${headings.map((t) => t.text).join(' | ')}`);

    const buttons = screen.targets.filter((t) => t.kind === 'button').slice(0, 10);
    if (buttons.length) lines.push(`Buttons: ${buttons.map((t) => t.text).join(' | ')}`);

    for (const form of screen.forms.slice(0, 3)) {
      const fields = form.fields.map((f) => `${f.label || f.name} (${f.kind})`).join(', ');
      lines.push(`Form "${form.label}": ${fields} → submits with "${form.submitText ?? 'unknown'}"`);
    }

    const links = screen.links.slice(0, 8);
    if (links.length) lines.push(`Links: ${links.map((l) => l.text).join(' | ')}`);
  }

  return lines.join('\n');
}
