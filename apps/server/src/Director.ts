import type { LlmClient } from './llm/LlmClient';
import { parseJsonObject } from './llm/jsonParse';
import { wrapUntrusted } from './security/untrustedContent';
import type { Beat, BeatAction, ScreenSnapshot, SiteMap, Walkthrough } from './cinematics/types';
import type { DummyIdentity } from './cinematics/dummyIdentity';

/**
 * Turns the scouted site map into a timed walkthrough.
 *
 * This replaces the old shot planner, which could only decide where to point a
 * camera on a single page — so the best it could ever produce was a well-shot
 * tour of the landing page. Framing and action are planned together here
 * because they are one decision: the push-in onto a button and the click of
 * that button are the same moment in the video, and keeping them in separate
 * lists is how they drift apart.
 *
 * The craft rules in the prompt are taken from how product demos are actually
 * cut, not invented: a zoom that lands off the beat reads as an accident,
 * over-zooming crops away the context that tells a viewer where they are, and
 * constant motion is more tiring than a held frame.
 */

export class DirectorError extends Error {}

/** Ceiling on the push-in. Past a mild move, context is cropped away. */
const MAX_ZOOM = 1.3;
/** Minimum quiet time between camera moves. Faster than this reads as nervous. */
const MIN_CAMERA_GAP_SEC = 3;

const SYSTEM = `You are directing a screen recording of a web app, timed against a finished voiceover. You decide both what the app DOES on camera and where the camera looks.

Return ONLY JSON: {"beats":[{"atSec":0,"action":"hold","selector":"...","url":null,"value":null,"zoom":1.0,"highlight":false,"note":"why, max 8 words"}]}

ACTIONS
- "hold"      — camera only. Settle on an element and stay there.
- "scrollTo"  — camera only. Same as hold; use when simply moving down a page.
- "goto"      — navigate to a URL from the site map. Sets "url", not "selector".
- "click"     — click an element. Use for buttons, links, tabs, submits.
- "type"      — type into a field. Sets "selector" and "value".

THE POINT OF THIS VIDEO
The viewer wants to see the product WORK. A tour of the landing page is a
failure, no matter how well shot. Spend the opening establishing what this is,
then get inside the product and use it: click into it, fill the form, submit it,
show what comes back. Aim to spend well over half the runtime past the landing
page. If the site map contains a signup or app screen, you must reach it.

TYPED VALUES — CRITICAL
Never invent literal names, emails or passwords. Write these tokens instead and
they are substituted at record time:
  {{email}} {{password}} {{name}} {{firstName}} {{lastName}}
  {{username}} {{company}} {{jobTitle}} {{phone}} {{url}}
For anything with no matching token, write a short plausible value.

SEQUENCING
- Beats run in "atSec" order against the wall clock. The app is in whatever
  state earlier beats left it.
- A selector only exists on its own screen. After a "goto" or a navigating
  "click", only use selectors listed under the screen you are now on.
- Typing is visible and takes real time: budget about 2.5 seconds per field,
  and do not schedule the submit click until the typing has finished.
- Leave 1.5-2.5 seconds after a click or submit for the app to respond.

HOW GOOD DEMO VIDEOS ARE CUT — follow these, they are not suggestions:

1. MOTION MUST EARN ITSELF. Every move should reduce the work the viewer does
   to understand what is being said. If a move does not clarify, do not make it.
   A held frame is better than a pointless drift.

2. LAND ON THE BEAT. An action or push-in that arrives before or after the
   narration mentions the thing feels like an accident. Set atSec so the camera
   settles, or the click happens, as the narrator reaches that idea. Read the
   script's pacing to place them: about 2.5 words per second of speech.

3. OPEN WIDE. The first beat establishes context — zoom 1.0, held 4-6s, showing
   the top of the page. Viewers decide in the first ten seconds whether to keep
   watching; disorienting them immediately loses them.

4. THE CAMERA IS RESTRAINED. Zoom stays between 1.0 and 1.3. Most beats should
   be 1.0 to 1.15. Reserve 1.3 for a genuinely small subject — one button, one
   input. Past this the surrounding context is cropped away and the viewer no
   longer knows where they are on the page.

5. PUSH IN, THEN RELEASE. Zoom in for a specific point, then return to a wider
   frame. Do not stack consecutive deep zooms — the viewer loses their place.

6. LET SHOTS BREATHE. At least 3 seconds between camera moves; 4-6s is the
   comfortable range. Aim for a visual change roughly every 8-10 seconds rather
   than constant movement. Interaction is not a camera move: while a form is
   being filled, hold one frame on the form.

7. ONE IDEA PER SHOT. Point at the single element the narration is discussing,
   not a region containing several things.

8. HIGHLIGHT SPARINGLY. Set highlight:true only for something interactive the
   narration is calling out — a button, a field. Highlighting everything is the
   same as highlighting nothing. At most a third of beats.

9. COVER THE WHOLE RUNTIME. Beats must span from 0 to the full duration with no
   gaps. The final beat should ease back out to a wide frame.

Use ONLY selectors and URLs given to you. Do not invent them.`;

