// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * An unpaid sell goes to dispute by itself, and a dispute decided against the
 * member can compensate the player out of the team's own pool (owner,
 * 2026-10-17).
 *
 * Through the real path: a ₹1,000 sell routed to a member of a CASH team (the
 * stake locked by the order's own admission), its paying window passed, the
 * expiry sweep, then the Dispute Manager's routes. Money is asserted on both
 * sides from the rows: the player's pockets, the team's pool, the compensation
 * row and the treasury movement it posted.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pgConfigured, applySchema, closePg, pgQuery } from '#db/client.js';
import { getOrderRecord } from '#db/repositories/orders.record.js';
import { getBalancesPaise } from '#db/repositories/wallets.core.js';
import { updateUser } from '#db/repositories/users.js';
import { getPool, compensationFor } from '#db/repositories/teamPools.js';
import { approveMerchant } from '#db/repositories/merchants.js';
import { creditWinnings } from '../../domains/wallet/walletAuthority.service.js';
import { createWithdrawalOrder, expireOrders } from '../../domains/payment/paymentProcessing.service.js';
import { teamFixture } from '../teamFixture.js';
import { mountRouter, actor, merchantActor, as } from './_harness.js';

const describePg = pgConfigured() ? describe : describe.skip;
const RUPEES = 1_000;
const A = RUPEES * 100;

