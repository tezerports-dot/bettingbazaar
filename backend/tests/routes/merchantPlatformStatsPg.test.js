// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The Merchant Platform's per-merchant figures, through the real router and a
 * real database: `GET /api/admin/merchant-platform/:id/funding-stats` and
 * `/performance-history` (no screen called either until 2026-10-01; owner:
 * wire them), and the leaderboard row the screen opens them from.
 *
 * What is pinned, and why each was worth a test:
 *   · the leaderboard row carries the merchant's token balance. The screen's
 *     Wallet column read `tokenBalance` off rows that never had one, so every
 *     merchant showed 0 BB (§32 S9);
 *   · the stats say WHICH currency their volumes are in. They are summed in the
 *     order's currency — one rail per merchant (§2) — so a USDT merchant's
 *     figure is USDT, and rendered as rupees it is trap 15's display mouth;
 *   · the history buckets a completed order on its own day, with a zero for
 *     every day that had none, over exactly the window asked for.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pgConfigured, applySchema, closePg } from '#db/client.js';
import { createOrderRecord } from '#db/repositories/orders.record.js';
import { updateMerchant } from '#db/repositories/merchants.js';
import { mountRouter, actor, merchantActor, as } from './_harness.js';

const describePg = pgConfigured() ? describe : describe.skip;

describePg('merchant platform stats', () => {
  let app; let admin; let contentOnly; let seq = 0;
  const oid = () => `mps-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}-${seq += 1}`;

  beforeAll(async () => {
    await applySchema();
    app = mountRouter((await import('../../domains/merchant/merchantPlatform.admin.routes.js')).default);
    admin = await actor({ isSubAdmin: true, permissions: { canManageMerchants: true } });
    contentOnly = await actor({ isSubAdmin: true, permissions: { canManageContent: true } });
  }, 60_000);

  afterAll(async () => { await closePg(); });

  /** A completed order on `merchant`, today. */
  const completed = async (merchant, { type = 'DEPOSIT', tokens, fiat, currency = 'INR' }) => {
    const player = await actor({});
    await createOrderRecord({
      orderId: oid(), userId: player.userId, type, state: 'COMPLETED',
      tokenAmountRupees: tokens, fiatAmountRupees: fiat, merchantId: merchant.merchantId,
      currency, usdtChain: currency === 'USDT' ? 'TRC20' : null, completedAt: new Date(),
    });
  };

  it("carries the merchant's token balance on the leaderboard row", async () => {
    const merchant = await merchantActor({ tokensRupees: 12_345 });
    await completed(merchant, { tokens: 500, fiat: 500 });
    const res = await as(app, admin).get('/merchant-platform/leaderboard').query({ days: 30, limit: 100 });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const row = res.body.leaderboard.find((r) => r.merchantId === merchant.merchantId);
    expect(row, 'the merchant with a completed order is on the board').toBeTruthy();
    expect(row.tokenBalance).toBe(12_345);
  });

  it('counts an INR merchant\'s completed work, in rupees, and says so', async () => {
    const merchant = await merchantActor({ tokensRupees: 1_000 });
    await completed(merchant, { type: 'DEPOSIT', tokens: 500, fiat: 500 });
    await completed(merchant, { type: 'DEPOSIT', tokens: 1_000, fiat: 1_000 });
    await completed(merchant, { type: 'WITHDRAWAL', tokens: 700, fiat: 700 });
    const res = await as(app, admin).get(`/merchant-platform/${merchant.merchantId}/funding-stats`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.stats).toMatchObject({
      currency: 'INR',
      depositsCompleted: 2, depositVolume: 1_500,
      withdrawalsCompleted: 1, withdrawalVolume: 700,
      tokenBalance: 1_000,
    });
  });

  it("names USDT for a USDT merchant, whose volume is USDT and not rupees", async () => {
    const merchant = await merchantActor({ tokensRupees: 100_000 });
    await updateMerchant(merchant.merchantId, { acceptedCurrencies: ['USDT'] });
    await completed(merchant, { tokens: 50_000, fiat: 555.56, currency: 'USDT' });
    const res = await as(app, admin).get(`/merchant-platform/${merchant.merchantId}/funding-stats`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.stats.currency).toBe('USDT');
    expect(res.body.stats.depositVolume).toBe(555.56);
  });

  it('answers 404 for a merchant that does not exist, not a page of zeroes', async () => {
    const res = await as(app, admin).get('/merchant-platform/MRC-does-not-exist/funding-stats');
    expect(res.status).toBe(404);
  });

  it('charts each day of the window, the completed order on today', async () => {
    const merchant = await merchantActor({ tokensRupees: 1_000 });
    await completed(merchant, { type: 'DEPOSIT', tokens: 800, fiat: 800 });
    const res = await as(app, admin).get(`/merchant-platform/${merchant.merchantId}/performance-history`).query({ days: 7 });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.days).toBe(7);
    expect(res.body.history).toHaveLength(7);
    const today = res.body.history[res.body.history.length - 1];
    expect(today.totalOrders).toBe(1);
    expect(today.totalVolume).toBe(800);
    expect(today.byType.find((t) => t.type === 'DEPOSIT')).toMatchObject({ orders: 1, volume: 800 });
    expect(res.body.history.slice(0, -1).every((d) => d.totalOrders === 0)).toBe(true);
  });

  it('refuses both to an account without the merchants area', async () => {
    const merchant = await merchantActor({});
    expect((await as(app, contentOnly).get(`/merchant-platform/${merchant.merchantId}/funding-stats`)).status).toBe(403);
    expect((await as(app, contentOnly).get(`/merchant-platform/${merchant.merchantId}/performance-history`)).status).toBe(403);
  });
});
