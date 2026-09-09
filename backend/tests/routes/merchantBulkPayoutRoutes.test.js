// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * A bulk payout is N confirms, and has to behave like N confirms.
 *
 * ── What this route used to do ──────────────────────────────────────────────
 * One raw UPDATE straight to `state = 'COMPLETED'`, bypassing every guarantee
 * the single confirm provides:
 *
 *   the withdrawal HOLD was skipped, so the player's stake was consumed and the
 *   merchant's tokens released the moment the merchant said so — which is
 *   exactly the loss `withdrawalHold.service.js` exists to close, because a
 *   confirm is an assertion and not evidence;
 *
 *   no `order_transitions` row was written, so a batch of payouts left nothing
 *   in the append-only history a dispute is decided from;
 *
 *   the escrow flags were never touched, so the settlement worker would never
 *   pick these orders up. They read COMPLETED with the value still frozen on
 *   both sides — the player's money locked, the merchant's tokens never
 *   credited — and no check anywhere was looking for that combination.
 *
 * And the response read `result.modifiedCount`, a field the repository never
 * returned, so every batch reported `undefined` orders paid.
 *
 * ── What is asserted ────────────────────────────────────────────────────────
 * That a batch lands in the SAME state a single confirm produces, that the
 * transition history records it, that another merchant's order cannot be swept
 * into a batch, and that a second submission pays nothing twice.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { pgConfigured, applySchema, closePg, pgQuery } from '#db/client.js';
import { createOrderRecord, getOrderRecord } from '#db/repositories/orders.record.js';
import { applySystemConfig } from '#db/repositories/config.js';
import { mountRouter, actor, merchantActor, as } from './_harness.js';

const describePg = pgConfigured() ? describe : describe.skip;

// The feature flag, which defaults to OFF. The route's own guard has its own
// coverage; what is under test here is what the handler does once past it.
vi.mock('../../services/featureFlags.service.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, isEnabled: async () => true };
});

