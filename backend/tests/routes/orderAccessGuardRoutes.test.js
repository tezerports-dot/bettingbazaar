// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * Who may act on an order, and whether the order came from this system.
 *
 * ── Why this file exists ────────────────────────────────────────────────────
 * `order_hmac` is written on every order at creation, `ORDER_HMAC_SECRET` is a
 * REQUIRED boot variable, and until now no request path read the tag back. The
 * platform computed a signature for every order and never once checked one —
 * tamper evidence that evidenced nothing.
 *
 * `orderAccessGuard` was written to check it and was mounted on nothing. Two
 * defects had therefore never been exercised, and both are asserted below
 * because both would have shipped:
 *
 *   1. It recognised a merchant by `req.user.isMerchant`. A merchant arrives
 *      through `merchantAuth`, which sets `req.merchantId` and does NOT set
 *      `req.user` — so mounting it as written would have refused EVERY
 *      merchant confirm on the deposit path.
 *   2. It answered 403 for "not yours" while the helper it replaces answered
 *      404 for both that and "no such order". Order ids travel in URLs, and a
 *      distinguishable answer tells someone probing which ids are real.
 *
 * ── What the tag is and is not ──────────────────────────────────────────────
 * It is NOT authorisation: a forged id fails the ownership test regardless. It
 * detects a row that did not come from this system — an injected order, or one
 * whose id was edited in the database. So the test for it writes a bad tag
 * directly and asserts the request is refused.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pgConfigured, applySchema, closePg } from '#db/client.js';
import { createOrderRecord, getOrderRecord } from '#db/repositories/orders.record.js';
// Writing a row the application never would is a data-layer concern, so the
// statement lives under database/ where check:db-boundary allows it — see the
// note in that file for why no repository offers this.
import { corruptOrderHmac, clearOrderHmac } from '#db/tests/_tamperFixtures.js';
import { mountRouter, actor, merchantActor, as, request } from './_harness.js';

const describePg = pgConfigured() ? describe : describe.skip;

describePg('order access guard', () => {
  let app;
  let seq = 0;
  const oid = (p) => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}-${seq += 1}`;

  beforeAll(async () => {
    await applySchema();
    const mod = await import('../../domains/payment/payment.routes.js');
    app = mountRouter(mod.default);
  }, 60_000);

  afterAll(async () => { await closePg(); });

  /** A deposit belonging to `player`, assigned to `merchant`. */
  const deposit = async (player, merchant, { state = 'ASSIGNED' } = {}) => {
    const orderId = oid('gd');
    await createOrderRecord({
      orderId, userId: player.userId, type: 'DEPOSIT',
      tokenAmountRupees: 500, fiatAmountRupees: 500,
      state, merchantId: merchant?.merchantId ?? null,
      depositAllocation: 300, reserveAllocation: 200,
    });
    return orderId;
  };

  it('lets the order owner read their own order', async () => {
    const alice = await actor({});
    const orderId = await deposit(alice, null);
    const res = await as(app, alice).get(`/order/${orderId}`);
    expect(res.status).toBe(200);
    expect(res.body.order.orderId).toBe(orderId);
  });

  it('hands the handler the FULL record, not a twelve-field stub', async () => {
    // The guard fetched with `getOrder`, which maps twelve columns and omits
    // status, tokenAmount, the deposit/reserve split and the UTR. Handing that
    // to the handlers as req.p2pOrder leaves every rendered field undefined
    // with no error anywhere — a bug with a green test.
    const alice = await actor({});
    const orderId = await deposit(alice, null);
    const res = await as(app, alice).get(`/order/${orderId}`);
    expect(res.body.order.status).toBe('ASSIGNED');
    expect(Number(res.body.order.tokenAmount)).toBe(500);
    expect(Number(res.body.order.depositAllocation)).toBe(300);
    expect(Number(res.body.order.reserveAllocation)).toBe(200);
  });

  it("answers 404 — not 403 — for somebody else's order", async () => {
    // Indistinguishable from an order that does not exist. A 403 confirms the
    // id is real, and ids travel in URLs.
    const alice = await actor({});
    const mallory = await actor({});
    const orderId = await deposit(alice, null);

    const theirs = await as(app, mallory).get(`/order/${orderId}`);
    const nothing = await as(app, mallory).get(`/order/${oid('nope')}`);

    expect(theirs.status).toBe(404);
    expect(nothing.status).toBe(404);
    // Byte-identical, so the two cases cannot be told apart.
    expect(theirs.body).toEqual(nothing.body);
  });

  it('refuses an order whose tamper tag does not verify', async () => {
    // A row that did not come from this system: the tag is present and wrong.
    const alice = await actor({});
    const orderId = await deposit(alice, null);
    await corruptOrderHmac(orderId);

    const res = await as(app, alice).get(`/order/${orderId}`);
    expect(res.status).toBe(404);
    // Even the owner is refused — the question is not "whose order is this"
    // but "did this row come from us".
    expect(res.body.success).toBe(false);
  });

  it('still serves an order that predates the tag', async () => {
    // Orders written before the column existed carry none. Refusing those would
    // lock their owners out of their own money.
    const alice = await actor({});
    const orderId = await deposit(alice, null);
    await clearOrderHmac(orderId);

    expect((await as(app, alice).get(`/order/${orderId}`)).status).toBe(200);
  });

  it('recognises the assigned merchant, who arrives with no req.user at all', async () => {
    // The defect this replaces: the guard read `req.user.isMerchant`, which
    // merchantAuth never sets, so every merchant was refused. A 404 here would
    // mean the deposit confirm path is dead for every merchant on the platform.
    const alice = await actor({});
    const merchant = await merchantActor({ tokensRupees: 10_000 });
    const orderId = await deposit(alice, merchant, { state: 'PAID' });

    const res = await as(app, merchant).post(`/deposit/${orderId}/confirm`).send({});
    expect(res.status).not.toBe(404);
    expect(res.status).not.toBe(403);
  });

  it('refuses a merchant the order is not assigned to', async () => {
    const alice = await actor({});
    const mine = await merchantActor({ tokensRupees: 10_000 });
    const theirs = await merchantActor({ tokensRupees: 10_000 });
    const orderId = await deposit(alice, mine, { state: 'PAID' });

    const res = await as(app, theirs).post(`/deposit/${orderId}/confirm`).send({});
    expect(res.status).toBe(404);
    expect((await getOrderRecord(orderId)).status).toBe('PAID');
  });

  it('lets an admin through', async () => {
    const alice = await actor({});
    const admin = await actor({ isAdmin: true });
    const orderId = await deposit(alice, null);
    expect((await as(app, admin).get(`/order/${orderId}`)).status).toBe(200);
  });

  it('guards every :orderId route, not just the read', async () => {
    // The point of a middleware rather than a per-handler check: a route cannot
    // be added without it. Each of these belongs to alice.
    const alice = await actor({});
    const mallory = await actor({});
    const orderId = await deposit(alice, null, { state: 'PAID' });

    const calls = [
      as(app, mallory).get(`/order/${orderId}/status`),
      as(app, mallory).post(`/order/${orderId}/dispute`).send({ reason: 'let me in' }),
      as(app, mallory).post(`/order/${orderId}/status`).send({ status: 'DISPUTED' }),
      as(app, mallory).post(`/order/${orderId}/mark-paid`).send({ utrNumber: 'UTR123456789012' }),
    ];
    for (const call of calls) expect((await call).status).toBe(404);
  });

  it('refuses every one of them without a token', async () => {
    expect((await request(app).get('/order/anything')).status).toBe(401);
    expect((await request(app).get('/order/anything/status')).status).toBe(401);
  });
});
