/**
 * Shot planning for the screen recording.
 *
 * A flat top-to-bottom scroll shows everything and emphasises nothing. A shot
 * list lets the camera behave like a presenter: settle on the headline while
 * the narration introduces the product, push in on the button it mentions, hold
 * on the thing being described.
 */

/** A candidate element the camera could point at, harvested from the page. */
export interface PageTarget {
  /** Stable selector the recorder can re-resolve at shot time. */
  selector: string;
  /** Visible text, trimmed — this is what the planner reasons about. */
  text: string;
  /** Tag plus a coarse role hint ('heading' | 'button' | 'input' | 'media' | 'block'). */
  kind: string;
  /** Vertical position in the document, so the planner can keep shots in order. */
  top: number;
}

export interface Shot {
  /** Selector from the supplied targets. Unresolvable selectors are skipped. */
  selector: string;
  /** Seconds into the video when this shot should begin. */
  atSec: number;
  /** How long to stay on it. */
  holdSec: number;
  /**
   * 1 = no zoom (wide). Values above 1 push in. Kept modest by the planner —
   * past roughly 2x, layout artefacts on fixed headers become obvious.
   */
  zoom: number;
  /** Draw an attention ring around the element for this shot. */
  highlight: boolean;
}

export interface ShotPlan {
  shots: Shot[];
}
