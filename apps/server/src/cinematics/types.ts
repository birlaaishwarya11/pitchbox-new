/**
 * Shot and walkthrough planning for the screen recording.
 *
 * A flat top-to-bottom scroll of the landing page shows everything and
 * emphasises nothing — and it never shows the product actually being used. A
 * walkthrough lets the recording behave like a presenter driving the app: open
 * on the headline, click into the real flow, type into the real fields, and
 * frame whatever the narration is describing at that moment.
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

/** One fillable control inside a form. */
export interface FormField {
  selector: string;
  /** Normalised control type — drives which dummy value gets typed in. */
  kind:
    | 'text'
    | 'email'
    | 'password'
    | 'number'
    | 'tel'
    | 'url'
    | 'search'
    | 'date'
    | 'textarea'
    | 'select'
    | 'checkbox'
    | 'radio';
  /** Best available human label: <label>, aria-label, placeholder, then name. */
  label: string;
  name: string;
  required: boolean;
}

/** A form the walkthrough could fill in and submit. */
export interface FormTarget {
  selector: string;
  /** Heading or legend nearest the form, used to describe it to the planner. */
  label: string;
  fields: FormField[];
  /** The submit control, when one could be identified. */
  submitSelector?: string;
  submitText?: string;
}

/** A same-origin link the walkthrough could follow. */
export interface LinkTarget {
  selector: string;
  text: string;
  /** Absolute URL, always same-origin as the entry point. */
  href: string;
}

/** Everything harvested from one screen the scout reached. */
export interface ScreenSnapshot {
  url: string;
  /** Pathname + search, which is what the planner should reason about. */
  path: string;
  title: string;
  /** Plain-English description of how the scout arrived here. */
  reachedBy: string;
  targets: PageTarget[];
  forms: FormTarget[];
  links: LinkTarget[];
}

/** The result of the scouting pass: every screen reached, in visit order. */
export interface SiteMap {
  origin: string;
  entryUrl: string;
  screens: ScreenSnapshot[];
  /** Non-fatal problems worth surfacing (auth wall hit, budget exhausted, …). */
  notes: string[];
  /**
   * Set when the entry page was a framework error overlay rather than the app.
   *
   * Fatal for a repo run: the project started, answered HTTP 200, and rendered
   * its own stack trace. Recording that produces a video of an error, so the
   * caller is told what the app said instead.
   */
  appError?: string;
  /**
   * How the scout got past the front door, when it did.
   *
   * This decides which persona the take may use. Scouting and recording use
   * separate personas so that a signup performed on camera does not collide with
   * the account scouting just made — but that only holds for a signup. If the
   * scout *signed in*, only its own account exists, and a take using the other
   * persona lands on "Invalid login credentials" in the finished video.
   */
  authUsed?: 'registered' | 'signed-in';
  /**
   * The scout's cookies once it was authenticated.
   *
   * Handed to the recorder so the take starts already signed in. Performing the
   * login again on camera is the fragile path — it depends on the form
   * submitting, the redirect landing, and the account matching — and every one of
   * those failed at least once. Reusing the session that already worked skips all
   * of it, and a demo that opens inside the product is a better demo anyway.
   */
  authCookies?: SerializedCookie[];
}

/** A cookie as Puppeteer both reports and accepts it. */
export interface SerializedCookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
}

/**
 * What the recorder does at a moment in the video.
 *
 * `hold` and `scrollTo` are camera-only; the rest drive the app. Every beat
 * also carries its framing, so an action and the shot that covers it are one
 * decision rather than two lists to keep in sync.
 */
export type BeatAction = 'hold' | 'goto' | 'click' | 'type' | 'scrollTo';

export interface Beat {
  /** Seconds into the video when this beat should begin. */
  atSec: number;
  action: BeatAction;
  /** Target element. Required for click/type/scrollTo, optional for hold. */
  selector?: string;
  /** Destination for `goto`. Must be same-origin with the entry point. */
  url?: string;
  /**
   * Text to type. May contain `{{email}}`-style identity tokens, which the
   * recorder substitutes — so a plan can never leak a real-looking secret and
   * the same dummy account is used consistently across the whole walkthrough.
   */
  value?: string;
  /**
   * 1 = no zoom (wide). Kept restrained by the planner and clamped by the
   * director: past a mild push the surrounding context is cropped away and the
   * viewer no longer knows where they are.
   */
  zoom: number;
  /** Draw an attention ring around the element for this beat. */
  highlight: boolean;
  /**
   * Whether this beat moves the camera. The director clears it when a beat
   * lands too soon after the previous move: the action still happens, but the
   * frame it happens in is inherited rather than re-aimed. Defaults to true.
   */
  reframe?: boolean;
  /** Short note on intent — logged, never rendered. */
  note?: string;
}

export interface Walkthrough {
  beats: Beat[];
}
