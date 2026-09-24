// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * passwordReset.service.js — "I've forgotten my password."
 *
 * ── The only channel this platform has ─────────────────────────────────────
 * There is no player email (§2: "Player contact details — there are none
 * beyond the mobile"), and no SMS gateway. What there IS, is a Telegram account
 * whose phone number Telegram itself has verified and which the player has
 * already linked to their account. So the reset travels the same way the
 * verification did: they open a bot, share their contact, and if that number
 * matches an account they are sent a link.
 *
 * ── What the link grants, and what it deliberately does not ───────────────
 * It grants the right to CHOOSE A PASSWORD (owner, 2026-09-24). It does not
 * sign anybody in. The whole point of deleting `telegram_login_tokens` was that
 * a fleet of hundreds of bot tokens must not be able to mint a session; a reset
 * that logged somebody in would put that back under a different name. After
 * setting it they log in like anybody else.
 *
 * And setting it REVOKES every existing session, because the commonest reason
 * somebody resets a password is that a session they did not open is holding
 * their account.
 *
 * ── Why it is bound to a Telegram id ──────────────────────────────────────
 * The token records WHICH Telegram account asked for it. That is not used to
 * authorise the redemption — the token is the credential — but it is the only
 * record of who requested a password change on somebody else's account, and it
 * is the first thing an investigation asks for.
 *
 * ── The token is in the FRAGMENT ──────────────────────────────────────────
 * The link is `.../#/reset/<token>`. A query string reaches the server: it
 * lands in access logs, in the proxy's log, and in the `Referer` header of
 * whatever the page loads next. A fragment is never sent. That lesson was paid
 * for once already, by the login link this replaces.
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
 * A contact share matched an account. Issue the link.
 *
 * @returns {Promise<{ok: true, url: string, minutes: number} | {ok: false, reason: string}>}
 */
export async function issueResetLink({ userId, telegramUserId, audience, baseUrl }) {
  const user = await db.users.getUser(userId);
  if (!user) return { ok: false, reason: 'no_user' };

  // ══════════════════════════════════════════════════════════════════════════
  // THE ACCOUNT'S TYPE MUST EQUAL THE BOT'S AUDIENCE — checked AGAIN, here
  // ══════════════════════════════════════════════════════════════════════════
  // This is a SECOND refusal for one rule, and it is deliberate. It was one,
  // and one was not enough: `linkTelegramToAccount` matched by mobile without
  // the account type, a player's contact share linked the STAFF account on the
  // same number, and this function then issued an admin a password-reset link
  // to somebody who had proved nothing but possession of the phone. Measured on
  // a running server (§32 S30).
  //
  // The rule used to be "PLAYER only", because only players recovered through
  // Telegram. All three panels do now (owner, 2026-09-24), so the refusal is
  // stated as the thing it was always protecting: the account this issues for
  // must be of the same type as the bot that asked. A merchant bot cannot mint
  // a staff reset; a player bot cannot mint a merchant one. The literal became
  // a comparison, which is wider in what it permits and exactly as narrow in
  // what it lets cross.
  //
  // `audience` is REQUIRED. Absent, there is no comparison to make, and a
  // caller that has not said which door this came from is a caller that has
  // not checked — so it refuses rather than assuming.
  if (!audience || user.accountType !== audience) {
    console.error(`[password-reset] REFUSED: a ${audience || 'unspecified'} bot asked for a `
      + `${user.accountType} account (${userId}) — reaching this means a lookup is not scoped`);
    return { ok: false, reason: 'wrong_audience' };
  }
  // A blocked account does not get a route back in. The refusal is here rather
  // than at redemption so the bot can say something true instead of handing
  // over a link that will fail.
  if (user.isBlocked || user.status === 'BLOCKED') return { ok: false, reason: 'blocked' };

  const token = mint();
  const { expiresAt } = await db.telegram.issuePasswordReset({
    tokenHash: hash(token), userId, telegramUserId, ttlSeconds: TTL_SECONDS,
  });

  // ── The link opens the RIGHT PANEL ──────────────────────────────────────
  // A staff reset sent to the player app is a token spent on the wrong door,
  // and it is single-use — so the one link they were given is gone and the
  // screen they reached cannot tell them why. `panelOrigin` is the one owner
  // of where each panel lives; an explicit `baseUrl` still wins, which is what
  // a test passes.
  const root = String(baseUrl || panelOrigin(audience) || '').replace(/\/+$/, '');
  return {
    ok: true,
    url: `${root}/#/reset/${token}`,
    minutes: Math.max(1, Math.round((new Date(expiresAt).getTime() - Date.now()) / 60000)),
  };
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
      message: `${err.message} Your reset link has been used up — share your contact with the bot again for a new one.`,
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
