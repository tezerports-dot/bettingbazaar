// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * A merchant can actually release the tokens.
 *
 * ── What was wrong ──────────────────────────────────────────────────────────
 * `POST /api/merchant/confirm/:id` refused every deposit with "Payment proof
 * screenshot is required."
 *
 * Payment-proof COLLECTION had been removed platform-wide, deliberately and for
 * good reasons: the presign route was deleted, `mark-paid` takes the reference
 * alone, and no player screen has an upload. The CONSUMER was left behind. So
 * `order.proofScreenshot` was NULL on every order created after that pass, the
 * check could never pass, and EVERY deposit confirm 400'd.
 *
 * What that looked like to the two people involved:
 *   - The player sent real money, submitted their UTR, and was told "Payment
 *     marked. Awaiting merchant review."
 *   - The merchant opened the order, pressed "Confirm & release", and the panel
 *     told them "The user has not uploaded payment proof yet" — blaming the
 *     player for not supplying something nothing on the platform asks them for.
 * The order then sat at PAID until the 30-minute unanswered sweep moved it to
 * DISPUTED, or the player disputed it. No deposit could complete.
 *
 * Every check was green throughout. Both handlers pass their own route tests;
 * it was the PAIR that was broken, which is §28 — a route test proves a handler
 * works and can never prove the other half agrees with it. It was found by
 * running a deposit end to end against a real server, not by reading one.
 *
 * ── What is asserted ────────────────────────────────────────────────────────
 * 1. The confirm works with NO BODY AT ALL, which is what the panel now sends.
 * 2. The money actually moved — this is the assertion the 400 was hiding. A
 *    status check alone would pass against a route that completed the order and
 *    credited nobody (§21, and trap 17: `completed_at` is not "money moved").
 * 3. A deposit with no reference from the player is still refused, so removing
 *    the dead check did not remove the live one.
 * 4. The player's reference is never taken from the merchant's request body
 *    (§27): one payment, one claim, and the claim belongs to the player's.
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

describePg('a merchant can release tokens on a paid deposit', () => {
  let app;
  let seq = 0;
  const oid = () => `dcr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}-${seq += 1}`;

  beforeAll(async () => {
    await applySchema();
    app = mountRouter((await import('../../domains/merchant/merchant.routes.js')).default);
  }, 60_000);

  afterAll(async () => { await closePg(); });

  /**
   * A deposit in exactly the state the player leaves it in: PAID, carrying the
   * reference THEY submitted, and carrying no proof screenshot — because
   * nothing on this platform can produce one.
   */
  // A payment reference is unique across orders by index (§27), so each order
  // gets its own. `utrNumber: null` means the player has not submitted one yet.
  const nextUtr = () => String(410000000000 + (seq * 7919) + Math.floor(Math.random() * 7000));

  const paidDeposit = async ({ tokensRupees = 1000, utrNumber = nextUtr() } = {}) => {
    const merchant = await merchantActor({ tokensRupees: 50_000 });
    await updateMerchant(merchant.merchantId, {
      isOnline: true, acceptsDeposits: true,
      maxConcurrentDepositOrders: 10, maxConcurrentWithdrawalOrders: 10,
    });
    const player = await actor({});
    const orderId = oid();
    await createOrderRecord({
      orderId, userId: player.userId, type: 'DEPOSIT',
      tokenAmountRupees: tokensRupees, fiatAmountRupees: tokensRupees,
      state: 'PAID', merchantId: merchant.merchantId,
      ...(utrNumber ? { utrNumber } : {}),
    });
    // The tokens are held from the moment the order became this merchant's, as
    // they are in production. The confirm CONSUMES this hold, and a confirm
    // that debited `available` while leaving it standing would charge twice.
    const held = await holdForOrder(await getOrderRecord(orderId), merchant.merchantId);
    expect(held.ok, `could not hold: ${held.reason}`).toBe(true);
    return { merchant, player, orderId, tokensRupees, utrNumber };
  };

  it('completes on an empty body, and the money moves', async () => {
    const { merchant, player, orderId, tokensRupees } = await paidDeposit();

    const before = await getMerchantBalances(merchant.merchantId);

    // No body. Not `{}` with fields the route ignores — nothing at all, which
    // is what `api.confirmPayment` sends.
    const res = await as(app, merchant).post(`/confirm/${orderId}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.success).toBe(true);

    const row = await getOrderRecord(orderId);
    expect(row.status).toBe('COMPLETED');

    // ── The assertion the 400 was hiding ──────────────────────────────────
    // COMPLETED is not "the money moved" (trap 17). Both sides are checked.
    const paise = tokensRupees * 100;
    const after = await getMerchantBalances(merchant.merchantId);
    expect(Number(after.availablePaise)).toBe(Number(before.availablePaise) - paise);
    // The hold was CONSUMED by the payment, not left standing beside it.
    expect(Number(after.reservedPaise)).toBe(Number(before.reservedPaise) - paise);

    // The player holds exactly what the merchant lost — moved, never minted.
    // `getBalances` answers in RUPEES; the split between the two pockets is
    // `depositPolicy`'s business, so this asserts only the total.
    const wallet = await getBalances(player.userId);
    const credited = Number(wallet.depositBalance) + Number(wallet.reserveBalance);
    expect(credited).toBe(paise / 100);
  });

  it('still refuses a deposit the player has not referenced', async () => {
    const { merchant, orderId } = await paidDeposit({ utrNumber: null });

    const res = await as(app, merchant).post(`/confirm/${orderId}`);
    expect(res.status).toBe(400);
    expect((await getOrderRecord(orderId)).status).toBe('PAID');
  });

  it('never takes the payment reference from the merchant', async () => {
    const { merchant, orderId, utrNumber: PLAYERS } = await paidDeposit();

    // A merchant posting a different reference. `utr_registry` claimed the
    // PLAYER's against this order (§27); writing the merchant's over it would
    // leave the order naming a reference nothing had claimed, and free the
    // merchant's string to be spent again on another order.
    const res = await as(app, merchant).post(`/confirm/${orderId}`)
      .send({ utrNumber: '999999999999', proof: 'https://cdn.test/forged.jpg' });
    expect(res.status).toBe(200);

    const row = await getOrderRecord(orderId);
    expect(row.utrNumber).toBe(PLAYERS);
    // And the removed proof field was not resurrected through the body either.
    expect(row.proofScreenshot ?? null).toBeNull();
  });
});
