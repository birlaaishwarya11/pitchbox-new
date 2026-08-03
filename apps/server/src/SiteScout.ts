/// <reference lib="dom" />
import puppeteer, { type Browser, type Page } from 'puppeteer';

import {
  detectAppError,
  dismissOverlays,
  harvestForms,
  harvestLinks,
  harvestNavButtons,
  harvestTargets,
} from './cinematics/pageScript';
import type { FormTarget, LinkTarget, ScreenSnapshot, SiteMap } from './cinematics/types';
import { valueForField, type DummyIdentity } from './cinematics/dummyIdentity';

/**
 * Somewhere the walkthrough could go next: a link, or — in an app that routes
 * through onClick handlers and renders no anchors — a button.
 */
interface RouteCandidate {
  selector: string;
  text: string;
  /** Absolute same-origin URL. Absent for button-driven navigation. */
  href?: string;
}

/**
 * Walks the app before the camera rolls.
 *
 * The recording used to point at one URL and scroll, which is why every demo
 * came out as a tour of the landing page. To show the product actually being
 * used, something has to find out what "using it" looks like — which pages
 * exist, what the signup form wants, what appears after you submit it.
 *
 * That discovery cannot happen during the take. Deciding the next click from a
 * live screen means an LLM round-trip per step, and each one is a frozen frame
 * in the finished video. So the scout runs first, headless and uncaptured, and
 * hands the director a map of everywhere it managed to reach.
 *
 * It drives a real browser and submits real forms, so it will create whatever
 * the app creates — an account, a project, a contact request. That is the cost
 * of showing a product rather than a landing page, and it is why the persona is
 * unmistakably fake.
 */

export interface SiteScoutOptions {
  viewport?: { width: number; height: number };
  navigationTimeoutMs?: number;
  /** Hard ceiling on screens harvested, including the entry page. */
  maxScreens?: number;
  /** Hard ceiling on wall-clock time for the whole exploration. */
  budgetMs?: number;
}

const DEFAULTS = {
  viewport: { width: 1280, height: 720 },
  navigationTimeoutMs: 30_000,
  maxScreens: 7,
  budgetMs: 110_000,
};

/** Reads as "this creates an account" — the scout tries these first. */
const SIGNUP_TEXT = /sign\s*up|create\s+(an?\s+)?account|register|get\s+started(\s+free)?|try\s+(it\s+)?free|start\s+free/i;
/** Reads as "this authenticates an existing account" — the fallback. */
const SIGNIN_TEXT = /sign\s*in|log\s*in|login/i;
/**
 * Never click these. Leaving the session, deleting data or starting a payment
 * all end the walkthrough — the first two silently, the third expensively.
 */
const FORBIDDEN_TEXT =
  /sign\s*out|log\s*out|logout|delete|remove|destroy|deactivate|close\s+account|unsubscribe|checkout|buy\s+now|subscribe\s+now|upgrade\s+to|pay\b/i;
/**
 * Reads as "this does something here" rather than "this goes somewhere".
 *
 * In an app with no `<form>` element — which is most React apps — the button
 * that submits a form is indistinguishable from a nav control by markup alone.
 * Pressing "Add check" is not a route; it just re-renders the screen the scout
 * is already on, and the click is wasted. Forms still get filled and submitted,
 * but by the code that understands them as forms.
 */
const ACTION_TEXT = /^(add|create|save|submit|send|update|post|upload|generate|run|apply|confirm|invite|new)\b/i;
/**
 * Federated-login controls. Clicking one hands the browser to an identity
 * provider, which is off-origin by definition and unusable by a dummy persona.
 */
const OAUTH_TEXT = /(continue|sign\s*in|sign\s*up|log\s*in)\s+with\s+\w|with\s+(google|github|gitlab|apple|microsoft|facebook|twitter|x|discord|slack|okta|sso)\b/i;

export class SiteScout {
  private readonly viewport: { width: number; height: number };
  private readonly navigationTimeoutMs: number;
  private readonly maxScreens: number;
  private readonly budgetMs: number;

