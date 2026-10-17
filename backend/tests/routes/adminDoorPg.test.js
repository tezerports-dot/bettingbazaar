// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The ADMIN routes admit a staff session and nobody else's (owner,
 * 2026-10-17: "admin and player accounts are completely separate, as well as
 * the merchant").
 *
 * What was wrong: the `/api/admin` router took the shared `authenticate`,
 * which admits PLAYER sessions and leaves the refusal to each route's area
 * check, and the admin panel restored its session from the shared
 * `/api/v1/auth/me`, which admits players too. So a player's session was let
 * into the panel and shown "You don't have access to this screen" instead of
 * being refused at the door. Now the whole router is `authenticateStaff`
 * (STAFF rows holding a staff role) and the panel restores from
 * `/api/admin/account/me`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pgConfigured, applySchema, closePg } from '#db/client.js';
import { createMerchantAccount, updateMerchant } from '#db/repositories/merchants.js';
import { newUserId, createUser } from '#db/repositories/users.js';
import { signToken } from '../../domains/identity/paseto.util.js';
import { mountRouter, actor, as } from './_harness.js';

const describePg = pgConfigured() ? describe : describe.skip;

describePg('the admin door', () => {
  let app;
  beforeAll(async () => {
    await applySchema();
    app = mountRouter((await import('../../routes/admin/index.js')).default, { prefix: '/api/admin' });
  }, 60_000);
  afterAll(async () => { await closePg(); });

  const wrongPanel = (res) => {
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.code).toBe('WRONG_PANEL');
  };

  it('refuses a player session on the session restore and on admin routes', async () => {
    const player = await actor();
    wrongPanel(await as(app, player).get('/api/admin/account/me'));
    wrongPanel(await as(app, player).get('/api/admin/users'));
    wrongPanel(await as(app, player).get('/api/admin/analytics/dashboard'));
  });

  it('refuses a merchant session', async () => {
    const mobile = `7${String(Date.now()).slice(-6)}${Math.floor(Math.random() * 900 + 100)}`;
    const created = await createMerchantAccount({
      userId: newUserId(), username: `adr${Date.now()}${Math.floor(Math.random() * 1000)}`, mobile, currency: 'INR',
    });
    expect(created.ok, JSON.stringify(created)).toBe(true);
    await updateMerchant(created.merchant.merchantId, { status: 'ACTIVE', merchantApprovalStatus: 'APPROVED' });
    const token = signToken({ merchantId: created.merchant.merchantId, userId: created.userId, mobile, isMerchant: true, isAdmin: false, amr: ['tg'] });
    wrongPanel(await as(app, { auth: `Bearer ${token}` }).get('/api/admin/account/me'));
  });

  it('refuses a STAFF row that holds no staff role', async () => {
    const id = `adr-norole-${Math.random().toString(36).slice(2, 8)}`;
    await createUser({ userId: id, username: id, mobile: `6${String(Date.now()).slice(-9)}`, accountType: 'STAFF' });
    const token = signToken({ userId: id, amr: ['pwd', 'otp'] });
    wrongPanel(await as(app, { auth: `Bearer ${token}` }).get('/api/admin/account/me'));
  });

  it('admits a full admin and a sub-admin (the opposite behaviour)', async () => {
    const admin = await actor({ isAdmin: true });
    const me = await as(app, admin).get('/api/admin/account/me');
    expect(me.status, JSON.stringify(me.body)).toBe(200);
    expect(me.body.user).toMatchObject({ id: admin.userId, accountType: 'STAFF', isAdmin: true });
    expect((await as(app, admin).get('/api/admin/users')).status).toBe(200);
    const sub = await actor({ isSubAdmin: true, permissions: { canManageUsers: true } });
    const subMe = await as(app, sub).get('/api/admin/account/me');
    expect(subMe.status).toBe(200);
    expect(subMe.body.user.isSubAdmin).toBe(true);
  });
});
