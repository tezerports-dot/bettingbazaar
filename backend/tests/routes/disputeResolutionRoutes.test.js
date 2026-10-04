// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Admin dispute resolution — the money-out ruling — over HTTP against a real DB.
 *
 * This is the highest-risk admin action: it credits a player's deposit, refunds
 * a withdrawal, or cancels an order, and two admins ruling at once must not
 * double-move money. The transition is the gate (it runs before any credit) and
 * every money call is keyed, so the tests assert money moves exactly once and
 * the order carries the decision that moved it.
 *
 * The side opposite the player is the TEAM POOL (PROJECT_STATUS §3.10, 2c): a
 * buy is held in the pool of the team whose member serves it, and a settled
 * sell's tokens sit in that pool. So every ruling is asserted on both sides —
 * the player's wallet, and the pool plus the order's own treasury legs.
 *
 * Nothing below the HTTP boundary is mocked, and no order here is written into
 * a state production could not reach: each is routed to a member, accepted,
 * paid and disputed through the same functions the routes call (§32 S16).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pgConfigured, applySchema, closePg, pgQuery, withTransaction } from '#db/client.js';
import { getBalancesPaise } from '#db/repositories/wallets.core.js';
import { createOrderRecord, getOrderRecord } from '#db/repositories/orders.record.js';
import { transitionOrder } from '#db/repositories/orders.js';
import { updateUser } from '#db/repositories/users.js';
import { getPool } from '#db/repositories/teamPools.js';
import { setCashReady } from '#db/repositories/teamRouting.js';
import { creditWinnings } from '../../domains/wallet/walletAuthority.service.js';
import {
  tryAssignMerchant, markOrderPaid, createWithdrawalOrder,
} from '../../domains/payment/paymentProcessing.service.js';
import { settleHold } from '../../domains/payment/withdrawalHold.service.js';
import { teamFixture, readyToPay } from '../teamFixture.js';
import { mountRouter, actor, merchantActor, as, request } from './_harness.js';

const describePg = pgConfigured() ? describe : describe.skip;

