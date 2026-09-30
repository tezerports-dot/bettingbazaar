// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * config/panelOrigins.js — where each panel LIVES, as one owner.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 * There are three panels and, as of 2026-09-24, three Telegram surfaces. A
 * password-reset link minted for a STAFF account has to open the ADMIN panel:
 * sent to the player app it lands on a screen that will happily take a new
 * password and then leave the admin looking at a player login they have no
 * account for. The token is single-use, so the one link they were given is
 * spent on the wrong door.
 *
 * `PUBLIC_APP_ORIGIN` was the only origin the backend knew, and it is the
 * player one. Adding a second and a third as literals at the call site is §2 in
 * the exact form that keeps costing this repository: one value, three copies,
 * and the drift is invisible until somebody deploys the admin panel somewhere
 * new.
 *
 * ── The fallback is the player origin, and that is deliberate ──────────────
 * An install that has not set the other two is the ordinary single-host
 * deployment where all three panels are served from one origin under different
 * paths — which is how this repository's own dev stack runs. Falling back
 * keeps that working. An install that genuinely splits the hosts sets the
 * variables. (A `panelOriginsConfigured()` that claimed to tell the admin panel
 * which were still defaults was removed 2026-09-30: nothing called it, so the
 * admin panel never said so.)
 */

/** Trailing slashes are stripped once, here, so no caller has to remember. */
const clean = (value) => String(value || '').replace(/\/+$/, '');

/**
 * The origin for one audience. Audience values are `users.account_type`.
 *
 * @param {'PLAYER'|'STAFF'|'MERCHANT'} audience
 * @returns {string} an origin with no trailing slash, possibly ''
 */
export function panelOrigin(audience) {
  const player = clean(process.env.PUBLIC_APP_ORIGIN);
  if (audience === 'STAFF') return clean(process.env.ADMIN_PANEL_ORIGIN) || player;
  if (audience === 'MERCHANT') return clean(process.env.MERCHANT_PANEL_ORIGIN) || player;
  return player;
}
