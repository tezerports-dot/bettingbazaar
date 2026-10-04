// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * On the CASH rail, "I have paid" and "here is the reference" are two steps.
 *
 * ── Why the split exists ────────────────────────────────────────────────────
 * Every other rail asks for the reference with the payment, because the player
 * is at their own phone and can read it off a banking app. At a cash machine
 * they are not: the MERCHANT is standing at the ATM with a session that times
 * out, and making them wait while the player hunts for a twelve-character bank
 * reference loses the machine, and with it the player's turn at it.
 *
 * So a cash buy reaches PAID on the tap — which is what unblocks the merchant
 * to continue at the machine — and the reference follows. What does NOT move
 * is the money: Confirm refuses until the reference is on the row, so PAID
 * here means "the player says they paid", never "evidenced".
 *
 * ── The two halves that must not be one ─────────────────────────────────────
 * `sweepUnansweredPaidDeposits` records a REFUSAL against a merchant who
 * ignores a paid order. These orders are ones the merchant CANNOT act on. Run
 * as one sweep, a player's delay suspends an honest merchant — §2 in as many
 * words: whose fault an expiry is depends on the DIRECTION. So the merchant
 * sweep now skips orders with no reference, and `sweepUtrAfterPaid` owns them.
 *
 * ── How the orders are made (PROJECT_STATUS §3.10, 2c) ──────────────────────
 * Through the real path, so every row is one the platform can produce (§32
 * S16): a ₹1,000 buy is a CASH order by its size, ROUTED to the one member of
 * a working CASH team who is online and has pressed Ready, and the PLAYER taps
 * Paid through `markOrderPaid` — with a reference, or without one, which only
 * the cash rail allows. Only the clock is moved: `paid_at` is set back to
 * stand for the minutes that would otherwise have to pass.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pgConfigured, applySchema, closePg, pgQuery } from '#db/client.js';
import {
  getOrderRecord, findUnansweredPaidDeposits, findPaidDepositsAwaitingReference,
} from '#db/repositories/orders.record.js';
import { PAYMENT_MODES, setCashReady } from '#db/repositories/teamRouting.js';
import { createDepositOrder, markOrderPaid } from '../../domains/payment/paymentProcessing.service.js';
import { teamFixture, readyToPay } from '../teamFixture.js';
import { actor } from './_harness.js';

const describePg = pgConfigured() ? describe : describe.skip;

