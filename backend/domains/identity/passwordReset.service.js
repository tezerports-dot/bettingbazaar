// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * passwordReset.service.js — "I've forgotten my password."
 *
 * ── The only channel this platform has ─────────────────────────────────────
 * There is no email and no SMS gateway. What there IS, is the Telegram account
 * whose phone number Telegram itself verified. So a reset happens in the Mini
 * App (Step 3, owner 2026-10-07): the person opens "Forgot password" for a
 * panel, types a new password, and shares their contact; if its phone is the
 * mobile of an account on that panel, that account's password is set. The
 * same share verifies or relinks the account (`telegram.resetPasswordByContact`).
 *
 * ── Set where the person is, for every panel (2026-10-08) ─────────────────
 * It used to answer with a link to `<panel>/#/reset/<token>`. Only the player
 * app had that page, so a merchant or staff member who forgot their password
 * was handed a link to a screen that did not exist. The person is already in
 * the Mini App holding the proof; the password is set there, in the same
 * transaction that spends the proof, and there is no token to carry anywhere.
 *
 * ── What it grants, and what it deliberately does not ─────────────────────
 * A new password, and nothing else (owner, 2026-09-24): nobody is signed in.
 * Setting it REVOKES every existing session in the same statement, because the
 * commonest reason somebody resets a password is that a session they did not
 * open is holding their account.
 */
import { db } from '#db';
import { hashPassword } from './password.util.js';
import { assertPlayerPassword, assertStaffPassword } from './passwordPolicy.js';
import { refusal } from '../../shared/httpError.js';

/**
 * Check a new password for `panel`'s account on `mobile`, BEFORE anything is
 * spent. The Mini App's `initData` and contact are single-use: a password the
 * policy refuses must not cost the person the page they are on.
 *
 * The floor is the ACCOUNT's (§2: 12 staff and merchant, 8 player), derived
 * from the panel, which IS the account type the reset looks up.
 *
 * @throws status 400: PASSWORDS_DIFFER, or the policy's WEAK_PASSWORD (§32 S35)
 */
export function assertNewPassword(panel, { password, confirmPassword, mobile }) {
  if (String(password ?? '') !== String(confirmPassword ?? '')) {
    throw refusal(400, 'PASSWORDS_DIFFER', 'The two passwords do not match.');
  }
  if (panel === 'PLAYER') assertPlayerPassword(password, { mobile }, 'player');
  else assertStaffPassword(password, { mobile }, String(panel).toLowerCase());
}

/**
 * A contact shared in the Mini App resets the password of the account of that
 * mobile on `panel`. The account's type IS the panel, in the repository's
 * WHERE (§33.5): a player's share can never reach the staff account on the
 * same number.
 *
 * @returns {Promise<{ok: true, userId: string} | {ok: false, code: string}>}
 * @throws status 400 when the password is refused (before anything is spent)
 */
export async function resetFromMiniApp({ panel, telegramUser, initData, contact, password, confirmPassword }) {
  assertNewPassword(panel, { password, confirmPassword, mobile: contact.phone });
  return db.telegram.resetPasswordByContact({
    panel, telegramUser, initData, contact,
    passwordHash: await hashPassword(password),
    validFrom: new Date(),
  });
}
