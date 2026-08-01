import type { LlmClient } from './llm/LlmClient';
import { parseJsonObject } from './llm/jsonParse';
import { wrapUntrusted } from './security/untrustedContent';
import type { PageTarget, Shot, ShotPlan } from './cinematics/types';

/**
 * Plans camera moves for the screen recording.
 *
 * Existing behaviour scrolled top-to-bottom at a constant rate, which shows
 * everything and emphasises nothing — the viewer has to work out for themselves
 * which part of the screen the narrator is talking about. This agent decides
 * where the camera looks and when, so the picture follows the sentence.
 *
 * The craft rules in the prompt are taken from how product demos are actually
 * cut, not invented: a zoom that lands off the beat reads as an accident,
 * over-zooming crops away the context that tells a viewer where they are, and
 * constant motion is more tiring than a held frame.
 */

export class CinematographerError extends Error {}

const SYSTEM = `You are a video editor planning camera moves over a screen recording of a web page, timed against a voiceover.

Return ONLY JSON: {"shots":[{"selector":"...","atSec":0,"holdSec":4,"zoom":1.0,"highlight":false}]}

HOW GOOD DEMO VIDEOS ARE CUT — follow these, they are not suggestions:

1. MOTION MUST EARN ITSELF. Every move should reduce the work the viewer does to
   understand what is being said. If a move does not clarify, do not make it. A
   held frame is better than a pointless drift.

2. LAND ON THE BEAT. A push-in that arrives before or after the narration
   mentions the thing feels like an accident. Set atSec so the camera settles as
   the narrator reaches that idea. Read the script's pacing to place them: about
   2.5 words per second of speech.

3. OPEN WIDE. The first shot establishes context — zoom 1.0, held 4-6s, showing
   the top of the page. Viewers decide in the first ten seconds whether to keep
   watching; disorienting them immediately loses them.

4. PUSH IN, THEN RELEASE. Zoom in for a specific point, then return to a wider
   frame. Do not stack consecutive deep zooms — the viewer loses their place.

5. DO NOT OVER-ZOOM. Stay between 1.0 and 1.8. Past that, surrounding context is
   cropped away and the viewer no longer knows where they are on the page.
   Reserve the upper end for genuinely small things like a single button.

6. LET SHOTS BREATHE. Minimum 3s per shot; 4-6s is the comfortable range. Rapid
   cutting reads as nervous. Aim for a visual change roughly every 8-10 seconds
   rather than constant movement.

7. ONE IDEA PER SHOT. Point at the single element the narrator is discussing,
   not a region containing several things.

8. HIGHLIGHT SPARINGLY. Set highlight:true only for something interactive the
   narration is calling out — a button, a field. Highlighting everything is the
   same as highlighting nothing. At most a third of shots.

9. COVER THE WHOLE RUNTIME. Shots should span from 0 to the full duration with
   no gaps. The final shot should ease back out to a wide frame.

10. GO IN DOCUMENT ORDER where the script allows. Jumping up and down the page
    feels chaotic; moving steadily down feels like a tour.

Use ONLY selectors given to you. Do not invent selectors.`;

export interface CinematographerInput {
  /** The approved voiceover, so shots can be timed to what is being said. */
  script: string;
  /** Total runtime to cover, in seconds. */
  durationSec: number;
  /** Candidate elements harvested from the live page. */
  targets: PageTarget[];
}

export class Cinematographer {
  constructor(private readonly client: LlmClient) {}

  async plan(input: CinematographerInput): Promise<ShotPlan> {
    const targetList = input.targets
      .map((t, i) => `${i + 1}. selector=${JSON.stringify(t.selector)} kind=${t.kind} y=${Math.round(t.top)} text=${JSON.stringify(t.text.slice(0, 70))}`)
      .join('\n');

    const text = await this.client.chat({
      system: SYSTEM,
      maxTokens: 8192,
      user: [
        `# Video duration`,
        `${Math.round(input.durationSec)} seconds — shots must cover 0 to ${Math.round(input.durationSec)}.`,
        ``,
        `# Voiceover script (timing reference)`,
        input.script.trim(),
        ``,
        // The page is a third party's content, so it is fenced like any other
        // untrusted input — a page could otherwise put instructions in its own
        // copy and steer the edit.
        wrapUntrusted('Elements available on the page', targetList),
        ``,
        `Output JSON only.`,
      ].join('\n'),
    });

    const json = parseJsonObject(text);
    if (!json || !Array.isArray((json as any).shots)) {
      throw new CinematographerError(`Cinematographer returned non-JSON: ${text.slice(0, 200)}`);
    }

    const known = new Set(input.targets.map((t) => t.selector));
    const shots: Shot[] = ((json as any).shots as any[])
      .map((s) => ({
        selector: String(s.selector ?? ''),
        atSec: Number(s.atSec) || 0,
        holdSec: Math.max(2, Number(s.holdSec) || 4),
        // Clamp rather than trust: an out-of-range zoom is the difference
        // between a polished push-in and an unreadable crop.
        zoom: Math.min(1.8, Math.max(1, Number(s.zoom) || 1)),
        highlight: s.highlight === true,
      }))
      .filter((s) => known.has(s.selector))
      .sort((a, b) => a.atSec - b.atSec);

    if (!shots.length) throw new CinematographerError('Cinematographer produced no usable shots.');
    return { shots };
  }
}
