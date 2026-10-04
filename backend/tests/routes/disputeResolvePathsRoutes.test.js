// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Both dispute paths — the merchant raising one, the admin resolving one.
 *
 * ── Why this suite exists ───────────────────────────────────────────────────
 * `transitionOrder` moves the STATE first and writes the accompanying fields
 * SECOND, so an order is never found in a new state without the facts that
 * justify it. The cost is that a field name `setOrderFields` refuses throws
 * AFTER the state has committed — the order moves, the handler's catch returns
 * a 500, and everything the handler meant to do next never runs.
 *
 * Both routes here shipped with one, and both were reachable from a panel:
 *
 *   • The merchant panel's dispute button sent `updatedAt`. The order went to
 *     DISPUTED with `disputeReason` NULL and the merchant was told it failed.
 *     Retrying repeated it, so the order could never acquire a reason.
 *
 *   • The admin panel's Payment Control Centre sent `resolutionNotes` and
 *     `updatedAt`. Releasing a disputed DEPOSIT marked the order COMPLETED and
 *     threw before `creditDeposit` ran: the player's money was closed out and
 *     never credited, the order left the DISPUTED queue, and the admin saw
 *     "Failed to release".
 *
 * `check:settable` now refuses that class at build time. These assert the two
 * handlers do the work — a name gate cannot see whether money moved.
 *
 * Every order here is one production could make: routed to a member of a
 * working team, whose pool holds a buy from the assignment on (PROJECT_STATUS
 * §3.10, 2c). So "the money moved" is asserted on BOTH sides — the player's
 * pockets and the team's pool (§9, §19).
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