  constructor(options: SiteScoutOptions = {}) {
    this.viewport = options.viewport ?? DEFAULTS.viewport;
    this.navigationTimeoutMs = options.navigationTimeoutMs ?? DEFAULTS.navigationTimeoutMs;
    this.maxScreens = options.maxScreens ?? DEFAULTS.maxScreens;
    this.budgetMs = options.budgetMs ?? DEFAULTS.budgetMs;
  }

  /**
   * Explore `entryUrl` and return everywhere reachable within the budget.
   *
   * Never rejects on a slow or hostile target. The budget is enforced as a hard
   * deadline around the whole pass, not just checked between steps: a single
   * navigation that hangs would otherwise blow straight through it, and this
   * runs inside the recording stage's own timeout. Whatever was harvested
   * before the deadline is still returned — a partial map beats none.
   */
  async explore(entryUrl: string, identity: DummyIdentity): Promise<SiteMap> {
    const entry = new URL(entryUrl);
    const deadline = Date.now() + this.budgetMs;
    const notes: string[] = [];
    const screens: ScreenSnapshot[] = [];
    const visitedPaths = new Set<string>();
    // Button routes have no URL to dedupe on until after they are taken, so
    // every candidate is also remembered by selector.
    const triedSelectors = new Set<string>();

    let browser: Browser | undefined;
    let appError: string | undefined;
    let authUsed: 'registered' | 'signed-in' | undefined;
    const finish = (): SiteMap => {
      if (screens.length >= this.maxScreens) {
        notes.push(`Exploration stopped at the ${this.maxScreens}-screen cap.`);
      }
      return { origin: entry.origin, entryUrl: entry.toString(), screens, notes, appError, authUsed };
    };

    const run = async (): Promise<void> => {
      browser = await puppeteer.launch({
        headless: true,
        defaultViewport: this.viewport,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--hide-scrollbars',
          `--window-size=${this.viewport.width},${this.viewport.height}`,
        ],
        timeout: this.navigationTimeoutMs,
      });
      const page = await browser.newPage();
      await page.setViewport(this.viewport);
      await this.installShim(page);

      await page.goto(entry.toString(), {
        waitUntil: 'domcontentloaded',
        timeout: this.navigationTimeoutMs,
      });
      await this.settle(page);

      const landing = await this.harvest(page, 'the landing page');
      screens.push(landing);
      visitedPaths.add(landing.path);

      // Before exploring: is this the app, or the app's crash report? A dev
      // server answers 200 while rendering its own error overlay, so a status
      // check calls a broken app ready. Everything past here is pointless if it
      // is broken, and the overlay usually names what is missing.
      appError = (await page.evaluate(detectAppError).catch(() => null)) ?? undefined;
      if (appError) {
        notes.push(`The entry page is showing an application error, not the app: ${appError.slice(0, 200)}`);
        return;
      }

      // 1. Get inside the product first. Everything interesting usually lives
      //    behind the signup, and the routes discovered there are better demo
      //    material than the marketing footer links.
      const authScreens = await this.attemptAuth(page, entry, identity, deadline, notes);
      for (const screen of authScreens) {
        if (screens.length >= this.maxScreens) break;
        if (visitedPaths.has(screen.path)) continue;
        screens.push(screen);
        visitedPaths.add(screen.path);
      }

      // 2. Then spread out across whatever the current screen links to. Links
      //    are re-read from wherever auth left us, so an authenticated nav wins
      //    over the marketing nav we started on.
      while (screens.length < this.maxScreens && Date.now() < deadline) {
        const next = await this.nextRoute(page, entry, visitedPaths, triedSelectors);
        if (!next) {
          // Worth recording. "Three screens" and "three screens because there
          // was nothing else to click" are very different diagnoses when a
          // user asks why their demo is short.
          notes.push(`No further routes were reachable from ${new URL(page.url()).pathname}.`);
          break;
        }
        // Only the selector is retired up front. Marking the destination
        // visited before going there made the dedupe below reject the very
        // screen this was about to harvest, so every link route was explored
        // and then silently thrown away.
        triedSelectors.add(next.selector);
        // A button route's destination is unknowable until it is taken, so
        // the duplicate check has to happen here rather than when choosing it.
        const record = (how: 'registered' | 'signed-in') => {
          authUsed = how;
        };
        for (const screen of await this.visitRoute(page, next, entry, identity, deadline, notes, record)) {
          if (visitedPaths.has(screen.path)) continue;
          if (screens.length >= this.maxScreens) break;
          screens.push(screen);
          visitedPaths.add(screen.path);
        }
      }

    };

