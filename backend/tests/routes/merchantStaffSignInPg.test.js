// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * A merchant account's SUB-MEMBER signs in through Telegram, end to end
 * (owner, 2026-10-11: "sub members need to sign in through telegram login so
 * test it"; 2026-10-14: no password for players or merchants, sub-members
 * included). §33 at the HTTP boundary, with a real PostgreSQL:
 *
 *   · the owner signs in at the merchant door by Continue with Telegram and
 *     adds the sub-member through the real route, with a mobile and no
 *     password;
 *   · the sub-member's first Continue with Telegram links their login when
 *     their own Telegram shares the contact of THEIR mobile; a stranger's
 *     contact, or the owner's Telegram, verifies nothing and enters no
 *     sub-member's account;
 *   · the session acts as the sub-member, with their roles (`actor`), and
 *     never as the owner;
 *   · a change of roles ends the session, at merchantAuth and at the live
 *     order feed; a removed sub-member cannot sign in again, however good
 *     their Telegram.
 *
 * Nothing reaches Telegram: the Mini App's strings are signed with the test
 * bot token the server holds (miniAppFixture.js). Every request comes from its
 * own address: the Telegram limiters key on it.
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
import { verifyJwt } from '../../domains/identity/jwt.util.js';
import {
  saveTestBot, removeTestBot, linkTelegram, signInitData, signContact, freshTelegramUserId,
} from '../miniAppFixture.js';

const describePg = pgConfigured() ? describe : describe.skip;

// A /16 of its own per run, so a rerun is not paced by the last one's budget.
const NET = 100 + Math.floor(Math.random() * 150);
let addr = 0;
const from = () => { addr += 1; return `172.${NET}.${(addr >> 8) & 255}.${addr & 255}`; };
let n = 0;
const freshMobile = (lead) => `${lead}${String(Date.now()).slice(-5)}${String(n += 1).padStart(4, '0')}`;

