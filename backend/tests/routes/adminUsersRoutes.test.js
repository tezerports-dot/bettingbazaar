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
import { createOrderRecord } from '#db/repositories/orders.record.js';
import { getUser, flagPaymentWarning, softDeleteUser } from '#db/repositories/users.js';
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

  /**
   * ── `status` and `is_blocked` are one decision, so they are one write ─────
   *
   * Sign-in reads `status`; every request guard reads `is_blocked`. They were
   * set by two separate statements from the route, and this suite asserted only
   * `is_blocked` — so an account the two halves disagreed about was invisible
   * here. `setBlocked` writes both now, and these assert both.
   */
  it('moves status with the block, and back with the unblock', async () => {
    plain = await subject();
    await as(app, admin).put(`/users/${plain.userId}/block`).send({ reason: 'fraud review' });
    const blocked = await getUser(plain.userId);
    expect(blocked.isBlocked).toBe(true);
    expect(blocked.status).toBe('BLOCKED');

    await as(app, admin).put(`/users/${plain.userId}/unblock`).send({});
    const unblocked = await getUser(plain.userId);
    expect(unblocked.isBlocked).toBe(false);
    expect(unblocked.status).toBe('ACTIVE');
  });

  /**
   * ── This path was a 500, and a 500 after the unblock had committed ────────
   *
   * `resetWarnings` set `paymentFlagReason = null` through `updateUser`, and
   * the column is `NOT NULL DEFAULT ''` — every call raised 23502. The unblock
   * statement had already committed by then, so the admin was told it failed
   * while `is_blocked` was already false and `status` was still BLOCKED: the
   * player could not sign in, the request guards would have let them through,
   * and retrying produced the identical 500 forever.
   *
   * Nothing caught it because no test ever sent `resetWarnings`.
   */
  it('unblocks and resets warnings without throwing', async () => {
    plain = await subject();
    await flagPaymentWarning(plain.userId, { reason: 'merchant says no credit', maxWarnings: 0 });
    await as(app, admin).put(`/users/${plain.userId}/block`).send({ reason: 'under review' });

    const res = await as(app, admin).put(`/users/${plain.userId}/unblock`)
      .send({ resetWarnings: true });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const after = await getUser(plain.userId);
    expect(after.isBlocked).toBe(false);
    expect(after.status).toBe('ACTIVE');
    expect(Number(after.warningCount)).toBe(0);
    expect(after.paymentFlagged).toBe(false);
    // '' is the column's default. null is what raised 23502.
    expect(after.paymentFlagReason).toBe('');
    expect(after.paymentFlaggedAt).toBeNull();
    // The response reports the reset count, not a stale pre-reset read.
    expect(Number(res.body.warningCount)).toBe(0);
  });

  /**
   * ── A delete must not strand money ────────────────────────────────────────
   *
   * `DELETE /users/:userId` had NO guards. Both of these existed only in
   * `services/admin.service.js`, which nothing imported, and
   * `moneyDecisionsReadTheWallet.test.js` asserted the locked-balance one
   * against that dead file — so the suite reported the guard as present while
   * the live route would soft-delete a player mid-transaction.
   *
   * `softDeleteUser` writes status/deleted_at/deleted_by and succeeds, so
   * nothing anywhere reported a problem: the order stayed live in the merchant
   * queue and the money ended up with an owner who could no longer sign in.
   */
  it('refuses to delete a player with an open order', async () => {
    plain = await subject();
    const orderId = `del-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    await createOrderRecord({
      orderId, userId: plain.userId, type: 'DEPOSIT',
      tokenAmountRupees: 500, fiatAmountRupees: 500, state: 'PAID',
    });

    const res = await as(app, admin).delete(`/users/${plain.userId}`);

    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/open/i);
    expect((await getUser(plain.userId)).status).not.toBe('DELETED');
  });

  it('refuses to delete a player with money locked in escrow', async () => {
    plain = await subject();
    await applyMovementPaise({
      userId: plain.userId,
      legs: [{ field: 'depositBalance', deltaPaise: 1000_00 }],
      ledger: [{ txId: `dseed_${plain.userId}`, field: 'depositBalance', amountPaise: 1000_00, type: 'CREDIT' }],
    });
    // Deposit → locked, the shape an in-flight withdrawal leaves behind.
    await applyMovementPaise({
      userId: plain.userId,
      legs: [
        { field: 'depositBalance', deltaPaise: -600_00 },
        { field: 'lockedBalance',  deltaPaise:  600_00 },
      ],
      ledger: [{ txId: `dlock_${plain.userId}`, field: 'lockedBalance', amountPaise: 600_00, type: 'LOCK' }],
    });

    const res = await as(app, admin).delete(`/users/${plain.userId}`);

    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/locked/i);
    expect((await getUser(plain.userId)).status).not.toBe('DELETED');
  });

  it('deletes a player with no open orders and nothing locked', async () => {
    // The guards must refuse the dangerous case without blocking the ordinary
    // one — a delete nobody can perform is its own defect.
    plain = await subject();
    const res = await as(app, admin).delete(`/users/${plain.userId}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await getUser(plain.userId)).status).toBe('DELETED');
  });

  it('does not resurrect a deleted account by unblocking it', async () => {
    // The route set `status = 'ACTIVE'` unconditionally, so an unblock on a
    // soft-deleted account brought it back to ACTIVE while `deleted_at` and
    // `deleted_by` stayed set — a row the DELETED status was the only marker
    // for, silently readmitted.
    plain = await subject();
    await softDeleteUser(plain.userId, { actor: admin.userId });

    await as(app, admin).put(`/users/${plain.userId}/unblock`).send({});

    const after = await getUser(plain.userId);
    expect(after.status).toBe('DELETED');
    expect(after.deletedAt).toBeTruthy();
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
