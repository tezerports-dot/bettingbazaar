// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * routes.js — the three sign-in doors, the one place a session is minted, and
 * the session lifecycle.
 *
 * ── Staff (owner, 2026-10-13) ──────────────────────────────────────────────
 * A STAFF account (admin, sub-admin, mediator) has no Telegram
 * at all. It signs in with its mobile, its password and a code from an
 * authenticator app (`/login/totp`), and enrols that app at its first sign-in
 * (`/login/totp/setup`, `/login/totp/activate`). The staff door has only those
 * legs (`loginDoors.js`).
 *
 * ── Players and merchants (owner, 2026-10-13/14) ──────────────────────────
 * "Continue with Telegram" and nothing else: no password, no form. Signing up
 * and signing in are the same action (CLAUDE.md §33):
 *
 *   • `/login/telegram` opens the sign-in. On a phone that runs Telegram it is
 *     a HANDOFF: Verify opens the site with a one-time ticket, spent at
 *     `/login/telegram/ticket`. Elsewhere it is a MATCH: this browser shows a
 *     two-digit number, the Mini App offers three, and this browser polls
 *     `/login/telegram/complete` for the approval.
 *   • The first Verify on a panel shares the contact once, which links the
 *     account of that mobile or makes one (a player; a merchant application).
 *   • For a merchant, the Telegram sign-in IS the second factor (`amr` 'tg').
 *
 * Every leg of every door is one handler here, mounted per door with that
 * door's limits (`loginDoors.js`). Writing a door's legs as copies would be the
 * place one of three quietly stops asking (§5).
 *
 * What a token proves is ON the token (`amr`): `pwd`, `otp`, `tg`. Every path
 * that honours a session asks `secondFactorMissing` of it (auth.middleware.js).
 */
import express     from 'express';
import { getBalances } from './domains/wallet/walletAuthority.service.js';
import { db } from '#db';
// AQ-2: sign/verify via the single PASETO authority (PASETO/Ed25519, iss/aud stamped).
import { signToken, verifyJwt, decodeTokenClaims } from './domains/identity/jwt.util.js';
// AQ-8: password hashing authority (argon2id + bcrypt verify-fallback). Staff only.
import { hashPassword, verifyPassword } from './domains/identity/password.util.js';
import { isTokenRevoked, revokeToken } from '#db/repositories/identity.js';
import { verifyChallenge, issueChallenge, isChallengeToken } from './domains/identity/twoFactorChallenge.js';
import crypto from 'node:crypto';
import {
  sessionSuperseded, refuseSupersededSession, accountClosed, refuseClosedAccount,
  belongsElsewhere, refuseWrongPanel, secondFactorMissing, refuseMissingSecondFactor, hasStaffRole,
} from './domains/identity/auth.middleware.js';
import {
  beginEnrolment, completeEnrolment, checkSignInCode,
} from './domains/identity/totp.service.js';
import { currentBranding } from './domains/branding/brandingPayload.js';
import { normalisePhone, normaliseReferralCode } from './domains/identity/signupFields.js';
import { deliveryFor, openChallenge, ticketHash } from './domains/identity/telegramChallenge.service.js';
import { respondError, refusal } from './shared/httpError.js';
import { TELEGRAM_AUDIENCES } from '#db/repositories/telegram.js';
import { formatMerchant } from './domains/merchant/merchantSelfView.js';

const router = express.Router();

// httpOnly cookie options — secure in production, lax in dev
const COOKIE_OPTS = {
  httpOnly: true,
  secure:   process.env.NODE_ENV === 'production',
  sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
  maxAge:   7 * 24 * 60 * 60 * 1000,
  path:     '/',
};

// Helper — extract token from cookie OR Authorization header
// The bearer header wins: every panel is served from one origin, so a cookie
// can belong to another panel's sign-in in the same browser.
function extractToken(req) {
  return req.headers.authorization?.replace('Bearer ', '')
    || req.cookies?.auth_token
    || null;
}

/** Admin, sub-admin or mediator: `hasStaffRole`, the one rule. */
const isStaffAccount = hasStaffRole;

