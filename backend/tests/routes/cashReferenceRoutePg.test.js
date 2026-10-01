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
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pgConfigured, applySchema, closePg, pgQuery } from '#db/client.js';
import { createOrderRecord, getOrderRecord } from '#db/repositories/orders.record.js';
import router from '../../domains/payment/payment.routes.js';
import { mountRouter, actor, merchantActor, as } from './_harness.js';

const describePg = pgConfigured() ? describe : describe.skip;

describePg('a cash player submits the payment reference after Paid', () => {
  const RUN = Math.random().toString(36).slice(2, 8);
  let seq = 0;
  let app;
  const utr = () => `CR${RUN}${String((seq += 1)).padStart(6, '0')}`;

  beforeAll(async () => {
    await applySchema();
    app = mountRouter(router);
  }, 60_000);
  afterAll(async () => { await closePg(); });

  /** A deposit at PAID with no reference: the state the cash rail's split creates. */
  const paidOrder = async ({ paymentMode = 'CASH_ATM' } = {}) => {
    const merchant = await merchantActor({ tokensRupees: 50_000 });
    const player = await actor({});
    const orderId = `CRR-${RUN}-${(seq += 1)}`;
    await createOrderRecord({
      orderId, userId: player.userId, type: 'DEPOSIT',
      tokenAmountRupees: 1000, fiatAmountRupees: 1000,
      state: 'PAID', merchantId: merchant.merchantId, paymentMode,
    });
    return { orderId, player };
  };
  const submit = (who, orderId, utrNumber) =>
    as(app, who).post(`/order/${orderId}/payment-reference`).send({ utrNumber });
  const claimsFor = async (orderId) => (await pgQuery(
    'SELECT utr FROM utr_registry WHERE order_id = $1', [orderId])).rows.map((r) => r.utr);

  it('records the reference on the order and claims it once', async () => {
    const { orderId, player } = await paidOrder();
    const ref = utr();
    const res = await submit(player, orderId, ref);
    expect(res.status, res.body?.message).toBe(200);
    expect((await getOrderRecord(orderId)).utrNumber).toBe(ref.toUpperCase());
    expect(await claimsFor(orderId)).toEqual([ref.toUpperCase()]);
  });

  it('refuses a second reference to an order that has one, and claims nothing for it', async () => {
    const { orderId, player } = await paidOrder();
    const first = utr();
    expect((await submit(player, orderId, first)).status).toBe(200);
    const res = await submit(player, orderId, utr());
    expect(res.status).toBe(409);
    expect(await claimsFor(orderId)).toEqual([first.toUpperCase()]);
  });

  it('two DIFFERENT references sent together: exactly one lands, and one is claimed', async () => {
    const { orderId, player } = await paidOrder();
    const a = utr();
    const b = utr();
    const [ra, rb] = await Promise.all([submit(player, orderId, a), submit(player, orderId, b)]);
    const ok = [ra, rb].filter((r) => r.status === 200);
    expect(ok.length, `both answered ${ra.status}/${rb.status}`).toBe(1);
    const claimed = await claimsFor(orderId);
    expect(claimed.length, `references claimed for one order: ${claimed.join(', ')}`).toBe(1);
    expect((await getOrderRecord(orderId)).utrNumber).toBe(claimed[0]);
  });

  it('refuses on the UPI rail, where the reference comes WITH the payment', async () => {
    const { orderId, player } = await paidOrder({ paymentMode: 'P2P_UPI' });
    const res = await submit(player, orderId, utr());
    expect(res.status).toBe(400);
    expect(await claimsFor(orderId)).toEqual([]);
  });

  it('does not let another player submit a reference to somebody else\'s order', async () => {
    const { orderId } = await paidOrder();
    const stranger = await actor({});
    const res = await submit(stranger, orderId, utr());
    expect([403, 404]).toContain(res.status);
    expect(await claimsFor(orderId)).toEqual([]);
  });
});
