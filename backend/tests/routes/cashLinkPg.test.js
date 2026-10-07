// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * A cash buy is paid through the ATM the member scans (Step 2d).
 *
 * The member picks the order amount on a machine offering UPI cash withdrawal
 * and scans its QR; the link it decodes is what the player pays, and the
 * machine hands the member the cash. So:
 *
 *   • before the scan the player is given nothing to pay — not the member's own
 *     handle — and cannot say they paid;
 *   • only the assigned member can attach a link, only to a cash buy, only for
 *     the order's own amount, and only until the player says they paid;
 *   • a link never survives the order changing hands;
 *   • a cash buy that lapses with no link is the member's, not the player's.
 *
 * Every order is one production makes (§32 S16): a ₹1,000 buy is a CASH order
 * by its size, created through `createDepositOrder` and ROUTED to the one
 * member of a working CASH team who is online and has pressed Ready.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pgConfigured, applySchema, closePg, pgQuery, withTransaction } from '#db/client.js';
import { getOrderRecord, setCashLink } from '#db/repositories/orders.record.js';
import { getMerchant } from '#db/repositories/merchants.js';
import { getUser, updateUser } from '#db/repositories/users.js';
import { PAYMENT_MODES, setCashReady } from '#db/repositories/teamRouting.js';
import { markOrderPaid as markOrderPaidState } from '../../domains/payment/orderLifecycle.service.js';
import { creditWinnings } from '../../domains/wallet/walletAuthority.service.js';
import {
  createDepositOrder, createWithdrawalOrder, expireOrders,
} from '../../domains/payment/paymentProcessing.service.js';
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

/** What an ATM's QR decodes to, for a given amount. */
const atm = (amount, tr = 'ATM1') => `upi://pay?pa=atm.cash@icici&pn=ICICI%20ATM&am=${amount}.00&cu=INR&tr=${tr}&mc=6011`;

