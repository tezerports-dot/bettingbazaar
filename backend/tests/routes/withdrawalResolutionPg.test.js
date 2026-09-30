// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Every way an admin ends a withdrawal, in every state its money can be in.
 *
 * ── Why a matrix ───────────────────────────────────────────────────────────
 * A withdrawal's money is in one of two positions when an admin decides it:
 *
 *   NOT YET CONFIRMED   the player's stake is LOCKED; no settlement exists
 *                       (PENDING_QUEUE / ASSIGNED / PROCESSING, or DISPUTED
 *                       from PROCESSING)
 *   HELD                the merchant asserted payment; the stake is still
 *                       LOCKED and a WITHDRAWAL settlement is RESERVED — the
 *                       merchant's `settlement` pocket shows what they will
 *                       be owed (PAID, or DISPUTED from PAID)
 *
 * and three routes decide it: the admin queue action, the Payment Control
 * Centre resolve, and the Dispute Manager resolve. Each was written with ONE
 * of those positions in mind, so each was right for some and wrong for others:
 * a refund that credited winnings and left the lock standing (the wallet reads
 * double), a release that cleared a flag and moved nothing, a settlement left
 * RESERVED on an order that can no longer reach the sweep, a resolved dispute
 * written back into the dispute queue.
 *
 * So the assertion is the same for every cell — about MONEY, both sides:
 *
 *   REFUND   winnings +a, locked −a; the merchant is owed nothing and holds
 *            nothing for it; the order is CANCELLED
 *   RELEASE  locked −a (the stake left the platform); the merchant's
 *            `available` +a; nothing left in `settlement`; COMPLETED
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pgConfigured, applySchema, closePg } from '#db/client.js';
import { createOrderRecord, getOrderRecord, setOrderFields } from '#db/repositories/orders.record.js';
import { getBalancesPaise } from '#db/repositories/wallets.core.js';
import { getMerchantBalances } from '#db/repositories/merchantWallets.core.js';
import { openSettlement } from '#db/repositories/merchantSettlements.js';
import { getSystemConfig, applySystemConfig } from '#db/repositories/config.js';
import { creditWinnings, debitWinningsForWithdrawal } from '../../domains/wallet/walletAuthority.service.js';
import { mountRouter, actor, merchantActor, as } from './_harness.js';

const describePg = pgConfigured() ? describe : describe.skip;
const A = 100_000; // ₹1,000 in paise