describePg('unpaid sells go to dispute; the losing team compensates the player', () => {
  const teams = teamFixture();
  let disputeApp;
  const players = [];
  let seq = 0;

  beforeAll(async () => {
    await applySchema();
    disputeApp = mountRouter((await import('../../domains/disputes/disputeResolution.admin.routes.js')).default);
  }, 120_000);

  afterAll(async () => {
    await pgQuery('SET session_replication_role = replica');
    try {
      await pgQuery('DELETE FROM dispute_compensations WHERE user_id = ANY($1)', [players]);
      await pgQuery(
        'DELETE FROM order_transitions WHERE order_id IN (SELECT order_id FROM order_states WHERE user_id = ANY($1))',
        [players]);
      await pgQuery('DELETE FROM order_states WHERE user_id = ANY($1)', [players]);
    } finally {
      await pgQuery('SET session_replication_role = DEFAULT');
    }
    await teams.cleanup();
    await closePg();
  });

  /** A team of one online member, its pool funded with `poolTokens`. */
  const teamOf = async (poolTokens) => {
    const member = await merchantActor({});
    const team = await teams.workingTeam({ rail: 'CASH', include: [member.merchantId], poolTokens });
    return { member, team };
  };

  /** A ₹1,000 sell routed to `member`, its paying window already passed. */
  const unpaidSell = async (member) => {
    await approveMerchant(member.merchantId, { actor: 'test', mayLiftHighRisk: true });
    await teams.onlyOnline([member.merchantId]);
    const player = await actor({});
    players.push(player.userId);
    await updateUser(player.userId, {
      bankDetails: { accountNumber: '000111222333', ifscCode: 'HDFC0000001', bankName: 'HDFC Bank', accountHolderName: 'Test Player' },
    });
    seq += 1;
    await creditWinnings(player.userId, RUPEES, 'compensation suite float', 'Test',
      `seed_${player.userId}`, `dcomp_seed_${player.userId}_${seq}`);
    const { order } = await createWithdrawalOrder(player.userId, RUPEES);
    const orderId = order.orderId ?? order._id;
    const routed = await getOrderRecord(orderId);
    expect(routed.status).toBe('PROCESSING');
    expect(routed.merchantId).toBe(String(member.merchantId));
    // The paying window passing, as time would make it.
    await pgQuery(`UPDATE order_states SET expires_at = now() - interval '1 second' WHERE order_id = $1`, [orderId]);
    return { player, orderId };
  };

  const adminPost = async (path, body) => as(disputeApp, await actor({ isAdmin: true })).post(path).send(body);
  const adminGet = async (path) => as(disputeApp, await actor({ isAdmin: true })).get(path);

  it('a sell not paid in its window is disputed by the sweep, its stake still locked', async () => {
    const { member } = await teamOf(5_000);
    const s = await unpaidSell(member);
    const before = await getBalancesPaise(s.player.userId);
    await expireOrders();
    const row = await getOrderRecord(s.orderId);
    expect(row.status).toBe('DISPUTED');
    expect(row.disputeRaisedBy).toBe('system');
    const after = await getBalancesPaise(s.player.userId);
    expect(after.lockedBalance).toBe(before.lockedBalance);
    expect(after.winningsBalance).toBe(before.winningsBalance);
    // A second sweep moves nothing.
    await expireOrders();
    expect((await getOrderRecord(s.orderId)).status).toBe('DISPUTED');
  });

  it('decided against the member, 10% comes out of the team\'s pool into the player\'s winnings, once', async () => {
    const { member, team } = await teamOf(5_000);
    const s = await unpaidSell(member);
    await expireOrders();
    const poolBefore = await getPool(team.teamId);
    const walletBefore = await getBalancesPaise(s.player.userId);

    const detail = await adminGet(`/dispute-orders/${s.orderId}`);
    expect(detail.status).toBe(200);
    expect(detail.body.compensationPercents).toEqual([0, 5, 10]);
    expect(detail.body.dispute.suspendsIfToUser).toBe('MERCHANT');
    expect(detail.body.merchantRecord).toMatchObject({ merchantId: String(member.merchantId) });

    const res = await adminPost(`/dispute-orders/${s.orderId}/resolve`,
      { decision: 'RELEASE_TO_USER', resolution: 'member never paid', compensationPercent: 10 });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.compensation).toMatchObject({ ok: true, percent: 10, amountPaise: A / 10 });

    expect((await getOrderRecord(s.orderId)).status).toBe('CANCELLED');
    const walletAfter = await getBalancesPaise(s.player.userId);
    expect(walletAfter.lockedBalance - walletBefore.lockedBalance).toBe(-A);
    expect(walletAfter.winningsBalance - walletBefore.winningsBalance).toBe(A + A / 10);
    const poolAfter = await getPool(team.teamId);
    expect(poolAfter.availablePaise - poolBefore.availablePaise).toBe(-A / 10);
    expect(poolAfter.heldPaise).toBe(poolBefore.heldPaise);
    expect(await compensationFor(s.orderId)).toMatchObject({ percent: 10, amountPaise: A / 10 });
    const { rows: legs } = await pgQuery(
      'SELECT account, amount_paise FROM treasury_entries WHERE movement_id = $1 ORDER BY account', [`dispute_comp_${s.orderId}`]);
    expect(legs.map((l) => [l.account, Number(l.amount_paise)])).toEqual([['TEAM_FLOAT', -A / 10], ['USER_FLOAT', A / 10]]);

    // Paid once: asking again answers what was paid and moves nothing.
    const again = await adminPost(`/dispute-orders/${s.orderId}/compensation`, { percent: 10 });
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(again.body.compensation).toMatchObject({ ok: true, already: true });
    expect((await getBalancesPaise(s.player.userId)).winningsBalance).toBe(walletAfter.winningsBalance);
    expect((await getPool(team.teamId)).availablePaise).toBe(poolAfter.availablePaise);

    // The member's record now shows the loss and the compensation.
    const { rows: m } = await pgQuery('SELECT lost_disputes FROM merchants WHERE merchant_id = $1', [String(member.merchantId)]);
    expect(Number(m[0].lost_disputes)).toBeGreaterThanOrEqual(1);
    const { db } = await import('#db');
    const record = await db.disputeFaults.merchantOffenceRecord(member.merchantId);
    expect(record).toMatchObject({ disputesLost: 1, compensationsPaid: 1, compensatedPaise: A / 10, repeatOffender: true });
  });

  it('refuses compensation the decision does not owe, and an unknown percent, before anything moves', async () => {
    const { member, team } = await teamOf(5_000);
    const s = await unpaidSell(member);
    await expireOrders();
    const poolBefore = await getPool(team.teamId);

    const odd = await adminPost(`/dispute-orders/${s.orderId}/resolve`,
      { decision: 'RELEASE_TO_USER', resolution: 'x', compensationPercent: 7 });
    expect(odd.status).toBe(400);
    expect(odd.body.code).toBe('UNKNOWN_COMPENSATION');

    // The member paid, only late: nobody lost, so nothing is owed.
    const notOwed = await adminPost(`/dispute-orders/${s.orderId}/resolve`,
      { decision: 'RELEASE_TO_MERCHANT', resolution: 'paid late', compensationPercent: 5 });
    expect(notOwed.status).toBe(400);
    expect(notOwed.body.code).toBe('COMPENSATION_NEEDS_MERCHANT_FAULT');
    expect((await getOrderRecord(s.orderId)).status).toBe('DISPUTED');

    // The same decision with 0% goes through: the stake goes to the pool and no one is at fault.
    const ok = await adminPost(`/dispute-orders/${s.orderId}/resolve`,
      { decision: 'RELEASE_TO_MERCHANT', resolution: 'paid late', compensationPercent: 0 });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect((await getOrderRecord(s.orderId)).status).toBe('COMPLETED');
    expect((await getPool(team.teamId)).availablePaise - poolBefore.availablePaise).toBe(A);
    const { rows: f } = await pgQuery('SELECT 1 FROM dispute_faults WHERE order_id = $1', [s.orderId]);
    expect(f).toHaveLength(0);
    expect(await compensationFor(s.orderId)).toBeNull();
  });

  it('a pool too small pays nothing and says so; paid in full once the pool is topped up', async () => {
    // 10 tokens: a pool that exists, short of the 50 owed.
    const { member, team } = await teamOf(10);
    const s = await unpaidSell(member);
    await expireOrders();
    const res = await adminPost(`/dispute-orders/${s.orderId}/resolve`,
      { decision: 'RELEASE_TO_USER', resolution: 'member never paid', compensationPercent: 5 });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.compensation).toMatchObject({ ok: false, reason: 'pool_short', availablePaise: 10 * 100 });
    expect((await getPool(team.teamId)).availablePaise).toBe(10 * 100);
    expect((await getOrderRecord(s.orderId)).status).toBe('CANCELLED');
    expect(await compensationFor(s.orderId)).toBeNull();
    const walletShort = await getBalancesPaise(s.player.userId);

    const stillShort = await adminPost(`/dispute-orders/${s.orderId}/compensation`, { percent: 5 });
    expect(stillShort.status).toBe(409);
    expect(stillShort.body.code).toBe('POOL_SHORT');

    await teams.fund(team, 100);
    const paid = await adminPost(`/dispute-orders/${s.orderId}/compensation`, { percent: 5 });
    expect(paid.status, JSON.stringify(paid.body)).toBe(200);
    expect(paid.body.compensation).toMatchObject({ ok: true, percent: 5, amountPaise: A / 20 });
    expect((await getBalancesPaise(s.player.userId)).winningsBalance - walletShort.winningsBalance).toBe(A / 20);
    expect((await getPool(team.teamId)).availablePaise).toBe(110 * 100 - A / 20);
  });
});