describePg('disputes are raised and resolved, not half-written', () => {
  let merchantApp;
  let adminApp;
  let admin;
  let seq = 0;
  const teams = teamFixture();
  const made = [];
  const oid = () => {
    const id = `dr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}-${seq += 1}`;
    made.push(id);
    return id;
  };

  beforeAll(async () => {
    await applySchema();
    merchantApp = mountRouter((await import('../../domains/merchant/merchant.routes.js')).default);
    adminApp = mountRouter((await import('../../domains/payment/paymentOrder.routes.js')).default);
    admin = await actor({ isAdmin: true });
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
   * A buy served by `merchant` — a member of a working CASH team (≤ 10,000
   * tokens is the CASH rail) whose pool holds it — accepted, and taken on to
   * PAID by the player's own mark-paid when asked.
   */
  const order = async ({ player, merchant = null, state = 'PROCESSING', rupees = 500 }) => {
    const member = merchant || await merchantActor({});
    const team = await teams.workingTeam({ rail: 'CASH', poolTokens: 10_000, include: [member.merchantId] });
    expect(await setCashReady(member.merchantId, true)).toEqual({ ok: true, ready: true });
    const orderId = oid();
    const created = await createOrderRecord({
      orderId, userId: player.userId, type: 'DEPOSIT',
      tokenAmountRupees: rupees, fiatAmountRupees: rupees,
      currency: 'INR', rateUsed: 1, merchantProfit: 0,
      depositAllocation: rupees, reserveAllocation: 0,
    });
    expect(await tryAssignMerchant(created), 'team routing did not take the buy').toBe(true);
    expect((await getOrderRecord(orderId)).merchantId).toBe(member.merchantId);
    expect((await transitionOrder(orderId, 'PROCESSING', { set: { processingAt: new Date() } })).ok).toBe(true);
    if (state === 'PAID') {
      await readyToPay(orderId);
      await markOrderPaid(player.userId, orderId, `UTRDRP${Date.now()}${seq}`);
    }
    expect((await getOrderRecord(orderId)).status).toBe(state);
    return { orderId, team, merchant: member };
  };

  describe('a merchant flags an order instead of disputing it', () => {
    // The merchant dispute route was DELETED on 2026-09-10. A dispute is the
    // instrument of the party who is OWED, which here is always the player; a
    // merchant asserts that a transaction FAILED — decline, reject with proof,
    // or red-flag. This block therefore tests the ESCALATION they do have, and
    // that the row it produces is still complete enough to rule on, which is
    // what this file has always been about. Ownership is pinned separately in
    // disputeOwnershipPg.test.js.
    it('records the reason, the raiser and the time', async () => {
      const merchant = await merchantActor({});
      const player = await actor({});
      const { orderId } = await order({ player, merchant });

      const res = await as(merchantApp, merchant).post(`/orders/${orderId}/red-flag`)
        .send({ reason: 'The player never sent the money' });

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const row = await getOrderRecord(orderId);
      expect(row.status).toBe('DISPUTED');
      // The half that used to be lost. DISPUTED with a null reason is a dispute
      // nobody can rule on.
      expect(row.disputeReason).toMatch(/The player never sent the money/);
      expect(row.redFlagged).toBe(true);
      expect(row.disputeRaisedAt ?? row.redFlaggedAt).toBeTruthy();
      // A flag stops the order; it does not decide it. The team's tokens stay
      // held for whichever way the admin rules.
      expect(row.poolHeldPaise).toBe(500_00);
    });

    it('admits a PAID order — the ordinary case', async () => {
      // A player says they paid and the merchant's statement disagrees. The
      // merchant cannot claim they are owed; they can say this should not
      // settle until somebody looks at it.
      const merchant = await merchantActor({});
      const player = await actor({});
      const { orderId } = await order({ player, merchant, state: 'PAID' });

      const res = await as(merchantApp, merchant).post(`/orders/${orderId}/red-flag`)
        .send({ reason: 'UTR 999888777666 is not in my statement' });

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const row = await getOrderRecord(orderId);
      expect(row.status).toBe('DISPUTED');
      expect(row.disputeReason).toMatch(/999888777666/);
    });

    it("refuses another member's order", async () => {
      // Scoped by the member's own reader (trap 16): somebody else's order is
      // not there to flag, so it is a 404 rather than a 403 that confirms it
      // exists. The deleted dispute path answers 404 to everybody.
      const mine = await merchantActor({});
      const stranger = await merchantActor({});
      const player = await actor({});
      const { orderId } = await order({ player, merchant: mine });

      const flag = await as(merchantApp, stranger).post(`/orders/${orderId}/red-flag`)
        .send({ reason: 'Not mine, but I would like it stopped' });
      expect(flag.status).toBe(404);
      const res = await as(merchantApp, stranger).post(`/order/${orderId}/dispute`)
        .send({ reason: 'Not mine, but I would like to dispute it' });
      expect(res.status).toBe(404);
      const row = await getOrderRecord(orderId);
      expect(row.status).toBe('PROCESSING');
      expect(row.redFlagged).not.toBe(true);
    });
  });

  describe('an admin resolves a dispute', () => {
    /**
     * A disputed buy WITH a team holding it, because that is the only kind
     * that exists: a deposit reaches DISPUTED from PAID, and nothing reaches
     * PAID unassigned. These fixtures once had nobody behind them, and passed
     * only because the release credited the player while debiting nobody — it
     * MINTED the tokens.
     */
    const disputed = async (opts) => {
      const paid = await order({ ...opts, state: 'PAID' });
      // What the player's dispute route writes on a PAID buy.
      expect((await transitionOrder(paid.orderId, 'DISPUTED', {
        set: { disputeReason: 'no credit', disputeRaisedBy: 'user', disputeRaisedAt: new Date() },
      })).ok).toBe(true);
      return paid;
    };

    it('releasing a deposit credits the player from the team pool and records the decision', async () => {
      const player = await actor({});
      const { orderId, team } = await disputed({ player, rupees: 500 });
      const before = await getBalancesPaise(player.userId);
      const poolBefore = await getPool(team.teamId);

      const res = await as(adminApp, admin).post(`/payment-orders/${orderId}/resolve`)
        .send({ resolution: 'release', reason: 'Bank statement shows the credit arrived' });

      expect(res.status, JSON.stringify(res.body)).toBe(200);

      const row = await getOrderRecord(orderId);
      expect(row.status).toBe('COMPLETED');
      // The decision, in the same vocabulary the other resolve route uses.
      expect(row.disputeDecision).toBe('RELEASE_TO_USER');
      expect(row.disputeResolution).toBe('Bank statement shows the credit arrived');
      expect(row.disputeResolvedBy).toBe(admin.userId);
      expect(row.disputeResolvedAt).toBeTruthy();

      // And the money actually moved. This is the half a field-name gate can
      // never see: the route used to mark the order COMPLETED and throw before
      // `creditDeposit` ran, so the player's disputed deposit was closed out
      // and never paid.
      const after = await getBalancesPaise(player.userId);
      const moved = (after.depositBalance + after.reserveBalance)
                  - (before.depositBalance + before.reserveBalance);
      expect(moved).toBe(50000);
      // …out of the team's hold, and nowhere else.
      const poolAfter = await getPool(team.teamId);
      expect(poolBefore.heldPaise - poolAfter.heldPaise).toBe(50000);
      expect(poolAfter.availablePaise).toBe(poolBefore.availablePaise);
      expect(await legsFor(orderId)).toEqual({ TEAM_FLOAT: -50000, USER_FLOAT: 50000 });
    });

    it('refusing a deposit cancels it, credits nobody, and gives the hold back to the pool', async () => {
      const player = await actor({});
      const { orderId, team } = await disputed({ player, rupees: 500 });
      const before = await getBalancesPaise(player.userId);
      const poolBefore = await getPool(team.teamId);

      const res = await as(adminApp, admin).post(`/payment-orders/${orderId}/resolve`)
        .send({ resolution: 'refund', reason: 'No such credit on any statement' });

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const row = await getOrderRecord(orderId);
      expect(row.status).toBe('CANCELLED');
      expect(row.disputeDecision).toBe('CANCEL_ORDER');
      expect(row.disputeResolution).toBe('No such credit on any statement');
      expect(row.cancelReason).toBe('DISPUTE_REFUNDED');
      expect(row.poolHeldPaise).toBe(0);

      const after = await getBalancesPaise(player.userId);
      expect(after.depositBalance).toBe(before.depositBalance);
      expect(after.reserveBalance).toBe(before.reserveBalance);
      const poolAfter = await getPool(team.teamId);
      expect(poolAfter.heldPaise).toBe(poolBefore.heldPaise - 50000);
      expect(poolAfter.availablePaise).toBe(poolBefore.availablePaise + 50000);
      expect(await legsFor(orderId)).toEqual({});
    });

    it('refuses an order that is not disputed, and moves nothing', async () => {
      const player = await actor({});
      const { orderId, team } = await order({ player, state: 'PROCESSING' });
      const before = await getBalancesPaise(player.userId);
      const poolBefore = await getPool(team.teamId);

      const res = await as(adminApp, admin).post(`/payment-orders/${orderId}/resolve`)
        .send({ resolution: 'release', reason: 'Trying to release an undisputed order' });

      expect(res.status).toBe(400);
      expect((await getOrderRecord(orderId)).status).toBe('PROCESSING');
      const after = await getBalancesPaise(player.userId);
      expect(after.depositBalance).toBe(before.depositBalance);
      expect(await getPool(team.teamId)).toEqual(poolBefore);
      expect(await legsFor(orderId)).toEqual({});
    });

    it('pays once when the same resolution arrives twice', async () => {
      // The transition is the gate. A double-click, or an admin retrying a
      // request that timed out, must not credit the player twice.
      const player = await actor({});
      const { orderId, team } = await disputed({ player, rupees: 500 });
      const before = await getBalancesPaise(player.userId);
      const poolBefore = await getPool(team.teamId);
      const body = { resolution: 'release', reason: 'Credit confirmed with the bank' };

      expect((await as(adminApp, admin).post(`/payment-orders/${orderId}/resolve`).send(body)).status).toBe(200);
      const second = await as(adminApp, admin).post(`/payment-orders/${orderId}/resolve`).send(body);
      expect([200, 400, 409]).toContain(second.status);

      const after = await getBalancesPaise(player.userId);
      const moved = (after.depositBalance + after.reserveBalance)
                  - (before.depositBalance + before.reserveBalance);
      expect(moved, 'the player was paid twice for one dispute').toBe(50000);
      expect(poolBefore.totalPaise - (await getPool(team.teamId)).totalPaise).toBe(50000);
      expect(await legsFor(orderId)).toEqual({ TEAM_FLOAT: -50000, USER_FLOAT: 50000 });
    });
  });
});
