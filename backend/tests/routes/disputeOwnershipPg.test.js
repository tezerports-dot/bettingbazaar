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
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pgConfigured, applySchema, closePg } from '#db/client.js';
import { createOrderRecord, getOrderRecord } from '#db/repositories/orders.record.js';
import { mountRouter, actor, merchantActor, as } from './_harness.js';

const describePg = pgConfigured() ? describe : describe.skip;

describePg('a dispute belongs to the player', () => {
  let playerApp, merchantApp;
  const RUN = Math.random().toString(36).slice(2, 8);
  let seq = 0;

  beforeAll(async () => {
    await applySchema();
    playerApp = mountRouter((await import('../../domains/payment/payment.routes.js')).default);
    merchantApp = mountRouter((await import('../../domains/merchant/merchant.routes.js')).default);
  }, 60_000);

  afterAll(async () => { await closePg(); });

  /**
   * An order in a given state, owned by `who`. `paidAt` is pushed into the past
   * because the player route holds a PAID order for ten minutes before it will
   * accept a dispute — a policy about elapsed time, not about the state.
   */
  const orderIn = async (state, { type = 'DEPOSIT', merchantId = null, owner = null } = {}) => {
    seq += 1;
    const who = owner || await actor({});
    const orderId = `DSP-${RUN}-${seq}`;
    await createOrderRecord({
      orderId, userId: who.userId, type,
      tokenAmountRupees: 1000, fiatAmountRupees: 1000, state,
      depositAllocation: 900, reserveAllocation: 100,
      ...(merchantId ? { merchantId } : {}),
      paidAt: new Date(Date.now() - 30 * 60 * 1000),
    });
    return { orderId, who };
  };

  const dispute = (who, orderId) =>
    as(playerApp, who).post(`/order/${orderId}/dispute`).send({ reason: 'The money never arrived on my side.' });

  describe('the player may dispute', () => {
    it('a PAID buy — the merchant is not confirming', async () => {
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
      // The wait exists so a player does not dispute a deposit the merchant is
      // still working. A COMPLETED order has had its outcome declared, so there
      // is nothing left to wait for — and making somebody wait to report that a
      // finished order did not pay them is the window a defect hides in.
      seq += 1;
      const who = await actor({});
      const orderId = `DSP-${RUN}-fresh-${seq}`;
      await createOrderRecord({
        orderId, userId: who.userId, type: 'DEPOSIT',
        tokenAmountRupees: 1000, fiatAmountRupees: 1000, state: 'COMPLETED',
        depositAllocation: 900, reserveAllocation: 100,
        paidAt: new Date(),
      });
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
    });

    it('somebody else\'s order', async () => {
      const { orderId } = await orderIn('PAID');
      const stranger = await actor({});
      expect([403, 404]).toContain((await dispute(stranger, orderId)).status);
    });
  });

  describe('the merchant has no dispute at all', () => {
    it('the route is gone, in every shape it was ever called', async () => {
      const m = await merchantActor({ tokensRupees: 5000 });
      const { orderId } = await orderIn('PAID', { merchantId: m.merchantId });

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
      const m = await merchantActor({ tokensRupees: 5000 });
      const { orderId } = await orderIn('PAID', { merchantId: m.merchantId });

      const res = await as(merchantApp, m).post(`/orders/${orderId}/red-flag`)
        .send({ reason: 'Third-party account details on this transfer' });
      expect(res.status, res.body?.message).toBe(200);

      const row = await getOrderRecord(orderId);
      expect(row.redFlagged).toBe(true);
      expect(row.state).toBe('DISPUTED');
    });
  });
});
