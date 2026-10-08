// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * routes.js — the three sign-in doors, the one place a session is minted, and
 * the session lifecycle.
 *
 * ── Step 3 (owner, 2026-10-07) ─────────────────────────────────────────────
 * "they must verify and share contact on signup ... now they can do login
 * without telegram mini app but add also login with telegram button too."
 *
 * So a sign-in is a mobile, a password and a captcha, at the door of the
 * account's own panel (CLAUDE.md §33):
 *
 *   • An account whose mobile Telegram has not yet verified is not signed in:
 *     it is answered 403 TELEGRAM_VERIFICATION_REQUIRED with a Mini App link,
 *     and finishing that step signs it in (`/login/2fa`).
 *   • A staff or merchant sign-in is also approved in the account's own
 *     Telegram (the second factor); a player's is, only if they switched it on.
 *   • "Login with Telegram" (`/login/telegram`): a player is signed in by
 *     Telegram alone; staff and merchants still give their password.
 *
 * Every leg of every door is one handler here, mounted per door with that
 * door's limits (`loginDoors.js`). Writing a door's legs as copies would be the
 * place one of three quietly stops asking (§5).
 *
 * What a token proves is ON the token (`amr`): `pwd`, `tg`, or both. Every path
 * that honours a session asks `secondFactorMissing` of it (auth.middleware.js).
 */
import express     from 'express';
import { getBalances } from './domains/wallet/walletAuthority.service.js';
import { db } from '#db';
// AQ-2: sign/verify via the single PASETO authority (PASETO/Ed25519, iss/aud stamped).
import { signToken, verifyJwt, decodeTokenClaims } from './domains/identity/jwt.util.js';
// AQ-8: password hashing authority (argon2id + bcrypt verify-fallback).
import { hashPassword, verifyPassword } from './domains/identity/password.util.js';
import { isTokenRevoked, revokeToken } from '#db/repositories/identity.js';
import { verifyChallenge, issueChallenge, isChallengeToken } from './domains/identity/twoFactorChallenge.js';
import { verifySecondFactor, SECOND_FACTOR_RESULT } from './domains/identity/verifySecondFactor.js';
import {
  sessionSuperseded, refuseSupersededSession, accountClosed, refuseClosedAccount,
  belongsElsewhere, refuseWrongPanel, secondFactorMissing, refuseMissingSecondFactor,
  staffBootstrap,
} from './domains/identity/auth.middleware.js';
import { normalisePhone } from './domains/identity/signupFields.js';
import {
  openChallenge, newChallengeId, telegramUnavailable, REDEEM_WINDOW_SECONDS,
} from './domains/identity/telegramChallenge.service.js';
import { miniAppBot } from './domains/telegram/telegramClient.js';
import { verifyInitData } from './domains/telegram/miniAppAuth.js';
import { miniAppRefusal } from './domains/telegram/miniAppRefusals.js';
import { respondError } from './shared/httpError.js';

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
function extractToken(req) {
  return req.cookies?.auth_token
    || req.headers.authorization?.replace('Bearer ', '')
    || null;
}

/** Admin, sub-admin, queue manager or mediator. */
function isStaffAccount(user) {
  return Boolean(user?.isAdmin || user?.isSubAdmin || user?.isQueueManager || user?.isMediator);
}

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
  if (loginType === 'queue_manager' && !user.isQueueManager) return { status: 403, code: 'ROLE_REQUIRED', message: 'Queue manager access required.' };
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
  const merchant = await db.merchants.getMerchantByUserId(user.userId);
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
  return { merchant };
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
 * @param {string[]} o.amr  what this sign-in proved: 'pwd', 'tg', or both
 * @param {object|null} [o.merchant]
 */
async function sessionFor(door, user, res, { amr, merchant = null }) {
  if (door.accountType === 'MERCHANT') return issueMerchantSession(merchant, res, { amr });
  return issueSession(user, res, { amr });
}

/**
 * The player and staff session (the cookie for the player app, the bearer for
 * the admin panel).
 */
