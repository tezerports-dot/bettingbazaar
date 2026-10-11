// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * A merchant account's SUB-MEMBER signs in through Telegram, end to end
 * (owner, 2026-10-11: "sub members need to sign in through telegram login so
 * test it"). §33 at the HTTP boundary, with a real PostgreSQL:
 *
 *   · the owner signs in at the merchant door (password + Telegram approval)
 *     and adds the sub-member through the real route;
 *   · the sub-member's first sign-in is refused until their own Telegram
 *     shares the contact matching THEIR mobile; a stranger's contact, or the
 *     owner's Telegram, verifies nothing;
 *   · once verified, every later sign-in owes the Telegram approval, on both
 *     orders (password first; Telegram first), and the session's `amr` says so;
 *   · the session acts as the sub-member, with their roles (`actor`), and
 *     never as the owner;
 *   · a change of roles ends the session; a removed sub-member cannot sign in
 *     again, however good their password and Telegram.
 *
 * Nothing reaches Telegram: the Mini App's strings are signed with the test
 * bot token the server holds (miniAppFixture.js).
 *
 * Time is fast-forwarded past the credential pace (one try per mobile per
 * 10 s) by resetting that one key before each try, so one account can sign in
 * several times in a run; the pace itself is pinned by its own suites.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { pgConfigured, applySchema, closePg, pgQuery } from '#db/client.js';
import { db } from '#db';
import { createMerchantAccount } from '#db/repositories/merchants.js';
import { createDirectTeam } from '#db/repositories/teams.js';
import { newUserId } from '#db/repositories/users.js';
import { hashPassword } from '../../domains/identity/password.util.js';
import { loginPaceLimiter } from '../../middleware/security.js';
import { verifyJwt } from '../../domains/identity/jwt.util.js';
import {
  saveTestBot, removeTestBot, linkTelegram, signInitData, signContact, freshTelegramUserId,
} from '../miniAppFixture.js';

const describePg = pgConfigured() ? describe : describe.skip;
const PASSWORD = 'SubMember-Telegram-Pass-9k!';
const STAFF_PASSWORD = 'Desk-Sub-Member-Pass-4r!';

// A /16 of its own per run, so a rerun is not paced by the last one's subnet budget.
const NET = 100 + Math.floor(Math.random() * 150);
let addr = 0;
const from = () => { addr += 1; return `172.${NET}.${(addr >> 8) & 255}.${addr & 255}`; };
let n = 0;
const freshMobile = (lead) => `${lead}${String(Date.now()).slice(-5)}${String(n += 1).padStart(4, '0')}`;

describePg('a sub-member signs in through Telegram', () => {
  let app;
  const owners = [];
  const teams = [];
  const logins = [];

  beforeAll(async () => {
    await applySchema();
    app = express();
    app.set('trust proxy', true);
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/merchant', (await import('../../domains/merchant/merchant.routes.js')).default);
    app.use('/api/merchant', (await import('../../domains/merchant/merchantAccount.routes.js')).default);
    app.use('/api/telegram', (await import('../../domains/telegram/miniApp.routes.js')).default);
    await saveTestBot();
  }, 60_000);

  afterAll(async () => {
    try {
      if (logins.length) {
        await pgQuery(`DELETE FROM merchant_staff_accounts WHERE staff_id IN (SELECT staff_id FROM merchant_staff WHERE user_id = ANY($1))`, [logins]);
        await pgQuery(`DELETE FROM merchant_staff WHERE user_id = ANY($1)`, [logins]);
      }
    } finally {
      await removeTestBot();
      await closePg();
    }
  });

  const post = (path, body, token) => {
    const r = request(app).post(path).set('X-Forwarded-For', from());
    if (token) r.set('Authorization', `Bearer ${token}`);
    return r.send(body);
  };
  const get = (path, token) => request(app).get(path).set('X-Forwarded-For', from()).set('Authorization', `Bearer ${token}`);
  /** userId by mobile, for the pace key a challenge-carrying request is counted under. */
  const userOf = new Map();
  const fastForwardPace = async (mobile) => {
    await loginPaceLimiter.resetKey(`p:${mobile}`);
    if (userOf.has(mobile)) await loginPaceLimiter.resetKey(`u:${userOf.get(mobile)}`);
  };
  const login = async (mobile, password, extra = {}) => {
    await fastForwardPace(mobile);
    return post('/api/merchant/auth/login', { mobile, password, ...extra });
  };
  const poll = (challengeToken) => post('/api/merchant/auth/login/2fa', { challengeToken });
  const startParam = (telegram) => new URL(telegram.url).searchParams.get('startapp');
  const approve = (telegram, tgId, { decision = 'approve', phone = null } = {}) => post('/api/telegram/mini-app/approve', {
    initData: signInitData({ telegramUserId: tgId, startParam: startParam(telegram) }),
    contact: phone ? signContact({ telegramUserId: tgId, phone }) : undefined,
    decision,
  });

  /** Password, then the linked Telegram's approval: the session token. */
  async function signIn(mobile, password, tgId) {
    const first = await login(mobile, password);
    expect(first.body, JSON.stringify(first.body)).toMatchObject({ success: false, twoFactorRequired: true });
    expect(first.body.token).toBeFalsy();
    expect((await approve(first.body.telegram, tgId)).body.approved).toBe(true);
    const session = await poll(first.body.challengeToken);
    expect(session.status, JSON.stringify(session.body)).toBe(200);
    return session.body.token;
  }

  /** An approved, verified merchant that owns a merchant account, signed in. */
  async function owner() {
    const mobile = freshMobile('7');
    const created = await createMerchantAccount({
      userId: newUserId(), username: `sso${Date.now()}${n += 1}`, mobile,
      passwordHash: await hashPassword(PASSWORD), currency: 'INR',
    });
    expect(created.ok, JSON.stringify(created)).toBe(true);
    const merchantId = created.merchant.merchantId;
    owners.push(merchantId);
    await pgQuery(`UPDATE merchants SET status = 'ACTIVE', merchant_approval_status = 'APPROVED' WHERE merchant_id = $1`, [merchantId]);
    const team = await createDirectTeam({ merchantId });
    expect(team.ok, JSON.stringify(team)).toBe(true);
    teams.push(team.team?.teamId);
    userOf.set(mobile, created.userId);
    const tgId = await linkTelegram(created.userId);
    const token = await signIn(mobile, PASSWORD, tgId);
    return { merchantId, mobile, tgId, token };
  }

  /** The owner adds a sub-member through the route: a fresh, unverified login. */
  async function addSubMember(o, roles) {
    const mobile = freshMobile('6');
    const res = await post('/api/merchant/account/staff', { name: 'Desk Clerk', mobile, password: STAFF_PASSWORD, roles }, o.token);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    logins.push(res.body.staff.userId);
    userOf.set(mobile, res.body.staff.userId);
    return { ...res.body.staff, mobile, tgId: freshTelegramUserId() };
  }

  /** First sign-in: verify the mobile by the sub-member's own contact share. */
  async function verifyFirstSignIn(s) {
    const first = await login(s.mobile, STAFF_PASSWORD);
    expect(first.status, JSON.stringify(first.body)).toBe(403);
    expect(first.body.code).toBe('TELEGRAM_VERIFICATION_REQUIRED');
    expect(first.body.token).toBeFalsy();
    const ok = await approve(first.body.telegram, s.tgId, { phone: `+91${s.mobile}` });
    expect(ok.body, JSON.stringify(ok.body)).toMatchObject({ success: true, approved: true, verified: true });
    const session = await poll(first.body.challengeToken);
    expect(session.status, JSON.stringify(session.body)).toBe(200);
    return session.body;
  }

  it('verifies on the first sign-in by their own contact, and acts with their own roles, never as the owner', async () => {
    const o = await owner();
    const s = await addSubMember(o, ['DEPOSITS']);

    const first = await verifyFirstSignIn(s);
    expect(verifyJwt(first.token).amr).toEqual(['pwd', 'tg']);
    expect(String(verifyJwt(first.token).userId)).toBe(String(s.userId));
    expect(first.merchant._id).toBe(o.merchantId);
    expect(first.actor).toMatchObject({ isOwner: false, roles: ['DEPOSITS'] });

    // The link is the sub-member's own, on their own mobile, with 2FA on.
    const link = await db.telegram.getLinkByUserId(s.userId);
    expect(link).toMatchObject({ twoFactor: true });
    expect(String(link.phone).slice(-10)).toBe(s.mobile);

    // Their session is theirs: a profile without the owner's fields, an
    // owner-only route refused.
    const profile = await get('/api/merchant/profile', first.token);
    expect(profile.status, JSON.stringify(profile.body)).toBe(200);
    const view = profile.body.merchant ?? profile.body.data ?? profile.body;
    expect(view.mobile).toBeUndefined();
    const ownerOnly = await post('/api/merchant/account/staff', { name: 'X', mobile: freshMobile('6'), password: STAFF_PASSWORD, roles: ['AUDIT'] }, first.token);
    expect(ownerOnly.status).toBe(403);
  });

  it('a stranger\'s contact, or the owner\'s own Telegram, cannot verify the sub-member', async () => {
    const o = await owner();
    const s = await addSubMember(o, ['WITHDRAWALS']);
    const first = await login(s.mobile, STAFF_PASSWORD);
    expect(first.body.code).toBe('TELEGRAM_VERIFICATION_REQUIRED');

    const stranger = await approve(first.body.telegram, freshTelegramUserId(), { phone: '9000000003' });
    expect(stranger.body.verified).not.toBe(true);
    // The owner's Telegram is linked to the owner's mobile, not the sub-member's.
    const ownerTg = await approve(first.body.telegram, o.tgId, { phone: `+91${o.mobile}` });
    expect(ownerTg.body.verified).not.toBe(true);
    expect((await poll(first.body.challengeToken)).status).not.toBe(200);
    expect(await db.telegram.getLinkByUserId(s.userId)).toBeFalsy();
  });

  it('once verified, every sign-in owes the Telegram approval: password first, or Telegram first', async () => {
    const o = await owner();
    const s = await addSubMember(o, ['AUDIT']);
    await verifyFirstSignIn(s);

    // Password first: no token until their Telegram approves.
    const token = await signIn(s.mobile, STAFF_PASSWORD, s.tgId);
    expect(verifyJwt(token).amr).toEqual(['pwd', 'tg']);

    // A denial opens nothing.
    const denied = await login(s.mobile, STAFF_PASSWORD);
    await approve(denied.body.telegram, s.tgId, { decision: 'deny' });
    expect((await poll(denied.body.challengeToken)).body.code).toBe('TWO_FACTOR_DENIED');

    // Telegram first ("Login with Telegram"): the password is still owed.
    const start = await post('/api/merchant/auth/login/telegram', {});
    await approve(start.body.telegram, s.tgId);
    const next = await post('/api/merchant/auth/login/telegram/complete', { challengeToken: start.body.challengeToken });
    expect(next.body).toMatchObject({ success: false, passwordRequired: true });
    expect(next.body.token).toBeFalsy();
    const done = await login(s.mobile, STAFF_PASSWORD, { challengeToken: start.body.challengeToken });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(verifyJwt(done.body.token).amr).toEqual(['pwd', 'tg']);
    expect(done.body.actor).toMatchObject({ isOwner: false, roles: ['AUDIT'] });

    // The owner's Telegram approval does not complete the sub-member's password.
    const ownerStart = await post('/api/merchant/auth/login/telegram', {});
    await approve(ownerStart.body.telegram, o.tgId);
    const crossed = await login(s.mobile, STAFF_PASSWORD, { challengeToken: ownerStart.body.challengeToken });
    expect(crossed.body.token).toBeFalsy();
  });

  it('a change of roles ends the session; a removed sub-member cannot sign in again', async () => {
    const o = await owner();
    const s = await addSubMember(o, ['DEPOSITS']);
    const { token } = await verifyFirstSignIn(s);
    expect((await get('/api/merchant/profile', token)).status).toBe(200);

    await new Promise((r) => setTimeout(r, 1100)); // sessions_valid_from is compared by the token's second
    const changed = await request(app).put(`/api/merchant/account/staff/${s.staffId}/roles`)
      .set('X-Forwarded-For', from()).set('Authorization', `Bearer ${o.token}`).send({ roles: ['WITHDRAWALS'] });
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    expect((await get('/api/merchant/profile', token)).status).toBe(401);

    // A fresh sign-in carries the new roles.
    const again = await login(s.mobile, STAFF_PASSWORD);
    await approve(again.body.telegram, s.tgId);
    const fresh = await poll(again.body.challengeToken);
    expect(fresh.status, JSON.stringify(fresh.body)).toBe(200);
    expect(fresh.body.actor).toMatchObject({ isOwner: false, roles: ['WITHDRAWALS'] });

    const removed = await request(app).delete(`/api/merchant/account/staff/${s.staffId}`)
      .set('X-Forwarded-For', from()).set('Authorization', `Bearer ${o.token}`);
    expect(removed.status, JSON.stringify(removed.body)).toBe(200);
    expect((await get('/api/merchant/profile', fresh.body.token)).status).toBe(401);

    // The removed login is refused at the door, before any Telegram step.
    const after = await login(s.mobile, STAFF_PASSWORD);
    expect(after.status, JSON.stringify(after.body)).toBe(403);
    expect(after.body.code).toBe('MERCHANT_NOT_ACTIVE');
    expect(after.body.token).toBeFalsy();
    expect(after.body.challengeToken).toBeFalsy();
  });
});
