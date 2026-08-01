import type { PageTarget } from './types';

/**
 * Browser-side halves of the camera. These run inside `page.evaluate`, so they
 * must be self-contained — no imports, no closure over server state.
 *
 * The zoom is a CSS transform on the page itself rather than a crop of the
 * captured image. A crop has to upscale to fill the frame and goes soft; a
 * transform makes the browser re-render at the new scale, so text stays sharp.
 */

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

/** Inject the camera stylesheet and highlight layer. Idempotent. */
export function installCinematics(): void {
  if (document.getElementById('pbx-cine-style')) return;
  const style = document.createElement('style');
  style.id = 'pbx-cine-style';
  style.textContent = `
    html { background: #0b0b0f; }
    body {
      transition: transform 1100ms cubic-bezier(0.22, 0.61, 0.36, 1) !important;
      will-change: transform;
    }
    #pbx-cine-ring {
      position: absolute;
      pointer-events: none;
      z-index: 2147483647;
      border: 3px solid rgba(99,102,241,0.95);
      border-radius: 10px;
      box-shadow: 0 0 0 6px rgba(99,102,241,0.20), 0 0 28px 6px rgba(99,102,241,0.45);
      opacity: 0;
      transition: opacity 420ms ease, top 700ms ease, left 700ms ease, width 700ms ease, height 700ms ease;
    }
    #pbx-cine-ring.on { opacity: 1; }
    /* Motion is the camera's job; page-level scroll animation fights it. */
    * { scroll-behavior: auto !important; }
  `;
  document.head.appendChild(style);

  const ring = document.createElement('div');
  ring.id = 'pbx-cine-ring';
  document.body.appendChild(ring);
}

/**
 * Move the camera to `selector`.
 *
 * Scroll positions the element near the middle of the viewport, then the page is
 * scaled about that same point so the push-in appears centred on the subject.
 */
export function applyShot(selector: string, zoom: number, highlight: boolean): boolean {
  const el = document.querySelector(selector);
  const body = document.body;
  const ring = document.getElementById('pbx-cine-ring');
  if (!el) return false;

  // Unzoom before measuring, or the rect is reported in scaled coordinates.
  body.style.transform = 'none';

  const rect = el.getBoundingClientRect();
  const docTop = rect.top + window.scrollY;
  const target = Math.max(0, docTop - (window.innerHeight - rect.height) / 2);
  window.scrollTo({ top: target, behavior: 'auto' });

  const centreY = window.scrollY + window.innerHeight / 2;
  body.style.transformOrigin = `50% ${centreY}px`;
  // Next frame, so the transition animates from the unzoomed state.
  requestAnimationFrame(() => {
    body.style.transform = zoom > 1.001 ? `scale(${zoom})` : 'none';
  });

  if (ring) {
    if (highlight) {
      const r = el.getBoundingClientRect();
      ring.style.top = `${r.top + window.scrollY - 6}px`;
      ring.style.left = `${r.left + window.scrollX - 6}px`;
      ring.style.width = `${r.width + 12}px`;
      ring.style.height = `${r.height + 12}px`;
      ring.classList.add('on');
    } else {
      ring.classList.remove('on');
    }
  }
  return true;
}

/** Ease back to an unzoomed, unhighlighted frame. */
export function resetCamera(): void {
  document.body.style.transform = 'none';
  document.getElementById('pbx-cine-ring')?.classList.remove('on');
}