export interface DirectorInput {
  /** The approved voiceover, so beats can be timed to what is being said. */
  script: string;
  /** Total runtime to cover, in seconds. */
  durationSec: number;
  /** Everywhere the scout reached. */
  siteMap: SiteMap;
  /** The persona whose values will be typed, for narration alignment. */
  identity: DummyIdentity;
  /**
   * The walkthrough the caller approved, in prose.
   *
   * Authoritative when present: it has been read and possibly rewritten by a
   * human, so it outranks anything this agent would have chosen for itself.
   */
  flowPlan?: string;
  /**
   * The recording opens inside the product because a human already signed in.
   *
   * Set by the caller rather than inferred: the sign-in happened in a browser
   * Pitchbox was handed, not one it drove, so there is nothing in the site map
   * that would reveal it.
   */
  alreadySignedIn?: boolean;
}

export class Director {
  constructor(private readonly client: LlmClient) {}

  async plan(input: DirectorInput): Promise<Walkthrough> {
    const duration = Math.round(input.durationSec);
    const text = await this.client.chat({
      system: SYSTEM,
      // Generous on purpose. Current models reason before answering and the
      // budget caps thinking and output together, so a figure sized for the
      // beat list alone comes back as JSON cut off mid-object — which reads as
      // "the model returned garbage" rather than "it ran out of room".
      maxTokens: 24_000,
      user: [
        `# Video duration`,
        `${duration} seconds — beats must cover 0 to ${duration}.`,
        ``,
        `# Voiceover script (timing reference)`,
        input.script.trim(),
        ``,
        ...(input.alreadySignedIn
          ? [
              `# ALREADY SIGNED IN`,
              `The recording opens with the demo account's session already restored, so the product is`,
              `open and authenticated from the first frame. Do NOT plan a sign-in, a signup, or any`,
              `visit to a login screen — there is nothing to log into and it would waste the runtime.`,
              `Start inside the product.`,
              ``,
            ]
          : []),
        ...(input.flowPlan
          ? [
              `# THE APPROVED WALKTHROUGH — follow this`,
              `A human read this and signed it off. Perform these steps, in this order, with these`,
              `values. Do not substitute a flow you would have preferred. Your job is the timing and`,
              `the framing: map each step onto the selectors below and place it against the narration.`,
              `If a step cannot be mapped to anything available, skip that step rather than inventing`,
              `a different one.`,
              ``,
              input.flowPlan.trim(),
              ``,
            ]
          : []),
        `# Persona that will be typed in`,
        `Name ${input.identity.fullName} · ${input.identity.email} · ${input.identity.company}.`,
        `Refer to tokens, not these literals.`,
        ``,
        // The app is a third party's content, so it is fenced like any other
        // untrusted input — a page could otherwise put instructions in its own
        // copy and steer the edit.
        wrapUntrusted('Screens the scout reached in this app', describeSiteMap(input.siteMap)),
        ``,
        `Output JSON only.`,
      ].join('\n'),
    });

    const json = parseJsonObject(text);
    if (!json || !Array.isArray((json as any).beats)) {
      const truncated = text.trimEnd().endsWith('}') ? '' : ' (the response looks cut off)';
      throw new DirectorError(`Director returned non-JSON${truncated}: ${text.slice(0, 200)}`);
    }

    const beats = this.sanitise((json as any).beats as any[], input.siteMap, duration);
    if (!beats.length) throw new DirectorError('Director produced no usable beats.');
    return { beats };
  }