describePg('a sub-member signs in through Telegram', () => {
  let app;
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
    // The live order feed verifies its token inline, not through merchantAuth
    // (§32 S32): it is asked the same question.
    const { initSSERoutes } = await import('../../routes/sse.routes.js');
    app.use('/sse', initSSERoutes({ addMerchantClient: () => {} }, {}));
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
  const startParam = (telegram) => new URL(telegram.url).searchParams.get('startapp');

  /** Continue with Telegram at the merchant door: opened, Verified by `tgId` (with the contact of `phone`), polled. */
  async function continueWithTelegram(tgId, { phone = null, decision = 'approve' } = {}) {
    const opened = (await post('/api/merchant/auth/login/telegram', { delivery: 'MATCH' })).body;
    expect(opened, JSON.stringify(opened)).toMatchObject({ pending: true });
    const approval = await post('/api/telegram/mini-app/approve', {
      initData: signInitData({ telegramUserId: tgId, startParam: startParam(opened.telegram) }),
      contact: phone ? signContact({ telegramUserId: tgId, phone }) : undefined,
      decision, pick: opened.matchNumber,
    });
    const done = await post('/api/merchant/auth/login/telegram/complete', { challengeToken: opened.challengeToken });
    return { opened, approval, done };
  }

  /** An approved, verified merchant that owns a merchant account, signed in. */
  async function owner() {
    const mobile = freshMobile('7');
    const created = await createMerchantAccount({
      userId: newUserId(), username: `sso${Date.now()}${n += 1}`, mobile, currency: 'INR',
    });
    expect(created.ok, JSON.stringify(created)).toBe(true);
    const merchantId = created.merchant.merchantId;
    await pgQuery(`UPDATE merchants SET status = 'ACTIVE', merchant_approval_status = 'APPROVED' WHERE merchant_id = $1`, [merchantId]);
    const team = await createDirectTeam({ merchantId });
    expect(team.ok, JSON.stringify(team)).toBe(true);
    const tgId = await linkTelegram(created.userId);
    const { done } = await continueWithTelegram(tgId);
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body.actor).toEqual({ isOwner: true });
    return { merchantId, userId: created.userId, mobile, tgId, token: done.body.token };
  }

  /** The owner adds a sub-member through the route: a mobile, roles, no password. */
  async function addSubMember(o, roles) {
    const mobile = freshMobile('6');
    const res = await post('/api/merchant/account/staff', { name: 'Desk Clerk', mobile, roles }, o.token);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    logins.push(res.body.staff.userId);
    const creds = await db.users.getUserCredentials(res.body.staff.userId);
    expect(creds?.passwordHash ?? null).toBeNull();
    expect(await db.telegram.getLinkByUserId(res.body.staff.userId)).toBeFalsy();
    return { ...res.body.staff, mobile, tgId: freshTelegramUserId() };
  }

  /** First sign-in: their own Telegram shares the contact of their own mobile. */
  async function verifyFirstSignIn(s) {
    const { approval, done } = await continueWithTelegram(s.tgId, { phone: `+91${s.mobile}` });
    expect(approval.body, JSON.stringify(approval.body)).toMatchObject({ success: true, approved: true, verified: true, created: false });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    return done.body;
  }

  it('verifies on the first sign-in by their own contact, and acts with their own roles, never as the owner', async () => {
    const o = await owner();
    const s = await addSubMember(o, ['DEPOSITS']);

    const first = await verifyFirstSignIn(s);
    const claims = verifyJwt(first.token);
    expect(claims.amr).toEqual(['tg']);
    expect(String(claims.userId)).toBe(String(s.userId));
    expect(String(claims.staffUserId)).toBe(String(s.userId));
    expect(first.merchant._id).toBe(o.merchantId);
    expect(first.actor).toMatchObject({ isOwner: false, roles: ['DEPOSITS'] });

    // The link is the sub-member's own, on their own mobile.
    const link = await db.telegram.getLinkByUserId(s.userId);
    expect(link.telegramUserId).toBe(s.tgId);
    expect(String(link.phone).slice(-10)).toBe(s.mobile);

    // Their session is theirs: a profile without the owner's fields, an
    // owner-only route refused.
    const profile = await get('/api/merchant/profile', first.token);
    expect(profile.status, JSON.stringify(profile.body)).toBe(200);
    expect(profile.body.merchant.mobile).toBeUndefined();
    expect(profile.body.actor).toMatchObject({ isOwner: false, roles: ['DEPOSITS'] });
    const ownerOnly = await post('/api/merchant/account/staff', { name: 'X', mobile: freshMobile('6'), roles: ['AUDIT'] }, first.token);
    expect(ownerOnly.status).toBe(403);

    // Later sign-ins need no contact: the link answers.
    const again = await continueWithTelegram(s.tgId);
    expect(again.done.status, JSON.stringify(again.done.body)).toBe(200);
    expect(again.done.body.actor).toMatchObject({ isOwner: false, roles: ['DEPOSITS'] });
    // And a Deny in their Telegram opens nothing.
    const denied = await continueWithTelegram(s.tgId, { decision: 'deny' });
    expect(denied.done.body.code).toBe('TWO_FACTOR_DENIED');
    expect(denied.done.body.token).toBeFalsy();
  });

  it('a stranger\'s contact, or the owner\'s own Telegram, cannot verify the sub-member', async () => {
    const o = await owner();
    const s = await addSubMember(o, ['WITHDRAWALS']);

    // A contact Telegram signed for somebody else, carrying the sub-member's number.
    const strangerTg = freshTelegramUserId();
    const opened = (await post('/api/merchant/auth/login/telegram', { delivery: 'MATCH' })).body;
    const stranger = await post('/api/telegram/mini-app/approve', {
      initData: signInitData({ telegramUserId: strangerTg, startParam: startParam(opened.telegram) }),
      contact: signContact({ telegramUserId: freshTelegramUserId(), phone: s.mobile }),
      decision: 'approve', pick: opened.matchNumber,
    });
    expect(stranger.body.code).toBe('CONTACT_NOT_OWN');
    expect((await post('/api/merchant/auth/login/telegram/complete', { challengeToken: opened.challengeToken })).status).not.toBe(200);

    // The owner's Telegram, even carrying the sub-member's number, enters the
    // OWNER's account: it is already linked there, and the link decides.
    const ownerTg = await continueWithTelegram(o.tgId, { phone: s.mobile });
    expect(ownerTg.approval.body).toMatchObject({ approved: true, verified: false, created: false });
    expect(ownerTg.done.status).toBe(200);
    expect(ownerTg.done.body.actor).toEqual({ isOwner: true });
    expect(String(verifyJwt(ownerTg.done.body.token).userId)).toBe(String(o.userId));

    expect(await db.telegram.getLinkByUserId(s.userId)).toBeFalsy();
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
    const stale = await get('/api/merchant/profile', token);
    expect(stale.status).toBe(401);
    expect(stale.body.code).toBe('SESSION_SUPERSEDED');
    const feed = await request(app).get(`/sse/merchant/events?token=${encodeURIComponent(token)}`).set('X-Forwarded-For', from());
    expect(feed.status).toBe(401);
    expect(feed.body.code).toBe('SESSION_SUPERSEDED');

    // A fresh sign-in carries the new roles.
    const fresh = await continueWithTelegram(s.tgId);
    expect(fresh.done.status, JSON.stringify(fresh.done.body)).toBe(200);
    expect(fresh.done.body.actor).toMatchObject({ isOwner: false, roles: ['WITHDRAWALS'] });

    await new Promise((r) => setTimeout(r, 1100));
    const removed = await request(app).delete(`/api/merchant/account/staff/${s.staffId}`)
      .set('X-Forwarded-For', from()).set('Authorization', `Bearer ${o.token}`);
    expect(removed.status, JSON.stringify(removed.body)).toBe(200);
    expect((await get('/api/merchant/profile', fresh.done.body.token)).status).toBe(401);

    // Their own linked Telegram signs nobody in now.
    const after = await continueWithTelegram(s.tgId);
    expect(after.done.status, JSON.stringify(after.done.body)).toBe(403);
    expect(after.done.body.code).toBe('MERCHANT_NOT_ACTIVE');
    expect(after.done.body.token).toBeFalsy();
  });
});