describePg('dispute resolution routes', () => {
  let app; let admin;
  const RUN = Math.random().toString(36).slice(2, 8);
  let seq = 0;
  const teams = teamFixture();
  const made = [];

  beforeAll(async () => {
    await applySchema();
    const mod = await import('../../domains/disputes/disputeResolution.admin.routes.js');
    app = mountRouter(mod.default);
    admin = await actor({ isAdmin: true, roles: ['admin'] });
  }, 60_000);

  afterAll(async () => {
    // Trap 10: this run's orders, then its teams. The transitions table is
    // append-only, so its rows go with replication triggers off, in one
    // transaction so the setting cannot leak onto a pooled connection.
    await withTransaction(async (c) => {
      await c.query('SET LOCAL session_replication_role = replica');
      await c.query('DELETE FROM order_transitions WHERE order_id = ANY($1)', [made]);
      await c.query('DELETE FROM order_states WHERE order_id = ANY($1)', [made]);
    });
    await teams.cleanup();
    await closePg();
  });

  /** What the treasury moved for ONE order, account → paise. */
  const legsFor = async (orderId) => {
    const { rows } = await pgQuery(
      `SELECT account, SUM(amount_paise)::bigint AS paise FROM treasury_entries
        WHERE ref_id = $1 GROUP BY account`, [orderId]);
    return Object.fromEntries(rows.map((r) => [r.account, Number(r.paise)]));
  };

  /** What the player's dispute route writes when it moves an order. */
  const raiseDispute = (orderId) => transitionOrder(orderId, 'DISPUTED', {
    set: { disputeReason: 'The money never arrived on my side.', disputeRaisedBy: 'user', disputeRaisedAt: new Date() },
  });

  /**
   * A disputed BUY, served by a member of a working CASH team whose pool
   * holds it, because that is the only kind that exists.
   *
   * A deposit reaches DISPUTED from PAID, and nothing reaches PAID without
   * being assigned — so a memberless disputed deposit is not a case this route
   * can meet in production. These fixtures once had nobody behind them, and
   * passed only because the release credited the player while debiting
   * nobody: it MINTED the tokens. Releasing now spends the team pool's hold,
   * which needs a team that holds it.
   */
  const disputed = async ({ tokens = 500, owner = null } = {}) => {
    seq += 1;
    const who = owner || await actor({});
    const merchant = await merchantActor({});
    const team = await teams.workingTeam({ rail: 'CASH', poolTokens: 10_000, include: [merchant.merchantId] });
    expect(await setCashReady(merchant.merchantId, true)).toEqual({ ok: true, ready: true });
    const orderId = `DR-${RUN}-${seq}`;
    made.push(orderId);
    const order = await createOrderRecord({
      orderId, userId: who.userId, type: 'DEPOSIT',
      tokenAmountRupees: tokens, fiatAmountRupees: tokens,
      currency: 'INR', rateUsed: 1, merchantProfit: 0,
      depositAllocation: tokens, reserveAllocation: 0,
    });
    expect(await tryAssignMerchant(order), 'team routing did not take the buy').toBe(true);
    expect((await getOrderRecord(orderId)).merchantId).toBe(merchant.merchantId);
    expect((await transitionOrder(orderId, 'PROCESSING', { set: { processingAt: new Date() } })).ok).toBe(true);
    await readyToPay(orderId);
    await markOrderPaid(who.userId, orderId, `UTRDR${RUN}${Date.now()}${seq}`);
    expect((await raiseDispute(orderId)).ok).toBe(true);
    expect((await getOrderRecord(orderId)).poolHeldPaise).toBe(tokens * 100);
    return { orderId, who, merchant, team };
  };

  // ── Authorisation & validation ──────────────────────────────────────────────
  it('refuses a non-admin', async () => {
    const nobody = await actor({});
    const { orderId } = await disputed();
    expect((await request(app).post(`/dispute-orders/${orderId}/resolve`).send({ decision: 'CANCEL_ORDER', resolution: 'x' })).status).toBe(401);
    expect((await as(app, nobody).post(`/dispute-orders/${orderId}/resolve`).send({ decision: 'CANCEL_ORDER', resolution: 'x' })).status).toBe(403);
    expect((await getOrderRecord(orderId)).state).toBe('DISPUTED');
  });

  it('rejects an unknown decision and a missing resolution', async () => {
    const { orderId } = await disputed();
    expect((await as(app, admin).post(`/dispute-orders/${orderId}/resolve`).send({ decision: 'GIVE_IT_TO_ME', resolution: 'x' })).status).toBe(400);
    expect((await as(app, admin).post(`/dispute-orders/${orderId}/resolve`).send({ decision: 'CANCEL_ORDER' })).status).toBe(400);
    expect((await as(app, admin).post(`/dispute-orders/${orderId}/resolve`).send({ decision: 'CANCEL_ORDER', resolution: '   ' })).status).toBe(400);
  });

  it('404s an order that does not exist', async () => {
    expect((await as(app, admin).post(`/dispute-orders/NOSUCH-${RUN}/resolve`).send({ decision: 'CANCEL_ORDER', resolution: 'x' })).status).toBe(404);
  });

  it('refuses to resolve an order already final, and moves nothing the second time', async () => {
    // Made final the way an admin makes it final — a ruling through this very
    // route — and then ruled on again in the OPPOSITE direction, which is the
    // pair the transition gate exists to keep apart.
    const { orderId, who, team } = await disputed();
    expect((await as(app, admin).post(`/dispute-orders/${orderId}/resolve`)
      .send({ decision: 'CANCEL_ORDER', resolution: 'No payment was ever made.' })).status).toBe(200);
    const walletBefore = await getBalancesPaise(who.userId);
    const poolBefore = await getPool(team.teamId);

    const res = await as(app, admin).post(`/dispute-orders/${orderId}/resolve`).send({ decision: 'RELEASE_TO_USER', resolution: 'late' });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/CANCELLED/);
    expect(await getBalancesPaise(who.userId)).toEqual(walletBefore);
    expect(await getPool(team.teamId)).toEqual(poolBefore);
    expect(await legsFor(orderId)).toEqual({});
  });

  // ── DEPOSIT ─────────────────────────────────────────────────────────────────
  it('RELEASE_TO_USER on a deposit credits the player once from the team pool and completes the order', async () => {
    const { orderId, who, team } = await disputed({ tokens: 500 });
    const before = await getBalancesPaise(who.userId);
    const poolBefore = await getPool(team.teamId);

    const res = await as(app, admin).post(`/dispute-orders/${orderId}/resolve`)
      .send({ decision: 'RELEASE_TO_USER', resolution: 'Payment proof checks out.' });
    expect(res.status, res.body.message).toBe(200);

    const after = await getBalancesPaise(who.userId);
    expect(after.depositBalance - before.depositBalance).toBe(500_00);
    // The other side: the team's hold is spent, and the books say where it went.
    const poolAfter = await getPool(team.teamId);
    expect(poolBefore.heldPaise - poolAfter.heldPaise).toBe(500_00);
    expect(poolAfter.availablePaise).toBe(poolBefore.availablePaise);
    expect(await legsFor(orderId)).toEqual({ TEAM_FLOAT: -500_00, USER_FLOAT: 500_00 });

    const order = await getOrderRecord(orderId);
    expect(order.state).toBe('COMPLETED');
    expect(order.poolHeldPaise).toBe(0);
    expect(order.disputeDecision).toBe('RELEASE_TO_USER');
    expect(order.disputeResolution).toBe('Payment proof checks out.');
  });

  it('does not credit twice when the same deposit dispute is resolved again', async () => {
    const { orderId, who, team } = await disputed({ tokens: 500 });
    const before = await getBalancesPaise(who.userId);
    const first = await as(app, admin).post(`/dispute-orders/${orderId}/resolve`).send({ decision: 'RELEASE_TO_USER', resolution: 'ok' });
    const afterFirst = await getBalancesPaise(who.userId);
    const poolAfterFirst = await getPool(team.teamId);
    const second = await as(app, admin).post(`/dispute-orders/${orderId}/resolve`).send({ decision: 'RELEASE_TO_USER', resolution: 'ok again' });

    expect(first.status).toBe(200);
    // Once COMPLETED, the status pre-read refuses a re-resolve (400) before the
    // transition is even asked — either way the point is the money moved once.
    expect(second.status).toBeGreaterThanOrEqual(400);
    expect((await getBalancesPaise(who.userId)).depositBalance).toBe(afterFirst.depositBalance);
    expect(afterFirst.depositBalance - before.depositBalance).toBe(500_00);
    expect(await getPool(team.teamId)).toEqual(poolAfterFirst);
    expect(await legsFor(orderId)).toEqual({ TEAM_FLOAT: -500_00, USER_FLOAT: 500_00 });
  });

  it('a deposit ruled against the user credits nobody, gives the hold back to the pool, and cancels', async () => {
    const { orderId, who, team } = await disputed({ tokens: 500 });
    const before = await getBalancesPaise(who.userId);
    const poolBefore = await getPool(team.teamId);
    const res = await as(app, admin).post(`/dispute-orders/${orderId}/resolve`).send({ decision: 'CANCEL_ORDER', resolution: 'No payment was ever made.' });
    expect(res.status, res.body.message).toBe(200);
    expect(await getBalancesPaise(who.userId)).toMatchObject({ depositBalance: before.depositBalance });
    // The team's tokens held for a buy nobody paid for are the team's again —
    // free to serve the next order, not stranded until a sweep notices.
    const poolAfter = await getPool(team.teamId);
    expect(poolAfter.heldPaise).toBe(poolBefore.heldPaise - 500_00);
    expect(poolAfter.availablePaise).toBe(poolBefore.availablePaise + 500_00);
    expect(poolAfter.totalPaise).toBe(poolBefore.totalPaise);
    // A release inside the pool is not a movement between accounts.
    expect(await legsFor(orderId)).toEqual({});
    const order = await getOrderRecord(orderId);
    expect(order.state).toBe('CANCELLED');
    expect(order.poolHeldPaise).toBe(0);
  });

  // The merchant's live feed is SSE. The resolution was pushed to a socket room
  // no merchant client ever joined, so the order stayed DISPUTED on the
  // merchant's screen until they reloaded (§32 S17).
  it("tells the order's member the outcome, on the stream their panel listens to", async () => {
    const { orderId, merchant } = await disputed({ tokens: 500 });
    const sent = [];
    const previous = global.sseManager;
    global.sseManager = {
      sendToMerchant: (m, event, data) => sent.push({ m, event, data }),
      broadcastToAdmins: () => {},
    };
    try {
      const res = await as(app, admin).post(`/dispute-orders/${orderId}/resolve`)
        .send({ decision: 'CANCEL_ORDER', resolution: 'No payment was ever made.' });
      expect(res.status, res.body.message).toBe(200);
    } finally {
      global.sseManager = previous;
    }
    const toMerchant = sent.filter((e) => e.m === String(merchant.merchantId));
    expect(toMerchant.map((e) => e.event)).toEqual(['order_update']);
    expect(toMerchant[0].data).toMatchObject({ orderId, status: 'CANCELLED' });
    // The id and the state, nothing the merchant view does not carry: the
    // panel MERGES this payload into the order it holds.
    expect(Object.keys(toMerchant[0].data).sort()).toEqual(['orderId', 'server_ts', 'status']);
  });

  it('survives two admins resolving the same deposit dispute at once', async () => {
    const { orderId, who, team } = await disputed({ tokens: 500 });
    const before = await getBalancesPaise(who.userId);
    const poolBefore = await getPool(team.teamId);
    const results = await Promise.all(
      Array.from({ length: 4 }, () => as(app, admin).post(`/dispute-orders/${orderId}/resolve`).send({ decision: 'RELEASE_TO_USER', resolution: 'race' })),
    );
    // Exactly one applies; the rest are refused as already-resolved (409 at the
    // transition gate, or 400 at the status pre-read). The invariant is the
    // money: it moves once, on both sides.
    expect(results.filter((r) => r.status === 200).length).toBeGreaterThanOrEqual(1);
    expect(results.every((r) => [200, 400, 409].includes(r.status))).toBe(true);
    expect((await getBalancesPaise(who.userId)).depositBalance - before.depositBalance).toBe(500_00);
    expect(poolBefore.totalPaise - (await getPool(team.teamId)).totalPaise).toBe(500_00);
    expect(await legsFor(orderId)).toEqual({ TEAM_FLOAT: -500_00, USER_FLOAT: 500_00 });
  });

  // ── WITHDRAWAL refunded after settlement ─────────────────────────────────────
  /**
   * A sell that has SETTLED and then been disputed: the hold window passed, the
   * player's stake was consumed and the tokens joined the team's pool; then the
   * player said the payout never arrived. 1,000 tokens: a cash payout is a
   * denomination, so that is what a real one carries.
   */
  const settledDisputedSell = async () => {
    seq += 1;
    const who = await actor({});
    await updateUser(who.userId, {
      bankDetails: { accountNumber: '000111222333', ifscCode: 'TEST0000001', bankName: 'Test Bank', accountHolderName: 'Route Test' },
    });
    await creditWinnings(who.userId, 1000, 'route test seed', 'Test', `seed-${RUN}-${seq}`, `rt_seed_${RUN}_${seq}`);
    const merchant = await merchantActor({});
    const team = await teams.workingTeam({ rail: 'CASH', include: [merchant.merchantId] });

    const created = await createWithdrawalOrder(who.userId, 1000);
    const { orderId } = created.order;
    made.push(orderId);
    expect(await getOrderRecord(orderId)).toMatchObject({ status: 'ASSIGNED', merchantId: merchant.merchantId, teamId: team.teamId });
    expect((await transitionOrder(orderId, 'PROCESSING', { set: { processingAt: new Date() } })).ok).toBe(true);
    // The member's confirm, with the hold window already behind it.
    expect((await transitionOrder(orderId, 'PAID', {
      set: { merchantCreditStatus: 'HELD', merchantCreditHoldUntil: new Date(Date.now() - 60_000), escrowLocked: true },
    })).ok).toBe(true);
    expect(await settleHold(orderId)).toBe(true);
    expect(await getOrderRecord(orderId)).toMatchObject({ status: 'COMPLETED', merchantCreditStatus: 'RELEASED' });
    expect(await legsFor(orderId)).toEqual({ TEAM_FLOAT: 100_000, USER_FLOAT: -100_000 });
    expect((await raiseDispute(orderId)).ok).toBe(true);
    return { orderId, who, merchant, team };
  };

  it('refunds a settled withdrawal to the player’s winnings, once, takes it back out of the pool, and cancels', async () => {
    // Ruling for the player is a refund into winnings AND a reversal out of the
    // pool, both keyed, so a repeat does neither twice.
    const { orderId, who, team } = await settledDisputedSell();

    const before = await getBalancesPaise(who.userId);
    const poolBefore = await getPool(team.teamId);
    const res = await as(app, admin).post(`/dispute-orders/${orderId}/resolve`).send({ decision: 'RELEASE_TO_USER', resolution: 'User never received the payout.' });
    expect(res.status, res.body.message).toBe(200);

    const after = await getBalancesPaise(who.userId);
    expect(after.winningsBalance - before.winningsBalance).toBe(1000_00);
    expect(after.lockedBalance).toBe(before.lockedBalance);
    // The pool gives back what the settlement put in, and the books net to zero.
    expect(poolBefore.availablePaise - (await getPool(team.teamId)).availablePaise).toBe(1000_00);
    expect(await legsFor(orderId)).toEqual({ TEAM_FLOAT: 0, USER_FLOAT: 0 });
    expect((await getOrderRecord(orderId)).state).toBe('CANCELLED');

    // A second ruling must not refund again, from either side.
    const poolAfter = await getPool(team.teamId);
    await as(app, admin).post(`/dispute-orders/${orderId}/resolve`).send({ decision: 'RELEASE_TO_USER', resolution: 'again' });
    expect((await getBalancesPaise(who.userId)).winningsBalance).toBe(after.winningsBalance);
    expect(await getPool(team.teamId)).toEqual(poolAfter);
  });

  it('refunds a settled withdrawal whose tokens the team has already used: the platform covers it, the pool is not touched', async () => {
    // The neighbour of the case above (§37): the sell's 1,000 tokens reached
    // the pool and the team has since HELD them for the next buy it was given.
    // They cannot come back out. The player is still owed, so the platform
    // covers the refund from its own holding (TOKEN_SUPPLY → USER_FLOAT) and the
    // team is recovered from by a person — the pool, and the buy it is holding
    // for, are left alone.
    const { orderId, who, merchant, team } = await settledDisputedSell();
    expect((await getPool(team.teamId)).availablePaise).toBe(1000_00);

    // The team's next order: a buy, routed to the same member, holding those tokens.
    expect(await setCashReady(merchant.merchantId, true)).toEqual({ ok: true, ready: true });
    const buyer = await actor({});
    const buyId = `DR-${RUN}-buy-${seq}`;
    made.push(buyId);
    const buy = await createOrderRecord({
      orderId: buyId, userId: buyer.userId, type: 'DEPOSIT',
      tokenAmountRupees: 1000, fiatAmountRupees: 1000,
      currency: 'INR', rateUsed: 1, merchantProfit: 0,
      depositAllocation: 1000, reserveAllocation: 0,
    });
    expect(await tryAssignMerchant(buy), 'the team could not take its next buy').toBe(true);
    const poolBefore = await getPool(team.teamId);
    expect(poolBefore).toMatchObject({ availablePaise: 0, heldPaise: 1000_00 });

    const before = await getBalancesPaise(who.userId);
    const res = await as(app, admin).post(`/dispute-orders/${orderId}/resolve`).send({ decision: 'RELEASE_TO_USER', resolution: 'User never received the payout.' });
    expect(res.status, res.body.message).toBe(200);

    // The player is made whole…
    expect((await getBalancesPaise(who.userId)).winningsBalance - before.winningsBalance).toBe(1000_00);
    expect((await getOrderRecord(orderId)).state).toBe('CANCELLED');
    // …the pool, and the buy it holds for, are untouched…
    expect(await getPool(team.teamId)).toEqual(poolBefore);
    expect((await getOrderRecord(buyId)).poolHeldPaise).toBe(1000_00);
    // …and the books say who paid: the settlement's legs stand, and the cover is
    // a transfer out of the platform's own holding onto the user side.
    expect(await legsFor(orderId)).toEqual({ TEAM_FLOAT: 100_000, USER_FLOAT: 0, TOKEN_SUPPLY: -100_000 });

    // A retry of the reversal after the pool has REFILLED must still not take
    // from it: the cover IS the reversal, once (it is recorded under the
    // order's lock). The buy is given back to the queue, its hold returned.
    const { releaseBuyHold, reverseSellFromPool } = await import('#db/repositories/teamPools.js');
    expect((await releaseBuyHold(buyId, { actor: 'test', reason: 'refill' })).releasedPaise).toBe(1000_00);
    const refilled = await getPool(team.teamId);
    expect(refilled.availablePaise).toBe(1000_00);
    expect(await reverseSellFromPool(orderId, { actor: 'test', coverShortfall: true }))
      .toEqual({ ok: true, covered: true, alreadyCovered: true });
    expect(await getPool(team.teamId)).toEqual(refilled);
    expect(await legsFor(orderId)).toEqual({ TEAM_FLOAT: 100_000, USER_FLOAT: 0, TOKEN_SUPPLY: -100_000 });
  });
});