describePg('a cash buy reaches PAID before it is evidenced', () => {
  const teams = teamFixture();
  const RUN = Math.random().toString(36).slice(2, 8);
  let seq = 0;
  // Unique per order and per run: a reference belongs to one order for good,
  // and `utr_registry` is never reset between runs (trap 10).
  const utr = () => `UTRC${RUN}${Date.now().toString(36)}${seq += 1}`.toUpperCase();

  const players = [];
  // A cash member holds ONE open order, and every order here stays PAID — so
  // each fixture takes the next member of the team.
  let cashTeam;
  let turn = 0;
  let upiTeam;

  beforeAll(async () => {
    await applySchema();
    cashTeam = await teams.workingTeam({ rail: 'CASH', poolTokens: 10_000 });
    upiTeam = await teams.workingTeam({ rail: 'UPI_BANK', poolTokens: 50_000 });
  }, 120_000);

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
    await teams.cleanup();
    await closePg();
  });

  const player = async () => {
    const p = await actor({});
    players.push(p.userId);
    return p;
  };

  /** A cash deposit the player has tapped Paid on, with or without its reference. */
  const paidCash = async ({ utrNumber = undefined, minutesAgo = 0 } = {}) => {
    const member = cashTeam.members[turn % cashTeam.members.length];
    turn += 1;
    await teams.onlyOnline([member]);
    const ready = await setCashReady(member, true);
    expect(ready.ok).toBe(true);
    const p = await player();
    const { order } = await createDepositOrder(p.userId, 1000);
    const orderId = order.orderId ?? order._id;
    const routed = await getOrderRecord(orderId);
    expect(routed.status, 'the cash buy was not routed to the ready member').toBe('ASSIGNED');
    expect(routed.merchantId).toBe(String(member));
    expect(routed.paymentMode).toBe(PAYMENT_MODES.CASH_ATM);

    await readyToPay(orderId);
    await markOrderPaid(p.userId, orderId, utrNumber);
    // `paid_at` is what both sweeps measure from, and the tap wrote it as NOW.
    // Moving it back stands for the minutes that would otherwise have to pass.
    await pgQuery(
      'UPDATE order_states SET paid_at = now() - make_interval(mins => $2) WHERE order_id = $1',
      [orderId, minutesAgo],
    );
    return { orderId, merchantId: member, player: p };
  };

  it('the order really is PAID with no reference — the state the split creates', async () => {
    const { orderId } = await paidCash({});
    const row = await getOrderRecord(orderId);
    expect(row.status).toBe('PAID');
    expect(String(row.utrNumber ?? '')).toBe('');
  });

  it('the merchant timeout SKIPS an order with no reference', async () => {
    // The merchant cannot act on it, so their silence is not a refusal. Before
    // this clause the player's delay recorded against the merchant and, at
    // three, suspended them.
    const { orderId } = await paidCash({ minutesAgo: 120 });
    const due = await findUnansweredPaidDeposits({ olderThanMinutes: 30, limit: 1000 });
    expect(due.map((o) => o.orderId)).not.toContain(orderId);
  });

  it('the merchant timeout still catches one that IS evidenced', async () => {
    // The guard must not switch the merchant's own timeout off.
    const { orderId, merchantId } = await paidCash({ utrNumber: utr(), minutesAgo: 120 });
    const due = await findUnansweredPaidDeposits({ olderThanMinutes: 30, limit: 1000 });
    const hit = due.find((o) => o.orderId === orderId);
    expect(hit, 'an evidenced order the merchant ignored was not caught').toBeTruthy();
    expect(hit.merchantId).toBe(String(merchantId));
  });

  it('the player timeout catches the unevidenced one, and only it', async () => {
    const unevidenced = await paidCash({ minutesAgo: 120 });
    const evidenced = await paidCash({ utrNumber: utr(), minutesAgo: 120 });
    const due = await findPaidDepositsAwaitingReference({ olderThanMinutes: 15, limit: 1000 });
    const ids = due.map((o) => o.orderId);
    expect(ids).toContain(unevidenced.orderId);
    expect(ids).not.toContain(evidenced.orderId);
  });

  it('leaves one inside the window alone', async () => {
    // The player is still looking for the reference. Sweeping at two minutes
    // would dispute an order that is going to be fine.
    const { orderId } = await paidCash({ minutesAgo: 2 });
    const due = await findPaidDepositsAwaitingReference({ olderThanMinutes: 15, limit: 1000 });
    expect(due.map((o) => o.orderId)).not.toContain(orderId);
  });

  it('does not reach across to the UPI rail — a UPI buy cannot be PAID without its reference', async () => {
    // The split is the ATM's clock. There is no machine on a UPI transfer, so
    // the tap there still requires the reference, and the player's sweep can
    // never be handed one of its orders. Asserted at the source: the tap with
    // no reference is REFUSED and the order stays where it was — rather than by
    // staging a UPI row at PAID with no reference, a row the platform cannot
    // produce (§32 S16).
    const [member] = upiTeam.members;
    await teams.onlyOnline([member]);
    const p = await player();
    const { order } = await createDepositOrder(p.userId, 50_000);
    const orderId = order.orderId ?? order._id;
    const routed = await getOrderRecord(orderId);
    expect(routed.status).toBe('ASSIGNED');
    expect(routed.paymentMode).toBe(PAYMENT_MODES.P2P_UPI);
    await readyToPay(orderId);

    await expect(markOrderPaid(p.userId, orderId, undefined)).rejects.toMatchObject({ status: 400 });
    const row = await getOrderRecord(orderId);
    expect(row.status).toBe('PROCESSING');
    expect(row.paidAt ?? null).toBeNull();
    const due = await findPaidDepositsAwaitingReference({ olderThanMinutes: 0, limit: 1000 });
    expect(due.map((o) => o.orderId)).not.toContain(orderId);
  });
});
