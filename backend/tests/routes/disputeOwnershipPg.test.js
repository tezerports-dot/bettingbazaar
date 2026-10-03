// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * WHO may raise a dispute, and FROM WHERE.
 *
 * ── The model, stated once ──────────────────────────────────────────────────
 * A dispute is the instrument of the party who is OWED, and on this platform
 * that is always the PLAYER. It is available on BOTH directions — a buy the
 * merchant will not confirm, and a sell whose money never arrived — and from
 * BOTH states a player can be wronged in: `PAID` and `COMPLETED`.
 *
 * A MERCHANT has no dispute. What they may assert is that a transaction
 * FAILED, and they have three ways of saying so: decline before payment,
 * reject with proof after the player claims to have paid, and red-flag an order
 * that looks fraudulent or cannot be processed.
 *
 * ── Why this file exists ────────────────────────────────────────────────────
 * The routes had it backwards. The player route refused anything that was not
 * `PAID` — so a defect that moved an order to `COMPLETED` without paying them
 * ALSO removed their only recourse — while the merchant had a full dispute
 * route admitting `PROCESSING`, `PAID` and `COMPLETED`, letting one side park a
 * settled order in the admin queue on their own say-so.
 *
 * `ALLOWED_FROM` was right the whole time: it admits DISPUTED from those three
 * states and its comment says "that is precisely when disputes happen". The
 * rule table describes the TRANSITION; who may ask for it is a route's job, and
 * that is what these tests pin.
 *
 * ── The orders are real ones ─────────────────────────────────────────────────
 * Every order below is made the way production makes it (§32 S16): routed to a
 * member of a working team (PROJECT_STATUS §3.10, 2c), accepted by that member
 * on their own route, marked paid by the player or confirmed by the member,
 * and — for a completed sell — settled by the hold worker. A PAID order with
 * nobody serving it is a row the platform cannot produce, and a dispute rule
 * proven against one says nothing about the orders players actually hold.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pgConfigured, applySchema, closePg, withTransaction } from '#db/client.js';
import { createOrderRecord, getOrderRecord, setOrderFields } from '#db/repositories/orders.record.js';
import { updateUser } from '#db/repositories/users.js';
import { setCashReady } from '#db/repositories/teamRouting.js';
import { creditWinnings } from '../../domains/wallet/walletAuthority.service.js';
import {
  tryAssignMerchant, markOrderPaid, createWithdrawalOrder,
} from '../../domains/payment/paymentProcessing.service.js';
import { settleHold } from '../../domains/payment/withdrawalHold.service.js';
import { teamFixture, readyToPay } from '../teamFixture.js';
import { mountRouter, actor, merchantActor, as } from './_harness.js';

// Every sell is paid by bank transfer, so the member gives its UTR (2d).
let payoutSeq = 0;
const payoutUtr = () => `UTRDO${String(Date.now()).slice(-7)}${String(++payoutSeq).padStart(4, '0')}`;

const describePg = pgConfigured() ? describe : describe.skip;

