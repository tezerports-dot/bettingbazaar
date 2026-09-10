// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * What a merchant refusing orders costs them, and who the order goes to next.
 *
 * ── The two rules ───────────────────────────────────────────────────────────
 * 1. THREE CONSECUTIVE rejections and the merchant is suspended. Consecutive,
 *    not lifetime: any completed order resets the streak, so an ordinary
 *    merchant who occasionally declines never approaches it. A lifetime
 *    allowance of three would catch every honest merchant eventually, which is
 *    the failure mode that makes an operator switch a control off.
 * 2. A merchant who refuses an order never sees it again, and never sees
 *    another order from that PLAYER. Without the first half the reject route
 *    requeues and immediately reassigns, and can hand the order straight back
 *    to the merchant who just declined.
 *
 * ── Why the record is a table ───────────────────────────────────────────────
 * `order_states.rejected_by` is one column and is overwritten, so once a second
 * merchant declines the same order the first has vanished. Neither rule can be
 * answered from the order; both are answered from `order_rejections`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pgConfigured, applySchema, closePg, pgQuery } from '#db/client.js';
import { createOrderRecord, getOrderRecord, merchantsBarredFrom } from '#db/repositories/orders.record.js';
import { getMerchant, assignmentCandidates, updateMerchant } from '#db/repositories/merchants.js';
import { mountRouter, actor, merchantActor, as } from './_harness.js';

const describePg = pgConfigured() ? describe : describe.skip;