    // The rejection is captured rather than thrown: once the deadline wins the
    // race, an unhandled rejection from the abandoned pass would take the
    // process down long after this function has returned its map.
    let failure: unknown;
    const pass = run().then(
      () => undefined,
      (error) => {
        failure = error;
      },
    );

    const timedOut = Symbol('scout-deadline');
    const outcome = await Promise.race([
      pass,
      new Promise<typeof timedOut>((resolve) => {
        const timer = setTimeout(() => resolve(timedOut), Math.max(1_000, deadline - Date.now()));
        timer.unref?.();
      }),
    ]);

    if (outcome === timedOut) notes.push('Exploration stopped early: time budget reached.');
    else if (failure) notes.push(`Exploration ended early: ${describe(failure)}`);

    // Closing the browser unblocks whatever step the race abandoned mid-flight.
    if (browser) await browser.close().catch(() => undefined);

    return finish();
  }

  // -------------------------------------------------------------------------
  // Steps
  // -------------------------------------------------------------------------

  /**
   * Try to get past the front door, preferring signup over signin.
   *
   * Signup is tried first because it works on an app nobody has an account for,
   * which is the situation every demo run is in.
   */
  private async attemptAuth(
    page: Page,
    entry: URL,
    identity: DummyIdentity,
    deadline: number,
    notes: string[],
  ): Promise<ScreenSnapshot[]> {
    const out: ScreenSnapshot[] = [];
    if (Date.now() >= deadline) return out;

    const door = await this.findAuthEntry(page, entry);
    if (!door) {
      notes.push('No signup or signin entry point was found; the walkthrough stays on public pages.');
      return out;
    }

    try {
      await this.follow(page, door.selector, door.href, entry);
    } catch (err) {
      notes.push(`Could not open the ${door.kind} screen: ${describe(err)}`);
      return out;
    }

    const authScreen = await this.harvest(
      page,
      `clicking ${JSON.stringify(door.selector)} ("${door.text}") on the landing page — the ${door.kind} screen`,
    );
    out.push(authScreen);

    const form = pickFillableForm(authScreen.forms);
    if (!form) {
      notes.push(`The ${door.kind} screen had no fillable form.`);
      return out;
    }
    if (Date.now() >= deadline) return out;

    try {
      await this.fillForm(page, form, identity);
      const submitted = await this.submitForm(page, form);
      if (!submitted) {
        notes.push(`Filled the ${door.kind} form but found no safe submit control.`);
        return out;
      }
      await this.settle(page, 2_500);
      const landed = await this.harvest(
        page,
        `submitting the ${door.kind} form with ${JSON.stringify(form.submitSelector ?? '')}`,
      );
      // Still staring at the same form means it was rejected — a validation
      // error, an email that already exists, a captcha. Worth saying so.
      if (landed.path === authScreen.path && pickFillableForm(landed.forms)) {
        // Read the app's own complaint where it gives one: the two common causes
        // are a rejected address and a confirmation step, and they need different
        // fixes from whoever is running this.
        const shown = await page
          .evaluate(() => (document.body?.innerText ?? '').replace(/\s+/g, ' ').slice(0, 400))
          .catch(() => '');
        const emailRejected = /e-?mail[^.]{0,40}(invalid|not valid|not allowed|unsupported)/i.test(shown);
        const needsConfirm = /(confirm|verify)[^.]{0,30}(e-?mail|inbox)|check your (e-?mail|inbox)/i.test(shown);

        notes.push(
          `The ${door.kind} form did not go through (still on ${landed.path}).` +
            (emailRejected
              ? ' The app rejected the dummy email address. example.com is reserved and many' +
                ' validators refuse it — set PITCHBOX_DEMO_EMAIL_DOMAIN to a domain you control.'
              : needsConfirm
                ? ' The app requires email confirmation, so the walkthrough cannot get past the login.'
                : ' The app may require email confirmation, a captcha, or an invite.') +
            (shown ? ` It said: ${shown.slice(0, 160)}` : ''),
        );
      }
      out.push(landed);
    } catch (err) {
      notes.push(`The ${door.kind} flow failed: ${describe(err)}`);
    }

    return out;
  }

  /** The most promising route not yet taken, preferring real links. */
  private async nextRoute(
    page: Page,
    entry: URL,
    visited: Set<string>,
    tried: Set<string>,
  ): Promise<RouteCandidate | null> {
    let links: LinkTarget[] = [];
    try {
      links = await page.evaluate(harvestLinks);
    } catch {
      return null;
    }

    const candidates = links.filter((link) => {
      if (tried.has(link.selector)) return false;
      if (FORBIDDEN_TEXT.test(link.text)) return false;
      let url: URL;
      try {
        url = new URL(link.href);
      } catch {
        return false;
      }
      if (url.origin !== entry.origin) return false;
      if (visited.has(url.pathname)) return false;
      // Fragments, downloads and mail links are not screens.
      if (/\.(pdf|zip|png|jpe?g|svg|mp4|csv)$/i.test(url.pathname)) return false;
      return true;
    });

    // Product surfaces beat marketing pages: an app's value is in the dashboard,
    // not the changelog.
    const preferred = /dashboard|app|home|project|workspace|settings|new|create|editor|library|account|overview/i;
    if (candidates.length) {
      return candidates.find((c) => preferred.test(c.href) || preferred.test(c.text)) ?? candidates[0];
    }

    // No links left. In an app that routes through onClick there may never have
    // been any, and stopping here would report a one-page product.
    let buttons: Array<{ selector: string; text: string }> = [];
    try {
      buttons = await page.evaluate(harvestNavButtons);
    } catch {
      return null;
    }
    const usable = buttons.filter((b) => {
      if (tried.has(b.selector) || FORBIDDEN_TEXT.test(b.text)) return false;
      // The way into the product outranks the action-word exclusion: "Start
      // free" and "Create an account" are doors, not buttons on a form.
      if (OAUTH_TEXT.test(b.text)) return false;
      return SIGNUP_TEXT.test(b.text) || !ACTION_TEXT.test(b.text);
    });
    if (!usable.length) return null;
    return usable.find((b) => preferred.test(b.text)) ?? usable[0];
  }

  private async visitRoute(
    page: Page,
    route: RouteCandidate,
    entry: URL,
    identity: DummyIdentity,
    deadline: number,
    notes: string[],
    onAuth?: (how: 'registered' | 'signed-in') => void,
  ): Promise<ScreenSnapshot[]> {
    const from = new URL(page.url()).pathname;
    try {
      await this.follow(page, route.selector, route.href, entry);
    } catch (err) {
      notes.push(`Could not open ${route.text || route.href}: ${describe(err)}`);
      return [];
    }

    // Recorded precisely rather than prosaically: the director needs to know
    // which control on which screen leads here, or it cannot chain the beats.
    const screen = await this.harvest(
      page,
      `clicking ${JSON.stringify(route.selector)} ("${route.text}") on ${from}`,
    );

    // A form here is the chance to show the product being used rather than
    // read. Filling it without submitting proves nothing and costs a screen
    // slot, so go all the way through and harvest what comes back — the result
    // screen is usually the most demo-worthy thing in the whole app.
    const form = pickFillableForm(screen.forms);
    if (!form || Date.now() >= deadline) return [screen];

    // Fill it, but never submit a credential form from here.
    //
    // A form with a password field is a sign-in, and a dummy persona has no
    // account to sign in with — submitting it cannot succeed by construction, it
    // can only produce "Invalid login credentials". That error then became the
    // screen the director framed, and a showcase video ended on a red failure
    // box. Signing up is `attemptAuth`'s job: it knows to prefer registration
    // over authentication and reports why when it is refused.
    const isCredentialForm = form.fields.some((f) => f.kind === 'password');
    try {
      if (isCredentialForm) {
        // A credential form must be registered against, not signed into. Most
        // apps put both on one screen behind a "Sign up" toggle rather than at a
        // separate URL, which is why looking only at the landing page for a
        // signup entry point found nothing and left the product locked.
        const registered = await this.registerHere(page, entry, identity, notes, onAuth);
        return registered.length ? [screen, ...registered] : [screen];
      }
      await this.fillForm(page, form, identity);
      if (!(await this.submitForm(page, form))) return [screen];
      await this.settle(page, 2_000);
      const result = await this.harvest(
        page,
        `submitting "${form.label || route.text}" with ${JSON.stringify(form.submitSelector ?? '')}`,
      );
      return [screen, result];
    } catch (err) {
      notes.push(`Could not complete the form on ${screen.path}: ${describe(err)}`);
      return [screen];
    }
  }

  // -------------------------------------------------------------------------
  // Primitives
  // -------------------------------------------------------------------------

  /**
   * Click through when we can, navigate directly when we cannot.
   *
   * Clicking is the faithful path — it exercises the app's own router and any
   * transition attached to it. But a stale selector or an intercepting overlay
   * would abandon the whole branch, so a direct navigation backs it up.
   */
  private async follow(page: Page, selector: string, href: string | undefined, entry: URL): Promise<void> {
    const target = href ? new URL(href, entry) : undefined;
    if (target && target.origin !== entry.origin) throw new Error('refusing to leave the origin');

    const before = page.url();
    const beforeSignature = await this.pageSignature(page);
    try {
      await page.click(selector, { delay: 20 });
      await this.settle(page, 1_800);

      // A click can navigate anywhere, and the origin check above only guards
      // candidates that had an href to check. A "Continue with GitHub" button
      // calls signInWithOAuth and leaves for the identity provider, which is how
      // a scout of a logged-out app ended up harvesting a Supabase OAuth consent
      // screen — a third party's page, one screen of budget wasted, and the last
      // thing anyone wants appearing in their product demo.
      if (!this.isSameOrigin(page.url(), entry)) {
        await page
          .goto(before, { waitUntil: 'domcontentloaded', timeout: this.navigationTimeoutMs })
          .catch(() => undefined);
        throw new Error(`clicking ${selector} left ${entry.origin}`);
      }

      if (page.url() !== before) return;
      // An SPA router swaps the DOM without touching the URL, so a changed
      // page signature is the only evidence the click went anywhere.
      if ((await this.pageSignature(page)) !== beforeSignature) return;
    } catch (error) {
      // Leaving the origin is a decision, not a hiccup: do not then try to reach
      // the same place by direct navigation.
      if (error instanceof Error && error.message.includes('left ')) throw error;
      /* otherwise fall through to a direct navigation, if we have somewhere to go */
    }

    if (!target) throw new Error(`clicking ${selector} did not lead anywhere`);

    await page.goto(target.toString(), {
      waitUntil: 'domcontentloaded',
      timeout: this.navigationTimeoutMs,
    });
    await this.settle(page);
  }

