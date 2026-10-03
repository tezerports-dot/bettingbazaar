// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Who may act on an order, and whether the order came from this system.
 *
 * ── Why this file exists ────────────────────────────────────────────────────
 * `ORDER_HMAC_SECRET` is a REQUIRED boot variable, and for a long time no
 * request path read the tag back. Then the guard below was mounted — and the
 * tag was still decorative, because the one production creation path never
 * WROTE it and the guard passed an untagged order. Tamper evidence that
 * evidenced nothing, twice over. The first test below is the one that would
 * have caught the second time.
 *
 * `orderAccessGuard` was written to check it and was mounted on nothing. It
 * answered 403 for "not yours" while the helper it replaces answered 404 for
 * both that and "no such order". Order ids travel in URLs, and a
 * distinguishable answer tells someone probing which ids are real — asserted
 * below.
 *
 * ── Whose order (2026-10-01) ───────────────────────────────────────────────
 * The guard admits the order's OWNER and nobody else. Every route it guards is
 * behind `authenticatePlayer`, so a staff or merchant session is refused at the
 * door, before the guard runs, with the panel it belongs to (403 WRONG_PANEL).
 * The guard's "assigned merchant" and "full admin" branches existed for the
 * second deposit-confirm route, which no screen called and which was deleted;
 * a merchant's own session reaching the player's order through them is in
 * merchantSessionDoorPg.test.js.
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
import { verifyOrderHmac } from '../../middleware/order-crypto-access.js';
// Writing a row the application never would is a data-layer concern, so the
// statement lives under database/ where check:db-boundary allows it — see the
// note in that file for why no repository offers this.
import { corruptOrderHmac, clearOrderHmac } from '#db/tests/_tamperFixtures.js';
import { mountRouter, actor, as, request } from './_harness.js';

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

  it('writes a tag that verifies onto every order it creates', async () => {
    // The assertion that was missing. Every test above produced its tag by
    // WRITING one, so nothing checked that the platform ever did — and it did
    // not: the one production creation path left `order_hmac` NULL, the guard
    // waved untagged orders through, and its refusal had never run.
    const alice = await actor({});
    const orderId = await deposit(alice, null);
    const order = await getOrderRecord(orderId);
    expect(order.orderHmac).toMatch(/^[a-f0-9]{64}$/);
    expect(verifyOrderHmac(orderId, order.orderHmac)).toBe(true);
  });

  it('refuses an order whose tag was stripped', async () => {
    // There are no orders "from before the column existed" — this platform has
    // never held a live one (CLAUDE.md §0.0) — so a row with no tag did not come
    // from this system, exactly as a row with a wrong one did not.
    const alice = await actor({});
    const orderId = await deposit(alice, null);
    await clearOrderHmac(orderId);

    const stripped = await as(app, alice).get(`/order/${orderId}`);
    expect(stripped.status).toBe(404);
    expect(stripped.body.success).toBe(false);
  });

  // ── Staff on the PLAYER's order routes (2026-10-01) ─────────────────────
  // These routes are the player's. They admitted any staff account, so a
  // sub-admin trusted with nothing but chat could read any player's order and
  // raise a dispute recorded as raised by the player. A staff session is now
  // refused at the door, by name, before the guard is asked anything.
  const refusedAtTheDoor = (res) => {
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.code).toBe('WRONG_PANEL');
    expect(res.body.message).toMatch(/admin panel/);
    expect(res.body.order).toBeUndefined();
  };

  it('refuses a sub-admin, whatever they were given, on the player\'s order routes', async () => {
    const alice = await actor({});
    const orderId = await deposit(alice, null, { state: 'COMPLETED' });
    const chatOnly = await actor({ isSubAdmin: true, permissions: { canModerateChat: true } });
    const disputes = await actor({ isSubAdmin: true, permissions: { canResolveDisputes: true } });
    for (const staff of [chatOnly, disputes]) {
      refusedAtTheDoor(await as(app, staff).get(`/order/${orderId}`));
      refusedAtTheDoor(await as(app, staff).post(`/order/${orderId}/dispute`).send({ reason: 'not mine to raise' }));
    }
    // The order is exactly as the player left it: nobody raised anything for them.
    const after = await getOrderRecord(orderId);
    expect(after.status).toBe('COMPLETED');
    expect(after.disputeRaisedBy ?? null).toBeNull();
  });

  it('refuses a full admin too: an admin acts on orders through the admin routes', async () => {
    const alice = await actor({});
    const admin = await actor({ isAdmin: true });
    const orderId = await deposit(alice, null, { state: 'COMPLETED' });
    refusedAtTheDoor(await as(app, admin).get(`/order/${orderId}`));
    refusedAtTheDoor(await as(app, admin).post(`/order/${orderId}/dispute`).send({ reason: 'x' }));
    expect((await getOrderRecord(orderId)).status).toBe('COMPLETED');
  });

  it('still lets the PLAYER raise their own dispute (the opposite behaviour, §37)', async () => {
    const alice = await actor({});
    const orderId = await deposit(alice, null, { state: 'COMPLETED' });
    const res = await as(app, alice).post(`/order/${orderId}/dispute`).send({ reason: 'not credited' });
    expect(res.status).toBe(200);
    expect((await getOrderRecord(orderId)).status).toBe('DISPUTED');
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
      as(app, mallory).post(`/order/${orderId}/mark-paid`).send({ utrNumber: 'UTR123456789012' }),
    ];
    for (const call of calls) expect((await call).status).toBe(404);
  });

  it('refuses every one of them without a token', async () => {
    expect((await request(app).get('/order/anything')).status).toBe(401);
    expect((await request(app).get('/order/anything/status')).status).toBe(401);
  });
});
