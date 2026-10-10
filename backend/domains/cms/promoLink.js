// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Where a tapped promo card goes: a page of the player app ('/referrals',
 * '#/referrals' is read the same) or an https link; '' or null clears it. The
 * same rule as the row's `promo_link_known` CHECK, refused here first with a
 * message the admin can act on.
 */
export function promoLinkUrl(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const path = raw.startsWith('#/') ? raw.slice(1) : raw;
  if (/^\/[A-Za-z0-9/_-]*$/.test(path)) return path;
  if (/^https:\/\/\S+$/.test(raw)) {
    try { new URL(raw); return raw; } catch { /* falls through */ }
  }
  const err = new Error('A card link is a page of the app, like /referrals, or a full https:// link.');
  err.status = 400;
  throw err;
}

export default promoLinkUrl;
