// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * A confirmed buy moves the tokens ONCE: what the merchant loses is exactly what
 * the player gains.
 *
 * ── Why this suite measures the TOTAL, not a pocket ────────────────────────
 * A merchant's tokens live in three pockets — `available`, `reserved` (held for
 * buy orders they were given) and `settlement` (owed to them on withdrawals) —
 * and a buy moves them twice over its life: `available → reserved` when the
 * order becomes theirs, and `reserved → (the player)` when it completes.
 *
 * `depositConfirmReachablePg` asserted each pocket separately, both measured
 * AFTER the hold: available down by the order AND reserved down by the order.
 * Each line reads as a correct statement about one pocket. Together they say
 * the merchant paid TWICE — once when the hold was dispensed and once when
 * `moveDepositMoney` debited `available` as if no hold existed — and the suite
 * was green. So this measures the only figure that cannot be argued with: the
 * merchant's total, against the player's total, across the whole life of the
 * order.
 *
 * The second half is the consequence nobody would see until it happened: a
 * merchant whose tokens are all held for this one order has nothing left in
 * `available`, so the second charge is REFUSED — after the hold has already
 * been spent — and they can never confirm a deposit they were paid for.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pgConfigured, applySchema, closePg } from '#db/client.js';
import { createOrderRecord, getOrderRecord } from '#db/repositories/orders.record.js';
import { updateMerchant } from '#db/repositories/merchants.js';
import { getMerchantBalances } from '#db/repositories/merchantWallets.core.js';
import { getBalances } from '../../domains/wallet/walletAuthority.service.js';
import { holdForOrder } from '../../domains/merchant/depositEscrow.service.js';
import { mountRouter, actor, merchantActor, as } from './_harness.js';

const describePg = pgConfigured() ? describe : describe.skip;

/**
 * Every token the merchant holds, in paise — all three pockets.
 *
 * The keys are the POCKET names (`available`, `reserved`, `settlement`). A read
 * of `availablePaise` is `undefined`, `Number(undefined)` is NaN, and vitest's
 * `toBe` is `Object.is`, under which NaN EQUALS NaN — so an assertion built on
 * the wrong key passes for any value at all. That is exactly how the double
 * charge stayed green in `depositConfirmReachablePg`. Hence the guard below: a
 * total that is not a finite number is a broken measurement, not a result.
 */
const merchantTotal = async (merchantId) => {
  const b = await getMerchantBalances(merchantId);
  const total = b.available + b.reserved + b.settlement;
  if (!Number.isFinite(total)) throw new Error(`merchant pockets unreadable: ${JSON.stringify(b)}`);
  return total;
};

/** Every token the player holds from a buy — the two pockets a deposit splits into. */
const playerCredited = async (userId) => {
  const w = await getBalances(userId);
  return Math.round((Number(w.depositBalance) + Number(w.reserveBalance)) * 100);
};

