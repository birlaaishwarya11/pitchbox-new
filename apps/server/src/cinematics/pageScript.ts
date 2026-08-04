import type { FormField, FormTarget, LinkTarget, PageTarget } from './types';

/**
 * Browser-side halves of the camera and the walkthrough.
 *
 * These run inside `page.evaluate`, so each one must be self-contained — no
 * imports, no closure over server state, no shared helpers at module scope.
 * Anything that has to survive between calls hangs off `window.__pbx`.
 *
 * The zoom is a CSS transform on the page itself rather than a crop of the
 * captured image. A crop has to upscale to fill the frame and goes soft; a
 * transform makes the browser re-render at the new scale, so text stays sharp.
 */

// ---------------------------------------------------------------------------
// Harvesting
// ---------------------------------------------------------------------------

/** Collect elements worth pointing a camera at. Returns document order. */
export function harvestTargets(): PageTarget[] {
  const KINDS: Array<[string, string]> = [
    ['h1', 'heading'],
    ['h2', 'heading'],
    ['h3', 'heading'],
    ['button', 'button'],
    ['a[class*="btn"], a[class*="button"], [role="button"]', 'button'],
    ['input, textarea, select', 'input'],
    ['img, video, canvas, svg[width]', 'media'],
    ['section, article, [class*="card"], [class*="feature"]', 'block'],
  ];

  const seen = new Set<Element>();
  const out: PageTarget[] = [];

  const selectorFor = (el: Element): string => {
    // Prefer a stable id, then a data-* hook, then nth-of-type path. Class names
    // are avoided: utility frameworks make them long and non-unique.
    if (el.id && /^[A-Za-z][\w-]*$/.test(el.id)) return `#${el.id}`;
    const parts: string[] = [];
    let node: Element | null = el;
    while (node && node !== document.body && parts.length < 5) {
      const parent: Element | null = node.parentElement;
      if (!parent) break;
      const tag = node.tagName.toLowerCase();
      const sameTag = Array.from(parent.children).filter((c) => c.tagName === node!.tagName);
      const idx = sameTag.indexOf(node) + 1;
      parts.unshift(sameTag.length > 1 ? `${tag}:nth-of-type(${idx})` : tag);
      node = parent;
    }
    return `body > ${parts.join(' > ')}`;
  };

  for (const [sel, kind] of KINDS) {
    for (const el of Array.from(document.querySelectorAll(sel))) {
      if (seen.has(el)) continue;
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      // Skip anything invisible or too small/large to be a meaningful subject.
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) continue;
      if (rect.width < 60 || rect.height < 24) continue;
      if (rect.width > window.innerWidth * 1.5) continue;
      const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
      if (kind !== 'media' && kind !== 'input' && text.length < 3) continue;

      seen.add(el);
      const selector = selectorFor(el);
      try {
        if (document.querySelector(selector) !== el) continue; // selector must round-trip
      } catch {
        continue;
      }
      out.push({ selector, kind, text: text.slice(0, 120), top: rect.top + window.scrollY });
      if (out.length >= 40) break;
    }
  }
  return out.sort((a, b) => a.top - b.top);
}

/**
 * Collect fillable forms.
 *
 * Forms are what turn a page tour into a product walkthrough, so they are
 * harvested with enough detail to actually complete one: every control, its
 * best human label, and the button that submits it. Controls outside a `<form>`
 * are gathered too — React apps routinely submit with an onClick handler and no
 * form element at all.
 */