/**
 * WHICH DOOR a sign-in arrived at, and who that door admits.
 *
 * `accountType` is in the WHERE of the read (§33.5): the staff door never loads
 * a player row, and the merchant door never loads either. `admits` is the ROLE
 * question on top of that (a STAFF row with no staff role is nobody's admin).
 * The door is set by the mount (`loginDoors.js`), never by the request.
 */
export const LOGIN_DOOR = {
  STAFF: {
    name: 'staff',
    accountType: 'STAFF',
    admits: isStaffAccount,
    refusal: 'This account is not a staff account. Sign in on the panel your account belongs to.',
  },
  PLAYER: {
    name: 'player',
    accountType: 'PLAYER',
    // A PLAYER row is a player by construction; kept so the door can say who
    // it turns away.
    admits: () => true,
    refusal: 'This is not a player account. Sign in on the panel your account belongs to.',
  },
  MERCHANT: {
    name: 'merchant',
    accountType: 'MERCHANT',
    admits: () => true,
    refusal: 'This is not a merchant account. Sign in on the panel your account belongs to.',
  },
};

/** Send a refusal `{ status, code, message, ...extra }`. */
function send(res, r) {
  const { status, ...body } = r;
  return res.status(status).json({ success: false, ...body });
}

const INVALID_CREDENTIALS = {
  status: 401, code: 'INVALID_CREDENTIALS', message: 'Wrong mobile number or password.',
};

/**
 * Whether this account may sign in at this door at all, asked on EVERY leg —
 * between two legs an admin may have blocked it or taken its role away, and a
 * challenge minted at one door must not be redeemed at another.
 */
function accountRefusal(door, user, loginType = null) {
  if (!user) return INVALID_CREDENTIALS;
  if (user.accountType !== door.accountType || !door.admits(user)) {
    return { status: 403, code: 'WRONG_DOOR', message: door.refusal };
  }
  if (accountClosed(user)) {
    return { status: 403, code: 'ACCOUNT_CLOSED', message: 'This account has been closed. Contact support.' };
  }
  if (user.status === 'BLOCKED' || user.isBlocked) {
    return { status: 403, code: 'ACCOUNT_BLOCKED', message: 'This account is blocked. Contact support.' };
  }
  // The staff panel's role selector, re-applied on every leg.
  if (loginType === 'admin' && !user.isAdmin) return { status: 403, code: 'ROLE_REQUIRED', message: 'Admin access required.' };
  if (loginType === 'subadmin' && !user.isSubAdmin) return { status: 403, code: 'ROLE_REQUIRED', message: 'Sub-admin access required.' };
  return null;
}

const MERCHANT_STATE_MESSAGE = {
  PENDING: 'Your application is waiting for an admin\'s approval. You can sign in once it is approved.',
  REJECTED: 'Your application was not approved. Contact support.',
  SUSPENDED: 'Your account is suspended. Contact support.',
  INACTIVE: 'Your account is inactive. Contact support.',
};

/**
 * A merchant door's own question, after the account's: is the merchant
 * APPROVED and ACTIVE? Asked AFTER verification, so an applicant can verify
 * their Telegram while their application waits (approval and verification are
 * independent; signing in needs both).
 */
async function merchantRefusal(door, user) {
  if (door.accountType !== 'MERCHANT') return { merchant: null };
  // A merchant account's SUB-MEMBER signs in at the merchant door with their
  // own login (owner, 2026-10-11): their session is the owner merchant's,
  // acting as them, with the roles their row gives (`merchantAuth`).
  let staff = null;
  let merchant = await db.merchants.getMerchantByUserId(user.userId);
  if (!merchant) {
    staff = await db.merchantStaff.activeStaffByUser(user.userId);
    if (staff) merchant = await db.merchants.getMerchant(staff.merchantId);
  }
  if (!merchant) {
    return { refusal: { status: 403, code: 'MERCHANT_NOT_ACTIVE', message: 'This merchant account is not set up. Contact support.' } };
  }
  if (merchant.merchantApprovalStatus !== 'APPROVED' || merchant.status !== 'ACTIVE') {
    return {
      refusal: {
        status: 403, code: 'MERCHANT_NOT_ACTIVE',
        message: MERCHANT_STATE_MESSAGE[merchant.status]
          || MERCHANT_STATE_MESSAGE[merchant.merchantApprovalStatus]
          || 'Your account is not active. Contact support.',
      },
    };
  }
  return { merchant, staff };
}

