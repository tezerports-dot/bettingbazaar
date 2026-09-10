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
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pgConfigured, applySchema, closePg } from '#db/client.js';
import { createOrderRecord, getOrderRecord } from '#db/repositories/orders.record.js';
import { transitionOrder } from '#db/repositories/orders.js';
import { getBalancesPaise } from '#db/repositories/wallets.core.js';
import { mountRouter, actor, merchantActor, as } from './_harness.js';

const describePg = pgConfigured() ? describe : describe.skip;

describePg('disputes are raised and resolved, not half-written', () => {
  let merchantApp;
  let adminApp;
  let admin;
  let seq = 0;
  const oid = () => `dr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}-${seq += 1}`;

  beforeAll(async () => {
    await applySchema();
    merchantApp = mountRouter((await import('../../domains/merchant/merchant.routes.js')).default);
    adminApp = mountRouter((await import('../../domains/payment/paymentOrder.routes.js')).default);
    admin = await actor({ isAdmin: true });
  }, 60_000);

  afterAll(async () => { await closePg(); });

  const order = async ({ player, merchant = null, state = 'PROCESSING', type = 'DEPOSIT', rupees = 500 }) => {
    const orderId = oid();
    await createOrderRecord({
      orderId, userId: player.userId, type,
      tokenAmountRupees: rupees, fiatAmountRupees: rupees,
      state, merchantId: merchant?.merchantId,
    });
    return orderId;
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
      const orderId = await order({ player, merchant });

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
    });

    it('admits a PAID order — the ordinary case', async () => {
      // A player says they paid and the merchant's statement disagrees. The
      // merchant cannot claim they are owed; they can say this should not
      // settle until somebody looks at it.
      const merchant = await merchantActor({});
      const player = await actor({});
      const orderId = await order({ player, merchant, state: 'PAID' });

      const res = await as(merchantApp, merchant).post(`/orders/${orderId}/red-flag`)
        .send({ reason: 'UTR 999888777666 is not in my statement' });

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const row = await getOrderRecord(orderId);
      expect(row.status).toBe('DISPUTED');
      expect(row.disputeReason).toMatch(/999888777666/);
    });

    it("refuses another merchant's order", async () => {
      const mine = await merchantActor({});
      const stranger = await merchantActor({});
      const player = await actor({});
      const orderId = await order({ player, merchant: mine });

      const res = await as(merchantApp, stranger).post(`/order/${orderId}/dispute`)
        .send({ reason: 'Not mine, but I would like to dispute it' });
      expect(res.status).toBe(404);
      expect((await getOrderRecord(orderId)).status).toBe('PROCESSING');
    });
  });

  describe('an admin resolves a dispute', () => {
    const disputed = async (opts) => {
      const orderId = await order(opts);
      await transitionOrder(orderId, 'DISPUTED', {
        set: { disputeReason: 'no credit', disputeRaisedBy: 'merchant', disputeRaisedAt: new Date() },
      });
      return orderId;
    };

    it('releasing a deposit credits the player and records the decision', async () => {
      const player = await actor({});
      const orderId = await disputed({ player, rupees: 500 });
      const before = await getBalancesPaise(player.userId);

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
    });

    it('refusing a deposit cancels it and credits nobody', async () => {
      const player = await actor({});
      const orderId = await disputed({ player, rupees: 500 });
      const before = await getBalancesPaise(player.userId);

      const res = await as(adminApp, admin).post(`/payment-orders/${orderId}/resolve`)
        .send({ resolution: 'refund', reason: 'No such credit on any statement' });

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const row = await getOrderRecord(orderId);
      expect(row.status).toBe('CANCELLED');
      expect(row.disputeDecision).toBe('CANCEL_ORDER');
      expect(row.disputeResolution).toBe('No such credit on any statement');
      expect(row.cancelReason).toBe('DISPUTE_REFUNDED');

      const after = await getBalancesPaise(player.userId);
      expect(after.depositBalance).toBe(before.depositBalance);
      expect(after.reserveBalance).toBe(before.reserveBalance);
    });

    it('refuses an order that is not disputed, and moves nothing', async () => {
      const player = await actor({});
      const orderId = await order({ player, state: 'PROCESSING' });
      const before = await getBalancesPaise(player.userId);

      const res = await as(adminApp, admin).post(`/payment-orders/${orderId}/resolve`)
        .send({ resolution: 'release', reason: 'Trying to release an undisputed order' });

      expect(res.status).toBe(400);
      expect((await getOrderRecord(orderId)).status).toBe('PROCESSING');
      const after = await getBalancesPaise(player.userId);
      expect(after.depositBalance).toBe(before.depositBalance);
    });

    it('pays once when the same resolution arrives twice', async () => {
      // The transition is the gate. A double-click, or an admin retrying a
      // request that timed out, must not credit the player twice.
      const player = await actor({});
      const orderId = await disputed({ player, rupees: 500 });
      const before = await getBalancesPaise(player.userId);
      const body = { resolution: 'release', reason: 'Credit confirmed with the bank' };

      expect((await as(adminApp, admin).post(`/payment-orders/${orderId}/resolve`).send(body)).status).toBe(200);
      const second = await as(adminApp, admin).post(`/payment-orders/${orderId}/resolve`).send(body);
      expect([200, 400, 409]).toContain(second.status);

      const after = await getBalancesPaise(player.userId);
      const moved = (after.depositBalance + after.reserveBalance)
                  - (before.depositBalance + before.reserveBalance);
      expect(moved, 'the player was paid twice for one dispute').toBe(50000);
    });
  });
});
