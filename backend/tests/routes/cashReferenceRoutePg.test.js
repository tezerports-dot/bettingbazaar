// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * `POST /api/payment/order/:orderId/payment-reference` — the second half of a
 * CASH buy, through the real router and a real database.
 *
 * Route coverage (`npm run report:routes`, 2026-10-01) recorded this route as
 * reached by NOTHING in any tier, and `submitPaymentReference` had no test of
 * its own. It is the step that turns a merchant's Confirm on: until the
 * reference lands, a paid cash order cannot complete.
 *
 * §37's first/concurrent pair is asked of it directly: "this order already has
 * a reference" is a READ, and the claim and the write follow it in separate
 * statements — so two different references sent together are tried together.
 *
 * ── How the orders are made (PROJECT_STATUS §3.10, 2c) ──────────────────────
 * Through the real path (§32 S16): a ₹1,000 buy is a CASH order by its size,
 * routed to the one member of a working CASH team who is online and Ready, and
 * the player taps Paid with no reference — the state only the cash rail can
 * produce. The UPI case is a ₹20,000 buy routed to a UPI team and marked paid
 * the only way that rail allows: WITH its reference.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pgConfigured, applySchema, closePg, pgQuery } from '#db/client.js';
import { getOrderRecord } from '#db/repositories/orders.record.js';
import { PAYMENT_MODES, setCashReady } from '#db/repositories/teamRouting.js';
import { createDepositOrder, markOrderPaid } from '../../domains/payment/paymentProcessing.service.js';
import router from '../../domains/payment/payment.routes.js';
import { teamFixture } from '../teamFixture.js';
import { mountRouter, actor, as } from './_harness.js';

const describePg = pgConfigured() ? describe : describe.skip;

describePg('a cash player submits the payment reference after Paid', () => {
  const teams = teamFixture();
  const RUN = Math.random().toString(36).slice(2, 8);
  let seq = 0;
  let app;
  const utr = () => `CR${RUN}${String((seq += 1)).padStart(6, '0')}`;

  const players = [];
  // A cash member holds ONE open order and every order here stays PAID, so
  // each fixture takes the next member.
  let cashTeam;
  let upiTeam;
  let turn = 0;

  beforeAll(async () => {
    await applySchema();
    app = mountRouter(router);
    cashTeam = await teams.workingTeam({ rail: 'CASH', poolTokens: 10_000 });
    upiTeam = await teams.workingTeam({ rail: 'UPI_BANK', poolTokens: 20_000 });
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

  /** A cash deposit at PAID with no reference: the state the cash rail's split creates. */
  const paidOrder = async () => {
    const member = cashTeam.members[turn % cashTeam.members.length];
    turn += 1;
    await teams.onlyOnline([member]);
    expect((await setCashReady(member, true)).ok).toBe(true);
    const p = await player();
    const { order } = await createDepositOrder(p.userId, 1000);
    const orderId = order.orderId ?? order._id;
    const routed = await getOrderRecord(orderId);
    expect(routed.status, 'the cash buy was not routed to the ready member').toBe('ASSIGNED');
    expect(routed.paymentMode).toBe(PAYMENT_MODES.CASH_ATM);
    await markOrderPaid(p.userId, orderId, undefined);
    const paid = await getOrderRecord(orderId);
    expect(paid.status).toBe('PAID');
    expect(String(paid.utrNumber ?? '')).toBe('');
    return { orderId, player: p };
  };
  const submit = (who, orderId, utrNumber) =>
    as(app, who).post(`/order/${orderId}/payment-reference`).send({ utrNumber });
  const claimsFor = async (orderId) => (await pgQuery(
    'SELECT utr FROM utr_registry WHERE order_id = $1', [orderId])).rows.map((r) => r.utr);

  it('records the reference on the order and claims it once', async () => {
    const { orderId, player: p } = await paidOrder();
    const ref = utr();
    const res = await submit(p, orderId, ref);
    expect(res.status, res.body?.message).toBe(200);
    expect((await getOrderRecord(orderId)).utrNumber).toBe(ref.toUpperCase());
    expect(await claimsFor(orderId)).toEqual([ref.toUpperCase()]);
  });

  it('refuses a second reference to an order that has one, and claims nothing for it', async () => {
    const { orderId, player: p } = await paidOrder();
    const first = utr();
    expect((await submit(p, orderId, first)).status).toBe(200);
    const res = await submit(p, orderId, utr());
    expect(res.status).toBe(409);
    expect(await claimsFor(orderId)).toEqual([first.toUpperCase()]);
  });

  it('two DIFFERENT references sent together: exactly one lands, and one is claimed', async () => {
    const { orderId, player: p } = await paidOrder();
    const a = utr();
    const b = utr();
    const [ra, rb] = await Promise.all([submit(p, orderId, a), submit(p, orderId, b)]);
    const ok = [ra, rb].filter((r) => r.status === 200);
    expect(ok.length, `both answered ${ra.status}/${rb.status}`).toBe(1);
    const claimed = await claimsFor(orderId);
    expect(claimed.length, `references claimed for one order: ${claimed.join(', ')}`).toBe(1);
    expect((await getOrderRecord(orderId)).utrNumber).toBe(claimed[0]);
  });

  it('refuses on the UPI rail, where the reference comes WITH the payment', async () => {
    // A UPI buy reaches PAID only with its reference (`markOrderPaid` refuses
    // the tap without one), so the order here carries the player's own UTR —
    // and a second one sent afterwards is refused by the RAIL, before the
    // "already has one" check, and claims nothing.
    const [member] = upiTeam.members;
    await teams.onlyOnline([member]);
    const p = await player();
    const { order } = await createDepositOrder(p.userId, 20_000);
    const orderId = order.orderId ?? order._id;
    expect((await getOrderRecord(orderId)).paymentMode).toBe(PAYMENT_MODES.P2P_UPI);
    const original = utr();
    await markOrderPaid(p.userId, orderId, original);
    expect(await claimsFor(orderId)).toEqual([original.toUpperCase()]);

    const res = await submit(p, orderId, utr());
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/submitted with the payment/i);
    expect(await claimsFor(orderId)).toEqual([original.toUpperCase()]);
    expect((await getOrderRecord(orderId)).utrNumber).toBe(original.toUpperCase());
  });

  it('does not let another player submit a reference to somebody else\'s order', async () => {
    const { orderId } = await paidOrder();
    const stranger = await player();
    const res = await submit(stranger, orderId, utr());
    expect([403, 404]).toContain(res.status);
    expect(await claimsFor(orderId)).toEqual([]);
  });
});