export function harvestForms(): FormTarget[] {
  const out: FormTarget[] = [];

  const selectorFor = (el: Element): string => {
    if (el.id && /^[A-Za-z][\w-]*$/.test(el.id)) return `#${el.id}`;
    const nameAttr = el.getAttribute('name');
    if (nameAttr && /^[A-Za-z][\w-]*$/.test(nameAttr)) {
      const tag = el.tagName.toLowerCase();
      const candidate = `${tag}[name="${nameAttr}"]`;
      try {
        if (document.querySelectorAll(candidate).length === 1) return candidate;
      } catch {
        /* fall through to the path form */
      }
    }
    const parts: string[] = [];
    let node: Element | null = el;
    while (node && node !== document.body && parts.length < 6) {
      const parent: Element | null = node.parentElement;
      if (!parent) break;
      const tag = node.tagName.toLowerCase();
      const sameTag = Array.from(parent.children).filter((c) => c.tagName === node!.tagName);
      const idx = sameTag.indexOf(node) + 1;
      parts.unshift(sameTag.length > 1 ? `${tag}:nth-of-type(${idx})` : tag);
      node = parent;
    }
    return `body > ${parts.join(' > ')}`;
  };

  const visible = (el: Element): boolean => {
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
    if ((el as HTMLInputElement).type === 'hidden') return false;
    return rect.width > 8 && rect.height > 8;
  };

  const labelFor = (el: Element): string => {
    const input = el as HTMLInputElement;
    if (input.id) {
      const tag = document.querySelector(`label[for="${CSS.escape(input.id)}"]`);
      const text = (tag?.textContent ?? '').replace(/\s+/g, ' ').trim();
      if (text) return text.slice(0, 60);
    }
    const wrapping = el.closest('label');
    if (wrapping) {
      const text = (wrapping.textContent ?? '').replace(/\s+/g, ' ').trim();
      if (text) return text.slice(0, 60);
    }
    const aria = el.getAttribute('aria-label') ?? input.placeholder ?? '';
    if (aria.trim()) return aria.trim().slice(0, 60);
    return (input.name || '').slice(0, 60);
  };

  const kindFor = (el: Element): FormField['kind'] => {
    const tag = el.tagName.toLowerCase();
    if (tag === 'textarea') return 'textarea';
    if (tag === 'select') return 'select';
    const type = ((el as HTMLInputElement).type || 'text').toLowerCase();
    const known: FormField['kind'][] = [
      'text', 'email', 'password', 'number', 'tel', 'url', 'search', 'date', 'checkbox', 'radio',
    ];
    return (known as string[]).includes(type) ? (type as FormField['kind']) : 'text';
  };

  const fieldsIn = (root: ParentNode): FormField[] =>
    Array.from(root.querySelectorAll('input, textarea, select'))
      .filter(visible)
      .filter((el) => !['submit', 'button', 'reset', 'image', 'file'].includes((el as HTMLInputElement).type))
      .slice(0, 12)
      .map((el) => ({
        selector: selectorFor(el),
        kind: kindFor(el),
        label: labelFor(el),
        name: (el as HTMLInputElement).name || '',
        required: (el as HTMLInputElement).required === true,
      }));

  const submitIn = (root: ParentNode): { selector?: string; text?: string } => {
    const candidates = Array.from(
      root.querySelectorAll('button, input[type="submit"], [role="button"]'),
    ).filter(visible);
    // A button that says "cancel" or "back" is a submit control by markup and a
    // dead end on camera, so prefer anything that reads like it moves forward.
    const forward = candidates.find((el) =>
      /submit|sign\s*up|sign\s*in|log\s*in|create|continue|next|save|start|get\s*started|send|search|add/i.test(
        (el.textContent ?? '') + ' ' + (el.getAttribute('aria-label') ?? ''),
      ),
    );
    const chosen =
      forward ??
      candidates.find((el) => (el as HTMLButtonElement).type === 'submit') ??
      candidates[0];
    if (!chosen) return {};
    return {
      selector: selectorFor(chosen),
      text: (chosen.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 40),
    };
  };

  const headingNear = (el: Element): string => {
    let node: Element | null = el;
    for (let hops = 0; node && hops < 4; hops++) {
      const heading = node.querySelector('h1, h2, h3, legend');
      const text = (heading?.textContent ?? '').replace(/\s+/g, ' ').trim();
      if (text) return text.slice(0, 60);
      node = node.parentElement;
    }
    return (document.title || '').slice(0, 60);
  };

  const claimed = new Set<Element>();

  for (const form of Array.from(document.querySelectorAll('form'))) {
    if (!visible(form)) continue;
    const fields = fieldsIn(form);
    if (!fields.length) continue;
    for (const el of Array.from(form.querySelectorAll('input, textarea, select'))) claimed.add(el);
    const submit = submitIn(form);
    out.push({
      selector: selectorFor(form),
      label: headingNear(form),
      fields,
      submitSelector: submit.selector,
      submitText: submit.text,
    });
    if (out.length >= 6) return out;
  }

  // Formless inputs — group everything left over under their nearest common
  // section so a React signup panel still reads as one fillable unit.
  const orphans = Array.from(document.querySelectorAll('input, textarea, select'))
    .filter((el) => !claimed.has(el) && visible(el))
    .filter((el) => !['submit', 'button', 'reset', 'image', 'file', 'hidden'].includes((el as HTMLInputElement).type));

  if (orphans.length) {
    let container: Element = orphans[0].parentElement ?? document.body;
    for (let hops = 0; hops < 6 && container !== document.body; hops++) {
      if (orphans.every((el) => container.contains(el))) break;
      container = container.parentElement ?? document.body;
    }
    const submit = submitIn(container);
    out.push({
      selector: selectorFor(container),
      label: headingNear(container),
      fields: fieldsIn(container),
      submitSelector: submit.selector,
      submitText: submit.text,
    });
  }

  return out;
}