describePg('a merchant who keeps refusing', () => {
  let app;
  const RUN = Math.random().toString(36).slice(2, 8);
  let seq = 0;

  beforeAll(async () => {
    await applySchema();
    app = mountRouter((await import('../../domains/merchant/merchant.routes.js')).default);
  }, 60_000);

  afterAll(async () => { await closePg(); });

  /** An ASSIGNED deposit this merchant can decline. */
  const assigned = async (merchantId, owner = null) => {
    seq += 1;
    const who = owner || await actor({});
    const orderId = `REJ-${RUN}-${seq}`;
    await createOrderRecord({
      orderId, userId: who.userId, type: 'DEPOSIT',
      tokenAmountRupees: 500, fiatAmountRupees: 500, state: 'ASSIGNED',
      depositAllocation: 450, reserveAllocation: 50, merchantId,
    });
    return { orderId, who };
  };

  const reject = (m, orderId, reason = 'Cannot serve this right now') =>
    as(app, m).post(`/reject/${orderId}`).send({ reason });

  /**
   * A merchant the candidate query will actually return.
   *
   * `merchantActor` leaves `is_online` at its schema default of FALSE, so a
   * merchant from it is never a candidate — and a test asserting "the exclusion
   * removed them" would pass against a list they were never in. Bringing them
   * online first is what makes the before/after comparison mean something.
   */
  const onlineMerchant = async () => {
    const m = await merchantActor({ tokensRupees: 50_000 });
    await updateMerchant(m.merchantId, { isOnline: true });
    return m;
  };

  const isCandidate = async (merchantId) => {
    const rows = await assignmentCandidates({ currency: 'INR', direction: 'DEPOSIT', limit: 500 });
    return rows.some((c) => c.merchantId === merchantId);
  };

  describe('the cap', () => {
    it('suspends on the THIRD consecutive rejection, and not before', async () => {
      const m = await merchantActor({ tokensRupees: 50_000 });

      for (const n of [1, 2]) {
        const { orderId } = await assigned(m.merchantId);
        expect((await reject(m, orderId)).status, `reject ${n}`).toBe(200);
        const row = await getMerchant(m.merchantId);
        expect(row.consecutiveRejections ?? n, `streak after ${n}`).toBe(n);
        expect(row.status, `suspended too early, after ${n}`).toBe('ACTIVE');
      }

      const third = await assigned(m.merchantId);
      expect((await reject(m, third.orderId)).status).toBe(200);
      expect((await getMerchant(m.merchantId)).status).toBe('SUSPENDED');
    });

    it('a suspended merchant is no longer a candidate for anything', async () => {
      // Suspension is a refusal to ASSIGN, not a deletion — the merchant keeps
      // the orders they already hold, because taking those away would strand
      // players who are mid-payment on them.
      const m = await onlineMerchant();
      expect(await isCandidate(m.merchantId), 'not a candidate even before rejecting').toBe(true);

      for (let i = 0; i < 3; i += 1) {
        const { orderId } = await assigned(m.merchantId);
        await reject(m, orderId);
      }
      expect(await isCandidate(m.merchantId)).toBe(false);
    });

    it('a COMPLETED order resets the streak, so the cap is consecutive not lifetime', async () => {
      const m = await merchantActor({ tokensRupees: 50_000 });
      const { orderId: a } = await assigned(m.merchantId);
      const { orderId: b } = await assigned(m.merchantId);
      await reject(m, a);
      await reject(m, b);
      expect((await getMerchant(m.merchantId)).consecutiveRejections).toBe(2);

      const { updateMerchantStatsOnComplete } =
        await import('../../domains/payment/paymentProcessing.service.js');
      await updateMerchantStatsOnComplete(m.merchantId, true, { direction: 'DEPOSIT', amountRupees: 500 });

      expect((await getMerchant(m.merchantId)).consecutiveRejections).toBe(0);

      // And a third rejection AFTER the reset is only the first of a new run.
      const { orderId: c } = await assigned(m.merchantId);
      await reject(m, c);
      const row = await getMerchant(m.merchantId);
      expect(row.consecutiveRejections).toBe(1);
      expect(row.status).toBe('ACTIVE');
    });
  });

  describe('who the order goes to next', () => {
    it('records the refusal against the order AND the player', async () => {
      const m = await merchantActor({ tokensRupees: 50_000 });
      const { orderId, who } = await assigned(m.merchantId);
      await reject(m, orderId);

      const { rows } = await pgQuery(
        'SELECT merchant_id, user_id FROM order_rejections WHERE order_id = $1', [orderId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].merchant_id).toBe(m.merchantId);
      expect(rows[0].user_id).toBe(who.userId);
    });

    it('bars that merchant from THIS order', async () => {
      const m = await merchantActor({ tokensRupees: 50_000 });
      const { orderId } = await assigned(m.merchantId);
      await reject(m, orderId);

      expect(await merchantsBarredFrom({ orderId })).toContain(m.merchantId);
      // And the order really was requeued rather than left with them.
      const row = await getOrderRecord(orderId);
      expect(row.merchantId ?? null).not.toBe(m.merchantId);
    });

    it('bars that merchant from the same PLAYER\'s other orders too', async () => {
      // The order they refused is not the only one they should stop seeing.
      const m = await merchantActor({ tokensRupees: 50_000 });
      const player = await actor({});
      const first = await assigned(m.merchantId, player);
      await reject(m, first.orderId);

      const second = await assigned(m.merchantId, player);
      const barred = await merchantsBarredFrom({ orderId: second.orderId, userId: player.userId });
      expect(barred, 'a refusal on one order did not bar the pair').toContain(m.merchantId);
    });

    it('leaves a DIFFERENT player untouched', async () => {
      // The bar is a pair, not a blacklist. A merchant who declined one
      // person's order must still serve everybody else.
      const m = await merchantActor({ tokensRupees: 50_000 });
      const declined = await actor({});
      const other = await actor({});
      const { orderId } = await assigned(m.merchantId, declined);
      await reject(m, orderId);

      const barred = await merchantsBarredFrom({ orderId: null, userId: other.userId });
      expect(barred).not.toContain(m.merchantId);
    });

    it('the exclusion is applied by the QUERY, not left to the caller', async () => {
      const m = await onlineMerchant();
      expect(await isCandidate(m.merchantId)).toBe(true);

      const filtered = await assignmentCandidates({
        currency: 'INR', direction: 'DEPOSIT', limit: 500, barredMerchantIds: [m.merchantId],
      });
      expect(filtered.map((c) => c.merchantId)).not.toContain(m.merchantId);
    });

    it('an empty bar list changes nothing', async () => {
      // The ordinary case must cost nothing and must not accidentally exclude
      // everybody — an `<> ALL('{}')` that was built wrong would.
      const m = await onlineMerchant();
      const none = await assignmentCandidates({
        currency: 'INR', direction: 'DEPOSIT', limit: 500, barredMerchantIds: [],
      });
      expect(none.map((c) => c.merchantId)).toContain(m.merchantId);
    });
  });
});