/**
 * Mint the session for the door it was earned at. The ONE place a session
 * comes into existence (§2 "Login doors"): proving who you are changes WHEN
 * you get a session, never WHAT it contains.
 *
 * @param {object} door
 * @param {object} user     the `users` row
 * @param {object} res
 * @param {object} o
 * @param {string[]} o.amr  what this sign-in proved: 'pwd', 'otp', 'tg'
 * @param {object|null} [o.merchant]
 */
async function sessionFor(door, user, res, { amr, merchant = null, staff = null }) {
  if (door.accountType === 'MERCHANT') return issueMerchantSession(merchant, res, { amr, staff });
  return issueSession(user, res, { amr });
}

/**
 * The player and staff session (the cookie for the player app, the bearer for
 * the admin panel). `extra` is merged into the answer (a staff sign-in's
 * recovery codes, or how many are left).
 */
export async function issueSession(user, res, { amr, extra = {} } = {}) {
  if (!Array.isArray(amr) || !amr.length) throw new Error('issueSession: say what this sign-in proved (amr)');
  let role = 'user';
  if (user.isAdmin)          role = 'admin';
  else if (user.isSubAdmin)  role = 'subadmin';
  else if (user.isMediator)  role = 'mediator';

  const token = signToken(
    { userId: user.userId, mobile: user.mobile, role,
      isAdmin: user.isAdmin || false, isSubAdmin: user.isSubAdmin || false,
      amr: [...new Set(amr)],
      permissions: user.subAdminPermissions || {} }
  );

  // ── BALANCES COME FROM THE WALLET ───────────────────────────────────────
  // There is no balance column on the accounts table, by design: balances live
  // in `wallets`, in integer paise, behind a row lock, with one writer.
  const [balances, lastLogin] = await Promise.all([
    getBalances(user.userId),
    db.users.updateUser(user.userId, { lastLogin: new Date() }),
  ]);

  const dep = balances.depositBalance;
  const win = balances.winningsBalance;
  const userPayload = {
    id: user.userId, _id: user.userId, username: user.username, mobile: user.mobile,
    role, isAdmin: user.isAdmin || false, isSubAdmin: user.isSubAdmin || false,
    permissions: user.subAdminPermissions || {},
    depositBalance: dep, winningsBalance: win, lockedBalance: balances.lockedBalance,
    // Sent separately, and never folded into walletBalance: only
    // `betReservePercent` of a stake may come from the reserve.
    reserveBalance: balances.reserveBalance,
    walletBalance: dep + win,
    bankDetails: user.bankDetails || null, profilePic: user.profilePic || '',
    payoutDetailsLockedUntil: user.payoutDetailsLockedUntil ?? null,
    status: user.status || 'ACTIVE', joinedAt: user.joinedAt || null,
    lastLogin: lastLogin?.lastLogin ?? new Date(),
    phantomAccess: user.phantomAccess || 'NONE',
  };

  // Only a player session rides in the cookie. The admin panel sends its
  // bearer header; on one origin a staff cookie would reach the player app.
  if (user.accountType === 'PLAYER') res.cookie('auth_token', token, COOKIE_OPTS);
  return res.json({ ...extra, success: true, token, user: userPayload });
}

/**
 * The merchant session. Its token carries `merchantId` and `isMerchant`, which
 * is how `merchantAuth` knows it, and the same `amr` every session carries.
 */
export async function issueMerchantSession(merchant, res, { amr, staff = null } = {}) {
  if (!Array.isArray(amr) || !amr.length) throw new Error('issueMerchantSession: say what this sign-in proved (amr)');
  // A sub-member's session names their own login (`staffUserId`), whose
  // cutoff and row decide it on every request (`merchantLoginRow`).
  const token = signToken({
    merchantId: merchant._id,
    userId: staff ? staff.userId : merchant.userId,
    mobile: staff ? staff.mobile : merchant.mobile,
    ...(staff ? { staffUserId: staff.userId } : {}),
    isMerchant: true, isAdmin: false, amr: [...new Set(amr)],
  });
  // The panel's own view, from the one projection `GET /profile` answers with
  // (§5): a hand-built copy here lacked `isSupervisor`, so a supervisor signing
  // in was shown a member's online switch until the next reload. `actor` says
  // who is acting: the owner, or a sub-member and their roles.
  return res.json({
    success: true, token, merchant: formatMerchant(merchant),
    actor: staff
      ? { isOwner: false, staffId: staff.staffId, name: staff.name, roles: staff.roles }
      : { isOwner: true },
  });
}

