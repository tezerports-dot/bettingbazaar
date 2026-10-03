// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The Merchant Platform's per-merchant figures, through the real router and a
 * real database: `GET /api/admin/merchant-platform/:id/funding-stats` and
 * `/performance-history` (no screen called either until 2026-10-01; owner:
 * wire them).
 *
 * What is pinned, and why each was worth a test:
 *   · the stats say WHICH currency their volumes are in. They are summed in the
 *     order's currency — one rail per merchant (§2) — so a USDT merchant's
 *     figure is USDT, and rendered as rupees it is trap 15's display mouth;
 *   · the history buckets a completed order on its own day, with a zero for
 *     every day that had none, over exactly the window asked for.
 *
 * ── On the team model (PROJECT_STATUS §3.10, Step 2c) ────────────────────────
 * A member holds no tokens — their team's pool does — so there is no balance
 * in the funding picture, and the case that pinned the leaderboard row's
 * `tokenBalance` (§32 S9) went with the merchant wallet. The leaderboard
 * itself stays covered by merchantEarningsPg.
 *
 * The completed work below is completed the way production completes it
 * (§32 S16): a buy routed to the member, paid by the player with a reference
 * the registry claims, and confirmed through the member's own panel; a sell
 * through the player's admission, routed, accepted and confirmed with the
 * member's payout reference, then settled by the hold sweep's own settler.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pgConfigured, applySchema, closePg, withTransaction } from '#db/client.js';
import { createOrderRecord, getOrderRecord } from '#db/repositories/orders.record.js';
import { updateMerchant } from '#db/repositories/merchants.js';
import { updateUser } from '#db/repositories/users.js';
import { creditWinnings } from '../../domains/wallet/walletAuthority.service.js';
import {
  tryAssignMerchant, markOrderPaid, createWithdrawalOrder,
} from '../../domains/payment/paymentProcessing.service.js';
import { settleHold } from '../../domains/payment/withdrawalHold.service.js';
import { teamFixture } from '../teamFixture.js';
import { mountRouter, actor, merchantActor, as } from './_harness.js';

const describePg = pgConfigured() ? describe : describe.skip;