export async function issueSession(user, res, { amr = ['pwd'] } = {}) {
  let role = 'user';
  if (user.isAdmin)          role = 'admin';
  else if (user.isSubAdmin)  role = 'subadmin';
  else if (user.isQueueManager) role = 'queue_manager';
  else if (user.isMediator)  role = 'mediator';

  const token = signToken(
    { userId: user.userId, mobile: user.mobile, role,
      isAdmin: user.isAdmin || false, isSubAdmin: user.isSubAdmin || false,
      isQueueManager: user.isQueueManager || false,
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
    isQueueManager: user.isQueueManager || false, permissions: user.subAdminPermissions || {},
    depositBalance: dep, winningsBalance: win, lockedBalance: balances.lockedBalance,
    // Sent separately, and never folded into walletBalance: only
    // `betReservePercent` of a stake may come from the reserve.
    reserveBalance: balances.reserveBalance,
    walletBalance: dep + win,
    bankDetails: user.bankDetails || null, profilePic: user.profilePic || '',
    status: user.status || 'ACTIVE', joinedAt: user.joinedAt || null,
    lastLogin: lastLogin?.lastLogin ?? new Date(),
    phantomAccess: user.phantomAccess || 'NONE',
    twoFactorEnabled: user.twoFactorEnabled || false,
  };

  res.cookie('auth_token', token, COOKIE_OPTS);
  return res.json({
    success: true, token, user: userPayload,
    // The staff bootstrap (§33): no Mini App bot yet, so this staff session is
    // a password alone. The admin panel shows a standing banner naming the
    // Telegram screen that ends it.
    ...(user.accountType === 'STAFF' && await staffBootstrap() ? { bootstrap: true } : {}),
  });
}

/**
 * The merchant session. Its token carries `merchantId` and `isMerchant`, which
 * is how `merchantAuth` knows it, and the same `amr` every session carries.
 */
export async function issueMerchantSession(merchant, res, { amr = ['pwd'] } = {}) {
  const token = signToken({
    merchantId: merchant._id, userId: merchant.userId, mobile: merchant.mobile,
    isMerchant: true, isAdmin: false, amr: [...new Set(amr)],
  });
  return res.json({
    success: true, token,
    merchant: {
      _id: merchant._id, userId: merchant.userId,
      username: merchant.username, mobile: merchant.mobile, email: merchant.email,
      status: merchant.status, isOnline: merchant.isOnline,
      acceptsDeposits: merchant.acceptsDeposits !== false,
      acceptsWithdrawals: merchant.acceptsWithdrawals !== false,
      twoFactorEnabled: merchant.twoFactorEnabled || false,
    },
  });
}

/**
 * The Telegram step an unverified account owes before it can be signed in:
 * 403 TELEGRAM_VERIFICATION_REQUIRED with a fresh Mini App link. Finishing it
 * signs them in through `/login/2fa`, because they have just proved both the
 * password and the phone.
 */
async function verificationRequired(door, user, req, res, loginType) {
  const opened = await openChallenge({ purpose: 'VERIFY', door: door.accountType, userId: user.userId, req, loginType });
  return res.status(403).json({
    success: false,
    code: 'TELEGRAM_VERIFICATION_REQUIRED',
    verificationRequired: true,
    challengeToken: opened.challengeToken,
    telegram: opened.telegram,
    message: 'Verify your mobile number in Telegram to finish. Open the link, share your contact, then come back here.',
  });
}

// ── POST {door}/login ────────────────────────────────────────────────────────
export async function loginHandler(req, res) {
  try {
    const { mobile, password, loginType = null, challengeToken = null } = req.body || {};
    if (!mobile || !password) {
      return send(res, { status: 400, code: 'CREDENTIALS_REQUIRED', message: 'Enter your mobile number and password.' });
    }
    // Defaults to STAFF: a caller that never set a door would be a test, and a
    // default of "anyone" is the wrong way for that to fail.
    const door = req.loginDoor || LOGIN_DOOR.STAFF;

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
    // so a sign-in that stops at a Telegram step still upgrades it.
    if (needsRehash) {
      try {
        await db.users.updateUser(user.userId, { passwordHash: await hashPassword(password) });
      } catch { /* best-effort upgrade — never fail a valid login over it */ }
    }

    // After the password, so a wrong password and an account of another kind
    // read the same to a caller probing which numbers hold which accounts.
    const refused = accountRefusal(door, user, loginType);
    if (refused) return send(res, refused);

    const bot = await miniAppBot();
    // ── The staff bootstrap (§33) ──────────────────────────────────────────
    // No bot yet: a staff account signs in on its password, and says so.
    if (!bot && door.accountType === 'STAFF') return issueSession(user, res, { amr: ['pwd'] });

    // ── Verified yet? ──────────────────────────────────────────────────────
    const link = await db.telegram.getLinkByUserId(user.userId);
    if (!link) {
      if (!bot) throw telegramUnavailable();
      return verificationRequired(door, user, req, res, loginType);
    }

    const { merchant, refusal: notActive } = await merchantRefusal(door, user);
    if (notActive) return send(res, notActive);

    // ── Second factor ──────────────────────────────────────────────────────
    // Always for staff and merchants (the link's CHECK says so); a player's
    // own switch otherwise.
    if (!link.twoFactor) return sessionFor(door, user, res, { amr: ['pwd'], merchant });

    // A Telegram sign-in already approved for THIS account at THIS door — the
    // staff and merchant "Login with Telegram", finished with the password.
    // The account is in the redeem's WHERE, so another account's approval
    // spends nothing here.
    const presented = verifyChallenge(challengeToken, door.accountType);
    if (presented) {
      const spent = await db.telegram.redeemChallenge({
        challengeId: presented.challengeId, audience: door.accountType,
        purposes: ['TELEGRAM_LOGIN'], userId: user.userId,
      });
      if (spent.ok) return sessionFor(door, user, res, { amr: ['pwd', 'tg'], merchant });
    }

    if (!bot) throw telegramUnavailable();
    const opened = await openChallenge({ purpose: 'LOGIN', door: door.accountType, userId: user.userId, req, loginType });
    return res.status(200).json({
      success: false,               // deliberately NOT a logged-in success
      twoFactorRequired: true,
      challengeToken: opened.challengeToken,
      telegram: opened.telegram,
      // An authenticator app enrolled before Step 3 may answer instead, until
      // TOTP is removed in its own commit.
      totpAvailable: await totpEnrolled(door, user),
      message: 'Approve this sign-in in Telegram. Open the link on your phone, then come back here.',
    });
  } catch (e) {
    return respondError(res, e, 'auth/login', { message: 'Sign-in failed. Please try again.' });
  }
}

// ── The authenticator app, until TOTP is removed in its own commit ──────────
async function totpCredentials(door, user) {
  if (door.accountType === 'MERCHANT') {
    const merchant = await db.merchants.getMerchantByUserId(user.userId);
    if (!merchant) return null;
    const creds = await db.merchants.getMerchantCredentials(merchant.merchantId);
    return creds && {
      creds,
      store: {
        spendCounter: (counter) => db.merchants.spendTwoFactorCounter(merchant.merchantId, counter),
        consumeBackupCode: (arg) => db.merchants.consumeTwoFactorBackupCode(merchant.merchantId, arg),
      },
    };
  }
  const creds = await db.users.getUserCredentials(user.userId);
  return creds && {
    creds,
    store: {
      spendCounter: (counter) => db.users.spendTwoFactorCounter(user.userId, counter),
      consumeBackupCode: (arg) => db.users.consumeTwoFactorBackupCode(user.userId, arg),
    },
  };
}

async function totpEnrolled(door, user) {
  const found = await totpCredentials(door, user);
  return Boolean(found?.creds?.twoFactorEnabled);
}

async function totpVerdict(door, user, code) {
  const found = await totpCredentials(door, user);
  if (!found?.creds?.twoFactorEnabled) return { ok: false };
  return verifySecondFactor(found.creds, code, found.store);
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
      message: 'This sign-in was refused in Telegram. If that was not you, change your password.',
    });
  }
  return send(res, {
    status: 401, code: 'TWO_FACTOR_EXPIRED', twoFactorExpired: true,
    message: 'This sign-in has expired. Please sign in again.',
  });
}