// ── POST /api/admin/login ─────────────────────────────────────────────────────
// The staff door's password leg, and the only password leg there is: players
// and merchants have no password (owner, 2026-10-14). `doorRoute` mounts it at
// the staff door alone.
export async function loginHandler(req, res) {
  try {
    const { mobile, password, loginType = null } = req.body || {};
    if (!mobile || !password) {
      return send(res, { status: 400, code: 'CREDENTIALS_REQUIRED', message: 'Enter your mobile number and password.' });
    }
    const door = LOGIN_DOOR.STAFF;

    // The read is scoped by the door's population (§33.5). The mobile is read
    // the way the form normalises it, so `+91 98765 43210` finds `9876543210`.
    const user = await db.users.getUserByMobile(normalisePhone(mobile) || String(mobile), door.accountType);
    if (!user) return send(res, INVALID_CREDENTIALS);

    // The hash comes from the credentials read, the ONLY function that
    // returns it, so an ordinary user read cannot leak one.
    const credentials = await db.users.getUserCredentials(user.userId);
    const { valid, needsRehash } = await verifyPassword(credentials?.passwordHash, password);
    if (!valid) return send(res, INVALID_CREDENTIALS);

    // Upgrade a legacy bcrypt hash to argon2id, persisted in its own statement
    // so a sign-in that stops at the code step still upgrades it.
    if (needsRehash) {
      try {
        await db.users.updateUser(user.userId, { passwordHash: await hashPassword(password) });
      } catch { /* best-effort upgrade — never fail a valid login over it */ }
    }

    // After the password, so a wrong password and an account of another kind
    // read the same to a caller probing which numbers hold which accounts.
    const refused = accountRefusal(door, user, loginType);
    if (refused) return send(res, refused);

    // The authenticator app, never Telegram (owner, 2026-10-13): no session
    // yet; the code is the next leg.
    return staffCodeRequired(user, res, loginType);
  } catch (e) {
    return respondError(res, e, 'auth/login', { message: 'Sign-in failed. Please try again.' });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// THE STAFF AUTHENTICATOR (owner, 2026-10-13)
// ═══════════════════════════════════════════════════════════════════════════

/** How long a staff challenge token lasts: enough to scan a QR and type a code. */
const STAFF_CHALLENGE_TTL_SECONDS = 15 * 60;

/**
 * The answer to a right staff password: no session, a token for the next leg,
 * and which leg — a code from the enrolled app, or enrolling one.
 */
async function staffCodeRequired(user, res, loginType) {
  const { enrolled } = await db.totp.getState(user.userId);
  const step = enrolled ? 'totp' : 'totp_setup';
  return res.status(200).json({
    success: false,               // deliberately NOT a logged-in success
    twoFactorRequired: true,
    ...(enrolled ? { totpRequired: true } : { totpSetupRequired: true }),
    challengeToken: issueChallenge({
      userId: user.userId, door: 'STAFF', step, loginType,
      challengeId: `t${crypto.randomBytes(16).toString('hex')}`,
      ttlSeconds: STAFF_CHALLENGE_TTL_SECONDS,
    }),
    message: enrolled
      ? 'Type the 6-digit code from your authenticator app.'
      : 'Set up your authenticator app to finish signing in.',
  });
}

/**
 * The account a staff challenge token names, asked every account question
 * again: between the password and the code an admin may have blocked it or
 * taken its role away. Answers `{ user }` or `{ refusal }`.
 */
async function staffChallengeAccount(req, step) {
  const challenge = verifyChallenge(req.body?.challengeToken, 'STAFF', step);
  if (!challenge?.userId) {
    return {
      refusal: {
        status: 401, code: 'TWO_FACTOR_EXPIRED', twoFactorExpired: true,
        message: 'This sign-in has expired. Please sign in again.',
      },
    };
  }
  const user = await db.users.getUser(challenge.userId);
  const refused = accountRefusal(LOGIN_DOOR.STAFF, user, challenge.loginType);
  return refused ? { refusal: refused } : { user };
}

/** POST /api/admin/login/totp `{ challengeToken, code }` — the code, then a session. */
export async function totpLoginHandler(req, res) {
  try {
    const { user, refusal: refused } = await staffChallengeAccount(req, 'totp');
    if (refused) return send(res, refused);
    const checked = await checkSignInCode(user, req.body?.code);
    return issueSession(user, res, {
      amr: ['pwd', 'otp'],
      extra: checked.method === 'recovery' ? { recoveryCodesLeft: checked.recoveryCodesLeft } : {},
    });
  } catch (e) {
    return respondError(res, e, 'auth/login/totp', { message: 'Sign-in failed. Please try again.' });
  }
}

/**
 * POST /api/admin/login/totp/setup `{ challengeToken }` — the secret and its QR
 * for an account that has no authenticator yet. 409 once one is enrolled:
 * only an admin's reset or the break-glass script replaces it.
 */
export async function totpSetupHandler(req, res) {
  try {
    const { user, refusal: refused } = await staffChallengeAccount(req, 'totp_setup');
    if (refused) return send(res, refused);
    const branding = await currentBranding();
    const issuer = branding?.appName || 'Betting Bazaar'; // schema default: 'Betting Bazaar' (config.spec.js)
    const { secret, otpauthUri, qrDataUrl } = await beginEnrolment(user, { issuer });
    return res.json({ success: true, secret, otpauthUri, qrDataUrl });
  } catch (e) {
    return respondError(res, e, 'auth/login/totp/setup', { message: 'Could not start the authenticator setup.' });
  }
}

/**
 * POST /api/admin/login/totp/activate `{ challengeToken, code }` — the first
 * code from the app. Answers a session AND the ten recovery codes, shown once.
 */
export async function totpActivateHandler(req, res) {
  try {
    const { user, refusal: refused } = await staffChallengeAccount(req, 'totp_setup');
    if (refused) return send(res, refused);
    const { recoveryCodes } = await completeEnrolment(user, req.body?.code);
    return issueSession(user, res, { amr: ['pwd', 'otp'], extra: { recoveryCodes } });
  } catch (e) {
    return respondError(res, e, 'auth/login/totp/activate', { message: 'Could not finish the authenticator setup.' });
  }
}

/**
 * The door a Telegram leg serves: a player's or a merchant's, never staff's
 * (owner, 2026-10-13: staff have no Telegram). `doorRoute` already refuses to
 * mount one at the staff door; this refuses a handler mounted without a door
 * rather than defaulting to one.
 */
function telegramDoor(req) {
  const door = req.loginDoor;
  if (!door || !TELEGRAM_AUDIENCES.includes(door.accountType)) {
    throw refusal(404, 'NO_TELEGRAM_STEP', 'This sign-in has no Telegram step.');
  }
  return door;
}

/**
 * What a poll is told when nothing was redeemed. 202 keeps the panel polling;
 * a 401 tells it to stop and start the sign-in again.
 */
function notRedeemed(res, state) {
  if (state === 'PENDING' || state === 'APPROVED') {
    return res.status(202).json({
      success: false, pending: true, code: 'TWO_FACTOR_PENDING',
      message: 'Waiting for you to approve in Telegram.',
    });
  }
  if (state === 'DENIED') {
    return send(res, {
      status: 401, code: 'TWO_FACTOR_DENIED',
      message: 'This sign-in was refused in Telegram. Press Continue with Telegram to start again.',
    });
  }
  return send(res, {
    status: 401, code: 'TWO_FACTOR_EXPIRED', twoFactorExpired: true,
    message: 'This sign-in has expired. Please sign in again.',
  });
}

/**
 * POST {door}/login/telegram `{ delivery?, referralCode? }` — "Continue with
 * Telegram": opens the sign-in and gives the browser its Mini App link.
 *
 * How the approval will reach a browser is the caller's to ask (`delivery`):
 * HANDOFF on the phone that will open Telegram itself, MATCH elsewhere, and a
 * HANDOFF only where the caller opens again at the site's own address
 * (`returnOrigin`, `deliveryFor`); the answer's `delivery` is what it got. Either
 * is safe whoever asks: a HANDOFF is never spent by this browser's poll, only
 * by the ticket Verify opens on the device that pressed it
 * (repositories/telegram.js, `redeemTicket`), and a MATCH is approved only
 * with the number this browser shows. No bot is the platform's state, said
 * plainly (503 TELEGRAM_UNAVAILABLE).
 */
export async function telegramLoginHandler(req, res) {
  try {
    const door = telegramDoor(req);
    const isPlayer = door.accountType === 'PLAYER';
    const opened = await openChallenge({
      door: door.accountType, req,
      delivery: deliveryFor(req.body?.delivery, req.body?.returnOrigin, door.accountType),
      referralCode: isPlayer ? normaliseReferralCode(req.body?.referralCode) : null,
    });
    return res.status(200).json({
      success: false, pending: true,
      challengeToken: opened.challengeToken,
      telegram: opened.telegram,
      delivery: opened.delivery,
      matchNumber: opened.matchNumber,
      message: opened.delivery === 'HANDOFF'
        ? 'Open Telegram and press Verify. It brings you back here signed in.'
        : 'Open Telegram, choose the number shown here, and press Verify.',
    });
  } catch (e) {
    return respondError(res, e, 'auth/login/telegram', { message: 'Telegram sign-in failed. Please try again.' });
  }
}

/**
 * POST {door}/login/telegram/complete `{ challengeToken }` — has the Mini App
 * answered this browser's sign-in?
 *
 * A MATCH approval is spent here, once, and every account question is asked
 * again (an admin may have blocked the account, or a merchant application may
 * still be waiting). A HANDOFF is never this browser's to spend: its session
 * went to the device that pressed Verify, through the ticket; the poll is told
 * that it happened.
 */
export async function telegramLoginCompleteHandler(req, res) {
  try {
    const door = telegramDoor(req);
    const challenge = verifyChallenge(req.body?.challengeToken, door.accountType);
    if (!challenge) return notRedeemed(res, 'EXPIRED');

    const row = await db.telegram.getChallenge(challenge.challengeId);
    if (row?.delivery === 'HANDOFF' && row.audience === door.accountType) {
      if (row.status === 'APPROVED' || row.status === 'REDEEMED') {
        return res.status(200).json({
          success: false, handedOff: true,
          message: 'Verified in Telegram. You are signed in where Telegram opened the site.',
        });
      }
      return notRedeemed(res, db.telegram.stateOf(row, { audience: door.accountType }));
    }

    const spent = await db.telegram.redeemChallenge({
      challengeId: challenge.challengeId, audience: door.accountType,
    });
    if (!spent.ok) return notRedeemed(res, spent.state);
    return signInRedeemed(door, spent.userId, res);
  } catch (e) {
    return respondError(res, e, 'auth/login/telegram/complete', { message: 'Telegram sign-in failed. Please try again.' });
  }
}

/**
 * The session for a redeemed Telegram sign-in, after every account question
 * the door asks: the approval is seconds old, and an admin may have blocked
 * the account in those seconds; a merchant must be APPROVED and ACTIVE.
 */
async function signInRedeemed(door, userId, res) {
  const user = await db.users.getUser(userId);
  const refused = accountRefusal(door, user);
  if (refused) return send(res, refused);
  const { merchant, staff, refusal: notActive } = await merchantRefusal(door, user);
  if (notActive) return send(res, notActive);
  return sessionFor(door, user, res, { amr: ['tg'], merchant, staff });
}

/**
 * POST {door}/login/telegram/ticket `{ ticket }` — the site, opened by the Mini
 * App at `#/tg/<ticket>`, exchanges the ticket for the session.
 *
 * The ticket is spent once, with its HANDOFF challenge, at this door
 * (`redeemTicket`). Every account question is asked again: the approval is
 * seconds old, and an admin may have blocked the account in those seconds.
 */
export async function telegramTicketHandler(req, res) {
  try {
    const door = telegramDoor(req);
    const ticket = String(req.body?.ticket || '');
    const spent = ticket ? await db.telegram.redeemTicket({ ticketHash: ticketHash(ticket), audience: door.accountType }) : { ok: false };
    if (!spent.ok) {
      return send(res, {
        status: 401, code: 'TICKET_INVALID',
        message: 'This sign-in link has already been used or has expired. Press Continue with Telegram again.',
      });
    }
    return signInRedeemed(door, spent.userId, res);
  } catch (e) {
    return respondError(res, e, 'auth/login/telegram/ticket', { message: 'Telegram sign-in failed. Please try again.' });
  }
}

// The handlers above are mounted per door by `loginDoors.js`: the player door
// in playerAuth.routes.js, the staff door in server.js, the merchant door in
// merchant.routes.js — each with that door's own limits.

// ── GET /me — session restore on every page load ─────────────────────────────
router.get('/me', async (req, res) => {
  try {
    const token = extractToken(req);
    if (!token) return res.status(401).json({ success: false, message: 'No token provided' });

    const decoded = verifyJwt(token);
    if (isChallengeToken(decoded)) {
      return res.status(401).json({ success: false, code: 'TWO_FACTOR_REQUIRED', message: 'Finish signing in first.' });
    }

    // NOT wrapped in a swallow: isTokenRevoked fails closed.
    if (await isTokenRevoked(token)) {
      return res.status(401).json({ success: false, message: 'Token invalidated. Please login again.' });
    }

    const user = await db.users.getUser(decoded.userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    // The SAME checks `authenticate` applies, from the same functions: this
    // endpoint verifies the token inline and never calls that middleware
    // (§32 S32).
    if (accountClosed(user)) return refuseClosedAccount(res);
    if (sessionSuperseded(user, decoded)) return refuseSupersededSession(res);
    if (belongsElsewhere(user, ['PLAYER', 'STAFF'])) return refuseWrongPanel(res, user);
    if (secondFactorMissing(user.accountType, decoded)) return refuseMissingSecondFactor(res);

    if (user.isBlocked || user.status === 'BLOCKED')
      return res.status(403).json({ success: false, message: 'Account blocked' });

    const balances = await getBalances(String(decoded.userId));
    const dep = balances.depositBalance  || 0;
    const win = balances.winningsBalance || 0;
    res.json({
      success: true,
      user: {
        id: user.userId, _id: user.userId, username: user.username, mobile: user.mobile,
        role: decoded.role, isAdmin: user.isAdmin || false, isSubAdmin: user.isSubAdmin || false,
        permissions: user.subAdminPermissions || {},
        depositBalance: dep, winningsBalance: win, lockedBalance: balances.lockedBalance || 0,
        reserveBalance: balances.reserveBalance || 0,
        walletBalance: dep + win,
        bankDetails: user.bankDetails || null, profilePic: user.profilePic || '',
        payoutDetailsLockedUntil: user.payoutDetailsLockedUntil ?? null,
        status: user.status || 'ACTIVE', joinedAt: user.joinedAt || null,
        lastLogin: user.lastLogin || null, phantomAccess: user.phantomAccess || 'NONE',
      },
    });
  } catch (e) {
    console.error('Auth check error:', e);
    res.status(401).json({ success: false, message: 'Invalid or expired token' });
  }
});

// ── POST /logout ─────────────────────────────────────────────────────────────
router.post('/logout', async (req, res) => {
  try {
    const token = extractToken(req);
    if (token) {
      // A failed revocation is reported: the caller must not be told the token
      // is dead when it is not.
      try {
        const decoded = decodeTokenClaims(token);
        const exp = decoded?.exp ? new Date(decoded.exp * 1000) : new Date(Date.now() + 7 * 86400000);
        await revokeToken(token, { ttlSeconds: Math.max(1, Math.ceil((exp - Date.now()) / 1000)) });
      } catch (e) {
        console.error('[auth] logout could not revoke the token:', e.message);
        res.clearCookie('auth_token', { path: '/' });
        return res.status(500).json({
          success: false,
          message: 'Signed out on this device, but the session could not be revoked. '
                 + 'Please try again — the token is still valid until you do.',
        });
      }
    }
    res.clearCookie('auth_token', { path: '/' });
    res.json({ success: true, message: 'Logged out successfully' });
  } catch {
    res.json({ success: true, message: 'Logged out successfully' });
  }
});

export default router;
