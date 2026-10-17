// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Routing starts an order as it hands it out: there is no Accept (owner,
 * 2026-10-17).
 *
 * So a bank-transfer buy shows the player the member's account at once, and
 * the player may tap Paid at once. Because the player may already be paying,
 * such a buy never changes hands again: the member cannot decline it (400
 * CANNOT_DECLINE) and answers it with "payment not received" once the player
 * says they paid. Only an order nobody can have paid on may change hands (a
 * sell, or a cash buy before its QR), asked again under the order's lock
 * (`refuseIfPayableWithin`), which is what the race at the end proves:
 *
 *   • a routed bank buy is PROCESSING, its account shown, Paid taken;
 *   • unpaid, it lapses on the PLAYER (they were shown where to pay);
 *   • its member cannot decline it, and the order stays theirs;
 *   • a cash buy's decline that races the QR scan is refused, not requeued
 *     with the player holding a QR to pay;
 *   • the Paid move names the member the player was shown, so a change of
 *     hands between the read and the move is refused.
 *
 * Every order here is one production makes (§32 S16): created through
 * `createDepositOrder` and routed to the one member of a working team.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pgConfigured, applySchema, closePg, pgQuery, withTransaction } from '#db/client.js';
import { getOrderRecord } from '#db/repositories/orders.record.js';
import { checkCashLink } from '../../domains/payment/cashLink.js';
import { getMerchant } from '#db/repositories/merchants.js';
import { getUser } from '#db/repositories/users.js';
import { PAYMENT_MODES, setCashReady } from '#db/repositories/teamRouting.js';
import { createDepositOrder, expireOrders } from '../../domains/payment/paymentProcessing.service.js';
import { teamFixture } from '../teamFixture.js';
import { mountRouter, actor, merchantActor, as } from './_harness.js';

const describePg = pgConfigured() ? describe : describe.skip;

/**
 * Resolve once a backend running a statement matching `like` is queued behind
 * one of `behind` (this test's own lock holder). pg_stat_activity lists every
 * session on the server and the text carries `$1`, not the order, so the text
 * alone also matched other suites' lock waits, and the holder moved the order
 * before the tap had read it (see disputeSettleRacePg).
 */
async function untilBlocked(like, behind, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { rows } = await pgQuery(
      `SELECT 1 FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE $1
          AND pg_blocking_pids(pid) && $2::int[]
        LIMIT 1`, [like, behind]);
    if (rows.length) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`nothing blocked on ${like} within ${timeoutMs}ms — the interleaving never happened`);
}