describePg('a dispute belongs to the player', () => {
  let playerApp, merchantApp;
  const RUN = Math.random().toString(36).slice(2, 8);
  let seq = 0;
  const teams = teamFixture();
  const made = [];

  beforeAll(async () => {
    await applySchema();
    playerApp = mountRouter((await import('../../domains/payment/payment.routes.js')).default);
    merchantApp = mountRouter((await import('../../domains/merchant/merchant.routes.js')).default);
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

  /**
   * An order in a given state, owned by `who`, served by a member of a working
   * CASH team (1,000 tokens is the CASH rail, and a cash denomination).
   *
   * A PAID order's `paidAt` is pushed into the past, because the player route
   * holds a PAID order for ten minutes before it will accept a dispute — a
   * policy about elapsed time, not about the state. A completed sell has its
   * hold window put behind it the same way, and is then settled by the worker.
   */
  const orderIn = async (state, { type = 'DEPOSIT', owner = null, paidMinutesAgo = 30 } = {}) => {
    seq += 1;
    const who = owner || await actor({});
    const merchant = await merchantActor({});
    await teams.workingTeam({ rail: 'CASH', poolTokens: type === 'DEPOSIT' ? 10_000 : 0, include: [merchant.merchantId] });

    let orderId;
    if (type === 'DEPOSIT') {
      // A CASH buy goes only to a member who has said they are at the machine.
      expect(await setCashReady(merchant.merchantId, true)).toEqual({ ok: true, ready: true });
      orderId = `DSP-${RUN}-${seq}`;
      made.push(orderId);
      const order = await createOrderRecord({
        orderId, userId: who.userId, type,
        tokenAmountRupees: 1000, fiatAmountRupees: 1000,
        currency: 'INR', rateUsed: 1, merchantProfit: 0,
        depositAllocation: 900, reserveAllocation: 100,
      });
      expect(await tryAssignMerchant(order), 'team routing did not take the buy').toBe(true);
    } else {
      await updateUser(who.userId, {
        bankDetails: { accountNumber: '000111222333', ifscCode: 'TEST0000001', bankName: 'Test Bank', accountHolderName: 'Route Test' },
      });
      await creditWinnings(who.userId, 1000, 'route test seed', 'Test', `seed-${RUN}-${seq}`, `rt_seed_${RUN}_${seq}`);
      ({ orderId } = (await createWithdrawalOrder(who.userId, 1000)).order);
      made.push(orderId);
    }
    expect((await getOrderRecord(orderId)).merchantId, 'routed to somebody else').toBe(merchant.merchantId);

    // The member takes it on their own route.
    const accepted = await as(merchantApp, merchant).post(`/accept/${orderId}`);
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);

    if (state !== 'PROCESSING') {
      if (type === 'DEPOSIT') {
        await readyToPay(orderId);
        await markOrderPaid(who.userId, orderId, `UTRDSP${RUN}${Date.now()}${seq}`);
      } else {
        // The member says they paid the player: PAID, the team's credit HELD.
        const confirmed = await as(merchantApp, merchant).post(`/confirm/${orderId}`).send({ utrNumber: payoutUtr() });
        expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
      }
    }
    if (state === 'COMPLETED') {
      if (type === 'DEPOSIT') {
        // The member confirms the money arrived: the pool's hold is spent.
        const confirmed = await as(merchantApp, merchant).post(`/confirm/${orderId}`);
        expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
      } else {
        // The hold window passes and the worker settles it.
        await setOrderFields(orderId, { merchantCreditHoldUntil: new Date(Date.now() - 60_000) });
        expect(await settleHold(orderId)).toBe(true);
      }
    }
    if (state === 'PAID' && paidMinutesAgo) {
      await setOrderFields(orderId, { paidAt: new Date(Date.now() - paidMinutesAgo * 60 * 1000) });
    }
    expect((await getOrderRecord(orderId)).state).toBe(state);
    return { orderId, who, merchant };
  };

  const dispute = (who, orderId) =>
    as(playerApp, who).post(`/order/${orderId}/dispute`).send({ reason: 'The money never arrived on my side.' });

  describe('the player may dispute', () => {
    it('a PAID buy — the member is not confirming', async () => {
      const { orderId, who } = await orderIn('PAID', { type: 'DEPOSIT' });
      expect((await dispute(who, orderId)).status).toBe(200);
      expect((await getOrderRecord(orderId)).state).toBe('DISPUTED');
    });

    it('a PAID sell — they are owed the payout', async () => {
      const { orderId, who } = await orderIn('PAID', { type: 'WITHDRAWAL' });
      expect((await dispute(who, orderId)).status).toBe(200);
      expect((await getOrderRecord(orderId)).state).toBe('DISPUTED');
    });

    it('a COMPLETED buy — the order says it finished and it did not', async () => {
      // The case the old rule refused, and the one that matters most: an order
      // reading COMPLETED is the shape a player has no other way to challenge.
      const { orderId, who } = await orderIn('COMPLETED', { type: 'DEPOSIT' });
      const res = await dispute(who, orderId);
      expect(res.status, res.body?.message).toBe(200);
      expect((await getOrderRecord(orderId)).state).toBe('DISPUTED');
    });

    it('a COMPLETED sell', async () => {
      const { orderId, who } = await orderIn('COMPLETED', { type: 'WITHDRAWAL' });
      expect((await dispute(who, orderId)).status).toBe(200);
      expect((await getOrderRecord(orderId)).state).toBe('DISPUTED');
    });

    it('with no ten-minute wait on a COMPLETED order', async () => {
      // The wait exists so a player does not dispute a deposit the member is
      // still working. A COMPLETED order has had its outcome declared, so there
      // is nothing left to wait for — and making somebody wait to report that a
      // finished order did not pay them is the window a defect hides in. This
      // one was paid and confirmed moments ago.
      const { orderId, who } = await orderIn('COMPLETED', { type: 'DEPOSIT' });
      const paidAt = new Date((await getOrderRecord(orderId)).paidAt).getTime();
      expect(Date.now() - paidAt, 'the fixture is not fresh').toBeLessThan(10 * 60 * 1000);
      expect((await dispute(who, orderId)).status).toBe(200);
    });
  });

  describe('the player may NOT dispute', () => {
    it('an order that has not been paid yet', async () => {
      // Nothing has been asserted, so there is nothing to be wronged about.
      const { orderId, who } = await orderIn('PROCESSING');
      const res = await dispute(who, orderId);
      expect(res.status).toBe(400);
      // The refusal names the states, because "cannot dispute" alone sends a
      // player to support to ask which ones they are.
      expect(res.body.message).toMatch(/paid or completed/i);
      expect((await getOrderRecord(orderId)).state).toBe('PROCESSING');
    });

    it('a PAID buy inside the ten minutes the member has to confirm it', async () => {
      // The opposite of the COMPLETED case above: on a PAID order the wait is
      // the rule, and it is refused by name rather than silently.
      const { orderId, who } = await orderIn('PAID', { type: 'DEPOSIT', paidMinutesAgo: 0 });
      const res = await dispute(who, orderId);
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/10 minutes/);
      expect((await getOrderRecord(orderId)).state).toBe('PAID');
    });

    it('somebody else\'s order', async () => {
      const { orderId } = await orderIn('PAID');
      const stranger = await actor({});
      expect([403, 404]).toContain((await dispute(stranger, orderId)).status);
      expect((await getOrderRecord(orderId)).state).toBe('PAID');
    });
  });

  describe('the merchant has no dispute at all', () => {
    it('the route is gone, in every shape it was ever called', async () => {
      const { orderId, merchant: m } = await orderIn('PAID');

      for (const path of [`/order/${orderId}/dispute`, `/orders/${orderId}/dispute`]) {
        const res = await as(merchantApp, m).post(path).send({ reason: 'I want this reviewed' });
        expect(res.status, `${path} still answers`).toBe(404);
      }
      // And the order did not move.
      expect((await getOrderRecord(orderId)).state).toBe('PAID');
    });

    it('but they CAN red-flag one, which is their escalation', async () => {
      // Not a dispute — a fraud report. The merchant is not claiming they are
      // owed; they are saying this order should not be settled by anybody until
      // somebody looks at it.
      const { orderId, merchant: m } = await orderIn('PAID');

      const res = await as(merchantApp, m).post(`/orders/${orderId}/red-flag`)
        .send({ reason: 'Third-party account details on this transfer' });
      expect(res.status, res.body?.message).toBe(200);

      const row = await getOrderRecord(orderId);
      expect(row.redFlagged).toBe(true);
      expect(row.state).toBe('DISPUTED');
    });
  });
});
