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
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pgConfigured, applySchema, closePg, pgQuery } from '#db/client.js';
import { createOrderRecord, getOrderRecord } from '#db/repositories/orders.record.js';
import {
  findUnansweredPaidDeposits, findPaidDepositsAwaitingReference,
} from '#db/repositories/orders.record.js';
import { actor, merchantActor } from './_harness.js';

const describePg = pgConfigured() ? describe : describe.skip;

describePg('a cash buy reaches PAID before it is evidenced', () => {
  const RUN = Math.random().toString(36).slice(2, 8);
  let seq = 0;
  const oid = () => `CPR-${RUN}-${seq += 1}`;

  beforeAll(async () => { await applySchema(); }, 60_000);
  afterAll(async () => { await closePg(); });

  /** A cash deposit sitting at PAID, with or without its reference. */
  const paidCash = async ({ utrNumber = null, minutesAgo = 0 } = {}) => {
    const merchant = await merchantActor({ tokensRupees: 50_000 });
    const player = await actor({});
    const orderId = oid();
    await createOrderRecord({
      orderId, userId: player.userId, type: 'DEPOSIT',
      tokenAmountRupees: 1000, fiatAmountRupees: 1000,
      state: 'PAID', merchantId: merchant.merchantId,
      paymentMode: 'CASH_ATM',
      ...(utrNumber ? { utrNumber } : {}),
    });
    // `paid_at` is what both sweeps measure from, and `createOrderRecord` does
    // not set it — so it is written here rather than left null, which would
    // make the order invisible to both and the test vacuous.
    await pgQuery(
      `UPDATE order_states SET paid_at = now() - make_interval(mins => $2) WHERE order_id = $1`,
      [orderId, minutesAgo],
    );
    return { orderId, merchant, player };
  };

  it('the merchant timeout SKIPS an order with no reference', async () => {
    // The merchant cannot act on it, so their silence is not a refusal. Before
    // this clause the player's delay recorded against the merchant and, at
    // three, suspended them.
    const { orderId } = await paidCash({ minutesAgo: 120 });
    const due = await findUnansweredPaidDeposits({ olderThanMinutes: 30 });
    expect(due.map((o) => o.orderId)).not.toContain(orderId);
  });

  it('the merchant timeout still catches one that IS evidenced', async () => {
    // The guard must not switch the merchant's own timeout off.
    const { orderId } = await paidCash({ utrNumber: `UTRC${RUN}${seq}`.toUpperCase(), minutesAgo: 120 });
    const due = await findUnansweredPaidDeposits({ olderThanMinutes: 30 });
    expect(due.map((o) => o.orderId)).toContain(orderId);
  });

  it('the player timeout catches the unevidenced one, and only it', async () => {
    const unevidenced = await paidCash({ minutesAgo: 120 });
    const evidenced = await paidCash({ utrNumber: `UTRD${RUN}${seq}`.toUpperCase(), minutesAgo: 120 });
    const due = await findPaidDepositsAwaitingReference({ olderThanMinutes: 15 });
    const ids = due.map((o) => o.orderId);
    expect(ids).toContain(unevidenced.orderId);
    expect(ids).not.toContain(evidenced.orderId);
  });

  it('leaves one inside the window alone', async () => {
    // The player is still looking for the reference. Sweeping at two minutes
    // would dispute an order that is going to be fine.
    const { orderId } = await paidCash({ minutesAgo: 2 });
    const due = await findPaidDepositsAwaitingReference({ olderThanMinutes: 15 });
    expect(due.map((o) => o.orderId)).not.toContain(orderId);
  });

  it('does not reach across to the UPI rail', async () => {
    // The split is the ATM's clock. There is no machine on a UPI transfer, so
    // mark-paid there still requires the reference and this sweep must never
    // see one of its orders.
    const merchant = await merchantActor({ tokensRupees: 50_000 });
    const player = await actor({});
    const orderId = oid();
    await createOrderRecord({
      orderId, userId: player.userId, type: 'DEPOSIT',
      tokenAmountRupees: 1000, fiatAmountRupees: 1000,
      state: 'PAID', merchantId: merchant.merchantId, paymentMode: 'P2P_UPI',
    });
    await pgQuery(
      `UPDATE order_states SET paid_at = now() - make_interval(mins => 120) WHERE order_id = $1`,
      [orderId],
    );
    const due = await findPaidDepositsAwaitingReference({ olderThanMinutes: 15 });
    expect(due.map((o) => o.orderId)).not.toContain(orderId);
  });

  it('the order really is PAID with no reference — the state the split creates', async () => {
    const { orderId } = await paidCash({});
    const row = await getOrderRecord(orderId);
    expect(row.state ?? row.status).toBe('PAID');
    expect(String(row.utrNumber ?? '')).toBe('');
  });
});
