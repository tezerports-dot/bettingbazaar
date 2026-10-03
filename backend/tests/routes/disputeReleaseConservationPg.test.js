// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Releasing a disputed deposit TRANSFERS tokens. It does not mint them.
 *
 * ── What was wrong ──────────────────────────────────────────────────────────
 * `POST /api/admin/dispute-orders/:orderId/resolve` — the route the admin
 * Disputes screen actually calls — credited the player and debited nobody.
 * So every dispute an admin resolved in the player's favour created tokens out
 * of nothing, and the conservation the settlement design rests on broke a
 * little each time.
 *
 * It also passed a SENTENCE where `creditDeposit` expects the order id. That
 * third argument builds the idempotency key `dep_complete_<orderId>`, so
 * "Dispute resolved — deposit credited: DEP_…" produced a DIFFERENT key from
 * the one the normal confirm uses — and the gate could not tell that the
 * deposit had already been paid. An order confirmed normally and then released
 * here was credited TWICE.
 *
 * Both routes now go through `moveDepositMoney`, the one owner, which is also
 * what restores the deposit/reserve split, the UTR release and the player's
 * payment-failure clear.
 *
 * ── The other side is the TEAM POOL (PROJECT_STATUS §3.10, 2c) ──────────────
 * A buy is held in the pool of the team whose member serves it, from the
 * moment it is assigned, and a DISPUTED buy keeps that hold. Releasing it to
 * the player SPENDS the hold (`teamPools.spendForBuy`): the pool's `held` falls
 * by the amount and the treasury moves it TEAM_FLOAT → USER_FLOAT, keyed on
 * the order. The disputed orders below are made the way production makes them
 * — routed to a member, accepted, marked paid by the player, disputed — so the
 * hold the release spends is one the assignment really took (§32 S16).
 *
 * ── What is asserted, and why it is the pair ────────────────────────────────
 * The existing dispute suite asserts `deposit + reserve` moved by the right
 * TOTAL. That is a conservation check on the player's side alone, and it passes
 * whether or not anybody funded it — which is exactly why the minting was
 * invisible for so long. These assert the OTHER side (the pool and the
 * order's treasury legs), and the split, and the key.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pgConfigured, applySchema, closePg, pgQuery, withTransaction } from '#db/client.js';
import { createOrderRecord, getOrderRecord } from '#db/repositories/orders.record.js';
import { transitionOrder } from '#db/repositories/orders.js';
import { getBalancesPaise } from '#db/repositories/wallets.core.js';
import { getPool } from '#db/repositories/teamPools.js';
import { setCashReady } from '#db/repositories/teamRouting.js';
import { tryAssignMerchant, markOrderPaid } from '../../domains/payment/paymentProcessing.service.js';
import { teamFixture, readyToPay } from '../teamFixture.js';
import { mountRouter, actor, merchantActor, as } from './_harness.js';

const describePg = pgConfigured() ? describe : describe.skip;

describePg('a released dispute moves tokens between two parties', () => {
  let app; let admin;
  let seq = 0;
  const teams = teamFixture();
  const made = [];
  const oid = () => {
    const id = `drc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}-${seq += 1}`;
    made.push(id);
    return id;
  };

  beforeAll(async () => {
    await applySchema();
    app = mountRouter((await import('../../domains/disputes/disputeResolution.admin.routes.js')).default);
    admin = await actor({ isAdmin: true, roles: ['admin'] });
  }, 60_000);

  afterAll(async () => {
    // Trap 10: this run's orders, then its teams (append-only transitions, so
    // with replication triggers off, inside one transaction).
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

  /**
   * A disputed deposit carrying its allocation, as a real one does: the split
   * is stamped on the ORDER at creation by the deposit policy, so the release
   * has to honour what that order was created under rather than a live read.
   * Served by a member of a working CASH team (≤ 10,000 tokens is the CASH
   * rail), whose pool holds it from the assignment on.
   */
  const disputedDeposit = async ({ rupees = 1000, deposit = 900, reserve = 100 } = {}) => {
    const merchant = await merchantActor({});
    const team = await teams.workingTeam({ rail: 'CASH', poolTokens: 10_000, include: [merchant.merchantId] });
    expect(await setCashReady(merchant.merchantId, true)).toEqual({ ok: true, ready: true });
    const player = await actor({});
    const orderId = oid();
    const order = await createOrderRecord({
      orderId, userId: player.userId, type: 'DEPOSIT',
      tokenAmountRupees: rupees, fiatAmountRupees: rupees,
      currency: 'INR', rateUsed: 1, merchantProfit: 0,
      depositAllocation: deposit, reserveAllocation: reserve,
    });
    expect(await tryAssignMerchant(order), 'team routing did not take the buy').toBe(true);
    expect(await getOrderRecord(orderId)).toMatchObject({ merchantId: merchant.merchantId, poolHeldPaise: rupees * 100 });
    expect((await transitionOrder(orderId, 'PROCESSING', { set: { processingAt: new Date() } })).ok).toBe(true);
    await readyToPay(orderId);
    await markOrderPaid(player.userId, orderId, `UTRDRC${Date.now()}${seq}`);
    // What the player's dispute route writes, on a PAID buy.
    expect((await transitionOrder(orderId, 'DISPUTED', {
      set: { disputeReason: 'paid but no tokens', disputeRaisedBy: 'user', disputeRaisedAt: new Date() },
    })).ok).toBe(true);
    // A DISPUTED buy still holds its tokens: the dispute is a question, not a refund.
    expect((await getOrderRecord(orderId)).poolHeldPaise).toBe(rupees * 100);
    return { orderId, player, merchant, team };
  };

  const resolve = (orderId, body) =>
    as(app, admin).post(`/dispute-orders/${orderId}/resolve`).send(body);

  it('takes from the team pool exactly what it credits the player', async () => {
    const { orderId, player, team } = await disputedDeposit({ rupees: 1000 });
    const playerBefore = await getBalancesPaise(player.userId);
    const poolBefore = await getPool(team.teamId);

    const res = await resolve(orderId, {
      decision: 'RELEASE_TO_USER', resolution: 'Bank statement shows the credit',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const playerAfter = await getBalancesPaise(player.userId);
    const poolAfter = await getPool(team.teamId);

    const credited = (playerAfter.depositBalance + playerAfter.reserveBalance)
                   - (playerBefore.depositBalance + playerBefore.reserveBalance);
    const taken = poolBefore.totalPaise - poolAfter.totalPaise;

    expect(credited).toBe(100_000);
    // THE assertion. This route credited the player and debited NOBODY, so the
    // tokens were minted. A player-side check alone cannot see that.
    expect(taken, 'a released dispute must move tokens, never create them').toBe(credited);
    // From the HOLD, not from what the team still has free.
    expect(poolBefore.heldPaise - poolAfter.heldPaise).toBe(100_000);
    expect(poolAfter.availablePaise).toBe(poolBefore.availablePaise);
    // And the books agree, for this order alone: out of the teams, into the players.
    expect(await legsFor(orderId)).toEqual({ TEAM_FLOAT: -100_000, USER_FLOAT: 100_000 });
  });

  it('honours the split the ORDER was created under', async () => {
    const { orderId, player } = await disputedDeposit({ rupees: 1000, deposit: 900, reserve: 100 });
    const before = await getBalancesPaise(player.userId);

    expect((await resolve(orderId, {
      decision: 'RELEASE_TO_USER', resolution: 'confirmed',
    })).status).toBe(200);

    const after = await getBalancesPaise(player.userId);
    // The whole amount used to land in the betting pocket, so the same deposit
    // left the player with a different wallet shape depending on whether it had
    // been disputed.
    expect(after.depositBalance - before.depositBalance).toBe(90_000);
    expect(after.reserveBalance - before.reserveBalance).toBe(10_000);
  });

  it('keys the credit on the ORDER, so a second release pays nothing again', async () => {
    const { orderId, player, team } = await disputedDeposit({ rupees: 1000 });
    const playerBefore = await getBalancesPaise(player.userId);
    const poolBefore = await getPool(team.teamId);

    await resolve(orderId, { decision: 'RELEASE_TO_USER', resolution: 'first' });
    // The order is COMPLETED now, so the route refuses on state — but the money
    // calls underneath are keyed on the order id either way, which is the
    // property that was lost when a sentence was passed instead.
    await resolve(orderId, { decision: 'RELEASE_TO_USER', resolution: 'second' });

    const playerAfter = await getBalancesPaise(player.userId);
    const poolAfter = await getPool(team.teamId);
    expect((playerAfter.depositBalance + playerAfter.reserveBalance)
         - (playerBefore.depositBalance + playerBefore.reserveBalance)).toBe(100_000);
    expect(poolBefore.totalPaise - poolAfter.totalPaise).toBe(100_000);
    expect(await legsFor(orderId)).toEqual({ TEAM_FLOAT: -100_000, USER_FLOAT: 100_000 });
    expect((await getOrderRecord(orderId)).status).toBe('COMPLETED');
  });
});
