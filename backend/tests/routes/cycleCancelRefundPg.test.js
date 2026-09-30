// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * An admin CANCEL returns every stake on the cycle (R6, 2026-09-30).
 *
 * It moved the status and nothing else. The comment beside it said returning
 * the stakes was settlement's job, but settlement only claims a cycle with a
 * winner and a cancelled cycle can never be given one — so every real stake
 * on a cancelled cycle stayed locked for good, while the admin screen toasted
 * "all bets refunded".
 *
 * Bets are placed through the REAL bet route and the cycle is cancelled
 * through the REAL admin route, so the test asserts what a player's wallet
 * says after an operator presses the button.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomInt } from 'node:crypto';
import express from 'express';
import cookieParser from 'cookie-parser';
import { pgConfigured, applySchema, closePg, pgQuery } from '#db/client.js';
import { ensureCycle, cancelCycle } from '#db/repositories/markets.js';
import { voidCancelledCycle, voidCancelledCycles } from '#db/repositories/settlements.js';
import { creditDeposit, getBalances } from '../../domains/wallet/walletAuthority.service.js';
import { actor, as } from './_harness.js';

const describePg = pgConfigured() ? describe : describe.skip;

async function linkTelegram({ userId, mobile }) {
  const active = await pgQuery(
    `SELECT generation FROM telegram_configs WHERE active AND audience = 'PLAYER' LIMIT 1`, []);
  if (!active.rows[0]) return;
  await pgQuery(
    `INSERT INTO telegram_identities (
       telegram_user_id, audience, user_id, phone, contact_shared_at,
       contact_active, channel_status, channel_checked_at, channel_generation, linked_generation)
     VALUES ($1, 'PLAYER', $2, $3, now(), TRUE, 'member', now(), $4, $4)
     ON CONFLICT (telegram_user_id, audience) DO NOTHING`,
    [`rt-tg-${userId}`, userId, mobile, active.rows[0].generation]);
}

async function openCycle() {
  const start = new Date(Date.now() - 60_000 - randomInt(0, 50_000_000));
  const { cycle } = await ensureCycle({
    cycleId: `rt-cancel-${start.getTime()}`, cycleType: '30_MIN',
    startTime: start, endTime: new Date(Date.now() + 25 * 60_000),
  });
  return cycle;
}

describePg('cancelling a cycle returns its stakes', () => {
  let app;
  let admin;
  const made = [];

  const player = async () => {
    const p = await actor({});
    await linkTelegram(p);
    await creditDeposit(p.userId, 1_000, `rt-cancel-fund-${p.userId}`);
    return p;
  };
  const bet = (p, cycleId, side, amount) => as(app, p).post('/bet/place')
    .set('Idempotency-Key', `k-${Math.random().toString(36).slice(2)}`)
    .send({ cycleId, side, amount });

  beforeAll(async () => {
    await applySchema();
    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/bet', (await import('../../domains/markets/bet.routes.js')).default);
    app.use('/admin', (await import('../../routes/admin/cycles.admin.routes.js')).default);
    admin = await actor({ isAdmin: true });
  }, 60_000);

  afterAll(async () => {
    if (made.length) {
      await pgQuery(`UPDATE cycles SET status = 'CANCELLED' WHERE cycle_id = ANY($1) AND status IN ('OPEN','MERGED')`, [made]).catch(() => {});
    }
    await closePg();
  });

  it('the CANCEL button returns every real stake, and leaves another cycle\'s bet alone', async () => {
    const cycle = await openCycle();
    const other = await openCycle();
    made.push(cycle.cycleId, other.cycleId);
    const a = await player();
    const b = await player();
    const before = { a: await getBalances(a.userId), b: await getBalances(b.userId) };

    expect((await bet(a, cycle.cycleId, 'DELHI', 100)).status).toBe(200);
    expect((await bet(b, cycle.cycleId, 'BOMBAY', 200)).status).toBe(200);
    // The bystander: same player, a DIFFERENT cycle.
    expect((await bet(a, other.cycleId, 'DELHI', 50)).status).toBe(200);

    const res = await as(app, admin).post('/admin/manage-cycle').send({ action: 'CANCEL', cycleId: cycle.cycleId });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.stakesReturned).toBe(2);

    const after = { a: await getBalances(a.userId), b: await getBalances(b.userId) };
    // B is whole again; A is whole except the ₹50 still riding on the other cycle.
    expect(after.b.depositBalance).toBe(before.b.depositBalance);
    expect(after.b.lockedBalance).toBe(before.b.lockedBalance);
    expect(after.a.depositBalance).toBe(before.a.depositBalance - 50);
    expect(after.a.lockedBalance).toBe(before.a.lockedBalance + 50);

    const { rows } = await pgQuery(
      `SELECT cycle_id, status FROM bets WHERE user_id = ANY($1) ORDER BY cycle_id, status`, [[a.userId, b.userId]]);
    expect(rows.filter((r) => r.cycle_id === cycle.cycleId).map((r) => r.status)).toEqual(['VOID', 'VOID']);
    expect(rows.filter((r) => r.cycle_id === other.cycleId).map((r) => r.status)).toEqual(['PENDING']);
  });

  it('the recovery sweep returns stakes a cancel left behind', async () => {
    const cycle = await openCycle();
    made.push(cycle.cycleId);
    const p = await player();
    const before = await getBalances(p.userId);
    expect((await bet(p, cycle.cycleId, 'DELHI', 100)).status).toBe(200);

    // A cancel whose immediate void never ran — a crash between the two.
    expect((await cancelCycle(cycle.cycleId, { by: 'rt' })).ok).toBe(true);
    expect((await getBalances(p.userId)).lockedBalance).toBe(before.lockedBalance + 100);

    const swept = await voidCancelledCycles({ limit: 100 });
    expect(swept.some((r) => r.cycleId === cycle.cycleId && r.ok)).toBe(true);
    const after = await getBalances(p.userId);
    expect(after.depositBalance).toBe(before.depositBalance);
    expect(after.lockedBalance).toBe(before.lockedBalance);
  });

  it('refuses to void a cycle that is still being played, and moves nothing', async () => {
    const cycle = await openCycle();
    made.push(cycle.cycleId);
    const p = await player();
    expect((await bet(p, cycle.cycleId, 'BOMBAY', 100)).status).toBe(200);
    const locked = (await getBalances(p.userId)).lockedBalance;

    const r = await voidCancelledCycle(cycle.cycleId);
    expect(r).toMatchObject({ ok: false, reason: 'not_cancelled' });
    expect((await getBalances(p.userId)).lockedBalance).toBe(locked);
    const { rows } = await pgQuery(`SELECT status FROM bets WHERE user_id = $1`, [p.userId]);
    expect(rows.map((x) => x.status)).toEqual(['PENDING']);
  });
});
