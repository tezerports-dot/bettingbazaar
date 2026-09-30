// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The ONE place this panel turns a `Branding` document into CSS variables.
 *
 * Per §15 each panel owns its own copy — no panel imports another panel's
 * source — but the reasoning is the user panel's, so it is stated once there
 * and summarised here: a hex is enough for `color: var(--brand-primary)`, and
 * not enough for a tint. `rgba()` needs an `r,g,b` triplet, CSS cannot take an
 * alpha off a hex variable, and the result was the brand colour written twice
 * — once as a token an operator controls and again as literals they do not.
 *
 * The triplet is DERIVED from the hex here, never stored separately, so the
 * two cannot disagree (§2).
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
  adminPanelName?: string;
  [k: string]: unknown;
}

export function applyBranding(b: BrandingDoc | null | undefined): void {
  if (!b || typeof b !== 'object') return;
  const root = document.documentElement;

  if (typeof b.primaryColor === 'string' && b.primaryColor) {
    root.style.setProperty('--brand-primary', b.primaryColor);
    // Only when the hex parses: a malformed colour leaves the previous triplet
    // standing rather than writing `rgba(, .4)`, which the browser drops —
    // taking the tint out entirely instead of leaving it slightly wrong.
    const triplet = hexToRgbTriplet(b.primaryColor);
    if (triplet) root.style.setProperty('--brand-primary-rgb', triplet);
  }

  // §13: each panel titles itself from its OWN panel-name field.
  if (b.adminPanelName) document.title = String(b.adminPanelName);

  try { localStorage.setItem('app_branding', JSON.stringify(b)); } catch { /* private mode */ }
}

/** Apply whatever was cached, so the first paint is branded before the socket arrives. */
export function applyCachedBranding(): void {
  try {
    const cached = localStorage.getItem('app_branding');
    if (cached) applyBranding(JSON.parse(cached));
  } catch { /* ignore */ }
}