  /**
   * Clamp the plan into something safe to replay.
   *
   * The model is asked for restraint; this is what makes restraint true. An
   * out-of-range zoom is the difference between a polished push-in and an
   * unreadable crop, and an off-origin `goto` is an SSRF hop out of the URL the
   * caller actually authorised.
   */
  private sanitise(raw: any[], siteMap: SiteMap, durationSec: number): Beat[] {
    const knownSelectors = new Set<string>();
    for (const screen of siteMap.screens) {
      for (const t of screen.targets) knownSelectors.add(t.selector);
      for (const l of screen.links) knownSelectors.add(l.selector);
      for (const f of screen.forms) {
        knownSelectors.add(f.selector);
        if (f.submitSelector) knownSelectors.add(f.submitSelector);
        for (const field of f.fields) knownSelectors.add(field.selector);
      }
    }

    const ACTIONS: BeatAction[] = ['hold', 'goto', 'click', 'type', 'scrollTo'];

    const beats = raw
      .map((b): Beat | null => {
        const action = ACTIONS.includes(b?.action) ? (b.action as BeatAction) : 'hold';
        const selector = typeof b?.selector === 'string' && b.selector ? b.selector : undefined;
        const atSec = Math.max(0, Number(b?.atSec) || 0);

        let url: string | undefined;
        if (action === 'goto') {
          const candidate = typeof b?.url === 'string' ? b.url : '';
          try {
            const parsed = new URL(candidate, siteMap.entryUrl);
            // Only ever navigate inside the origin the caller had validated.
            if (parsed.origin !== siteMap.origin) return null;
            url = parsed.toString();
          } catch {
            return null;
          }
        }

        // An action that needs a target and has an unknown one is dropped: the
        // recorder would skip it anyway, and a silent skip mid-take leaves the
        // narration talking about something that never happened.
        if (action !== 'goto' && !selector) return null;
        if (selector && !knownSelectors.has(selector)) return null;

        return {
          atSec,
          action,
          selector,
          url,
          value: action === 'type' && typeof b?.value === 'string' ? b.value : undefined,
          zoom: Math.min(MAX_ZOOM, Math.max(1, Number(b?.zoom) || 1)),
          highlight: b?.highlight === true,
          reframe: true,
          note: typeof b?.note === 'string' ? b.note.slice(0, 120) : undefined,
        };
      })
      .filter((b): b is Beat => b !== null)
      .filter((b) => b.atSec <= durationSec)
      .filter((b) => b.action !== 'type' || (b.value ?? '').length > 0)
      .sort((a, b) => a.atSec - b.atSec);

    if (!beats.length) return beats;

    // Open at zero whatever the model said, so the first frames are composed
    // rather than whatever the page happened to load as.
    beats[0].atSec = 0;

    // Space the camera out. The action still happens on time; only the move is
    // suppressed, so a burst of typing holds one frame instead of jittering.
    let lastCameraAt = -Infinity;
    let lastSelector: string | undefined;
    let lastZoom = -1;
    for (const beat of beats) {
      // A beat with no selector (a bare `goto`) has nothing to aim at.
      const wouldMove =
        !!beat.selector && (beat.selector !== lastSelector || Math.abs(beat.zoom - lastZoom) > 0.02);
      if (!wouldMove || beat.atSec - lastCameraAt < MIN_CAMERA_GAP_SEC) {
        beat.reframe = false;
        continue;
      }
      beat.reframe = true;
      lastCameraAt = beat.atSec;
      lastSelector = beat.selector;
      lastZoom = beat.zoom;
    }

    return beats;
  }
}

/** Render the site map compactly enough to fit alongside the script. */
function describeSiteMap(siteMap: SiteMap): string {
  const lines: string[] = [];
  lines.push(`Origin: ${siteMap.origin}`);
  if (siteMap.notes.length) lines.push(`Scout notes: ${siteMap.notes.join(' | ')}`);

  siteMap.screens.forEach((screen, index) => {
    lines.push('');
    lines.push(`## Screen ${index + 1}: ${screen.path} — "${screen.title}" (reached by ${screen.reachedBy})`);
    lines.push(`url=${JSON.stringify(screen.url)}`);
    lines.push(...describeScreen(screen));
  });

  return lines.join('\n');
}

function describeScreen(screen: ScreenSnapshot): string[] {
  const lines: string[] = [];

  const targets = screen.targets.slice(0, 14);
  if (targets.length) {
    lines.push('Elements:');
    for (const t of targets) {
      lines.push(`  selector=${JSON.stringify(t.selector)} kind=${t.kind} text=${JSON.stringify(t.text.slice(0, 60))}`);
    }
  }

  for (const form of screen.forms.slice(0, 3)) {
    lines.push(`Form "${form.label}" (selector=${JSON.stringify(form.selector)}):`);
    for (const field of form.fields.slice(0, 8)) {
      lines.push(
        `  field selector=${JSON.stringify(field.selector)} kind=${field.kind} ` +
          `label=${JSON.stringify(field.label.slice(0, 40))}${field.required ? ' required' : ''}`,
      );
    }
    if (form.submitSelector) {
      lines.push(`  submit selector=${JSON.stringify(form.submitSelector)} text=${JSON.stringify(form.submitText ?? '')}`);
    }
  }

  const links = screen.links.slice(0, 8);
  if (links.length) {
    lines.push('Links:');
    for (const l of links) {
      lines.push(`  selector=${JSON.stringify(l.selector)} text=${JSON.stringify(l.text)} href=${JSON.stringify(l.href)}`);
    }
  }

  return lines;
}
