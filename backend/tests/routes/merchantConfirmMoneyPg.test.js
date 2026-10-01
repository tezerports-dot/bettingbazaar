// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The money assertions for a confirmed buy, on the route merchants USE —
 * `POST /api/merchant/confirm/:id` — with the order HELD as assignment holds it.
 *
 * ── Where these came from ───────────────────────────────────────────────────
 * They lived in `paymentRoutes.test.js`, against `POST /api/payment/deposit/
 * :orderId/confirm`: a second confirm route that no screen and no workflow
 * called (F-017; check:ui-coverage --unused). Owner, 2026-10-01: delete a stale
 * duplicate once it is shown nothing uses it. The catch was that the split, the
 * double delivery, the race, the accounting event and the reference release
 * were asserted ONLY there — so deleting it would have left the live confirm
 * without them. They are ported here first, then the route went.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pgConfigured, applySchema, closePg } from '#db/client.js';
import { createOrderRecord, getOrderRecord, listOrderTransitions } from '#db/repositories/orders.record.js';
import { updateMerchant } from '#db/repositories/merchants.js';
import { getMerchantBalances } from '#db/repositories/merchantWallets.core.js';
import { getBalancesPaise } from '#db/repositories/wallets.core.js';
import { getEvent } from '#db/repositories/ledger.core.js';
import { claimUtr, getUtr } from '#db/repositories/utr.js';
import { holdForOrder } from '../../domains/merchant/depositEscrow.service.js';
import { mountRouter, actor, merchantActor, as } from './_harness.js';

const describePg = pgConfigured() ? describe : describe.skip;

const merchantTotal = async (merchantId) => {
  const b = await getMerchantBalances(merchantId);
  const total = b.available + b.reserved + b.settlement;
  if (!Number.isFinite(total)) throw new Error(`merchant pockets unreadable: ${JSON.stringify(b)}`);
  return total;
};

