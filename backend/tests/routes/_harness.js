// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The route harness — a real Express app, real routers, real database.
 *
 * ── Why these tests are not unit tests ──────────────────────────────────────
 * The defects this platform kept producing at the route layer were not logic
 * errors. They were handlers that could not run at all: `.save()` called on a
 * plain object the repository returned, `.select()` chained onto a promise, a
 * create that passed no id to a table whose primary key is one. Every one of
 * those is invisible to a unit test that mocks the data layer, because the mock
 * has whatever method the handler reaches for.
 *
 * So nothing here is mocked below the HTTP boundary. The router is the real
 * one, the middleware chain is the real one, the token is really minted and
 * really verified, and the database is really PostgreSQL. A handler that would
 * throw in production throws here.
 *
 * ── What is deliberately NOT covered ────────────────────────────────────────
 * Rate limiting, CSRF and the WAF filter are mounted by `server.js`, not by the
 * routers, so a route test says nothing about them. They have their own suites.
 */
import { randomInt } from 'node:crypto';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { signToken } from '../../domains/identity/paseto.util.js';
import { createUser, updateUser, setRoles } from '#db/repositories/users.js';
import {
  createMerchant, updateMerchant, newMerchantId, generateMerchantPublicRef,
} from '#db/repositories/merchants.js';
import { creditMerchantTokens } from '../../domains/merchant/merchantWallet.service.js';

/**
 * A mobile number nothing else in the run holds.
 *
 * ── The defect this shape used to have, and what it cost ────────────────────
 * The seed was `Math.random() * 90_000` and the generator counted up from it.
 * Each test FILE gets a fresh module registry, so each drew its own seed out of
 * a 90,000-wide space and then walked forward through it. Across the 65 files in
 * this tier, two files starting near each other and each taking a few dozen
 * numbers overlap routinely — and the database is shared and never reset
 * between files, so the second file's insert hit the first file's row.
 *
 * `createUser` is `ON CONFLICT (mobile) DO NOTHING`, so that collision wrote
 * NOTHING and returned the OTHER user. The harness signed a token for a
 * `userId` with no row behind it, and the failure surfaced hundreds of lines
 * away as a 401 from `authenticate` and a `null` from the test's own `getUser`
 * — in a file that had nothing to do with whichever file took the number first.
 *
 * The space is now the full nine digits from `crypto.randomInt`, which is
 * 1-in-a-billion per draw rather than 1-in-90,000, and the counter still
 * guarantees uniqueness WITHIN a file when several actors are built in the same
 * millisecond by `Promise.all`. The retry in `actor()` covers the rest: this
 * generator makes a collision unlikely, and that check makes one harmless.
 */
let mobileSeq = randomInt(0, 1_000_000_000);
function uniqueMobile(prefix) {
  mobileSeq = (mobileSeq + 1) % 1_000_000_000;
  return `${prefix}${String(mobileSeq).padStart(9, '0')}`;
}

/**
 * Mount one router on a bare app, with only the middleware the router itself
 * relies on: a JSON body parser and cookies.
 *
 * `mergeParams` is off and no prefix is applied, so paths in a test are the
 * paths the router declares — a test that passes here is asserting the route,
 * not a mount point that could differ in server.js.
 */
export function mountRouter(router, { prefix = '' } = {}) {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  if (prefix) app.use(prefix, router); else app.use(router);
  // The error shape the app uses. Without this Express 5 renders HTML for a
  // thrown handler and a test asserting `body.success` reads `undefined` — the
  // failure looks like a wrong field rather than a 500.
  app.use((err, _req, res, _next) => {
    res.status(err.status || 500).json({ success: false, message: err.message });
  });
  return app;
}

/**
 * Create a real account and mint a token it can actually authenticate with.
 *
 * The token is signed by the same function the login handler uses and verified
 * by the same middleware, so an auth change that breaks the routes breaks these
 * tests too. A hand-written `req.user` would keep passing.
 */
export async function actor({
  userId, roles = [], isAdmin = false, isSubAdmin = false,
  isQueueManager = false, kycStatus = 'APPROVED', permissions = null,
} = {}) {
  const id = userId || `rt-${Math.random().toString(36).slice(2, 10)}`;

  // `createUser` is ON CONFLICT (mobile) DO NOTHING and returns the OTHER user
  // when the number is taken. Ignoring that return is how this harness used to
  // hand back an actor with NO ROW BEHIND IT: the token signed fine, and the
  // consequence arrived later as a 401 from `authenticate` and a `null` from
  // the test's own read, in whichever assertion happened to touch it first.
  //
  // So the insert is checked. A collision is retried with a fresh number, and
  // running out of attempts throws HERE, naming the cause, rather than
  // producing a mystery failure somewhere downstream.
  let mobile = null;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const candidate = uniqueMobile('9');
    const { created } = await createUser({ userId: id, username: id, mobile: candidate, kycStatus });
    if (created) { mobile = candidate; break; }
  }
  if (!mobile) {
    throw new Error(`actor(): could not claim a free mobile for ${id} in 5 attempts — the number space is colliding, not the test`);
  }

  const patch = { isAdmin, isSubAdmin, isQueueManager };
  if (permissions) patch.subAdminPermissions = permissions;
  await updateUser(id, patch);
  if (roles.length) await setRoles(id, roles);

  const token = signToken({ userId: id });
  return { userId: id, mobile, token, auth: `Bearer ${token}` };
}

/**
 * The same, for a merchant.
 *
 * A merchant token is a different shape — `{ merchantId, isMerchant: true }` —
 * and `merchantAuth` checks the row behind it, not just the signature: status,
 * approval, revocation. Building the merchant here means a route that admits a
 * suspended or unapproved merchant fails the test rather than passing it.
 */
export async function merchantActor({
  status = 'ACTIVE', approval = 'APPROVED', name = null, tokensRupees = 0,
  suspensionReason = 'route test suspension',
} = {}) {
  const merchantId = newMerchantId();
  const mobile = uniqueMobile('8');
  await createMerchant({
    merchantId, name: name || `RT Merchant ${merchantId.slice(-6)}`,
    publicRef: generateMerchantPublicRef(), mobile,
    // A merchant created straight into SUSPENDED needs the reason the CHECK
    // insists on: a suspension nobody can explain is one nobody can appeal.
    ...(status === 'SUSPENDED' ? { status: 'ACTIVE' } : { status }),
  });
  if (status === 'SUSPENDED') await updateMerchant(merchantId, { status, suspensionReason });
  if (approval !== 'PENDING') await updateMerchant(merchantId, { merchantApprovalStatus: approval });
  if (tokensRupees > 0) {
    await creditMerchantTokens({
      merchantId, amount: tokensRupees, reason: 'route test float',
      refModel: 'Test', refId: merchantId, txId: `rt_float_${merchantId}`,
    });
  }
  const token = signToken({ merchantId, userId: merchantId, mobile, isMerchant: true, isAdmin: false });
  return { merchantId, mobile, token, auth: `Bearer ${token}` };
}

/** `request(app)` with the Authorization header already attached. */
export function as(app, who) {
  const agent = request(app);
  const wrap = (method) => (url) => agent[method](url).set('Authorization', who.auth);
  return {
    get: wrap('get'), post: wrap('post'), put: wrap('put'),
    patch: wrap('patch'), delete: wrap('delete'),
  };
}

export { request };