/**
   * Register on the screen we are already looking at.
   *
   * Signing in cannot work — the persona has no account — so the only way past a
   * credential form is to create one. Apps overwhelmingly put sign-in and sign-up
   * on the same screen behind a toggle, so the toggle is clicked first when there
   * is one, and only then is the form filled and submitted.
   */
  private async registerHere(
    page: Page,
    entry: URL,
    identity: DummyIdentity,
    notes: string[],
    onAuth?: (how: 'registered' | 'signed-in') => void,
  ): Promise<ScreenSnapshot[]> {
    const before = page.url();

    // Switch the form into signup mode if the screen offers that.
    try {
      const candidates: RouteCandidate[] = [
        ...(await page.evaluate(harvestNavButtons).catch(() => [])),
        ...(await page.evaluate(harvestLinks).catch(() => [])),
      ];
      const toggle = candidates.find((c) => SIGNUP_TEXT.test(c.text) && !OAUTH_TEXT.test(c.text));
      if (toggle) {
        await page.click(toggle.selector, { delay: 20 }).catch(() => undefined);
        await this.settle(page, 900);
        if (!this.isSameOrigin(page.url(), entry)) {
          await page.goto(before, { waitUntil: 'domcontentloaded', timeout: this.navigationTimeoutMs }).catch(() => undefined);
          notes.push('The signup control led off-site, so registration was abandoned.');
          return [];
        }
      } else {
        notes.push('No signup toggle was found on the credential screen; trying the form as it stands.');
      }
    } catch {
      /* the form as it stands is still worth a try */
    }

    // Re-harvest: switching mode usually adds or relabels fields.
    const screen = await this.harvest(page, 'the signup form');
    const form = pickFillableForm(screen.forms);
    if (!form) {
      notes.push('The signup screen had no fillable form.');
      return [];
    }

    await this.fillForm(page, form, identity);
    if (!(await this.submitForm(page, form))) {
      notes.push('Filled the signup form but found no safe submit control.');
      return [];
    }
    await this.settle(page, 3_000);

    const landed = await this.harvest(page, `submitting the signup form with ${JSON.stringify(form.submitSelector ?? '')}`);

    // Refused means "still on the same screen, still asking for credentials".
    //
    // The path comparison is load-bearing. Testing only for a lingering password
    // field declared a *successful* signup a failure on the first app this was
    // pointed at, because the page it landed on has an API-key input — which is
    // `type="password"` like any other secret field. Signing in and being handed
    // a form that wants a different secret are not the same thing.
    const stillOnAuthScreen = landed.path === screen.path;
    if (stillOnAuthScreen && pickFillableForm(landed.forms)?.fields.some((f) => f.kind === 'password')) {
      const shown = await page
        .evaluate(() => (document.body?.innerText ?? '').replace(/\s+/g, ' ').slice(0, 400))
        .catch(() => '');
      const emailRejected = /e-?mail[^.]{0,40}(invalid|not valid|not allowed|unsupported)/i.test(shown);
      const needsConfirm = /(confirm|verify)[^.]{0,30}(e-?mail|inbox)|check your (e-?mail|inbox)/i.test(shown);
      const alreadyExists = /already (registered|exists|in use|taken)|account already|user already/i.test(shown);

      // The persona is deterministic so that a retry reuses the account it made
      // rather than orphaning a new one. The flip side is that every run after
      // the first is told the user already exists — at which point the obvious
      // move is the one a person would make: sign in with the credentials we
      // know, because we are the ones who created them.
      if (alreadyExists) {
        notes.push('This persona already has an account here, so signing in instead.');
        const signedIn = await this.signInHere(page, entry, identity, notes);
        if (signedIn) {
          onAuth?.('signed-in');
          return [signedIn];
        }
      }

      notes.push(
        'Signup was refused.' +
          (emailRejected
            ? ' The dummy email address was rejected — set PITCHBOX_DEMO_EMAIL_DOMAIN to a domain you control.'
            : needsConfirm
              ? ' The app requires email confirmation, so the walkthrough cannot get past the login.'
              : alreadyExists
                ? ' The persona already has an account and signing in did not work either.'
                : ' It may require a captcha or an invite.') +
          (shown ? ` It said: ${shown.slice(0, 160)}` : ''),
      );
      return [];
    }

    notes.push(`Registered and reached ${landed.path}.`);
    onAuth?.('registered');
    return [landed];
  }