/**
 * POST {door}/login/2fa `{ challengeToken }` — the browser that signed in (or
 * signed up) asks whether Telegram has answered.
 *
 * Redeems a VERIFY or LOGIN challenge of this door, once, and re-asks every
 * account question the first leg asked: the challenge proves the password was
 * right minutes ago, nothing more.
 */
export async function loginTwoFactorHandler(req, res) {
  try {
    const door = req.loginDoor || LOGIN_DOOR.STAFF;
    const { challengeToken, code } = req.body || {};
    if (!challengeToken) {
      return send(res, { status: 400, code: 'CHALLENGE_REQUIRED', message: 'Sign in again to continue.' });
    }
    const challenge = verifyChallenge(challengeToken, door.accountType);
    if (!challenge?.userId) return notRedeemed(res, 'EXPIRED');

    // ── An authenticator code, until TOTP is removed ───────────────────────
    if (code) {
      const user = await db.users.getUser(challenge.userId);
      const refused = accountRefusal(door, user, challenge.loginType);
      if (refused) return send(res, refused);
      if (!(await db.telegram.getLinkByUserId(user.userId))) return notRedeemed(res, 'EXPIRED');
      const verdict = await totpVerdict(door, user, code);
      if (!verdict.ok) {
        if (verdict.result === SECOND_FACTOR_RESULT.MALFORMED_SECRET) {
          console.error(`🚨 2FA secret undecryptable for ${user.userId} — check TOTP_ENCRYPTION_KEY`);
        }
        return send(res, { status: 401, code: 'INVALID_CODE', message: 'Invalid authentication code.' });
      }
      const { merchant, refusal: notActive } = await merchantRefusal(door, user);
      if (notActive) return send(res, notActive);
      return sessionFor(door, user, res, { amr: ['pwd', 'otp'], merchant });
    }

    const spent = await db.telegram.redeemChallenge({
      challengeId: challenge.challengeId, audience: door.accountType,
      purposes: ['VERIFY', 'LOGIN'], userId: challenge.userId,
    });
    if (!spent.ok) return notRedeemed(res, spent.state);

    const user = await db.users.getUser(spent.userId);
    const refused = accountRefusal(door, user, challenge.loginType);
    if (refused) return send(res, refused);
    const { merchant, refusal: notActive } = await merchantRefusal(door, user);
    if (notActive) {
      // Verified, and still waiting for approval: say so, so the panel can
      // show "verified" rather than an error.
      return send(res, { ...notActive, verified: spent.purpose === 'VERIFY' });
    }
    return sessionFor(door, user, res, { amr: ['pwd', 'tg'], merchant });
  } catch (e) {
    return respondError(res, e, 'auth/login/2fa', { message: 'Sign-in failed. Please try again.' });
  }
}