describePg('a merchant confirms a buy — the money', () => {
  let app; let seq = 0;
  const oid = () => `mcm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}-${seq += 1}`;
  const nextUtr = () => String(430000000000 + (seq * 7919) + Math.floor(Math.random() * 7000));

  beforeAll(async () => {
    await applySchema();
    app = mountRouter((await import('../../domains/merchant/merchant.routes.js')).default);
  }, 60_000);

  afterAll(async () => { await closePg(); });

  /** A PAID buy, its reference claimed and its tokens held, as production makes one. */
  const heldPaidBuy = async ({
    merchantTokens = 50_000, tokens = 500, betting = 400, reserve = 100, extra = {},
  } = {}) => {
    const merchant = await merchantActor({ tokensRupees: merchantTokens });
    await updateMerchant(merchant.merchantId, {
      isOnline: true, acceptsDeposits: true,
      maxConcurrentDepositOrders: 10, maxConcurrentWithdrawalOrders: 10,
    });
    const player = await actor({});
    const orderId = oid();
    const utr = nextUtr();
    await createOrderRecord({
      orderId, userId: player.userId, type: 'DEPOSIT',
      tokenAmountRupees: tokens, fiatAmountRupees: tokens,
      state: 'PAID', merchantId: merchant.merchantId, utrNumber: utr,
      depositAllocation: betting, reserveAllocation: reserve, ...extra,
    });
    await claimUtr({ utr, orderId, userId: player.userId, amountRupees: tokens });
    const held = await holdForOrder(await getOrderRecord(orderId), merchant.merchantId);
    expect(held.ok, `could not hold: ${held.reason}`).toBe(true);
    return { merchant, player, orderId, utr };
  };

  // ── Who may confirm ──────────────────────────────────────────────────────
  it('refuses a merchant the order is not assigned to, and nothing moves', async () => {
    const { player, orderId } = await heldPaidBuy();
    const stranger = await merchantActor({ tokensRupees: 10_000 });
    const strangerBefore = await merchantTotal(stranger.merchantId);
    const before = await getBalancesPaise(player.userId);
    const res = await as(app, stranger).post(`/confirm/${orderId}`);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(await merchantTotal(stranger.merchantId)).toBe(strangerBefore);
    expect(await getBalancesPaise(player.userId)).toEqual(before);
    expect((await getOrderRecord(orderId)).status).toBe('PAID');
  });

  // ── The split ────────────────────────────────────────────────────────────
  it('honours the split — betting and reserve pockets each get their share', async () => {
    const { merchant, player, orderId } = await heldPaidBuy({ tokens: 500, betting: 400, reserve: 100 });
    const before = await getBalancesPaise(player.userId);
    const merchantBefore = await merchantTotal(merchant.merchantId);
    const res = await as(app, merchant).post(`/confirm/${orderId}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const after = await getBalancesPaise(player.userId);
    expect(after.depositBalance - before.depositBalance).toBe(400_00);
    expect(after.reserveBalance - before.reserveBalance).toBe(100_00);
    expect(merchantBefore - await merchantTotal(merchant.merchantId)).toBe(500_00);
  });

  it('credits the whole amount to betting when the order never split', async () => {
    const { merchant, player, orderId } = await heldPaidBuy({ tokens: 500, betting: 0, reserve: 0 });
    const before = await getBalancesPaise(player.userId);
    expect((await as(app, merchant).post(`/confirm/${orderId}`)).status).toBe(200);
    const after = await getBalancesPaise(player.userId);
    expect(after.depositBalance - before.depositBalance).toBe(500_00);
    expect(after.reserveBalance).toBe(before.reserveBalance);
  });

  // ── Exactly once ─────────────────────────────────────────────────────────
  it('credits ONCE when the same confirm arrives twice', async () => {
    const { merchant, player, orderId } = await heldPaidBuy();
    expect((await as(app, merchant).post(`/confirm/${orderId}`)).status).toBe(200);
    const playerAfterFirst = await getBalancesPaise(player.userId);
    const merchantAfterFirst = await merchantTotal(merchant.merchantId);

    const second = await as(app, merchant).post(`/confirm/${orderId}`);
    expect(second.status).toBeLessThan(500);
    expect(await getBalancesPaise(player.userId)).toEqual(playerAfterFirst);
    expect(await merchantTotal(merchant.merchantId)).toBe(merchantAfterFirst);
  });

  it('survives four confirms racing each other — the tokens move once', async () => {
    const { merchant, player, orderId } = await heldPaidBuy();
    const before = await getBalancesPaise(player.userId);
    const merchantBefore = await merchantTotal(merchant.merchantId);
    const results = await Promise.all(
      Array.from({ length: 4 }, () => as(app, merchant).post(`/confirm/${orderId}`)),
    );
    expect(results.every((r) => r.status < 500), results.map((r) => r.status).join(',')).toBe(true);
    expect(results.filter((r) => r.status === 200).length).toBeGreaterThanOrEqual(1);
    const after = await getBalancesPaise(player.userId);
    expect(after.depositBalance - before.depositBalance).toBe(400_00);
    expect(after.reserveBalance - before.reserveBalance).toBe(100_00);
    expect(merchantBefore - await merchantTotal(merchant.merchantId)).toBe(500_00);
  });

  // ── The books and the reference ──────────────────────────────────────────
  it('posts the accounting event with the completion', async () => {
    const { merchant, orderId } = await heldPaidBuy();
    expect((await as(app, merchant).post(`/confirm/${orderId}`)).status).toBe(200);
    const completed = (await listOrderTransitions(orderId)).filter((t) => t.toState === 'COMPLETED');
    expect(completed).toHaveLength(1);
    expect(completed[0].ledgerKey, 'the completion recorded no ledger key').toBeTruthy();
    expect(await getEvent(completed[0].ledgerKey), 'no accounting event behind the completion').toBeTruthy();
  });

  it('releases the bank reference when the buy completes', async () => {
    const { merchant, orderId, utr } = await heldPaidBuy();
    expect((await getUtr(utr)).status).toBe('ACTIVE');
    expect((await as(app, merchant).post(`/confirm/${orderId}`)).status).toBe(200);
    expect((await getUtr(utr)).status).toBe('RELEASED');
  });

  // ── What a merchant is told ──────────────────────────────────────────────
  it("strips the player's contact and bank details from the merchant's response", async () => {
    const { merchant, orderId } = await heldPaidBuy({
      extra: { userPhone: '9998887777', userBankDetails: { accountNo: '123456789', ifsc: 'HDFC0001' } },
    });
    const res = await as(app, merchant).post(`/confirm/${orderId}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const body = JSON.stringify(res.body);
    expect(body).not.toContain('9998887777');
    expect(body).not.toContain('123456789');
    // Stripped from the response, not lost from the record.
    expect((await getOrderRecord(orderId)).userPhone).toBe('9998887777');
  });
});
