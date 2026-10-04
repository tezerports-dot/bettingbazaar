// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * `POST /api/payment/order/:orderId/retry`, over HTTP, through `authenticate`,
 * the order guard and a real database.
 *
 * Route coverage (report:routes, 2026-10-01) recorded it as reached by NO
 * tier: the wallet's Retry button calls it, and only the service underneath
 * had tests (withdrawalRetryPg). What this file owns is the ROUTE: who may call
 * it, what a refusal says, and that the response carries what the screen reads.
 *
 * The `/batch` route it used to share this file with listed the parts of a
 * split withdrawal. Withdrawals are not split (owner, 2026-10-02), so the route
 * went in 2d with the batch label; playerDoorPg pins that it answers nothing.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pgConfigured, applySchema, closePg, pgQuery } from '#db/client.js';
import { createOrderRecord, getOrderRecord } from '#db/repositories/orders.record.js';
import { getBalances } from '#db/repositories/wallets.js';
import { updateUser } from '#db/repositories/users.js';
import { cancelOrder as cancelState } from '../../domains/payment/orderLifecycle.service.js';
import { mountRouter, actor, as } from './_harness.js';

const describePg = pgConfigured() ? describe : describe.skip;

describePg('withdrawal retry route', () => {
  let app; let seq = 0;
  const oid = () => `wrb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}-${seq += 1}`;
  // Every player this run made, so their orders can be removed afterwards: a
  // queued withdrawal left behind is offered to the next suite's team (trap 10).
  const players = [];

  const withdrawer = async (winningsRupees) => {
    const player = await actor({});
    players.push(player.userId);
    await updateUser(player.userId, {
      bankDetails: {
        accountNumber: '000111222333', ifscCode: 'HDFC0000001',
        bankName: 'HDFC Bank', accountHolderName: 'Test Player',
      },
    });
    const { creditWinnings } = await import('../../domains/wallet/walletAuthority.service.js');
    await creditWinnings(
      player.userId, winningsRupees, 'retry route suite seed', 'Test',
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

  beforeAll(async () => {
    await applySchema();
    app = mountRouter((await import('../../domains/payment/payment.routes.js')).default);
  }, 60_000);

  afterAll(async () => {
    await pgQuery('SET session_replication_role = replica');
    try {
      await pgQuery(
        'DELETE FROM order_transitions WHERE order_id IN (SELECT order_id FROM order_states WHERE user_id = ANY($1))',
        [players]);
      await pgQuery('DELETE FROM order_states WHERE user_id = ANY($1)', [players]);
    } finally {
      await pgQuery('SET session_replication_role = DEFAULT');
    }
    await closePg();
  });

  // ── Retry ────────────────────────────────────────────────────────────────
  it('retries the player\'s own expired withdrawal, and locks it once', async () => {
    const player = await withdrawer(2_000);
    const expired = await expiredSell(player, 1_000);
    const before = await getBalances(player.userId);

    const res = await as(app, player).post(`/order/${expired}/retry`).send({});
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const freshId = res.body.order?.orderId ?? res.body.order?._id;
    expect((await getOrderRecord(freshId)).retryOfOrderId).toBe(expired);
    const after = await getBalances(player.userId);
    expect(Number(after.lockedBalance) - Number(before.lockedBalance)).toBe(1_000);
    expect(Number(before.winningsBalance) - Number(after.winningsBalance)).toBe(1_000);
  });

  it('answers a second tap with 409 ALREADY_RETRIED, and locks nothing more', async () => {
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
    const owner = await withdrawer(2_000);
    const stranger = await withdrawer(2_000);
    const expired = await expiredSell(owner, 1_000);
    const before = await getBalances(stranger.userId);
    const res = await as(app, stranger).post(`/order/${expired}/retry`).send({});
    expect([403, 404]).toContain(res.status);
    expect(await getBalances(stranger.userId)).toEqual(before);
  });
});