/**
 * POST {door}/login/telegram `{ initData? }` — "Login with Telegram".
 *
 * Inside Telegram (the Mini App sends its `initData`), the signed string is the
 * proof: a player is signed in on it; staff and merchants are handed a token
 * that their password then completes. Outside Telegram, a challenge is opened
 * and the browser is given its Mini App link to open, and polls
 * `/login/telegram/complete` (owner reading 2026-10-07: the Login Widget only
 * serves one domain per bot, and three panels and the app are not one domain).
 */
export async function telegramLoginHandler(req, res) {
  try {
    const door = req.loginDoor || LOGIN_DOOR.STAFF;
    const bot = await miniAppBot();
    if (!bot) throw telegramUnavailable();

    const raw = req.body?.initData;
    if (!raw) {
      const opened = await openChallenge({ purpose: 'TELEGRAM_LOGIN', door: door.accountType, userId: null, req });
      return res.status(200).json({
        success: false, pending: true,
        challengeToken: opened.challengeToken,
        telegram: opened.telegram,
        message: 'Open Telegram to sign in, then come back here.',
      });
    }

    const proof = verifyInitData(raw, { botToken: bot.token });
    if (!proof.ok) return send(res, miniAppRefusal(proof.reason));

    const isPlayer = door.accountType === 'PLAYER';
    const challengeId = isPlayer ? null : newChallengeId();
    const signedIn = await db.telegram.telegramSignIn({
      audience: door.accountType, telegramUser: proof.user,
      initData: { hash: proof.hash, expiresAt: proof.expiresAt },
      challengeId, redeemWindowSeconds: REDEEM_WINDOW_SECONDS,
      requestedIp: req.ip, requestedAgent: req.get('user-agent') || '',
    });
    if (!signedIn.ok) return send(res, miniAppRefusal(signedIn.code));

    const user = await db.users.getUser(signedIn.userId);
    const refused = accountRefusal(door, user);
    if (refused) return send(res, refused);

    if (!isPlayer) {
      return res.status(200).json({
        success: false, passwordRequired: true,
        challengeToken: issueChallenge({
          userId: null, door: door.accountType, challengeId, ttlSeconds: REDEEM_WINDOW_SECONDS,
        }),
        message: 'Telegram confirmed it is you. Enter your mobile number and password to finish.',
      });
    }
    return sessionFor(door, user, res, { amr: ['tg'] });
  } catch (e) {
    return respondError(res, e, 'auth/login/telegram', { message: 'Telegram sign-in failed. Please try again.' });
  }
}

