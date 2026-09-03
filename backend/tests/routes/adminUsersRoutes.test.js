// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * The admin user routes, driven over HTTP against a real database.
 *
 * ── What these are for ──────────────────────────────────────────────────────
 * These handlers grant authority and move money: they adjust a balance, hand
 * out a role, block an account, and issue phantom access. Every one of them was
 * previously covered only by whatever the services underneath happened to
 * assert, and that is exactly the gap where the platform's worst defects lived
 * — handlers that could not run at all, because they called `.save()` on a
 * plain object or passed no id to a create.
 *
 * So the request really goes through the real router, the real `authenticate`
 * middleware verifying a really-minted token, and the real repositories against
 * real PostgreSQL. A handler that throws in production throws here.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pgConfigured, applySchema, closePg } from '#db/client.js';
import { getBalancesPaise, applyMovementPaise } from '#db/repositories/wallets.core.js';
import { getUser } from '#db/repositories/users.js';
import { mountRouter, actor, as, request } from './_harness.js';

const describePg = pgConfigured() ? describe : describe.skip;

describePg('admin user routes', () => {
  let app; let admin; let plain;

  beforeAll(async () => {
    await applySchema();
    const mod = await import('../../routes/admin/users.admin.routes.js');
    app = mountRouter(mod.default);
    admin = await actor({ isAdmin: true, roles: ['admin'] });
  }, 60_000);

  afterAll(async () => { await closePg(); });

  // A fresh subject per test: these handlers mutate the account they name, and
  // a shared one would make the order of the tests part of their meaning.
  const subject = () => actor({ kycStatus: 'APPROVED' });

  // ── Authorisation is the first thing, not an afterthought ────────────────
  it('refuses every admin route without a token', async () => {
    for (const call of [
      () => request(app).get('/users'),
      () => request(app).post('/users/whoever/adjust-balance').send({ amount: 1 }),
      () => request(app).put('/users/whoever/block').send({ reason: 'x' }),
    ]) {
      const res = await call();
      expect(res.status, 'an unauthenticated admin call must never reach a handler').toBe(401);
    }
  });

  it('refuses an admin route to a signed-in NON-admin', async () => {
    const nobody = await actor({});
    const res = await as(app, nobody).get('/users');
    // 403, not 401: they are who they say they are and still may not do this.
    expect(res.status).toBe(403);
  });

  // ── The money one ────────────────────────────────────────────────────────
  it('adjusts a balance, and the money is really there afterwards', async () => {
    plain = await subject();
    const res = await as(app, admin)
      .post(`/users/${plain.userId}/adjust-balance`)
      // THE CONTRACT, which a first draft of this test got wrong: the
      // direction comes from the SIGN of `amount` and the pocket from
      // `walletType`. Sending `type`/`field` does nothing — they are ignored,
      // so a caller that believes in them credits when it meant to debit.
      .send({ amount: 250, walletType: 'deposit', reason: 'goodwill' });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.success).toBe(true);

    // The response saying so is not the assertion — the wallet is.
    const balances = await getBalancesPaise(plain.userId);
    expect(balances.depositBalance).toBe(250_00);
  });

  it('refuses a debit the pocket cannot fund, and moves nothing', async () => {
    plain = await subject();
    await applyMovementPaise({
      userId: plain.userId,
      legs: [{ field: 'depositBalance', deltaPaise: 100_00 }],
      ledger: [{ txId: `seed_${plain.userId}`, field: 'depositBalance', amountPaise: 100_00, type: 'CREDIT' }],
    });

    const res = await as(app, admin)
      .post(`/users/${plain.userId}/adjust-balance`)
      .send({ amount: -500, walletType: 'deposit', reason: 'clawback' });

    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(res.body.success).toBe(false);
    // The refusal names what they actually hold, taken from the locked read —
    // never from a balance fetched separately, which is how a player was once
    // told an available figure no wallet ever held.
    expect(res.body.message).toMatch(/Insufficient/i);
    expect((await getBalancesPaise(plain.userId)).depositBalance).toBe(100_00);
  });

  it('takes the direction from the SIGN of amount, not from a type field', async () => {
    plain = await subject();
    await applyMovementPaise({
      userId: plain.userId,
      legs: [{ field: 'depositBalance', deltaPaise: 400_00 }],
      ledger: [{ txId: `seed2_${plain.userId}`, field: 'depositBalance', amountPaise: 400_00, type: 'CREDIT' }],
    });

    // A caller sending `type: 'DEBIT'` alongside a POSITIVE amount is asking to
    // take money away and will be given money instead. Pinned because the field
    // is silently ignored, which is the shape that costs real money.
    const res = await as(app, admin)
      .post(`/users/${plain.userId}/adjust-balance`)
      .send({ amount: 100, type: 'DEBIT', walletType: 'deposit', reason: 'sign wins' });

    expect(res.status).toBe(200);
    expect((await getBalancesPaise(plain.userId)).depositBalance).toBe(500_00);
  });

  it('credits the winnings pocket when asked for it, not deposit', async () => {
    plain = await subject();
    const res = await as(app, admin)
      .post(`/users/${plain.userId}/adjust-balance`)
      .send({ amount: 75, walletType: 'winnings', reason: 'prize' });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const b = await getBalancesPaise(plain.userId);
    expect(b.winningsBalance).toBe(75_00);
    expect(b.depositBalance).toBe(0);
  });

  it('refuses a zero or non-numeric amount before touching the wallet', async () => {
    plain = await subject();
    for (const amount of [0, 'abc', null]) {
      const res = await as(app, admin)
        .post(`/users/${plain.userId}/adjust-balance`)
        .send({ amount, walletType: 'deposit', reason: 'nonsense' });
      expect(res.status, `amount=${amount}`).toBe(400);
    }
    expect((await getBalancesPaise(plain.userId)).depositBalance).toBe(0);
  });

  // ── The authority ones ───────────────────────────────────────────────────
  it('blocks an account, and the block is on the row', async () => {
    plain = await subject();
    const res = await as(app, admin)
      .put(`/users/${plain.userId}/block`)
      .send({ reason: 'fraud review' });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const after = await getUser(plain.userId);
    expect(after.isBlocked).toBe(true);
    expect(after.blockReason).toMatch(/fraud/i);
  });

  it('unblocks an account it previously blocked', async () => {
    plain = await subject();
    await as(app, admin).put(`/users/${plain.userId}/block`).send({ reason: 'mistake' });
    const res = await as(app, admin).put(`/users/${plain.userId}/unblock`).send({});

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await getUser(plain.userId)).isBlocked).toBe(false);
  });

  it('sets roles, and the row carries them', async () => {
    plain = await subject();
    const res = await as(app, admin)
      .put(`/users/${plain.userId}/roles`)
      .send({ roles: ['subadmin'] });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await getUser(plain.userId)).roles).toContain('subadmin');
  });

  // ── The read ones: a list and its count must describe one instant ────────
  it('lists users with a total that matches the page it labels', async () => {
    const res = await as(app, admin).get('/users?limit=5');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(Array.isArray(res.body.users)).toBe(true);
    expect(res.body.users.length).toBeLessThanOrEqual(5);
    // The count comes from the same statement as the rows; a total smaller than
    // the page it labels means it came from somewhere else.
    if (typeof res.body.total === 'number') {
      expect(res.body.total).toBeGreaterThanOrEqual(res.body.users.length);
    }
  });

  it('never puts a credential in a user listing', async () => {
    const res = await as(app, admin).get('/users?limit=20');
    const body = JSON.stringify(res.body);
    // The projection excludes these by construction rather than by each route
    // remembering to strip them, and this is what keeps that true.
    expect(body).not.toMatch(/passwordHash|password_hash/);
    expect(body).not.toMatch(/twoFactorSecret|two_factor_secret/);
    expect(body).not.toMatch(/backupCodes|backup_codes/);
  });

  it('reads one user without leaking credentials either', async () => {
    plain = await subject();
    const res = await as(app, admin).get(`/users/${plain.userId}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const body = JSON.stringify(res.body);
    expect(body).not.toMatch(/passwordHash|password_hash/);
    expect(body).not.toMatch(/twoFactorSecret|two_factor_secret/);
  });

  it('404s a user that does not exist rather than 500ing', async () => {
    const res = await as(app, admin).get('/users/definitely-not-a-user');
    expect(res.status).toBe(404);
  });
});
