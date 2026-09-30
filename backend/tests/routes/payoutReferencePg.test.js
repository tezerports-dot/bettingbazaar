// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The payment reference sits on the side that PAID.
 *
 * A buy and a sell are mirror images, and the reference follows the money
 * rather than the order:
 *
 *   BUY   the PLAYER pays the merchant. Their UTR arrives at `mark-paid`, is
 *         claimed against the order there, and the confirm reads it off the
 *         row. A merchant restating it would be a second writer for a value
 *         that already has an owner (§27).
 *   SELL  the MERCHANT pays the player out of their own bank account. The
 *         reference for that transfer exists only on their receipt, so it is
 *         theirs to give and there is nobody else who could.
 *
 * ── Why this file exists ────────────────────────────────────────────────────
 * Fixing the buy side took `utrNumber` out of the confirm body, which was right
 * for a deposit and wrong for a withdrawal: it took the merchant's payout
 * reference with it, on a route where the merchant is the only party who has
 * one. A payout then completed with nothing recorded against it and the
 * player's notification read "UTR / Ref: Provided separately" — for a transfer
 * that did have a reference, which nobody had been asked for.
 *
 * ── What is asserted ────────────────────────────────────────────────────────
 * Both directions of the asymmetry, so neither can be "simplified" into the
 * other, and the CLAIM — a merchant's bank transfer is a real payment and the
 * same registry decides whether it has been spent. Without that, one transfer
 * could be presented as proof of two payouts, which is the defect §27 records
 * against the CDM slip.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pgConfigured, applySchema, closePg } from '#db/client.js';
import { createOrderRecord, getOrderRecord } from '#db/repositories/orders.record.js';
import { updateMerchant } from '#db/repositories/merchants.js';
import { PAYMENT_MODES } from '#db/repositories/paymentModePolicy.js';
import { holdForOrder } from '../../domains/merchant/depositEscrow.service.js';
import { mountRouter, actor, merchantActor, as } from './_harness.js';

const describePg = pgConfigured() ? describe : describe.skip;

describePg('the payout reference is the MERCHANT\'s, and it is claimed', () => {
  let app;
  let seq = 0;
  const oid = (p) => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}-${seq += 1}`;
  // Unique per order: a reference belongs to exactly one order, by index (§27).
  const utr = () => `UTRPAY${String(Date.now()).slice(-6)}${String(seq).padStart(4, '0')}`;

  beforeAll(async () => {
    await applySchema();
    app = mountRouter((await import('../../domains/merchant/merchant.routes.js')).default);
  }, 60_000);

  afterAll(async () => { await closePg(); });

  const seller = async () => {
    const m = await merchantActor({ tokensRupees: 50_000 });
    await updateMerchant(m.merchantId, {
      isOnline: true, acceptsWithdrawals: true, acceptsDeposits: true,
      maxConcurrentDepositOrders: 10, maxConcurrentWithdrawalOrders: 10,
    });
    return m;
  };

  /** A withdrawal sitting where the merchant presses "I've sent the money". */
  const payout = async (merchant, { paymentMode = PAYMENT_MODES.P2P_UPI } = {}) => {
    const player = await actor({ kycStatus: 'APPROVED' });
    const orderId = oid('wd');
    await createOrderRecord({
      orderId, userId: player.userId, type: 'WITHDRAWAL',
      tokenAmountRupees: 500, fiatAmountRupees: 500,
      state: 'PROCESSING', merchantId: merchant.merchantId,
      depositAllocation: 0, reserveAllocation: 0,
      paymentMode,
    });
    return { orderId, player };
  };

  it('refuses a UPI payout with no reference, and moves nothing', async () => {
    const m = await seller();
    const { orderId } = await payout(m);

    const res = await as(app, m).post(`/confirm/${orderId}`).send({});
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(res.body.code).toBe('PAYOUT_REFERENCE_REQUIRED');
    // The refusal lands BEFORE the transition, so the order is untouched and
    // the merchant can try again with the reference in hand.
    expect((await getOrderRecord(orderId)).state).toBe('PROCESSING');
  });

  it('records the merchant\'s reference on the order', async () => {
    const m = await seller();
    const { orderId } = await payout(m);
    const reference = utr();

    const res = await as(app, m).post(`/confirm/${orderId}`).send({ utrNumber: reference });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const row = await getOrderRecord(orderId);
    // Uppercased on the way in, as every claimed reference is — a code stored
    // in two cases is two references as far as the registry is concerned.
    expect(row.utrNumber).toBe(reference.toUpperCase());
    // PAID under the hold, or COMPLETED with it disabled. Either is "the
    // merchant has asserted the payout"; this test is about the reference.
    expect(['PAID', 'COMPLETED']).toContain(row.state);
  });

  it('CLAIMS it — the same transfer cannot pay two withdrawals', async () => {
    const m = await seller();
    const first = await payout(m);
    const second = await payout(m);
    const reference = utr();

    expect((await as(app, m).post(`/confirm/${first.orderId}`).send({ utrNumber: reference })).status).toBe(200);

    const dup = await as(app, m).post(`/confirm/${second.orderId}`).send({ utrNumber: reference });
    expect(dup.status, 'one bank transfer must not settle two payouts').toBe(409);
    // And it names the order already holding it, so support can answer
    // "it says already used" without a second lookup that may disagree.
    expect(dup.body.originalOrderId).toBe(first.orderId);
    expect((await getOrderRecord(second.orderId)).state).toBe('PROCESSING');
  });

  it('refuses a reference too short to be a UTR', async () => {
    const m = await seller();
    const { orderId } = await payout(m);

    const res = await as(app, m).post(`/confirm/${orderId}`).send({ utrNumber: 'SHORT' });
    expect(res.status).toBe(400);
    expect((await getOrderRecord(orderId)).state).toBe('PROCESSING');
  });

  it('does NOT ask for one at a cash machine — that payout is evidenced by the slip', async () => {
    const m = await seller();
    const { orderId } = await payout(m, { paymentMode: PAYMENT_MODES.CASH_ATM });

    // No body at all. A CASH_ATM payout is notes handed over a counter; there
    // is no bank UTR for it, and its evidence is the CDM slip, which has its
    // own route and its own claim.
    const res = await as(app, m).post(`/confirm/${orderId}`).send({});
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(['PAID', 'COMPLETED']).toContain((await getOrderRecord(orderId)).state);
  });

  // ── The other half of the asymmetry, so it cannot be collapsed ───────────
  it('a DEPOSIT still takes no reference from the merchant', async () => {
    const m = await seller();
    const player = await actor({ kycStatus: 'APPROVED' });
    const orderId = oid('dep');
    const players = utr();
    await createOrderRecord({
      orderId, userId: player.userId, type: 'DEPOSIT',
      tokenAmountRupees: 500, fiatAmountRupees: 500,
      state: 'PAID', merchantId: m.merchantId, utrNumber: players,
    });
    await holdForOrder(await getOrderRecord(orderId), m.merchantId);

    // The merchant posting a DIFFERENT reference on a buy. The player's is
    // already claimed against this order; writing the merchant's over it would
    // leave the row naming a reference nothing had claimed.
    const res = await as(app, m).post(`/confirm/${orderId}`).send({ utrNumber: 'MERCHANTSUPPLIED9999' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await getOrderRecord(orderId)).utrNumber).toBe(players);
  });
});