describePg('merchant platform stats', () => {
  let app; let panel; let admin; let contentOnly; let seq = 0;
  const teams = teamFixture();
  const players = [];
  const oid = () => `mps-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}-${seq += 1}`;
  const utr = () => String(570000000000 + (seq * 7919) + Math.floor(Math.random() * 7000));
  const hex64 = () => Array.from({ length: 64 },
    () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('');
  const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const trc20 = () => `T${Array.from({ length: 33 },
    () => BASE58[Math.floor(Math.random() * BASE58.length)]).join('')}`;

  beforeAll(async () => {
    await applySchema();
    app = mountRouter((await import('../../domains/merchant/merchantPlatform.admin.routes.js')).default);
    panel = mountRouter((await import('../../domains/merchant/merchant.routes.js')).default);
    admin = await actor({ isSubAdmin: true, permissions: { canManageMerchants: true } });
    contentOnly = await actor({ isSubAdmin: true, permissions: { canManageContent: true } });
  }, 60_000);

  afterAll(async () => {
    await withTransaction(async (c) => {
      await c.query('SET LOCAL session_replication_role = replica');
      await c.query(
        'DELETE FROM order_transitions WHERE order_id IN (SELECT order_id FROM order_states WHERE user_id = ANY($1))',
        [players]);
      await c.query('DELETE FROM order_states WHERE user_id = ANY($1)', [players]);
    });
    await teams.cleanup();
    await closePg();
  });

  const player = async () => {
    const who = await actor({});
    players.push(who.userId);
    return who;
  };

  /** A member of a working team on `rail`, the only one online. */
  const member = async (rail) => {
    const ms = [await merchantActor()];
    if (rail === 'USDT') {
      // The rail is the admin's to set, and the address is what a USDT member
      // keeps in Profile.
      await updateMerchant(ms[0].merchantId, { acceptedCurrencies: ['USDT'], usdtAddressTrc20: trc20() });
    }
    const team = await teams.workingTeam({ rail, poolTokens: 200_000, include: ms.map((m) => m.merchantId) });
    return { ...ms[0], team };
  };

  /** A buy routed to `m`, paid by the player, confirmed by `m`. */
  const completedBuy = async (m, { tokens, fiat = tokens, currency = 'INR', rateUsed = null }) => {
    const who = await player();
    const orderId = oid();
    const order = await createOrderRecord({
      orderId, userId: who.userId, type: 'DEPOSIT',
      tokenAmountRupees: tokens, fiatAmountRupees: fiat,
      depositAllocation: tokens, reserveAllocation: 0,
      ...(currency === 'USDT' ? { currency, usdtChain: 'TRC20', rateUsed } : {}),
    });
    await teams.onlyOnline([m.merchantId]);
    expect(await tryAssignMerchant(order), 'the buy was not routed').toBe(true);
    const reference = currency === 'USDT' ? hex64() : utr();
    expect((await markOrderPaid(who.userId, orderId, reference)).status).toBe('PAID');
    const res = await as(panel, m).post(`/confirm/${orderId}`);
    expect(res.status, res.body.message).toBe(200);
    expect((await getOrderRecord(orderId)).state).toBe('COMPLETED');
  };

  /** A sell routed to `m`, accepted and paid out by `m`, and settled. */
  const completedSell = async (m, { tokens }) => {
    const who = await player();
    await updateUser(who.userId, {
      bankDetails: {
        accountNumber: '000111222333', ifscCode: 'HDFC0000001',
        bankName: 'HDFC Bank', accountHolderName: 'Test Player',
      },
    });
    await creditWinnings(who.userId, tokens, 'stats suite float', 'Test',
      `seed_${who.userId}`, `mps_seed_${who.userId}_${seq += 1}`);
    await teams.onlyOnline([m.merchantId]);
    const { order } = await createWithdrawalOrder(who.userId, tokens);
    const orderId = order.orderId ?? order._id;
    expect((await getOrderRecord(orderId)).merchantId, 'the sell was not routed').toBe(String(m.merchantId));
    expect((await as(panel, m).post(`/accept/${orderId}`).send({})).status).toBe(200);
    const paid = await as(panel, m).post(`/confirm/${orderId}`).send({ utrNumber: utr() });
    expect(paid.status, paid.body.message).toBe(200);
    // The hold window, elapsed: the sweep's own settler, for this order. It
    // settles a held withdrawal whatever the clock says, so it is not asked
    // whether the window is over — only the sweep's query asks that.
    const state = (await getOrderRecord(orderId)).state;
    if (state !== 'COMPLETED') expect(await settleHold(orderId)).toBe(true);
    expect((await getOrderRecord(orderId)).state).toBe('COMPLETED');
  };

  it('counts an INR merchant\'s completed work, in rupees, and says so', async () => {
    const m = await member('UPI_BANK');
    await completedBuy(m, { tokens: 20_000 });
    await completedBuy(m, { tokens: 30_000 });
    await completedSell(m, { tokens: 15_000 });
    const res = await as(app, admin).get(`/merchant-platform/${m.merchantId}/funding-stats`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.stats).toMatchObject({
      currency: 'INR',
      depositsCompleted: 2, depositVolume: 50_000,
      withdrawalsCompleted: 1, withdrawalVolume: 15_000,
    });
    // A member holds no tokens: the funding picture carries no balance at all,
    // rather than a zero a screen would render as "0 BB".
    expect(res.body.stats).not.toHaveProperty('tokenBalance');
  });

  it("names USDT for a USDT merchant, whose volume is USDT and not rupees", async () => {
    const m = await member('USDT');
    // 50,000 tokens at 90 tokens per USDT: the player sends 555.56 USDT.
    await completedBuy(m, { tokens: 50_000, fiat: 555.56, currency: 'USDT', rateUsed: 90 });
    const res = await as(app, admin).get(`/merchant-platform/${m.merchantId}/funding-stats`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.stats.currency).toBe('USDT');
    expect(res.body.stats.depositVolume).toBe(555.56);
  });

  it('answers 404 for a merchant that does not exist, not a page of zeroes', async () => {
    const res = await as(app, admin).get('/merchant-platform/MRC-does-not-exist/funding-stats');
    expect(res.status).toBe(404);
  });

  it('charts each day of the window, the completed order on today', async () => {
    const m = await member('UPI_BANK');
    await completedBuy(m, { tokens: 20_000 });
    const res = await as(app, admin).get(`/merchant-platform/${m.merchantId}/performance-history`).query({ days: 7 });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.days).toBe(7);
    expect(res.body.history).toHaveLength(7);
    const today = res.body.history[res.body.history.length - 1];
    expect(today.totalOrders).toBe(1);
    expect(today.totalVolume).toBe(20_000);
    expect(today.byType.find((t) => t.type === 'DEPOSIT')).toMatchObject({ orders: 1, volume: 20_000 });
    expect(res.body.history.slice(0, -1).every((d) => d.totalOrders === 0)).toBe(true);
  });

  it('refuses both to an account without the merchants area', async () => {
    const merchant = await merchantActor({});
    expect((await as(app, contentOnly).get(`/merchant-platform/${merchant.merchantId}/funding-stats`)).status).toBe(403);
    expect((await as(app, contentOnly).get(`/merchant-platform/${merchant.merchantId}/performance-history`)).status).toBe(403);
  });
});
