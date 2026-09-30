// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The ONE place this panel turns a `Branding` document into CSS variables.
 *
 * ── Why it exists ───────────────────────────────────────────────────────────
 * There were two: `App.tsx` on the branding subscription and `GameContext` on
 * the socket event. They had already drifted — `App.tsx` set `document.title`
 * from `userPanelName` and `GameContext` from `appName`, so the tab title
 * depended on which one fired last. That is §5 exactly: the same payload
 * applied in two places drifts, and it drifts silently. §13 says the panel
 * titles itself from its OWN panel-name field, so `userPanelName` is the one.
 *
 * ── The RGB triplets, and why a hex is not enough ───────────────────────────
 * `--brand-primary` is a hex, which is all `color: var(--brand-primary)` needs.
 * But most of this panel's brand colour is not a solid fill — it is tints,
 * glows, borders and shadows written as an rgba() triplet plus an alpha, and
 * CSS cannot
 * take an alpha channel off a hex variable. So the same colour was being
 * written twice: once as a token an operator controls, and 100+ times as a
 * literal triplet they do not. Changing the brand colour left most of the
 * panel gold.
 *
 * Setting `--brand-primary-rgb` to the hex's own triplet alongside it makes
 * `rgba(var(--brand-primary-rgb), 0.25)` follow the operator's colour like
 * everything else. The triplets are DERIVED here rather than stored, so they
 * cannot disagree with the hex they came from (§2: one owner per value).
 */

/** A 3- or 6-digit hex, with or without `#`, to an `r,g,b` triplet. Null if unparseable. */
export function hexToRgbTriplet(hex: string | null | undefined): string | null {
  if (!hex) return null;
  let h = String(hex).trim().replace(/^#/, '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)).join(',');
}

export interface BrandingDoc {
  primaryColor?: string;
  secondaryColor?: string;
  accentColor?: string;
  userPanelName?: string;
  [k: string]: unknown;
}

const PAIRS: Array<[keyof BrandingDoc, string]> = [
  ['primaryColor', '--brand-primary'],
  ['secondaryColor', '--brand-secondary'],
  ['accentColor', '--brand-accent'],
];

/**
 * Apply a branding document: CSS variables, the tab title, and the cache.
 *
 * Tolerates a partial document — an operator who has set only a primary colour
 * must not have the other two blanked to `undefined`, which would drop the
 * stylesheet's own defaults and leave those tokens unresolved.
 */
export function applyBranding(b: BrandingDoc | null | undefined): void {
  if (!b || typeof b !== 'object') return;
  const root = document.documentElement;

  for (const [field, cssVar] of PAIRS) {
    const value = b[field];
    if (typeof value !== 'string' || !value) continue;
    root.style.setProperty(cssVar, value);
    // The triplet is only set when the hex actually parses. A malformed colour
    // leaves the previous triplet standing rather than writing a broken one:
    // `rgba(, 0.25)` is an invalid declaration the browser drops, which would
    // take the tint out entirely instead of leaving it slightly wrong.
    const triplet = hexToRgbTriplet(value);
    if (triplet) root.style.setProperty(`${cssVar}-rgb`, triplet);
  }

  // §13: each panel titles itself from its OWN panel-name field.
  if (b.userPanelName) document.title = String(b.userPanelName);

  try { localStorage.setItem('app_branding', JSON.stringify(b)); } catch { /* private mode */ }
}

/** Apply whatever was cached, so the first paint is branded before the socket arrives. */
export function applyCachedBranding(): void {
  try {
    const cached = localStorage.getItem('app_branding');
    if (cached) applyBranding(JSON.parse(cached));
  } catch { /* ignore */ }
}