describePg('a confirmed buy moves the tokens once', () => {
  let app;
  let seq = 0;
  const oid = () => `dcc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}-${seq += 1}`;
  const nextUtr = () => String(420000000000 + (seq * 7919) + Math.floor(Math.random() * 7000));

  beforeAll(async () => {
    await applySchema();
    app = mountRouter((await import('../../domains/merchant/merchant.routes.js')).default);
  }, 60_000);

  afterAll(async () => { await closePg(); });

  /** A PAID buy, held against its merchant exactly as assignment holds it. */
  const heldPaidBuy = async ({ merchantTokens, orderTokens }) => {
    const merchant = await merchantActor({ tokensRupees: merchantTokens });
    await updateMerchant(merchant.merchantId, {
      isOnline: true, acceptsDeposits: true,
      maxConcurrentDepositOrders: 10, maxConcurrentWithdrawalOrders: 10,
    });
    const player = await actor({});
    const orderId = oid();
    await createOrderRecord({
      orderId, userId: player.userId, type: 'DEPOSIT',
      tokenAmountRupees: orderTokens, fiatAmountRupees: orderTokens,
      state: 'PAID', merchantId: merchant.merchantId, utrNumber: nextUtr(),
    });
    const held = await holdForOrder(await getOrderRecord(orderId), merchant.merchantId);
    expect(held.ok, `could not hold: ${held.reason}`).toBe(true);
    return { merchant, player, orderId };
  };

  it('the merchant loses exactly what the player gains', async () => {
    const { merchant, player, orderId } = await heldPaidBuy({ merchantTokens: 50_000, orderTokens: 1_000 });
    // Measured AFTER the hold: the hold moves tokens between the merchant's own
    // pockets and changes nothing about how many they hold.
    const merchantBefore = await merchantTotal(merchant.merchantId);
    const playerBefore = await playerCredited(player.userId);

    const res = await as(app, merchant).post(`/confirm/${orderId}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await getOrderRecord(orderId)).status).toBe('COMPLETED');

    const lost = merchantBefore - await merchantTotal(merchant.merchantId);
    const gained = await playerCredited(player.userId) - playerBefore;
    expect(gained).toBe(1_000 * 100);
    expect(lost, 'the merchant paid more than the player received').toBe(gained);
  });

  it('a merchant whose tokens are all held for this order can still confirm it', async () => {
    // Exactly enough for the one order: after the hold, `available` is empty
    // and every token they own is reserved for THIS player.
    const { merchant, player, orderId } = await heldPaidBuy({ merchantTokens: 1_000, orderTokens: 1_000 });

    const res = await as(app, merchant).post(`/confirm/${orderId}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await getOrderRecord(orderId)).status).toBe('COMPLETED');
    expect(await playerCredited(player.userId)).toBe(1_000 * 100);
    expect(await merchantTotal(merchant.merchantId)).toBe(0);
  });

  it('a retried confirm after the hold was spent charges nothing more', async () => {
    // The case `alreadyTaken` exists for: the hold is spent, then something
    // after it fails and the merchant presses confirm again. Reading "no live
    // hold" as "never held" would take the tokens a second time from `available`.
    const { merchant, player, orderId } = await heldPaidBuy({ merchantTokens: 50_000, orderTokens: 1_000 });
    const { dispenseForOrder } = await import('../../domains/merchant/depositEscrow.service.js');
    expect((await dispenseForOrder(await getOrderRecord(orderId))).taken).toBe(true);
    const merchantBefore = await merchantTotal(merchant.merchantId);

    const res = await as(app, merchant).post(`/confirm/${orderId}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await merchantTotal(merchant.merchantId)).toBe(merchantBefore);
    expect(await playerCredited(player.userId)).toBe(1_000 * 100);
  });

  // ── The four other doors that complete a buy ─────────────────────────────
  // None of them dispensed the hold. They debited `available` beside it, so the
  // merchant was charged twice until the stranded-hold sweep gave the hold back
  // fifteen minutes later — and the two without an overdraft REFUSED a merchant
  // whose tokens were all held for the very order being completed.
  describe('the admin and dispute doors take the tokens once, from the hold', () => {
    let adminApp;
    let disputeApp;
    beforeAll(async () => {
      adminApp = mountRouter((await import('../../domains/payment/paymentOrder.routes.js')).default);
      disputeApp = mountRouter((await import('../../domains/disputes/disputeResolution.admin.routes.js')).default);
    }, 60_000);

    const admin = () => actor({ isAdmin: true });

    /** Held against a merchant who owns exactly this order's tokens and nothing else. */
    const fullyHeld = async (state) => {
      const merchant = await merchantActor({ tokensRupees: 1_000 });
      const player = await actor({});
      const orderId = oid();
      await createOrderRecord({
        orderId, userId: player.userId, type: 'DEPOSIT',
        tokenAmountRupees: 1_000, fiatAmountRupees: 1_000,
        state, merchantId: merchant.merchantId, utrNumber: nextUtr(),
      });
      const held = await holdForOrder(await getOrderRecord(orderId), merchant.merchantId);
      expect(held.ok, `could not hold: ${held.reason}`).toBe(true);
      return { merchant, player, orderId };
    };

    const expectPaidOnce = async ({ merchant, player }) => {
      expect(await playerCredited(player.userId)).toBe(1_000 * 100);
      // Everything the merchant had went to the player, and not a token more:
      // not negative (a second charge on overdraft), not still reserved.
      expect(await merchantTotal(merchant.merchantId)).toBe(0);
    };

    it('an admin approval', async () => {
      const buy = await fullyHeld('PAID');
      const res = await as(adminApp, await admin())
        .post(`/payment-orders/${buy.orderId}/action`).send({ action: 'APPROVE', reason: 'paid' });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      await expectPaidOnce(buy);
    });

    it('a Payment Control Centre release', async () => {
      const buy = await fullyHeld('DISPUTED');
      const res = await as(adminApp, await admin())
        .post(`/payment-orders/${buy.orderId}/resolve`).send({ resolution: 'release', reason: 'payment seen' });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      await expectPaidOnce(buy);
    });

    it('a Dispute Manager release to the player', async () => {
      const buy = await fullyHeld('DISPUTED');
      const res = await as(disputeApp, await admin())
        .post(`/dispute-orders/${buy.orderId}/resolve`).send({ decision: 'RELEASE_TO_USER', resolution: 'payment seen' });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      await expectPaidOnce(buy);
    });
  });
});