describePg('a cash buy is paid through the machine the member scans', () => {
  let playerApp, merchantApp;
  const RUN = Math.random().toString(36).slice(2, 8);
  let seq = 0;
  const teams = teamFixture();
  const made = [];
  const utr = () => `UTRCL${RUN}${Date.now().toString(36)}${seq += 1}`.toUpperCase();

  beforeAll(async () => {
    await applySchema();
    playerApp = mountRouter((await import('../../domains/payment/payment.routes.js')).default);
    merchantApp = mountRouter((await import('../../domains/merchant/merchant.routes.js')).default);
  }, 60_000);

  afterAll(async () => {
    // Trap 10: this run's orders, then its teams.
    await withTransaction(async (c) => {
      await c.query('SET LOCAL session_replication_role = replica');
      await c.query('DELETE FROM order_transitions WHERE order_id = ANY($1)', [made]);
      await c.query('DELETE FROM order_states WHERE order_id = ANY($1)', [made]);
    });
    await teams.cleanup();
    await closePg();
  });

  /** A ₹1,000 cash buy, routed to a fresh member of a working CASH team and accepted by them. */
  const cashBuy = async ({ accept = true } = {}) => {
    const player = await actor({});
    const member = await merchantActor({});
    await teams.workingTeam({ rail: 'CASH', poolTokens: 10_000, include: [member.merchantId] });
    expect(await setCashReady(member.merchantId, true)).toEqual({ ok: true, ready: true });
    const { order } = await createDepositOrder(player.userId, 1000);
    const orderId = order.orderId ?? order._id;
    made.push(orderId);
    const row = await getOrderRecord(orderId);
    expect(row.status, 'the cash buy was not routed').toBe('ASSIGNED');
    expect(row.merchantId).toBe(String(member.merchantId));
    expect(row.paymentMode).toBe(PAYMENT_MODES.CASH_ATM);
    if (accept) {
      const res = await as(merchantApp, member).post(`/accept/${orderId}`).send({});
      expect(res.status, res.body.message).toBe(200);
    }
    return { orderId, player, member };
  };

  const scan = (who, orderId, link) =>
    as(merchantApp, who).post(`/orders/${orderId}/cash-link`).send({ link });
  const status = async (who, orderId) =>
    (await as(playerApp, who).get(`/order/${orderId}/status`)).body;

  it('before the scan the player is given nothing to pay, and cannot say they paid', async () => {
    const { orderId, player } = await cashBuy();
    const seen = await status(player, orderId);
    // Not the member's own handle: a cash buy is never paid to the member.
    expect(seen.payTo?.paymentLink).toBeUndefined();
    expect(JSON.stringify(seen)).not.toMatch(/upi:\/\//);

    const paid = await as(playerApp, player).post(`/order/${orderId}/mark-paid`).send({});
    expect(paid.status).toBe(409);
    expect(paid.body.code).toBe('CASH_LINK_PENDING');
    expect((await getOrderRecord(orderId)).status).toBe('PROCESSING');
  });

  it('nothing is scanned, shown or paid before the member accepts: they may still decline', async () => {
    const { orderId, player, member } = await cashBuy({ accept: false });
    const early = await scan(member, orderId, atm(1000));
    expect(early.status).toBe(409);
    expect(early.body.code).toBe('ACCEPT_FIRST');
    expect((await getOrderRecord(orderId)).cashLink).toBeNull();
    // The writer itself refuses it too (the route is not the only caller).
    expect(await setCashLink(orderId, member.merchantId, atm(1000))).toBeNull();
    const paid = await as(playerApp, player).post(`/order/${orderId}/mark-paid`).send({});
    expect(paid.status).toBe(409);
    expect(paid.body.code).toBe('NOT_ACCEPTED_YET');
    expect((await getOrderRecord(orderId)).status).toBe('ASSIGNED');
  });

  it('a buy the member never accepted lapses on the member, not the player', async () => {
    const { orderId, player, member } = await cashBuy({ accept: false });
    await pgQuery(`UPDATE order_states SET expires_at = now() - interval '1 minute' WHERE order_id = $1`, [orderId]);
    await expireOrders();
    expect((await getOrderRecord(orderId)).status).toBe('CANCELLED');
    expect((await getUser(player.userId)).consecutivePaymentFailures).toBe(0);
    expect((await getMerchant(member.merchantId)).consecutiveExpiries).toBe(1);
  });

  it('the member scans, and the player is given exactly that link to pay', async () => {
    const { orderId, player, member } = await cashBuy();
    const link = atm(1000);
    const res = await scan(member, orderId, link);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.order.cashLink).toBe(link);
    expect(res.body.order.cashLinkAt).toBeTruthy();

    const row = await getOrderRecord(orderId);
    expect(row.cashLink).toBe(link);
    const seen = await status(player, orderId);
    expect(seen.payTo.paymentLink).toBe(link);
    // The link travels as the payment destination and nowhere else.
    expect(seen.cashLink).toBeUndefined();

    // And now the tap is accepted: PAID, the reference to follow.
    const paid = await as(playerApp, player).post(`/order/${orderId}/mark-paid`).send({});
    expect(paid.status, JSON.stringify(paid.body)).toBe(200);
    expect((await getOrderRecord(orderId)).status).toBe('PAID');
  });

  it('a second scan replaces the first until the player says they paid, and not after', async () => {
    const { orderId, player, member } = await cashBuy();
    expect((await scan(member, orderId, atm(1000, 'FIRST'))).status).toBe(200);
    expect((await scan(member, orderId, atm(1000, 'SECOND'))).status).toBe(200);
    expect((await getOrderRecord(orderId)).cashLink).toBe(atm(1000, 'SECOND'));

    expect((await as(playerApp, player).post(`/order/${orderId}/mark-paid`).send({ utrNumber: utr() })).status).toBe(200);
    const late = await scan(member, orderId, atm(1000, 'THIRD'));
    expect(late.status).toBe(409);
    expect(late.body.code).toBe('CASH_LINK_CLOSED');
    // What was paid is what stays on the order.
    expect((await getOrderRecord(orderId)).cashLink).toBe(atm(1000, 'SECOND'));
  });

  it('refuses a QR for another amount, and stores nothing', async () => {
    const { orderId, member } = await cashBuy();
    const res = await scan(member, orderId, atm(5000));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_CASH_LINK');
    expect(res.body.message).toMatch(/₹5,000.*₹1,000/);
    expect((await getOrderRecord(orderId)).cashLink).toBeNull();
  });

  it('refuses something that is not a UPI payment link', async () => {
    const { orderId, member } = await cashBuy();
    for (const link of ['https://example.com/pay', 'javascript:alert(1)', '', undefined]) {
      const res = await scan(member, orderId, link);
      expect(res.status, String(link)).toBe(400);
      expect(res.body.code).toBe('INVALID_CASH_LINK');
    }
    expect((await getOrderRecord(orderId)).cashLink).toBeNull();
  });

  it('a member it is not assigned to cannot attach one', async () => {
    const { orderId } = await cashBuy();
    const stranger = await merchantActor({});
    const res = await scan(stranger, orderId, atm(1000));
    expect(res.status).toBe(404);
    expect((await getOrderRecord(orderId)).cashLink).toBeNull();
  });

  it('a sell is not paid through a machine', async () => {
    const player = await actor({});
    const member = await merchantActor({});
    await teams.workingTeam({ rail: 'CASH', include: [member.merchantId] });
    await updateUser(player.userId, {
      bankDetails: { accountNumber: '000111222333', ifscCode: 'TEST0000001', bankName: 'Test Bank', accountHolderName: 'Cash Link Test' },
    });
    await creditWinnings(player.userId, 1000, 'cash link float', 'Test', `cl-${RUN}-${seq}`, `cl_${RUN}_${seq += 1}`);
    const { orderId } = (await createWithdrawalOrder(player.userId, 1000)).order;
    made.push(orderId);
    expect((await getOrderRecord(orderId)).merchantId).toBe(member.merchantId);
    const res = await scan(member, orderId, atm(1000));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('NOT_A_CASH_BUY');
  });

  it('the link does not survive the order changing hands', async () => {
    // Whichever path moves it: the schema clears the link in the same UPDATE.
    const { orderId, member } = await cashBuy();
    expect((await scan(member, orderId, atm(1000))).status).toBe(200);
    const next = await merchantActor({});
    await pgQuery('UPDATE order_states SET merchant_id = $2 WHERE order_id = $1', [orderId, next.merchantId]);
    const row = await getOrderRecord(orderId);
    expect(row.cashLink).toBeNull();
    expect(row.cashLinkAt).toBeNull();
  });

  it('the writer itself asks who and when, not only the route in front of it', async () => {
    // The route reads first; a reassignment or a tap can land between that read
    // and this write, so the guards are in the UPDATE's WHERE (trap 18).
    const { orderId, player, member } = await cashBuy();
    const stranger = await merchantActor({});
    expect(await setCashLink(orderId, stranger.merchantId, atm(1000))).toBeNull();
    expect((await getOrderRecord(orderId)).cashLink).toBeNull();

    expect(await setCashLink(orderId, member.merchantId, atm(1000, 'PAID'))).not.toBeNull();
    expect((await as(playerApp, player).post(`/order/${orderId}/mark-paid`).send({})).status).toBe(200);
    expect(await setCashLink(orderId, member.merchantId, atm(1000, 'LATE'))).toBeNull();
    expect((await getOrderRecord(orderId)).cashLink).toBe(atm(1000, 'PAID'));
  });

  it('a Paid tap that races a change of hands is refused, not left PAID with no link', async () => {
    // The player's tap reads the order (member A, A's link), then waits on the
    // order lock while it moves to member B, which clears the link. Without the
    // member pinned in the transition, the tap would then make it PAID with
    // nothing paid to B's machine.
    const { orderId, player, member } = await cashBuy();
    expect((await scan(member, orderId, atm(1000))).status).toBe(200);
    const next = await merchantActor({});
    let tap;
    await withTransaction(async (c) => {
      const holder = (await c.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      await c.query('SELECT 1 FROM order_states WHERE order_id = $1 FOR UPDATE', [orderId]);
      tap = as(playerApp, player).post(`/order/${orderId}/mark-paid`).send({}).then((r) => r);
      await untilBlocked('SELECT * FROM order_states WHERE order_id = $1 FOR UPDATE%', [holder]);
      await c.query('UPDATE order_states SET merchant_id = $2 WHERE order_id = $1', [orderId, next.merchantId]);
    });
    const res = await tap;
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.code).toBe('merchant_changed');
    expect(res.body.message).toMatch(/moved to another member/);
    const row = await getOrderRecord(orderId);
    expect(row.status).toBe('PROCESSING');
    expect(row.cashLink).toBeNull();
  });

  it('a Paid tap names the member it read, so a change of hands cannot slip under it', async () => {
    // The link goes only with the member. Between the player's read and the
    // move, a reassignment would leave PAID with no link, or paid to the last
    // member's machine; the transition refuses it in its WHERE instead.
    const { orderId, member } = await cashBuy();
    expect((await scan(member, orderId, atm(1000))).status).toBe(200);
    const next = await merchantActor({});
    await pgQuery('UPDATE order_states SET merchant_id = $2 WHERE order_id = $1', [orderId, next.merchantId]);
    const moved = await markOrderPaidState(orderId, {
      expectFrom: ['PROCESSING'], expectMerchant: member.merchantId,
    });
    expect(moved.ok).toBe(false);
    expect(moved.reason).toBe('merchant_changed');
    expect((await getOrderRecord(orderId)).status).toBe('PROCESSING');
  });

  it('a cash buy that lapses with no link counts on the member, not the player', async () => {
    const { orderId, player, member } = await cashBuy();
    await pgQuery(`UPDATE order_states SET expires_at = now() - interval '1 minute' WHERE order_id = $1`, [orderId]);
    await expireOrders();
    expect((await getOrderRecord(orderId)).status).toBe('CANCELLED');
    expect((await getUser(player.userId)).consecutivePaymentFailures).toBe(0);
    expect((await getMerchant(member.merchantId)).consecutiveExpiries).toBe(1);
  });

  it('one that lapses after the scan is the player\'s, as any unpaid buy is', async () => {
    // The opposite case: the fix must not excuse a player who was given a link.
    const { orderId, player, member } = await cashBuy();
    expect((await scan(member, orderId, atm(1000))).status).toBe(200);
    await pgQuery(`UPDATE order_states SET expires_at = now() - interval '1 minute' WHERE order_id = $1`, [orderId]);
    await expireOrders();
    expect((await getOrderRecord(orderId)).status).toBe('CANCELLED');
    expect((await getUser(player.userId)).consecutivePaymentFailures).toBe(1);
    expect((await getMerchant(member.merchantId)).consecutiveExpiries).toBe(1);
  });
});