describePg('merchant bulk payouts', () => {
  let app;
  let seq = 0;
  const oid = () => `bp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}-${seq += 1}`;

  beforeAll(async () => {
    await applySchema();
    app = mountRouter((await import('../../domains/merchant/merchant.routes.js')).default);
  }, 60_000);

  afterAll(async () => { await closePg(); });

  /** The real hold window, driven through config rather than a mock. */
  const setHold = (minutes) => applySystemConfig({ withdrawalHoldMinutes: minutes }, { actor: 'test' });

  const withdrawal = async (merchant, player, state = 'PROCESSING') => {
    const orderId = oid();
    await createOrderRecord({
      orderId, userId: player.userId, type: 'WITHDRAWAL',
      tokenAmountRupees: 500, fiatAmountRupees: 500,
      state, merchantId: merchant.merchantId,
    });
    return orderId;
  };

  const transitionsFor = async (orderId) => {
    const { rows } = await pgQuery(
      'SELECT to_state FROM order_transitions WHERE order_id = $1 ORDER BY created_at', [orderId]);
    return rows.map((r) => r.to_state);
  };

  const markPaid = (merchant, orderIds, batchRef) =>
    as(app, merchant).post('/bulk-payouts/mark-paid').send({ orderIds, batchRef });

  describe('with a hold window configured', () => {
    it('leaves the batch ASSERTED, not settled', async () => {
      // PAID and escrow-locked is what a single confirm produces under a hold:
      // the merchant has said they sent the money and NO value has moved yet.
      // Straight to COMPLETED would release the player's stake on the
      // merchant's word alone.
      await setHold(60);
      const merchant = await merchantActor({});
      const player = await actor({});
      const a = await withdrawal(merchant, player);
      const b = await withdrawal(merchant, player);

      const res = await markPaid(merchant, [a, b], 'BATCH-1');
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.count).toBe(2);
      expect(res.body.held).toBe(true);

      for (const id of [a, b]) {
        const row = await getOrderRecord(id);
        expect(row.status, `order ${id}`).toBe('PAID');
        expect(row.escrowLocked).toBe(true);
        expect(row.merchantCreditStatus).toBe('HELD');
        // The worker needs a deadline to settle against; without one the order
        // is frozen for ever.
        expect(row.merchantCreditHoldUntil).toBeTruthy();
        expect(new Date(row.merchantCreditHoldUntil).getTime()).toBeGreaterThan(Date.now());
      }
    });

    it('records the batch on every order it closed', async () => {
      await setHold(60);
      const merchant = await merchantActor({});
      const player = await actor({});
      const id = await withdrawal(merchant, player);

      await markPaid(merchant, [id], 'BATCH-REF-9');
      const row = await getOrderRecord(id);
      expect(row.bulkPayoutBatch).toBe('BATCH-REF-9');
      expect(row.bulkPaidAt).toBeTruthy();
    });

    it('writes a transition, so the batch is in the history', async () => {
      // The raw UPDATE wrote none. A dispute is decided from this table.
      await setHold(60);
      const merchant = await merchantActor({});
      const player = await actor({});
      const id = await withdrawal(merchant, player);

      await markPaid(merchant, [id], 'BATCH-2');
      expect(await transitionsFor(id)).toContain('PAID');
    });
  });

  describe('with the hold disabled', () => {
    it('completes and releases the escrow in one step', async () => {
      // `withdrawalHoldMinutes: 0` is a real setting — settle on confirm. The
      // escrow flags must move WITH the state, or the order reads COMPLETED
      // while the money stays frozen.
      await setHold(0);
      const merchant = await merchantActor({});
      const player = await actor({});
      const id = await withdrawal(merchant, player);

      const res = await markPaid(merchant, [id], 'BATCH-3');
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.held).toBe(false);

      const row = await getOrderRecord(id);
      expect(row.status).toBe('COMPLETED');
      expect(row.escrowLocked).toBe(false);
      expect(row.merchantCreditStatus).toBe('RELEASED');
      expect(await transitionsFor(id)).toContain('COMPLETED');
    });
  });

  describe('what it refuses', () => {
    it("will not sweep another merchant's order into a batch", async () => {
      await setHold(60);
      const mine = await merchantActor({});
      const stranger = await merchantActor({});
      const player = await actor({});
      const theirs = await withdrawal(stranger, player);

      const res = await markPaid(mine, [theirs], 'BATCH-4');
      expect(res.status).toBe(200);
      expect(res.body.count).toBe(0);
      expect(res.body.skipped).toContain(theirs);
      // Untouched, and still theirs.
      expect((await getOrderRecord(theirs)).status).toBe('PROCESSING');
    });

    it('will not close a DEPOSIT through the withdrawal payout path', async () => {
      await setHold(60);
      const merchant = await merchantActor({});
      const player = await actor({});
      const orderId = oid();
      await createOrderRecord({
        orderId, userId: player.userId, type: 'DEPOSIT',
        tokenAmountRupees: 500, fiatAmountRupees: 500,
        state: 'PROCESSING', merchantId: merchant.merchantId,
      });

      const res = await markPaid(merchant, [orderId], 'BATCH-5');
      expect(res.body.count).toBe(0);
      expect(res.body.skipped).toContain(orderId);
      expect((await getOrderRecord(orderId)).status).toBe('PROCESSING');
    });

    it('pays nothing twice when the same batch is submitted again', async () => {
      // A merchant double-tapping, or a retry after a timeout. The transition
      // is the gate: the second pass matches no row and is reported as skipped
      // rather than counted again.
      await setHold(60);
      const merchant = await merchantActor({});
      const player = await actor({});
      const id = await withdrawal(merchant, player);

      expect((await markPaid(merchant, [id], 'BATCH-6')).body.count).toBe(1);
      const second = await markPaid(merchant, [id], 'BATCH-6');
      expect(second.body.count).toBe(0);
      expect(second.body.skipped).toContain(id);
    });

    it('reports a real number, not undefined', async () => {
      // `count` read `result.modifiedCount`, which the repository never
      // returned — every batch told the merchant `undefined` orders were paid.
      await setHold(60);
      const merchant = await merchantActor({});
      const player = await actor({});
      const id = await withdrawal(merchant, player);

      const res = await markPaid(merchant, [id], 'BATCH-7');
      expect(res.body.count).toBe(1);
      expect(res.body.message).toMatch(/^1 order\(s\) marked as paid\.$/);
    });

    it('closes the good orders and reports the rest', async () => {
      // Not one transaction across the batch, deliberately: these are
      // independent payouts and one bad order must not roll back nine good
      // ones.
      await setHold(60);
      const merchant = await merchantActor({});
      const player = await actor({});
      const good = await withdrawal(merchant, player);
      const alreadyDone = await withdrawal(merchant, player, 'COMPLETED');

      const res = await markPaid(merchant, [good, alreadyDone], 'BATCH-8');
      expect(res.body.count).toBe(1);
      expect(res.body.orderIds).toEqual([good]);
      expect(res.body.skipped).toContain(alreadyDone);
    });

    it('refuses an empty list', async () => {
      const merchant = await merchantActor({});
      expect((await markPaid(merchant, [], 'BATCH-9')).status).toBe(400);
    });
  });
});
