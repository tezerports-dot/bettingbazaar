// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * A buy is paid only once its member has ACCEPTED it (Step 2d, security review).
 *
 * ASSIGNED is the state in which the member may still decline (`/reject`) and
 * an admin may still move the order to someone else. A player shown the
 * member's bank account then, who paid it, would have paid a member who then
 * declined, with the order and its tokens gone to another. So:
 *
 *   • at ASSIGNED the player is shown no account and no address, and "I've
 *     paid" is refused by name (`NOT_ACCEPTED_YET`) before any reference is
 *     claimed;
 *   • a buy the member never accepted lapses on the MEMBER, not the player;
 *   • the Paid move names the member the player was shown, on every rail, so a
 *     change of hands between the read and the move is refused.
 *
 * The cash rail's half (the scan waits for the accept too) is in
 * `cashLinkPg.test.js`. Every order here is one production makes (§32 S16):
 * a 50,000-token buy is a bank-transfer order by its size, created through
 * `createDepositOrder` and routed to the one member of a working team.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pgConfigured, applySchema, closePg, pgQuery, withTransaction } from '#db/client.js';
import { getOrderRecord } from '#db/repositories/orders.record.js';
import { getMerchant } from '#db/repositories/merchants.js';
import { getUser } from '#db/repositories/users.js';
import { PAYMENT_MODES } from '#db/repositories/teamRouting.js';
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

describePg('a buy is paid only once its member has accepted it', () => {
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

  /** A 50,000-token bank-transfer buy, routed to a fresh member of a working team. */
  const bankBuy = async ({ accept = false } = {}) => {
    const player = await actor({});
    const member = await merchantActor({});
    await teams.workingTeam({ rail: 'UPI_BANK', poolTokens: 50_000, include: [member.merchantId] });
    const { order } = await createDepositOrder(player.userId, 50_000);
    const orderId = order.orderId ?? order._id;
    made.push(orderId);
    const row = await getOrderRecord(orderId);
    expect(row.status, `the buy was not routed (${RUN})`).toBe('ASSIGNED');
    expect(row.merchantId).toBe(String(member.merchantId));
    expect(row.paymentMode).not.toBe(PAYMENT_MODES.CASH_ATM);
    if (accept) {
      const res = await as(merchantApp, member).post(`/accept/${orderId}`).send({});
      expect(res.status, res.body.message).toBe(200);
    }
    return { orderId, player, member };
  };

  const shown = async (who, orderId) => (await as(playerApp, who).get(`/order/${orderId}/status`)).body;
  const pay = (who, orderId, utrNumber) => as(playerApp, who).post(`/order/${orderId}/mark-paid`).send({ utrNumber });

  it('shows no account and takes no Paid until the member accepts, and then both', async () => {
    const { orderId, player, member } = await bankBuy();
    const before = await shown(player, orderId);
    expect(before.payTo?.bankAccount).toBeUndefined();
    expect(JSON.stringify(before)).not.toContain((await getMerchant(member.merchantId)).bankDetails.accountNo);

    const reference = utr();
    const early = await pay(player, orderId, reference);
    expect(early.status, JSON.stringify(early.body)).toBe(409);
    expect(early.body.code).toBe('NOT_ACCEPTED_YET');
    expect(early.body.message).toMatch(/not accepted this order yet/);
    expect((await getOrderRecord(orderId)).status).toBe('ASSIGNED');
    // Refused before the reference is claimed, so the player can still use it.
    const { rows } = await pgQuery('SELECT 1 FROM utr_registry WHERE utr = $1', [reference]);
    expect(rows).toHaveLength(0);

    // The opposite case: accepted, the account is shown and the same reference is taken.
    expect((await as(merchantApp, member).post(`/accept/${orderId}`).send({})).status).toBe(200);
    const after = await shown(player, orderId);
    expect(after.payTo?.bankAccount?.accountNo).toBe((await getMerchant(member.merchantId)).bankDetails.accountNo);
    const paid = await pay(player, orderId, reference);
    expect(paid.status, JSON.stringify(paid.body)).toBe(200);
    expect((await getOrderRecord(orderId)).status).toBe('PAID');
  });

  it('a buy the member never accepted lapses on the member, not the player', async () => {
    const { orderId, player, member } = await bankBuy();
    await pgQuery(`UPDATE order_states SET expires_at = now() - interval '1 minute' WHERE order_id = $1`, [orderId]);
    await expireOrders();
    expect((await getOrderRecord(orderId)).status).toBe('CANCELLED');
    expect((await getUser(player.userId)).consecutivePaymentFailures).toBe(0);
    expect((await getMerchant(member.merchantId)).consecutiveExpiries).toBe(1);
  });

  it('one the member accepted and the player never paid is the player\'s', async () => {
    const { orderId, player, member } = await bankBuy({ accept: true });
    await pgQuery(`UPDATE order_states SET expires_at = now() - interval '1 minute' WHERE order_id = $1`, [orderId]);
    await expireOrders();
    expect((await getOrderRecord(orderId)).status).toBe('CANCELLED');
    expect((await getUser(player.userId)).consecutivePaymentFailures).toBe(1);
    expect((await getMerchant(member.merchantId)).consecutiveExpiries).toBe(1);
  });

  it('a Paid tap that races a change of hands is refused, not marked paid to the new member', async () => {
    // The player's tap reads the order (member A, A's account), then waits on
    // the order lock while it moves to member B. Without the member pinned in
    // the transition, the order would read PAID to B for money sent to A.
    const { orderId, player } = await bankBuy({ accept: true });
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
