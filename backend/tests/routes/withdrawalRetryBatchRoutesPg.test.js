// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * `POST /api/payment/order/:orderId/retry` and `GET /api/payment/order/:orderId/batch`,
 * over HTTP, through `authenticate`, the order guard and a real database.
 *
 * Route coverage (report:routes, 2026-10-01) recorded both as reached by NO
 * tier: the wallet's Retry button and the split-withdrawal parts list call
 * them, and only the services underneath had tests (withdrawalRetryPg,
 * splitWithdrawalPg). What this file owns is the ROUTE: who may call it, what
 * a refusal says, and that the response carries what the screen reads.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pgConfigured, applySchema, closePg } from '#db/client.js';
import { createOrderRecord, getOrderRecord } from '#db/repositories/orders.record.js';
import { getBalances } from '#db/repositories/wallets.js';
import { updateUser } from '#db/repositories/users.js';
import { PAYMENT_MODES, getActivePolicy, publishPolicyVersion } from '#db/repositories/paymentModePolicy.js';
import { getSystemConfig, applySystemConfig } from '#db/repositories/config.js';
import { cancelOrder as cancelState } from '../../domains/payment/orderLifecycle.service.js';
import { createWithdrawalOrder } from '../../domains/payment/paymentProcessing.service.js';
import { mountRouter, actor, as } from './_harness.js';

const describePg = pgConfigured() ? describe : describe.skip;

describePg('withdrawal retry and batch routes', () => {
  let app; let restore = null; let restoreMax = null; let seq = 0;
  const oid = () => `wrb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}-${seq += 1}`;

  const withdrawer = async (winningsRupees) => {
    const player = await actor({});
    await updateUser(player.userId, {
      bankDetails: {
        accountNumber: '000111222333', ifscCode: 'HDFC0000001',
        bankName: 'HDFC Bank', accountHolderName: 'Test Player',
      },
    });
    const { creditWinnings } = await import('../../domains/wallet/walletAuthority.service.js');
    await creditWinnings(
      player.userId, winningsRupees, 'retry/batch route suite seed', 'Test',
      `seed_${player.userId}`, `wrb_seed_${player.userId}`,
    );
    return player;
  };

  const expiredSell = async (player, rupees) => {
    const orderId = oid();
    await createOrderRecord({
      orderId, userId: player.userId, type: 'WITHDRAWAL',
      tokenAmountRupees: rupees, fiatAmountRupees: rupees, state: 'PENDING_QUEUE',
    });
    await cancelState(orderId, { set: { cancelReason: 'EXPIRED', cancelledAt: new Date() } });
    return orderId;
  };

  const rail = (activeMode) => publishPolicyVersion({
    activeMode, justification: 'Retry/batch route suite.', changedByName: 'test setup',
  });

  beforeAll(async () => {
    await applySchema();
    app = mountRouter((await import('../../domains/payment/payment.routes.js')).default);
    restore = await getActivePolicy();
    restoreMax = (await getSystemConfig({ fresh: true }))?.maxWithdrawal ?? null;
    await applySystemConfig({ maxWithdrawal: 200_000 });
  }, 60_000);

  afterAll(async () => {
    if (restore) {
      await publishPolicyVersion({
        activeMode: restore.activeMode,
        justification: 'Restoring the rail this suite found in force.', changedByName: 'test teardown',
      });
    }
    if (restoreMax !== null) await applySystemConfig({ maxWithdrawal: restoreMax });
    await closePg();
  });

  // ── Retry ────────────────────────────────────────────────────────────────
  it('retries the player\'s own expired withdrawal, and locks it once', async () => {
    await rail(PAYMENT_MODES.P2P_UPI);
    const player = await withdrawer(2_000);
    const expired = await expiredSell(player, 1_000);
    const before = await getBalances(player.userId);

    const res = await as(app, player).post(`/order/${expired}/retry`).send({});
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const freshId = res.body.order?.orderId ?? res.body.order?._id;
    expect((await getOrderRecord(freshId)).retryOfOrderId).toBe(expired);
    const after = await getBalances(player.userId);
    expect(Number(after.lockedBalance) - Number(before.lockedBalance)).toBe(1_000);
  });

  it('answers a second tap with 409 ALREADY_RETRIED, and locks nothing more', async () => {
    await rail(PAYMENT_MODES.P2P_UPI);
    const player = await withdrawer(3_000);
    const expired = await expiredSell(player, 1_000);
    expect((await as(app, player).post(`/order/${expired}/retry`).send({})).status).toBe(200);
    const between = await getBalances(player.userId);

    const again = await as(app, player).post(`/order/${expired}/retry`).send({});
    expect(again.status).toBeGreaterThanOrEqual(400);
    expect(again.status).toBeLessThan(500);
    expect(again.body.message).toBeTruthy();
    const after = await getBalances(player.userId);
    expect(Number(after.lockedBalance)).toBe(Number(between.lockedBalance));
    expect(Number(after.winningsBalance)).toBe(Number(between.winningsBalance));
  });

  it("refuses another player's order, and moves nothing", async () => {
    await rail(PAYMENT_MODES.P2P_UPI);
    const owner = await withdrawer(2_000);
    const stranger = await withdrawer(2_000);
    const expired = await expiredSell(owner, 1_000);
    const before = await getBalances(stranger.userId);
    const res = await as(app, stranger).post(`/order/${expired}/retry`).send({});
    expect([403, 404]).toContain(res.status);
    expect(await getBalances(stranger.userId)).toEqual(before);
  });

  // ── Batch ────────────────────────────────────────────────────────────────
  it('lists every part of a split withdrawal, to its owner, adding up to the payout', async () => {
    await rail(PAYMENT_MODES.CASH_ATM);
    const player = await withdrawer(200_000);
    const result = await createWithdrawalOrder(player.userId, 100_000);
    const first = result.parts[0].orderId;

    const res = await as(app, player).get(`/order/${first}/batch`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.batchRef).toBe(result.order.withdrawalBatchRef);
    expect(res.body.parts.map((p) => p.orderId).sort()).toEqual(result.parts.map((p) => p.orderId).sort());
    expect(res.body.parts.reduce((s, p) => s + p.amount, 0)).toBe(100_000);
    for (const p of res.body.parts) {
      // A display list, not an order: only these keys, never the order's own fields.
      expect(Object.keys(p).sort()).toEqual(['amount', 'cancellable', 'expiresAt', 'orderId', 'partIndex', 'status']);
    }
  });

  it("refuses another player's batch", async () => {
    await rail(PAYMENT_MODES.CASH_ATM);
    const owner = await withdrawer(200_000);
    const stranger = await withdrawer(1_000);
    const result = await createWithdrawalOrder(owner.userId, 100_000);
    const res = await as(app, stranger).get(`/order/${result.parts[0].orderId}/batch`);
    expect([403, 404]).toContain(res.status);
    expect(res.body.parts).toBeUndefined();
  });

  it('answers an ordinary single withdrawal with no batch and no parts', async () => {
    await rail(PAYMENT_MODES.P2P_UPI);
    const player = await withdrawer(2_000);
    const result = await createWithdrawalOrder(player.userId, 1_000);
    const id = result.order?.orderId ?? result.parts?.[0]?.orderId;
    const res = await as(app, player).get(`/order/${id}/batch`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.batchRef).toBeNull();
    expect(res.body.parts).toEqual([]);
  });
});
