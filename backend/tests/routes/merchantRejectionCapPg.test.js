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
import { setOrderFields } from '#db/repositories/orders.record.js';
import { expireOrders } from '../../domains/payment/paymentProcessing.service.js';
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

  /**
   * An ASSIGNED **sell** this merchant is expected to pay out.
   *
   * The direction matters to the cap now: a sell that lapses is the merchant
   * failing to pay the player, which is theirs; a buy that lapses is the player
   * failing to pay, which is not.
   */
  const assignedSell = async (merchantId, owner = null) => {
    seq += 1;
    const who = owner || await actor({});
    const orderId = `REJ-${RUN}-w${seq}`;
    await createOrderRecord({
      orderId, userId: who.userId, type: 'WITHDRAWAL',
      tokenAmountRupees: 500, fiatAmountRupees: 500, state: 'ASSIGNED',
      merchantId,
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

  describe('an EXPIRED SELL counts exactly the same as pressing reject', () => {
    /**
     * The hole the first version of this cap had, and the over-correction that
     * followed it.
     *
     * A merchant who never presses reject and simply lets the window close has
     * refused the order in every way that matters — and the streak did not
     * move, so they refused without limit. Counting only the button penalises
     * the merchant who tells you. That was the hole, and it was closed.
     *
     * Closing it by counting EVERY expiry then charged the wrong party. A BUY
     * order expires at ASSIGNED or PROCESSING because **the player never
     * paid** — the merchant was standing by, did nothing wrong, and took a
     * strike for it. Three players who changed their minds and an honest
     * merchant was suspended.
     *
     * So the direction decides. These cases are all SELL orders, where the
     * merchant had the order and did not pay the player. The buy side is in
     * `playerPaymentFailurePg.test.js`, which asserts the opposite: the streak
     * must NOT move.
     */
    const expired = async (merchantId, owner = null) => {
      const { orderId, who } = await assignedSell(merchantId, owner);
      // The deadline in the past is what makes the sweep consider it due. It is
      // set separately because `createOrderRecord` fills `expiresAt` from the
      // assignment window, not from the caller.
      await setOrderFields(orderId, { expiresAt: new Date(Date.now() - 60 * 1000) });
      return { orderId, who };
    };

    it('advances the streak', async () => {
      const m = await onlineMerchant();
      await expired(m.merchantId);
      await expireOrders();
      expect((await getMerchant(m.merchantId)).consecutiveRejections).toBe(1);
    });

    it('bars the pair, so the order cannot come back to them', async () => {
      const m = await onlineMerchant();
      const { orderId, who } = await expired(m.merchantId);
      await expireOrders();

      const barred = await merchantsBarredFrom({ orderId, userId: who.userId });
      expect(barred, 'an expiry left the merchant eligible for the same order').toContain(m.merchantId);
    });

    it('reaches the cap by expiry ALONE — the bypass is closed', async () => {
      // Three lapses, no button ever pressed.
      const m = await onlineMerchant();
      for (let i = 0; i < 3; i += 1) {
        await expired(m.merchantId);
        await expireOrders();
      }
      expect((await getMerchant(m.merchantId)).status).toBe('SUSPENDED');
    });

    it('MIXES with rejections, because they are the same event', async () => {
      // Two lapses and one decline is still three refusals in a row. A cap that
      // counted them in separate buckets would let a merchant alternate and
      // never reach either.
      const m = await onlineMerchant();
      await expired(m.merchantId);
      await expireOrders();
      await expired(m.merchantId);
      await expireOrders();
      expect((await getMerchant(m.merchantId)).status).toBe('ACTIVE');

      const third = await assigned(m.merchantId);
      await reject(m, third.orderId);
      expect((await getMerchant(m.merchantId)).status).toBe('SUSPENDED');
    });

    it('an order nobody held does not blame anybody', async () => {
      // PENDING_QUEUE orders reach the same sweep and have no merchant. A
      // refusal recorded against a null merchant would be a row nothing can
      // read, and a streak advanced on nobody.
      seq += 1;
      const who = await actor({});
      const orderId = `REJ-${RUN}-unheld-${seq}`;
      await createOrderRecord({
        orderId, userId: who.userId, type: 'DEPOSIT',
        tokenAmountRupees: 500, fiatAmountRupees: 500, state: 'PENDING_QUEUE',
        depositAllocation: 450, reserveAllocation: 50,
      });
      await setOrderFields(orderId, { expiresAt: new Date(Date.now() - 60 * 1000) });

      await expect(expireOrders()).resolves.toBeGreaterThanOrEqual(0);
      expect(await merchantsBarredFrom({ orderId })).toHaveLength(0);
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