/**
   * Sign in on the current screen with the persona's own credentials.
   *
   * Only reached after an app reports the account already exists, which means
   * this persona created it on an earlier run. This is the one case where
   * submitting a credential form can succeed, so it is the one case where it is
   * allowed to.
   */
  private async signInHere(
    page: Page,
    entry: URL,
    identity: DummyIdentity,
    notes: string[],
  ): Promise<ScreenSnapshot | null> {
    const before = new URL(page.url()).pathname;

    // Flip back to sign-in mode if the screen is a toggle.
    try {
      const candidates: RouteCandidate[] = [
        ...(await page.evaluate(harvestNavButtons).catch(() => [])),
        ...(await page.evaluate(harvestLinks).catch(() => [])),
      ];
      const toggle = candidates.find((c) => SIGNIN_TEXT.test(c.text) && !OAUTH_TEXT.test(c.text));
      if (toggle) {
        await page.click(toggle.selector, { delay: 20 }).catch(() => undefined);
        await this.settle(page, 900);
        if (!this.isSameOrigin(page.url(), entry)) return null;
      }
    } catch {
      /* the form as it stands may already be a sign-in */
    }

    const screen = await this.harvest(page, 'the sign-in form');
    const form = pickFillableForm(screen.forms);
    if (!form) return null;

    await this.fillForm(page, form, identity);
    if (!(await this.submitForm(page, form))) return null;
    // Longer than a plain form post: this is a network round-trip to the auth
    // provider followed by a client-side redirect.
    await this.settle(page, 5_000);

    const landed = await this.harvest(page, 'signing in with the persona that was registered earlier');
    // Compare pathnames, not paths. `ScreenSnapshot.path` carries the query
    // string, so measuring it against a bare pathname made
    // `/login?redirect=%2Fpipeline` look like progress away from `/login` and
    // reported a sign-in that had not happened.
    const landedPath = (() => {
      try {
        return new URL(landed.url).pathname;
      } catch {
        return landed.path;
      }
    })();
    if (landedPath === before) {
      notes.push('Signing in did not move off the login screen either.');
      return null;
    }
    notes.push(`Signed in and reached ${landedPath}.`);
    return landed;
  }

  /** True when `candidate` is on the origin the caller authorised. */
  private isSameOrigin(candidate: string, entry: URL): boolean {
    try {
      return new URL(candidate).origin === entry.origin;
    } catch {
      return false;
    }
  }

  /** Cheap fingerprint of what is on screen, to detect SPA route changes. */
  private async pageSignature(page: Page): Promise<string> {
    return page
      .evaluate(() => {
        const heading = document.querySelector('h1, h2')?.textContent ?? '';
        // A leading slice of the body text catches a route swap that happens to
        // keep the same title and heading; the length catches the rest.
        const text = (document.body?.innerText ?? '').replace(/\s+/g, ' ').trim();
        return `${document.title}|${heading}|${text.length}|${text.slice(0, 160)}`;
      })
      // A signature that cannot be read must not compare equal to the previous
      // one, or a failed navigation would look like a successful route change.
      .catch(() => `unreadable-${Date.now()}`);
  }

  private async fillForm(page: Page, form: FormTarget, identity: DummyIdentity): Promise<void> {
    for (const field of form.fields) {
      if (field.kind === 'checkbox' || field.kind === 'radio') {
        // Consent boxes gate most signups, so tick them; never untick.
        await page
          .evaluate((sel: string) => {
            const el = document.querySelector(sel) as HTMLInputElement | null;
            if (el && !el.checked) el.click();
          }, field.selector)
          .catch(() => undefined);
        continue;
      }

      if (field.kind === 'select') {
        await page
          .evaluate((sel: string) => {
            const el = document.querySelector(sel) as HTMLSelectElement | null;
            if (!el) return;
            // First option is usually the "choose one" placeholder.
            const option = Array.from(el.options).find((o) => o.value && !o.disabled);
            if (option) {
              el.value = option.value;
              el.dispatchEvent(new Event('change', { bubbles: true }));
            }
          }, field.selector)
          .catch(() => undefined);
        continue;
      }

      const value = valueForField(field, identity);
      try {
        // Triple-click selects whatever is already in the field so that typing
        // replaces it. `page.type` appends, and a form filled twice — which is
        // exactly what happens when a signup is refused and the same screen is
        // then used to sign in — ended up with the password entered twice over.
        // The credentials were correct and the login still failed.
        await page.click(field.selector, { clickCount: 3, delay: 10 });
        // Controlled React inputs ignore a value assignment, so type for real.
        await page.type(field.selector, value, { delay: 0 });
      } catch {
        // One unfillable field should not abandon the rest of the form.
      }
    }
  }

  /** Submit, unless the only available control looks destructive. */
  private async submitForm(page: Page, form: FormTarget): Promise<boolean> {
    if (!form.submitSelector) return false;
    if (form.submitText && FORBIDDEN_TEXT.test(form.submitText)) return false;
    try {
      await page.click(form.submitSelector, { delay: 20 });
      return true;
    } catch {
      return false;
    }
  }

  private async harvest(page: Page, reachedBy: string): Promise<ScreenSnapshot> {
    await this.installShim(page);
    const [targets, forms, links, meta] = await Promise.all([
      page.evaluate(harvestTargets).catch(() => []),
      page.evaluate(harvestForms).catch(() => []),
      page.evaluate(harvestLinks).catch(() => []),
      page
        .evaluate(() => ({ url: window.location.href, title: document.title }))
        .catch(() => ({ url: page.url(), title: '' })),
    ]);

    let path = '/';
    try {
      const parsed = new URL(meta.url);
      path = parsed.pathname + parsed.search;
    } catch {
      /* keep the default */
    }

    return { url: meta.url, path, title: meta.title, reachedBy, targets, forms, links };
  }

  /**
   * tsx/esbuild wraps transpiled functions in a `__name` helper to preserve
   * `Function.prototype.name`. `page.evaluate` ships the function's *source* to
   * the browser, where that helper does not exist, so every harvest would die
   * with "__name is not defined". Registering the shim on new documents makes
   * it survive navigation. Passed as a string on purpose: string arguments are
   * not transpiled, so this line cannot depend on the helper it installs.
   */
  private async installShim(page: Page): Promise<void> {
    const shim = 'globalThis.__name = globalThis.__name || ((fn) => fn)';
    await page.evaluate(shim).catch(() => undefined);
    const flagged = page as Page & { __pbxShimRegistered?: boolean };
    if (!flagged.__pbxShimRegistered) {
      flagged.__pbxShimRegistered = true;
      await page.evaluateOnNewDocument(shim).catch(() => undefined);
    }
  }

  private async settle(page: Page, extraMs = 1_200): Promise<void> {
    await page.waitForNetworkIdle({ idleTime: 400, timeout: 6_000 }).catch(() => undefined);
    await new Promise<void>((resolve) => setTimeout(resolve, extraMs));
    // A consent wall makes every later click land on a backdrop, so clear it
    // before harvesting anything. No-op once the page has been dealt with.
    await this.installShim(page);
    const dismissed = await page.evaluate(dismissOverlays).catch(() => null);
    if (dismissed) {
      console.log(`[scout] dismissed an overlay via "${dismissed}"`);
      await new Promise<void>((resolve) => setTimeout(resolve, 600));
    }
  }

  /**
   * Find the way in: a signup entry point, or a signin one if that is all there
   * is.
   *
   * Buttons are considered alongside links. An app that routes through onClick
   * has no anchor to match on, and looking only at anchors declared every such
   * product to be a single marketing page with nothing behind it.
   */
  private async findAuthEntry(
    page: Page,
    entry: URL,
  ): Promise<{ selector: string; text: string; href?: string; kind: 'signup' | 'signin' } | null> {
    const candidates: RouteCandidate[] = [];

    try {
      const links = await page.evaluate(harvestLinks);
      for (const link of links) {
        try {
          if (new URL(link.href).origin === entry.origin) candidates.push(link);
        } catch {
          /* skip an unparseable href */
        }
      }
    } catch {
      /* fall through to buttons */
    }

    try {
      candidates.push(...(await page.evaluate(harvestNavButtons)));
    } catch {
      /* buttons are a bonus, not a requirement */
    }

    const match = (pattern: RegExp): RouteCandidate | undefined =>
      candidates.find((c) => {
        // "Sign in with Google" matches SIGNIN_TEXT but is a door out of the app.
        if (OAUTH_TEXT.test(c.text)) return false;
        if (pattern.test(c.text)) return true;
        if (!c.href) return false;
        try {
          return pattern.test(new URL(c.href).pathname);
        } catch {
          return false;
        }
      });

    const signup = match(SIGNUP_TEXT);
    if (signup) return { ...signup, kind: 'signup' };
    const signin = match(SIGNIN_TEXT);
    if (signin) return { ...signin, kind: 'signin' };
    return null;
  }
}

/** The form on a screen most worth filling: the one with the most real fields. */
function pickFillableForm(forms: FormTarget[]): FormTarget | undefined {
  const usable = forms.filter((f) => f.fields.some((x) => x.kind !== 'checkbox' && x.kind !== 'radio'));
  if (!usable.length) return undefined;
  return usable.sort((a, b) => b.fields.length - a.fields.length)[0];
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