/**
 * POST {door}/login/telegram/complete `{ challengeToken }` — has the Mini App
 * answered a "Login with Telegram" opened outside Telegram?
 *
 * A player is signed in on the approval (spent here, once). Staff and
 * merchants are told their password is next, and the approval is spent only
 * when the password arrives with this same token (`loginHandler`), bound in
 * that redeem to the account the password proved.
 */
export async function telegramLoginCompleteHandler(req, res) {
  try {
    const door = req.loginDoor || LOGIN_DOOR.STAFF;
    const challenge = verifyChallenge(req.body?.challengeToken, door.accountType);
    if (!challenge) return notRedeemed(res, 'EXPIRED');

    if (door.accountType !== 'PLAYER') {
      const state = db.telegram.stateOf(await db.telegram.getChallenge(challenge.challengeId), {
        audience: door.accountType, purposes: ['TELEGRAM_LOGIN'],
      });
      if (state !== 'APPROVED') return notRedeemed(res, state);
      return res.status(200).json({
        success: false, passwordRequired: true,
        message: 'Telegram confirmed it is you. Enter your mobile number and password to finish.',
      });
    }

    const spent = await db.telegram.redeemChallenge({
      challengeId: challenge.challengeId, audience: door.accountType, purposes: ['TELEGRAM_LOGIN'],
    });
    if (!spent.ok) return notRedeemed(res, spent.state);
    const user = await db.users.getUser(spent.userId);
    const refused = accountRefusal(door, user);
    if (refused) return send(res, refused);
    return sessionFor(door, user, res, { amr: ['tg'] });
  } catch (e) {
    return respondError(res, e, 'auth/login/telegram/complete', { message: 'Telegram sign-in failed. Please try again.' });
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
    if (await secondFactorMissing(user.accountType, decoded)) return refuseMissingSecondFactor(res);

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
        isQueueManager: user.isQueueManager || false, permissions: user.subAdminPermissions || {},
        depositBalance: dep, winningsBalance: win, lockedBalance: balances.lockedBalance || 0,
        reserveBalance: balances.reserveBalance || 0,
        walletBalance: dep + win,
        bankDetails: user.bankDetails || null, profilePic: user.profilePic || '',
        status: user.status || 'ACTIVE', joinedAt: user.joinedAt || null,
        lastLogin: user.lastLogin || null, phantomAccess: user.phantomAccess || 'NONE',
      },
      // The staff bootstrap, re-stated on every load: it ends the moment a bot
      // is saved, and a panel that read it only at sign-in would keep the
      // banner up over a session that is about to be refused.
      ...(user.accountType === 'STAFF' && await staffBootstrap() ? { bootstrap: true } : {}),
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
