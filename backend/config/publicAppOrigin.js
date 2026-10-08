// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * config/publicAppOrigin.js — where the player app LIVES, as one owner.
 *
 * The one link the platform mints to a panel is the referral redirect's
 * fallback (`routes/referralRedirect.routes.js`), and it goes to the player
 * app. Read here rather than at the call site so `PUBLIC_APP_ORIGIN` has one
 * reader that strips its trailing slash, and no caller has to remember.
 *
 * There used to be an origin per panel (`ADMIN_PANEL_ORIGIN`,
 * `MERCHANT_PANEL_ORIGIN`), for password-reset links minted for staff and
 * merchants. The reset is finished inside the Mini App since 2026-10-08, so no
 * link to the admin or merchant panel is minted any more and both went.
 */

/** @returns {string} the player app's origin with no trailing slash, possibly '' */
export function publicAppOrigin() {
  return String(process.env.PUBLIC_APP_ORIGIN || '').replace(/\/+$/, '');
}