/** Same-origin links worth following, nav and primary calls-to-action first. */
export function harvestLinks(): LinkTarget[] {
  const out: LinkTarget[] = [];
  const seenHref = new Set<string>();

  const selectorFor = (el: Element): string => {
    if (el.id && /^[A-Za-z][\w-]*$/.test(el.id)) return `#${el.id}`;
    const parts: string[] = [];
    let node: Element | null = el;
    while (node && node !== document.body && parts.length < 6) {
      const parent: Element | null = node.parentElement;
      if (!parent) break;
      const tag = node.tagName.toLowerCase();
      const sameTag = Array.from(parent.children).filter((c) => c.tagName === node!.tagName);
      const idx = sameTag.indexOf(node) + 1;
      parts.unshift(sameTag.length > 1 ? `${tag}:nth-of-type(${idx})` : tag);
      node = parent;
    }
    return `body > ${parts.join(' > ')}`;
  };

  for (const el of Array.from(document.querySelectorAll('a[href]'))) {
    const anchor = el as HTMLAnchorElement;
    let url: URL;
    try {
      url = new URL(anchor.href, window.location.href);
    } catch {
      continue;
    }
    if (url.origin !== window.location.origin) continue;
    if (url.pathname === window.location.pathname && !url.search) continue;
    const key = url.pathname + url.search;
    if (seenHref.has(key)) continue;

    const rect = anchor.getBoundingClientRect();
    const style = window.getComputedStyle(anchor);
    if (style.display === 'none' || style.visibility === 'hidden') continue;
    if (rect.width < 8 || rect.height < 8) continue;

    const text = (anchor.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (!text) continue;

    seenHref.add(key);
    out.push({ selector: selectorFor(anchor), text: text.slice(0, 60), href: url.toString() });
    if (out.length >= 30) break;
  }

  return out;
}

/**
 * Buttons that navigate without being links.
 *
 * A React app routing through `onClick` and `navigate()` renders no `<a href>`
 * at all, so a link crawl sees a single screen and concludes the product is one
 * page. These are the controls worth trying when that happens.
 *
 * Form submits are excluded on purpose: the scout has usually just filled and
 * submitted the form, and pressing it again is a duplicate signup, not a new
 * screen.
 */
export function harvestNavButtons(): Array<{ selector: string; text: string }> {
  const out: Array<{ selector: string; text: string }> = [];

  const selectorFor = (el: Element): string => {
    if (el.id && /^[A-Za-z][\w-]*$/.test(el.id)) return `#${el.id}`;
    const parts: string[] = [];
    let node: Element | null = el;
    while (node && node !== document.body && parts.length < 6) {
      const parent: Element | null = node.parentElement;
      if (!parent) break;
      const tag = node.tagName.toLowerCase();
      const sameTag = Array.from(parent.children).filter((c) => c.tagName === node!.tagName);
      const idx = sameTag.indexOf(node) + 1;
      parts.unshift(sameTag.length > 1 ? `${tag}:nth-of-type(${idx})` : tag);
      node = parent;
    }
    return `body > ${parts.join(' > ')}`;
  };

  for (const el of Array.from(document.querySelectorAll('button, [role="button"], [role="tab"], [role="menuitem"]'))) {
    const button = el as HTMLButtonElement;
    if (button.disabled) continue;
    // Being inside a form is what makes a button a submit, not its `type`.
    // A bare `<button onClick=…>` — how essentially every React app writes a
    // nav control — reports type "submit" because that is the HTML default,
    // and filtering on that alone rejected every button in the app.
    if (el.closest('form')) continue;
    if (button.type === 'reset') continue;

    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') continue;
    if (rect.width < 20 || rect.height < 14) continue;

    const text = (el.textContent ?? el.getAttribute('aria-label') ?? '').replace(/\s+/g, ' ').trim();
    if (text.length < 2 || text.length > 40) continue;

    const selector = selectorFor(el);
    try {
      if (document.querySelector(selector) !== el) continue;
    } catch {
      continue;
    }
    out.push({ selector, text: text.slice(0, 40) });
    if (out.length >= 20) break;
  }

  return out;
}

/**
 * Detect that the page is showing a framework error rather than the app.
 *
 * A dev server answers HTTP 200 while rendering its own error overlay, so a
 * status-code readiness check calls a completely broken app ready and the
 * recording captures a stack trace. The overlay is also the single most useful
 * thing to report back: frameworks name the environment variable they are
 * missing, which is almost always the actual cause.
 */
export function detectAppError(): string | null {
  const clean = (value: string | null | undefined): string =>
    (value ?? '').replace(/\s+/g, ' ').trim();

  // Next.js renders its overlay into a shadow root inside these hosts; Vite
  // uses a custom element; CRA and Remix use plain containers.
  const hosts = Array.from(
    document.querySelectorAll(
      'nextjs-portal, [data-nextjs-dialog], #nextjs__container_errors_desc, ' +
        'vite-error-overlay, #vite-error-overlay, ' +
        '[data-remix-error-boundary], iframe[title="webpack-dev-server-client-overlay"]',
    ),
  );

  for (const host of hosts) {
    const root = (host as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot ?? host;
    const text = clean((root as Element).textContent);
    if (text) return text.slice(0, 600);
  }

  // Server-rendered error pages carry no special element, only their own words.
  const body = clean(document.body?.innerText).slice(0, 4_000);
  const SIGNATURES = [
    /Unhandled Runtime Error/i,
    /Application error: a (?:client|server)-side exception/i,
    /Internal Server Error/i,
    /500\s*[:—-]\s*Internal/i,
    /Failed to compile/i,
    /Module (?:not found|build failed)/i,
    /Cannot find module/i,
    /ReferenceError|TypeError:|SyntaxError:/,
  ];
  // A short page dominated by an error message is an error page; a long page
  // that happens to contain the word "TypeError" is documentation.
  if (body.length < 1_500 && SIGNATURES.some((pattern) => pattern.test(body))) {
    return body.slice(0, 600);
  }

  return null;
}

/**
 * Click away a cookie or consent overlay, if one is covering the page.
 *
 * A consent wall is opaque to everything downstream: the scout's clicks land on
 * a backdrop, the recording opens on a modal instead of the product, and the
 * whole run is wasted on a page nobody wanted. Dismissing it is worth doing
 * even though it means guessing at a button.
 *
 * The guess is kept narrow deliberately. A container only qualifies if it reads
 * like a consent notice — by its own id/class, or by mentioning cookies or
 * consent in its text — and only then is an accept-shaped control inside it
 * clicked. "Continue" and "OK" are ordinary words in an ordinary app, and
 * pressing one at random is worse than leaving a banner up.
 */
export function dismissOverlays(): string | null {
  const w = window as unknown as { __pbxOverlayDone?: boolean };
  if (w.__pbxOverlayDone) return null;
  w.__pbxOverlayDone = true;

  const CONSENT_WORDS = /cookie|consent|gdpr|privacy preference|we use .{0,20}(cookies|tracking)|tracking/i;
  const ACCEPT =
    /^(accept|accept all|accept all cookies|accept cookies|allow|allow all|i agree|agree|got it|understood|ok|okay|continue|reject all|decline|only necessary|essential only)$/i;

  const named = Array.from(
    document.querySelectorAll(
      '[id*="cookie" i],[class*="cookie" i],[id*="consent" i],[class*="consent" i],' +
        '[id*="gdpr" i],[class*="gdpr" i],[role="dialog"],[aria-modal="true"]',
    ),
  );

  // Anything pinned over the page is a candidate too — consent managers often
  // render a bare fixed div with no helpful class on it at all.
  const pinned = Array.from(document.querySelectorAll('div, section, aside')).filter((el) => {
    const style = window.getComputedStyle(el);
    if (style.position !== 'fixed' && style.position !== 'sticky') return false;
    const rect = el.getBoundingClientRect();
    return rect.width * rect.height > window.innerWidth * window.innerHeight * 0.04;
  });

  for (const container of [...named, ...pinned].slice(0, 40)) {
    const style = window.getComputedStyle(container);
    if (style.display === 'none' || style.visibility === 'hidden') continue;

    const text = (container.textContent ?? '').replace(/\s+/g, ' ').trim();
    const looksNamed = /cookie|consent|gdpr/i.test(container.id + ' ' + container.className);
    if (!looksNamed && !CONSENT_WORDS.test(text)) continue;

    const controls = Array.from(container.querySelectorAll('button, a, [role="button"], input[type="button"]'));
    for (const control of controls) {
      const label = (control.textContent ?? control.getAttribute('aria-label') ?? '')
        .replace(/\s+/g, ' ')
        .trim();
      if (!ACCEPT.test(label)) continue;
      const rect = control.getBoundingClientRect();
      if (rect.width < 8 || rect.height < 8) continue;
      (control as HTMLElement).click();
      return label;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Camera
// ---------------------------------------------------------------------------

/**
 * Inject the camera stylesheet, highlight ring and pointer. Idempotent.
 *
 * The ring and pointer are appended to `<html>`, deliberately outside `<body>`:
 * body is the element the camera transforms, and anything inside it would be
 * scaled along with the page — a pointer that grows as the camera pushes in.
 */
export function installCinematics(): void {
  const w = window as unknown as { __pbx?: { zoom: number; tx: number; ty: number } };
  w.__pbx = w.__pbx ?? { zoom: 1, tx: 0, ty: 0 };
  if (document.getElementById('pbx-cine-style')) return;

  // Match the page's own backdrop instead of imposing one.
  //
  // This used to hard-set `html { background: #0b0b0f }` so that any letterbox
  // area read as deliberate. But `body` is transparent unless a page says
  // otherwise — Tailwind's preflight, for one, sets no body background — and
  // then that near-black showed straight through the content. Every recording
  // of such a page came out as dark text on a black field: technically a demo,
  // practically unreadable. So the colour is copied from the page when it has
  // one, and otherwise left alone at the browser's own white.
  const isTransparent = (colour: string): boolean =>
    !colour || colour === 'transparent' || /rgba\(\s*0,\s*0,\s*0,\s*0\s*\)/.test(colour);
  const bodyBackground = window.getComputedStyle(document.body).backgroundColor;
  if (!isTransparent(bodyBackground)) {
    document.documentElement.style.backgroundColor = bodyBackground;
  }

  const style = document.createElement('style');
  style.id = 'pbx-cine-style';
  style.textContent = `
    body { transform-origin: 0 0; will-change: transform; }
    /* Motion is the camera's job; page-level scroll animation fights it. */
    * { scroll-behavior: auto !important; }
    #pbx-cine-ring {
      position: fixed;
      pointer-events: none;
      z-index: 2147483646;
      border: 2.5px solid rgba(99,102,241,0.95);
      border-radius: 10px;
      box-shadow: 0 0 0 5px rgba(99,102,241,0.16), 0 0 26px 5px rgba(99,102,241,0.38);
      opacity: 0;
      transition: opacity 380ms ease;
    }
    #pbx-cine-ring.on { opacity: 1; }
    #pbx-cursor {
      position: fixed;
      pointer-events: none;
      z-index: 2147483647;
      width: 22px;
      height: 22px;
      margin: -2px 0 0 -2px;
      opacity: 0;
      transition: opacity 300ms ease, left 620ms cubic-bezier(0.22,0.61,0.36,1), top 620ms cubic-bezier(0.22,0.61,0.36,1);
      filter: drop-shadow(0 2px 4px rgba(0,0,0,0.45));
    }
    #pbx-cursor.on { opacity: 1; }
    #pbx-cursor-pulse {
      position: fixed;
      pointer-events: none;
      z-index: 2147483645;
      width: 14px;
      height: 14px;
      margin: -7px 0 0 -7px;
      border-radius: 50%;
      background: rgba(99,102,241,0.45);
      opacity: 0;
      transform: scale(0.4);
    }
    #pbx-cursor-pulse.fire {
      animation: pbx-pulse 520ms ease-out forwards;
    }
    @keyframes pbx-pulse {
      0%   { opacity: 0.85; transform: scale(0.4); }
      100% { opacity: 0;    transform: scale(3.2); }
    }
  `;
  document.head.appendChild(style);

  const root = document.documentElement;

  const ring = document.createElement('div');
  ring.id = 'pbx-cine-ring';
  root.appendChild(ring);

  const pulse = document.createElement('div');
  pulse.id = 'pbx-cursor-pulse';
  root.appendChild(pulse);

  const cursor = document.createElement('div');
  cursor.id = 'pbx-cursor';
  cursor.innerHTML =
    '<svg viewBox="0 0 22 22" width="22" height="22" xmlns="http://www.w3.org/2000/svg">' +
    '<path d="M3 2 L3 17 L7.2 13.2 L10 19.4 L12.7 18.1 L10 12.1 L15.4 12.1 Z" ' +
    'fill="#ffffff" stroke="#111827" stroke-width="1.2" stroke-linejoin="round"/></svg>';
  root.appendChild(cursor);
}

/**
 * Move the camera onto `selector` — pan and push-in as one eased move.
 *
 * Three things made the previous version lurch, and all three are fixed here:
 *
 * 1. It measured the subject while a CSS transform transition was still in
 *    flight, so `getBoundingClientRect` returned scaled geometry and the camera
 *    aimed at the wrong place. Measurement now happens with the transform
 *    cleared and the layout flushed, inside a single task so nothing paints.
 * 2. It teleported with `scrollTo` and *then* animated the zoom, which reads as
 *    a cut followed by a push. Scroll, translate and scale are now interpolated
 *    together in one rAF loop.
 * 3. It reset to zoom 1 before every shot, so the picture pumped in and out
 *    between subjects. Moves now start from wherever the camera already is.
 *
 * Real scrolling is kept for the coarse pan on purpose: scroll-linked reveals
 * (IntersectionObserver, `whileInView`) never fire if the page is only ever
 * translated, and half a landing page would stay invisible.
 */
export async function moveCamera(
  selector: string,
  zoom: number,
  highlight: boolean,
  durationMs: number,
): Promise<boolean> {
  const w = window as unknown as { __pbx?: { zoom: number; tx: number; ty: number } };
  const state = w.__pbx ?? (w.__pbx = { zoom: 1, tx: 0, ty: 0 });
  const body = document.body;
  const ring = document.getElementById('pbx-cine-ring');

  let el: Element | null = null;
  try {
    el = document.querySelector(selector);
  } catch {
    return false;
  }
  if (!el) return false;

  const vw = window.innerWidth;
  const vh = window.innerHeight;

  // Where the subject currently *appears*, before anything changes. The move
  // starts from here so it is continuous with whatever the camera was doing.
  const startRect = el.getBoundingClientRect();
  const startVx = startRect.left + startRect.width / 2;
  const startVy = startRect.top + startRect.height / 2;
  const startScroll = window.scrollY;
  const startZoom = state.zoom;

  // True layout geometry: clear the transform, flush layout, read, restore —
  // all synchronously, so the browser never paints the untransformed state.
  const priorTransform = body.style.transform;
  body.style.transform = 'none';
  void body.offsetHeight;
  const bodyRect = body.getBoundingClientRect();
  const bodyTop = bodyRect.top + window.scrollY;
  const bodyLeft = bodyRect.left + window.scrollX;
  const bodyWidth = bodyRect.width;
  const bodyHeight = bodyRect.height;
  const rect = el.getBoundingClientRect();
  const docCx = rect.left + window.scrollX + rect.width / 2;
  const docCy = rect.top + window.scrollY + rect.height / 2;
  const subjectW = rect.width;
  const subjectH = rect.height;
  body.style.transform = priorTransform;
  void body.offsetHeight;

  // Never push in past the point where the subject stops fitting the frame —
  // a zoom that crops the thing it is pointing at is worse than no zoom.
  const fit = Math.min(vw / Math.max(1, subjectW + 96), vh / Math.max(1, subjectH + 96));
  const endZoom = Math.max(1, Math.min(zoom, Math.max(1, fit)));

  const maxScroll = Math.max(0, (document.documentElement.scrollHeight || bodyHeight) - vh);
  const endScroll = Math.min(maxScroll, Math.max(0, docCy - vh / 2));

  const clampT = (value: number, scrollPos: number, z: number, axis: 'x' | 'y'): number => {
    // Keep the body covering the viewport so scaling never reveals a gap.
    const origin = axis === 'y' ? bodyTop : bodyLeft;
    const extent = axis === 'y' ? bodyHeight : bodyWidth;
    const view = axis === 'y' ? vh : vw;
    const lower = view - origin - extent * z + scrollPos;
    const upper = scrollPos - origin;
    if (lower > upper) return upper; // body shorter than the viewport
    return Math.min(upper, Math.max(lower, value));
  };

  const easeInOutCubic = (t: number): number =>
    t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

  const paint = (progress: number): void => {
    const e = easeInOutCubic(progress);
    const z = startZoom + (endZoom - startZoom) * e;
    const scrollPos = startScroll + (endScroll - startScroll) * e;
    // Interpolate where the subject should *appear*, so it glides to centre
    // rather than being computed from a scroll position that is still moving.
    const vx = startVx + (vw / 2 - startVx) * e;
    const vy = startVy + (vh / 2 - startVy) * e;

    let tx = vx + window.scrollX - bodyLeft - (docCx - bodyLeft) * z;
    let ty = vy + scrollPos - bodyTop - (docCy - bodyTop) * z;
    tx = clampT(tx, window.scrollX, z, 'x');
    ty = clampT(ty, scrollPos, z, 'y');

    window.scrollTo(0, scrollPos);
    body.style.transform =
      z <= 1.0005 && Math.abs(tx) < 0.5 && Math.abs(ty) < 0.5
        ? '' // drop the transform entirely so position:fixed behaves again
        : `translate3d(${tx.toFixed(2)}px, ${ty.toFixed(2)}px, 0) scale(${z.toFixed(4)})`;

    state.zoom = z;
    state.tx = tx;
    state.ty = ty;

    if (ring && highlight) {
      const r = el!.getBoundingClientRect();
      ring.style.left = `${r.left - 6}px`;
      ring.style.top = `${r.top - 6}px`;
      ring.style.width = `${r.width + 12}px`;
      ring.style.height = `${r.height + 12}px`;
    }
  };

  if (ring) {
    if (highlight) ring.classList.add('on');
    else ring.classList.remove('on');
  }

  const duration = Math.max(1, durationMs);
  await new Promise<void>((resolve) => {
    const started = performance.now();
    const step = (now: number) => {
      const progress = Math.min(1, (now - started) / duration);
      paint(progress);
      if (progress < 1) requestAnimationFrame(step);
      else resolve();
    };
    requestAnimationFrame(step);
  });

  return true;
}

/** Ease back to an unzoomed, unhighlighted frame at the top of the page. */
export async function resetCamera(durationMs: number): Promise<void> {
  const w = window as unknown as { __pbx?: { zoom: number; tx: number; ty: number } };
  const state = w.__pbx ?? (w.__pbx = { zoom: 1, tx: 0, ty: 0 });
  const body = document.body;
  document.getElementById('pbx-cine-ring')?.classList.remove('on');
  document.getElementById('pbx-cursor')?.classList.remove('on');

  const startZoom = state.zoom;
  const startTx = state.tx;
  const startTy = state.ty;
  if (Math.abs(startZoom - 1) < 0.002 && Math.abs(startTx) < 1 && Math.abs(startTy) < 1) {
    body.style.transform = '';
    return;
  }

  const duration = Math.max(1, durationMs);
  await new Promise<void>((resolve) => {
    const started = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - started) / duration);
      const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      const z = startZoom + (1 - startZoom) * e;
      const tx = startTx * (1 - e);
      const ty = startTy * (1 - e);
      body.style.transform =
        t >= 1 ? '' : `translate3d(${tx.toFixed(2)}px, ${ty.toFixed(2)}px, 0) scale(${z.toFixed(4)})`;
      state.zoom = z;
      state.tx = tx;
      state.ty = ty;
      if (t < 1) requestAnimationFrame(step);
      else resolve();
    };
    requestAnimationFrame(step);
  });
}

// ---------------------------------------------------------------------------
// Pointer
// ---------------------------------------------------------------------------

/**
 * Glide the pointer onto an element and report where it landed.
 *
 * Headless screenshots contain no cursor, so without this the app appears to
 * operate itself — fields fill and buttons depress with nothing on screen doing
 * it. The returned viewport point is also what the recorder clicks, so the
 * visible pointer and the real click can never disagree.
 */
export function moveCursorTo(selector: string): { x: number; y: number } | null {
  const cursor = document.getElementById('pbx-cursor');
  let el: Element | null = null;
  try {
    el = document.querySelector(selector);
  } catch {
    return null;
  }
  if (!el) return null;

  const rect = el.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;

  if (cursor) {
    cursor.style.left = `${x}px`;
    cursor.style.top = `${y}px`;
    cursor.classList.add('on');
  }
  return { x, y };
}

/** Ripple at the pointer, so a click reads as a click and not a page glitch. */
export function cursorPulse(): void {
  const cursor = document.getElementById('pbx-cursor');
  const pulse = document.getElementById('pbx-cursor-pulse');
  if (!cursor || !pulse) return;
  pulse.style.left = cursor.style.left;
  pulse.style.top = cursor.style.top;
  pulse.classList.remove('fire');
  void pulse.offsetWidth; // restart the animation
  pulse.classList.add('fire');
}

/**
 * Hide the contents of a field, permanently, before a secret is typed into it.
 *
 * Lives here with the other page-evaluated code so the recorder and its tests run
 * the identical script — a masking routine verified in a copy of itself would
 * prove nothing.
 *
 * A stylesheet rule keyed off an attribute, rather than flipping `type` to
 * `password`: a controlled React input re-renders on every keystroke and would
 * reset the `type` prop mid-word, unmasking the remainder. React never sees this
 * rule, and `!important` beats whatever the app's own styles say.
 *
 * Returns false when the selector matches nothing, so the caller can refuse to
 * type rather than film the value.
 */
export function installSecretMask(selector: string): boolean {
  const el = document.querySelector(selector);
  if (!el) return false;
  el.setAttribute('data-pbx-secret', '1');
  const STYLE_ID = 'pbx-secret-mask';
  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent =
      '[data-pbx-secret]{-webkit-text-security:disc !important;text-security:disc !important;}';
    document.head.appendChild(style);
  }
  return true;
}