describePg('ending a withdrawal, in every state its money can be in', () => {
  let adminApp;
  let disputeApp;
  let seq = 0;
  const oid = () => `wres-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}-${seq += 1}`;
  const admin = () => actor({ isAdmin: true });

  beforeAll(async () => {
    await applySchema();
    adminApp = mountRouter((await import('../../domains/payment/paymentOrder.routes.js')).default);
    disputeApp = mountRouter((await import('../../domains/disputes/disputeResolution.admin.routes.js')).default);
  }, 60_000);

  afterAll(async () => { await closePg(); });

  /**
   * A withdrawal whose stake is REALLY locked — by the same debit admission
   * uses — optionally HELD with its settlement RESERVED, as the merchant's
   * confirm leaves it when the hold window is on.
   */
  const sell = async ({ state, held = false }) => {
    const merchant = await merchantActor({ tokensRupees: 5_000 });
    const player = await actor({});
    const orderId = oid();
    await creditWinnings(player.userId, 1_000, 'resolution suite float', 'Test', orderId, `wres_${orderId}`);
    await debitWinningsForWithdrawal(player.userId, 1_000, orderId);
    await createOrderRecord({
      orderId, userId: player.userId, type: 'WITHDRAWAL',
      tokenAmountRupees: 1_000, fiatAmountRupees: 1_000, state,
      merchantId: merchant.merchantId,
      escrowLocked: true, escrowStatus: 'LOCKED', escrowAmount: 1_000,
    });
    if (held) {
      await setOrderFields(orderId, {
        merchantCreditStatus: 'HELD',
        merchantCreditHoldUntil: new Date(Date.now() + 60 * 60 * 1000),
      });
      const opened = await openSettlement({
        settlementId: `ms_${orderId}`, merchantId: merchant.merchantId, orderId,
        direction: 'WITHDRAWAL', amountPaise: A, reason: 'held by the merchant confirm',
      });
      expect(opened.ok, `could not open the settlement: ${opened.reason}`).toBe(true);
    }
    const bal = await getBalancesPaise(player.userId);
    expect(bal.lockedBalance, 'the fixture never locked a stake').toBe(A);
    return { merchant, player, orderId };
  };

  const snapshot = async ({ merchant, player }) => {
    const p = await getBalancesPaise(player.userId);
    const m = await getMerchantBalances(merchant.merchantId);
    return {
      winnings: p.winningsBalance, locked: p.lockedBalance,
      available: m.available, settlement: m.settlement, reserved: m.reserved,
    };
  };

  const expectRefunded = async (s, before) => {
    const after = await snapshot(s);
    expect(after.winnings - before.winnings, 'winnings not returned').toBe(A);
    expect(after.locked - before.locked, 'the lock was left standing').toBe(-A);
    expect(after.available, 'the merchant was paid for a refunded withdrawal').toBe(before.available);
    expect(after.settlement, 'the merchant is still shown as owed').toBe(0);
    expect((await getOrderRecord(s.orderId)).status).toBe('CANCELLED');
  };

  const expectReleased = async (s, before) => {
    const after = await snapshot(s);
    expect(after.locked - before.locked, 'the stake never left the player').toBe(-A);
    expect(after.winnings, 'the player was credited on a release').toBe(before.winnings);
    expect(after.available - before.available, 'the merchant was never paid').toBe(A);
    expect(after.settlement, 'the settlement was left RESERVED').toBe(0);
    expect((await getOrderRecord(s.orderId)).status).toBe('COMPLETED');
  };

  describe('the admin queue action', () => {
    it('APPROVE on a withdrawal the merchant has paid moves the stake to the merchant', async () => {
      // APPROVE completed the order and moved nothing: the stake stayed locked
      // for good and the merchant who paid the player was never credited.
      const s = await sell({ state: 'PROCESSING' });
      const before = await snapshot(s);
      const res = await as(adminApp, await admin())
        .post(`/payment-orders/${s.orderId}/action`).send({ action: 'APPROVE', reason: 'payout seen' });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      await expectReleased(s, before);
    });

    it('APPROVE on a HELD withdrawal settles it', async () => {
      const s = await sell({ state: 'PAID', held: true });
      const before = await snapshot(s);
      const res = await as(adminApp, await admin())
        .post(`/payment-orders/${s.orderId}/action`).send({ action: 'APPROVE', reason: 'payout seen' });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      await expectReleased(s, before);
    });

    it('CANCEL on a HELD withdrawal returns the stake and releases the settlement', async () => {
      const s = await sell({ state: 'PAID', held: true });
      const before = await snapshot(s);
      const res = await as(adminApp, await admin())
        .post(`/payment-orders/${s.orderId}/action`).send({ action: 'CANCEL', reason: 'merchant never paid' });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      await expectRefunded(s, before);
    });
  });

  describe('the Payment Control Centre', () => {
    it('refund, not yet confirmed', async () => {
      const s = await sell({ state: 'DISPUTED' });
      const before = await snapshot(s);
      const res = await as(adminApp, await admin())
        .post(`/payment-orders/${s.orderId}/resolve`).send({ resolution: 'refund', reason: 'no payout' });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      await expectRefunded(s, before);
    });

    it('refund, HELD', async () => {
      const s = await sell({ state: 'DISPUTED', held: true });
      const before = await snapshot(s);
      const res = await as(adminApp, await admin())
        .post(`/payment-orders/${s.orderId}/resolve`).send({ resolution: 'refund', reason: 'no payout' });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      await expectRefunded(s, before);
    });

    it('release, not yet confirmed', async () => {
      const s = await sell({ state: 'DISPUTED' });
      const before = await snapshot(s);
      const res = await as(adminApp, await admin())
        .post(`/payment-orders/${s.orderId}/resolve`).send({ resolution: 'release', reason: 'payout seen' });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      await expectReleased(s, before);
    });

    it('release, HELD', async () => {
      const s = await sell({ state: 'DISPUTED', held: true });
      const before = await snapshot(s);
      const res = await as(adminApp, await admin())
        .post(`/payment-orders/${s.orderId}/resolve`).send({ resolution: 'release', reason: 'payout seen' });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      await expectReleased(s, before);
    });
  });

  describe('the Dispute Manager', () => {
    it('cancel, not yet confirmed', async () => {
      const s = await sell({ state: 'DISPUTED' });
      const before = await snapshot(s);
      const res = await as(disputeApp, await admin())
        .post(`/dispute-orders/${s.orderId}/resolve`).send({ decision: 'CANCEL_ORDER', resolution: 'no payout' });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      await expectRefunded(s, before);
    });

    it('cancel, HELD', async () => {
      const s = await sell({ state: 'DISPUTED', held: true });
      const before = await snapshot(s);
      const res = await as(disputeApp, await admin())
        .post(`/dispute-orders/${s.orderId}/resolve`).send({ decision: 'CANCEL_ORDER', resolution: 'no payout' });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      await expectRefunded(s, before);
    });

    it('release to the merchant, not yet confirmed', async () => {
      const s = await sell({ state: 'DISPUTED' });
      const before = await snapshot(s);
      const res = await as(disputeApp, await admin())
        .post(`/dispute-orders/${s.orderId}/resolve`).send({ decision: 'RELEASE_TO_MERCHANT', resolution: 'payout seen' });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      await expectReleased(s, before);
    });

    it('release to the merchant, HELD', async () => {
      const s = await sell({ state: 'DISPUTED', held: true });
      const before = await snapshot(s);
      const res = await as(disputeApp, await admin())
        .post(`/dispute-orders/${s.orderId}/resolve`).send({ decision: 'RELEASE_TO_MERCHANT', resolution: 'payout seen' });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      await expectReleased(s, before);
    });
  });

  // ── The merchant's own confirm, with the hold switched off ───────────────
  // `withdrawalHoldMinutes` is admin-editable down to 0. That path completed the
  // order FIRST and then released the stake and credited the merchant — a write
  // after the commit. It now takes the held path with a window that is already
  // over and settles through `settleHold`, money before status.
  describe('the merchant confirm with the hold disabled', () => {
    let merchantApp;
    let restoreHold = null;
    beforeAll(async () => {
      merchantApp = mountRouter((await import('../../domains/merchant/merchant.routes.js')).default);
      restoreHold = (await getSystemConfig({ fresh: true }))?.withdrawalHoldMinutes ?? null;
      await applySystemConfig({ withdrawalHoldMinutes: 0 });
    }, 60_000);
    // Outside any assertion (trap 10): the config row is shared by every suite.
    afterAll(async () => {
      if (restoreHold !== null) await applySystemConfig({ withdrawalHoldMinutes: restoreHold });
    });

    it('settles both sides before the order reads COMPLETED', async () => {
      const s = await sell({ state: 'PROCESSING' });
      const before = await snapshot(s);
      const utr = `UTRZH${Date.now().toString().slice(-7)}${seq}`;
      const res = await as(merchantApp, s.merchant).post(`/confirm/${s.orderId}`).send({ utrNumber: utr });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      await expectReleased(s, before);
      expect((await getOrderRecord(s.orderId)).merchantCreditStatus).toBe('RELEASED');
    });
  });
});
