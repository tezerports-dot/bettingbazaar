// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * passwordReset.service.js — "I've forgotten my password."
 *
 * ── The only channel this platform has ─────────────────────────────────────
 * There is no email and no SMS gateway. What there IS, is the Telegram account
 * whose phone number Telegram itself verified. So a reset happens in the Mini
 * App (Step 3, owner 2026-10-07): the person opens "Forgot password" for a
 * panel, shares their contact, and if its phone is the mobile of an account on
 * that panel they are given a link to choose a new password. The same share
 * verifies or relinks the account (`telegram.resetPasswordByContact`).
 *
 * ── What the link grants, and what it deliberately does not ───────────────
 * It grants the right to CHOOSE A PASSWORD (owner, 2026-09-24). It does not
 * sign anybody in. Setting it REVOKES every existing session, because the
 * commonest reason somebody resets a password is that a session they did not
 * open is holding their account.
 *
 * ── The token is in the FRAGMENT ──────────────────────────────────────────
 * The link is `<panel>/#/reset/<token>`. A query string reaches the server's
 * logs and the next page's `Referer`; a fragment is never sent.
 */
import crypto from 'crypto';
import { db } from '#db';
import { hashPassword } from './password.util.js';
import { assertPlayerPassword, assertStaffPassword } from './passwordPolicy.js';
import { panelOrigin } from '../../config/panelOrigins.js';

/** Fifteen minutes. Long enough to read a message; short enough to matter. */
const TTL_SECONDS = Number(process.env.PASSWORD_RESET_TTL_SECONDS || 900);

/** 256 bits, base64url. Not guessable, and not a database's problem if leaked. */
const mint = () => crypto.randomBytes(32).toString('base64url');
const hash = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

/**
 * A contact shared in the Mini App asks for a reset of the account of that
 * mobile on `panel`. The account's type IS the panel, in the repository's
 * WHERE (§33.5): a player's share can never reach the staff account on the
 * same number.
 *
 * @returns {Promise<{ok: true, token: string, url: string, expiresAt: Date}
 *          | {ok: false, code: string}>}
 */
export async function startResetFromMiniApp({ panel, telegramUser, initData, contact, baseUrl = null }) {
  const token = mint();
  const result = await db.telegram.resetPasswordByContact({
    panel, telegramUser, initData, contact, tokenHash: hash(token), ttlSeconds: TTL_SECONDS,
  });
  if (!result.ok) return result;
  // The link opens the RIGHT PANEL: a staff token spent on the player app is
  // a single-use link gone to the wrong door.
  const root = String(baseUrl || panelOrigin(panel) || '').replace(/\/+$/, '');
  return { ok: true, token, url: `${root}/#/reset/${token}`, expiresAt: result.expiresAt };
}

/**
 * Redeem it and set the password.
 *
 * Every refusal is ONE reason to the caller — unknown, used and expired are
 * indistinguishable, because a caller that can tell them apart can map which
 * tokens were ever live. The policy refusal is the exception and has to be:
 * "that password is too short" is the only message a person can act on.
 *
 * @returns {Promise<{ok: true, userId: string} | {ok: false, reason: string, message?: string}>}
 */
export async function redeemResetLink({ token, password, confirmPassword }) {
  if (!token) return { ok: false, reason: 'invalid' };
  if (String(password ?? '') !== String(confirmPassword ?? '')) {
    return { ok: false, reason: 'mismatch', message: 'The two passwords do not match.' };
  }

  // ── The token is checked FIRST, before the password is validated ────────
  // Deliberate. Validating the password first would answer "that password is
  // too short" to somebody holding a token that was never valid — which tells
  // an attacker their token got as far as the policy check, and tells a real
  // person to fix the wrong thing.
  const claim = await db.telegram.consumePasswordReset(hash(token));
  if (!claim) return { ok: false, reason: 'invalid' };

  const user = await db.users.getUser(claim.userId);
  if (!user) return { ok: false, reason: 'invalid' };

  try {
    // ── The floor is the ACCOUNT'S floor, derived not duplicated ──────────
    // §2: one implementation, two floors, set by blast radius. A staff or
    // merchant password reaches the player base, the float and the ledger, so
    // it is 12; a player's reaches one wallet, so it is 8. Reading the floor
    // off the account type here is what stops this path becoming the third
    // place the rule is written — and the way it would have failed is the
    // quiet one: an admin resetting through the bot could have set an
    // eight-character password that the admin signup form would have refused.
    const label = user.accountType === 'PLAYER' ? 'player' : user.accountType.toLowerCase();
    if (user.accountType === 'PLAYER') {
      assertPlayerPassword(password, { mobile: user.mobile }, label);
    } else {
      assertStaffPassword(password, { mobile: user.mobile }, label);
    }
  } catch (err) {
    // ── The token is already SPENT at this point ──────────────────────────
    // Consuming before validating means a weak password costs them the link.
    // That is the right way round: a token that survives a failed attempt is a
    // token an attacker can grind a password policy against, and the player's
    // remedy — share the contact again — is one tap. The message says so
    // rather than leaving them to discover it.
    return {
      ok: false,
      reason: 'weak',
      message: `${err.message} Your reset link has been used up — open "Forgot password" in Telegram again for a new one.`,
    };
  }

  // ── The password and the session cutoff move TOGETHER ─────────────────
  // One statement, deliberately. The commonest reason somebody resets is that
  // a session they did not open is holding their account, so a reset that
  // changes the password and leaves those sessions alive is a gesture. Written
  // as one patch rather than two calls because a second write that can fail
  // after the first has committed is §21 — and the half that would be missing
  // is the half that matters.
  await db.users.updateUser(claim.userId, {
    passwordHash: await hashPassword(password),
    sessionsValidFrom: new Date(),
  });

  return { ok: true, userId: claim.userId };
}