describePg('an order is started as it is handed out', () => {
  let playerApp, merchantApp;
  const RUN = Math.random().toString(36).slice(2, 8);
  let seq = 0;
  const teams = teamFixture();
  const made = [];
  const utr = () => `${String(Date.now()).slice(-8)}${String((seq += 1) + 1000).slice(-4)}`;

  beforeAll(async () => {
    await applySchema();
    playerApp = mountRouter((await import('../../domains/payment/payment.routes.js')).default);
    merchantApp = mountRouter((await import('../../domains/merchant/merchant.routes.js')).default);
  }, 60_000);

  afterAll(async () => {
    // Trap 10: this run's orders and their references, then its teams.
    await withTransaction(async (c) => {
      await c.query('SET LOCAL session_replication_role = replica');
      await c.query('DELETE FROM utr_registry WHERE order_id = ANY($1)', [made]);
      await c.query('DELETE FROM chat_messages WHERE order_id = ANY($1)', [made]);
      await c.query('DELETE FROM order_transitions WHERE order_id = ANY($1)', [made]);
      await c.query('DELETE FROM order_states WHERE order_id = ANY($1)', [made]);
    });
    await teams.cleanup();
    await closePg();
  });

  /** A buy routed to a fresh member of a working team on its rail. */
  const routedBuy = async (tokens, rail) => {
    const player = await actor({});
    const member = await merchantActor({});
    await teams.workingTeam({ rail, poolTokens: tokens, include: [member.merchantId] });
    // A cash buy goes only to a member who pressed Ready.
    if (rail === 'CASH') expect(await setCashReady(member.merchantId, true)).toEqual({ ok: true, ready: true });
    const { order } = await createDepositOrder(player.userId, tokens);
    const orderId = order.orderId ?? order._id;
    made.push(orderId);
    const row = await getOrderRecord(orderId);
    expect(row.status, `the buy was not routed (${RUN})`).toBe('PROCESSING');
    expect(row.merchantId).toBe(String(member.merchantId));
    return { orderId, player, member, row };
  };
  /** A 50,000-token bank-transfer buy. */
  const bankBuy = async () => {
    const out = await routedBuy(50_000, 'UPI_BANK');
    expect(out.row.paymentMode).not.toBe(PAYMENT_MODES.CASH_ATM);
    return out;
  };

  const shown = async (who, orderId) => (await as(playerApp, who).get(`/order/${orderId}/status`)).body;
  const pay = (who, orderId, utrNumber) => as(playerApp, who).post(`/order/${orderId}/mark-paid`).send({ utrNumber });

  it('shows the account and takes Paid at once: there is no Accept', async () => {
    const { orderId, player, member } = await bankBuy();
    const view = await shown(player, orderId);
    expect(view.payTo?.bankAccount?.accountNo).toBe((await getMerchant(member.merchantId)).bankDetails.accountNo);
    const paid = await pay(player, orderId, utr());
    expect(paid.status, JSON.stringify(paid.body)).toBe(200);
    expect((await getOrderRecord(orderId)).status).toBe('PAID');
    // The route the Accept button called is gone.
    expect((await as(merchantApp, member).post(`/accept/${orderId}`).send({})).status).toBe(404);
  });

  it('a started bank buy the player never paid is the player\'s', async () => {
    const { orderId, player, member } = await bankBuy();
    await pgQuery(`UPDATE order_states SET expires_at = now() - interval '1 minute' WHERE order_id = $1`, [orderId]);
    await expireOrders();
    expect((await getOrderRecord(orderId)).status).toBe('CANCELLED');
    expect((await getUser(player.userId)).consecutivePaymentFailures).toBe(1);
    expect((await getMerchant(member.merchantId)).consecutiveExpiries).toBe(1);
  });

  it('its member cannot decline a started bank buy: the player may already be paying', async () => {
    const { orderId, member } = await bankBuy();
    const res = await as(merchantApp, member).post(`/reject/${orderId}`).send({ reason: 'Busy right now' });
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(res.body.code).toBe('CANNOT_DECLINE');
    expect(res.body.message).toMatch(/Payment not received/);
    expect(await getOrderRecord(orderId)).toMatchObject({ status: 'PROCESSING', merchantId: String(member.merchantId) });
  });

  it('a cash buy may be declined before its QR (the opposite case), and goes back to the queue', async () => {
    const { orderId, member } = await routedBuy(1_000, 'CASH');
    const res = await as(merchantApp, member).post(`/reject/${orderId}`).send({ reason: 'Machine out of order' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    // Nobody else on the team is Ready, so it waits in the queue, its hold released.
    expect(await getOrderRecord(orderId)).toMatchObject({ status: 'PENDING_QUEUE', merchantId: null, poolHeldPaise: 0 });
  });

  it('a cash buy\'s decline that races the QR scan is refused under the lock', async () => {
    // The decline reads the order with no QR (so `mayChangeHands` says yes),
    // then waits on the order lock while the QR is written. Without the
    // question asked again under the lock, the order would go back to the
    // queue with the player holding a QR to pay.
    const { orderId, member, row } = await routedBuy(1_000, 'CASH');
    const link = checkCashLink(
      `upi://pay?pa=atm.cash@icici&pn=ATM&am=${Number(row.fiatAmount).toFixed(2)}&cu=INR&tr=${String(orderId).replace(/[^A-Za-z0-9]/g, '').slice(-20)}`,
      row.fiatAmount,
    );
    let decline;
    await withTransaction(async (c) => {
      const holder = (await c.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      await c.query('SELECT 1 FROM order_states WHERE order_id = $1 FOR UPDATE', [orderId]);
      decline = as(merchantApp, member).post(`/reject/${orderId}`).send({ reason: 'Machine out of order' }).then((r) => r);
      await untilBlocked('SELECT * FROM order_states WHERE order_id = $1 FOR UPDATE%', [holder]);
      await c.query('UPDATE order_states SET cash_link = $2, cash_link_at = now() WHERE order_id = $1', [orderId, link]);
    });
    const res = await decline;
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.code).toBe('PLAYER_MAY_BE_PAYING');
    expect(await getOrderRecord(orderId)).toMatchObject({ status: 'PROCESSING', merchantId: String(member.merchantId) });
  });

  it('a Paid tap that races a change of hands is refused, not marked paid to the new member', async () => {
    // The player's tap reads the order (member A, A's account), then waits on
    // the order lock while it moves to member B. Without the member pinned in
    // the transition, the order would read PAID to B for money sent to A.
    const { orderId, player } = await bankBuy();
    const next = await merchantActor({});
    let tap;
    await withTransaction(async (c) => {
      const holder = (await c.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      await c.query('SELECT 1 FROM order_states WHERE order_id = $1 FOR UPDATE', [orderId]);
      tap = pay(player, orderId, utr()).then((r) => r);
      await untilBlocked('SELECT * FROM order_states WHERE order_id = $1 FOR UPDATE%', [holder]);
      await c.query('UPDATE order_states SET merchant_id = $2 WHERE order_id = $1', [orderId, next.merchantId]);
    });
    const res = await tap;
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.code).toBe('merchant_changed');
    expect(res.body.message).toMatch(/moved to another member/);
    expect((await getOrderRecord(orderId)).status).toBe('PROCESSING');
  });
});
