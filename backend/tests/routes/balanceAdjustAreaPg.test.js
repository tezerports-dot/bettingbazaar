// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Balance adjustment works with ITS OWN area alone, and moves money on PLAYER
 * accounts only. Through the real router and a real database.
 *
 * ── Why ─────────────────────────────────────────────────────────────────────
 * The Balance Adjust screen found players through `GET /api/admin/users` (the
 * Users area) and read its ceiling from `GET /api/admin/system/config` (System
 * Settings). A sub-admin given balance adjustment alone — the owner's model is
 * that an area is a whole job (CLAUDE.md §2) — opened the screen and could find
 * nobody. Found by the cross-area rule added to check:staff-permissions.
 *
 * And `POST /admin/balance-adjust` took any user id. A STAFF or MERCHANT login
 * row is not a player (owner, 2026-10-01: the accounts are separate, and a staff
 * account is for admin work only), so money moved onto one is money in an
 * account that cannot play, cannot withdraw through the player app, and that no
 * screen lists as a player's.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pgConfigured, applySchema, closePg } from '#db/client.js';
import { db } from '#db';
import { getBalancesPaise, applyMovementPaise } from '#db/repositories/wallets.core.js';
import { mountRouter, actor, as } from './_harness.js';

const describePg = pgConfigured() ? describe : describe.skip;

describePg('balance adjustment — its own area, players only', () => {
  let app; let adjuster; let usersOnly;

  beforeAll(async () => {
    await applySchema();
    app = mountRouter((await import('../../routes/retention.routes.js')).default);
    adjuster = await actor({ isSubAdmin: true, permissions: { canAdjustBalances: true } });
    usersOnly = await actor({ isSubAdmin: true, permissions: { canManageUsers: true } });
  }, 60_000);

  afterAll(async () => { await closePg(); });

  const funded = async (rupees) => {
    const p = await actor({ kycStatus: 'APPROVED' });
    if (rupees > 0) {
      await applyMovementPaise({
        userId: p.userId,
        legs: [{ field: 'depositBalance', deltaPaise: rupees * 100 }],
        ledger: [{ txId: `seed_${p.userId}`, field: 'depositBalance', amountPaise: rupees * 100, type: 'CREDIT' }],
      });
    }
    return p;
  };

  it('finds a player, with their wallet, for an account holding balance adjustment alone', async () => {
    const p = await funded(1234);
    const res = await as(app, adjuster).get('/admin/balance-adjust/players').query({ search: p.mobile, limit: 10 });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const row = res.body.players.find((x) => x.userId === p.userId);
    expect(row).toMatchObject({ userId: p.userId, username: p.userId, mobile: p.mobile });
    expect(row.depositBalance).toBe(1234);
    expect(row.winningsBalance).toBe(0);
    // The ceiling, from the one owner, without reading System Settings.
    const { maxBalanceAdjustment } = await db.config.getSystemConfig();
    expect(res.body.maxBalanceAdjustment).toBe(Number(maxBalanceAdjustment));
  });

  it('lists PLAYERS only — never a staff or merchant login on the same number', async () => {
    const staff = await actor({ isSubAdmin: true, permissions: {} });
    const res = await as(app, adjuster).get('/admin/balance-adjust/players').query({ search: staff.mobile });
    expect(res.status).toBe(200);
    expect(res.body.players.map((x) => x.userId)).not.toContain(staff.userId);
  });

  it('answers the ceiling with no search, and lists nobody', async () => {
    const res = await as(app, adjuster).get('/admin/balance-adjust/players');
    expect(res.status).toBe(200);
    expect(res.body.players).toEqual([]);
    expect(Number.isFinite(res.body.maxBalanceAdjustment)).toBe(true);
  });

  it('refuses the lookup to an account without the area', async () => {
    const res = await as(app, usersOnly).get('/admin/balance-adjust/players').query({ search: '9' });
    expect(res.status).toBe(403);
  });

  it('refuses to move money on a STAFF account, and moves nothing', async () => {
    const staff = await actor({ isSubAdmin: true, permissions: {} });
    const before = await getBalancesPaise(staff.userId);
    const res = await as(app, adjuster).post('/admin/balance-adjust').send({
      userId: staff.userId, type: 'CREDIT', field: 'depositBalance', amount: 100, reason: 'test',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.message).toMatch(/player account/i);
    expect(await getBalancesPaise(staff.userId)).toEqual(before);
  });

  it('still adjusts a PLAYER account — the legitimate case on the same route', async () => {
    const p = await funded(0);
    const res = await as(app, adjuster).post('/admin/balance-adjust').send({
      userId: p.userId, type: 'CREDIT', field: 'depositBalance', amount: 100, reason: 'test',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await getBalancesPaise(p.userId)).depositBalance).toBe(10_000);
  });
});
