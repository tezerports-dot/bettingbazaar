// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * The admin's treasury routes: minting tokens into a merchant's wallet, taking
 * them back, and deciding a merchant's token purchase.
 *
 * ── The defect these exist to keep dead ─────────────────────────────────────
 * `/merchants/:id/fund` shipped with `txId: mw_topup_${new ObjectId()}` — a
 * FRESH key on every delivery, which is `random()`. The UNIQUE column behind it
 * could never collide, so every retry of a top-up funded the merchant a second
 * time while the code read as though it were protected. `/deduct` had the same
 * shape. The fix was not a better generated key: only the caller can tell a
 * retry from a second deliberate top-up, so the key is now REQUIRED from them
 * and a missing one is a 400.
 *
 * A generated fallback would restore exactly the illusion, so the tests below
 * assert both halves: the same key twice moves money once, and no key at all
 * moves nothing.
 *
 * ── And the ordering one ────────────────────────────────────────────────────
 * `/merchant-token-orders/:id/approve` used to mark the order APPROVED, then
 * mint, then credit — and on failure roll the mint back AND reset the order to
 * PENDING. Its own comment described the hazard: the reset "puts the order back
 * in reach of the guard while the mint stays spent". The money moves first now,
 * keyed on the order, so a failure leaves it PENDING with nothing to undo.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pgConfigured, applySchema, closePg, pgQuery } from '#db/client.js';
import { getMerchant } from '#db/repositories/merchants.js';
import { createTokenOrder, getTokenOrder } from '#db/repositories/paymentConfig.js';
import { getMerchantTokenBalance } from '../../domains/merchant/merchantWallet.service.js';
import { mountRouter, actor, merchantActor, as, request } from './_harness.js';

const describePg = pgConfigured() ? describe : describe.skip;

describePg('merchant admin routes', () => {
  let app; let admin;
  const RUN = Math.random().toString(36).slice(2, 8);
  let seq = 0;
  const key = (label) => `rt-${RUN}-${label}-${(seq += 1)}`;

  beforeAll(async () => {
    await applySchema();
    const mod = await import('../../domains/merchant/merchant.admin.routes.js');
    app = mountRouter(mod.default);
    admin = await actor({ isAdmin: true, roles: ['admin'] });
  }, 60_000);

  afterAll(async () => { await closePg(); });

  /** POST with an Idempotency-Key header, the way a real caller must. */
  const fund = (merchantId, body, idemKey) =>
    as(app, admin).post(`/merchants/${merchantId}/fund`)
      .set('Idempotency-Key', idemKey).send(body);

  const deduct = (merchantId, body, idemKey) =>
    as(app, admin).post(`/merchants/${merchantId}/deduct`)
      .set('Idempotency-Key', idemKey).send(body);

  // ── Authorisation ─────────────────────────────────────────────────────────
  it('refuses every treasury route without a token', async () => {
    for (const call of [
      () => request(app).get('/merchants'),
      () => request(app).post('/merchants/m/fund').send({ tokenAmount: 100 }),
      () => request(app).post('/merchants/m/deduct').send({ tokenAmount: 100, reason: 'r' }),
      () => request(app).post('/merchant-token-orders/o/approve').send({}),
      () => request(app).post('/merchant-token-orders/o/reject').send({}),
    ]) {
      expect((await call()).status, 'an unauthenticated call must never reach a handler').toBe(401);
    }
  });

  it('refuses the treasury to a signed-in NON-admin', async () => {
    const nobody = await actor({});
    const m = await merchantActor({});
    expect((await as(app, nobody).get('/merchants')).status).toBe(403);
    const res = await as(app, nobody).post(`/merchants/${m.merchantId}/fund`)
      .set('Idempotency-Key', key('nonadmin')).send({ tokenAmount: 100 });
    expect(res.status).toBe(403);
    expect(await getMerchantTokenBalance(m.merchantId)).toBe(0);
  });

  // ── Funding: the idempotency gate ─────────────────────────────────────────
  it('REFUSES a top-up with no idempotency key, rather than inventing one', async () => {
    // A server-generated fallback is the bug: it reads as a gate and is
    // `random()`. Only the caller can distinguish a retry from a second
    // deliberate top-up.
    const m = await merchantActor({});
    const res = await as(app, admin).post(`/merchants/${m.merchantId}/fund`).send({ tokenAmount: 1000 });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Idempotency-Key is required/i);
    expect(await getMerchantTokenBalance(m.merchantId), 'a refused top-up still funded the merchant').toBe(0);
  });

  it('refuses a malformed key rather than silently correcting it', async () => {
    // Quietly trimming or rewriting means the caller's idea of the key and the
    // server's differ, which is the whole point of the caller owning it.
    const m = await merchantActor({});
    for (const bad of ['ab', 'has spaces in it', 'x'.repeat(300), 'semi;colon']) {
      const res = await fund(m.merchantId, { tokenAmount: 100 }, bad);
      expect(res.status, `accepted key ${JSON.stringify(bad)}`).toBe(400);
      expect(res.body.message).toMatch(/Idempotency-Key/);
    }
    expect(await getMerchantTokenBalance(m.merchantId)).toBe(0);
  });

  it('answers a bad key on the DEDUCT route the same way, not with a 500', async () => {
    // This route caught every error into a hardcoded 500 with a generic
    // message, so the one refusal that tells the caller exactly what to do read
    // as "the server broke" — and on a money route a 500 also reads as "it may
    // have half-applied". Nothing had moved.
    const m = await merchantActor({ tokensRupees: 500 });
    for (const bad of ['ab', 'has spaces in it']) {
      const res = await deduct(m.merchantId, { tokenAmount: 100, reason: 'x' }, bad);
      expect(res.status, `accepted key ${JSON.stringify(bad)}`).toBe(400);
      expect(res.body.message).toMatch(/Idempotency-Key/);
    }
    expect(await getMerchantTokenBalance(m.merchantId)).toBe(500);
  });

  it('FUNDS ONCE when the same key arrives twice', async () => {
    const m = await merchantActor({});
    const k = key('retry');

    const first = await fund(m.merchantId, { tokenAmount: 1000, note: 'float' }, k);
    const second = await fund(m.merchantId, { tokenAmount: 1000, note: 'float' }, k);

    expect(first.status, first.body.message).toBe(200);
    expect(second.status, second.body.message).toBe(200);
    expect(await getMerchantTokenBalance(m.merchantId), 'a retried top-up funded twice').toBe(1000);
    expect(second.body.newTokenBalance).toBe(1000);
  });

  it('funds twice when the admin means it twice', async () => {
    // The other half: a DIFFERENT key is a different operation. A gate that
    // collapsed two deliberate top-ups would be as wrong as one that doubled a
    // retry.
    const m = await merchantActor({});
    await fund(m.merchantId, { tokenAmount: 1000 }, key('deliberate'));
    await fund(m.merchantId, { tokenAmount: 1000 }, key('deliberate'));
    expect(await getMerchantTokenBalance(m.merchantId)).toBe(2000);
  });

  it('survives four deliveries of one top-up racing each other', async () => {
    const m = await merchantActor({});
    const k = key('race');
    const results = await Promise.all(
      Array.from({ length: 4 }, () => fund(m.merchantId, { tokenAmount: 500 }, k)),
    );
    expect(results.every((r) => r.status === 200 || r.status >= 500)).toBe(true);
    expect(await getMerchantTokenBalance(m.merchantId)).toBe(500);
  });

  it('refuses a top-up that is not a positive number', async () => {
    const m = await merchantActor({});
    for (const tokenAmount of [0, -100, 'lots', null, undefined, Infinity, NaN]) {
      const res = await fund(m.merchantId, { tokenAmount }, key('bad'));
      expect(res.status, `accepted tokenAmount=${tokenAmount}`).toBe(400);
    }
    expect(await getMerchantTokenBalance(m.merchantId)).toBe(0);
  });

  it('records WHO funded and under which movement', async () => {
    // The mint and the credit each wrote their own append-only entry. What the
    // audit adds is the actor — which a ledger row cannot say.
    const m = await merchantActor({});
    const k = key('audited');
    await fund(m.merchantId, { tokenAmount: 250, note: 'seed float' }, k);

    const { rows } = await pgQuery(
      `SELECT performed_by, details FROM enhanced_audit_logs
        WHERE action = 'MERCHANT_FUNDED' AND target_id = $1`, [m.merchantId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].performed_by).toBe(admin.userId);
    expect(rows[0].details).toMatchObject({ tokenAmount: 250, note: 'seed float', movementId: `mint_${k}` });
  });

  it('reads the new balance back from the WALLET, not from the merchant row', async () => {
    // The merchant record carries no balance. A number read from anywhere else
    // is one no transfer will find.
    const m = await merchantActor({});
    const res = await fund(m.merchantId, { tokenAmount: 750 }, key('readback'));
    expect(res.body.newTokenBalance).toBe(await getMerchantTokenBalance(m.merchantId));
    expect(await getMerchant(m.merchantId)).not.toHaveProperty('tokenBalance');
  });

  // ── Deduction ─────────────────────────────────────────────────────────────
  it('REFUSES a deduction with no idempotency key', async () => {
    const m = await merchantActor({ tokensRupees: 1000 });
    const res = await as(app, admin).post(`/merchants/${m.merchantId}/deduct`)
      .send({ tokenAmount: 100, reason: 'correction' });
    expect(res.status).toBe(400);
    expect(await getMerchantTokenBalance(m.merchantId)).toBe(1000);
  });

  it('requires a reason — the deduction is otherwise unexplainable', async () => {
    const m = await merchantActor({ tokensRupees: 1000 });
    for (const reason of [undefined, '', '   ', null]) {
      const res = await deduct(m.merchantId, { tokenAmount: 100, reason }, key('noreason'));
      expect(res.status, `accepted reason=${JSON.stringify(reason)}`).toBe(400);
      expect(res.body.message).toMatch(/reason is required/i);
    }
    expect(await getMerchantTokenBalance(m.merchantId)).toBe(1000);
  });

  it('DEDUCTS ONCE when the same key arrives twice', async () => {
    const m = await merchantActor({ tokensRupees: 1000 });
    const k = key('deduct-retry');
    await deduct(m.merchantId, { tokenAmount: 400, reason: 'top-up correction' }, k);
    await deduct(m.merchantId, { tokenAmount: 400, reason: 'top-up correction' }, k);
    expect(await getMerchantTokenBalance(m.merchantId), 'a retried deduction deducted twice').toBe(600);
  });

  it('NEVER overdrafts a merchant', async () => {
    // A negative merchant wallet silently mints liability somewhere else.
    const m = await merchantActor({ tokensRupees: 100 });
    const res = await deduct(m.merchantId, { tokenAmount: 500, reason: 'off-boarding' }, key('overdraft'));
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Insufficient merchant balance/i);
    expect(res.body.tokenBalance).toBe(100);
    expect(await getMerchantTokenBalance(m.merchantId)).toBe(100);
  });

  it('distinguishes "no such merchant" from "not enough tokens"', async () => {
    // Which one it is decides what an admin does next, so the two are not
    // collapsed into one message.
    const res = await deduct(`ghost-${RUN}`, { tokenAmount: 100, reason: 'x' }, key('ghost'));
    expect(res.status).toBe(404);
    expect(res.body.message).toMatch(/Merchant not found/i);
  });

  it('records WHO deducted and why', async () => {
    const m = await merchantActor({ tokensRupees: 1000 });
    const k = key('deduct-audit');
    await deduct(m.merchantId, { tokenAmount: 300, reason: '  duplicate top-up  ' }, k);

    const { rows } = await pgQuery(
      `SELECT performed_by, details FROM enhanced_audit_logs
        WHERE action = 'MERCHANT_TOKENS_DEDUCTED' AND target_id = $1`, [m.merchantId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].performed_by).toBe(admin.userId);
    expect(rows[0].details).toMatchObject({ tokenAmount: 300, reason: 'duplicate top-up', movementId: `mw_deduct_${k}` });
  });

  it('funds and deducts to the same balance it started from', async () => {
    // A round trip through both routes is the cheapest check that they are the
    // same unit in the same direction.
    const m = await merchantActor({});
    await fund(m.merchantId, { tokenAmount: 1234 }, key('rt-in'));
    await deduct(m.merchantId, { tokenAmount: 1234, reason: 'reversal' }, key('rt-out'));
    expect(await getMerchantTokenBalance(m.merchantId)).toBe(0);
  });

  // ── The merchant's own token purchase ─────────────────────────────────────
  const tokenOrder = async ({ tokens = 1000, merchant = null } = {}) => {
    const m = merchant || await merchantActor({});
    const orderId = `MTO-${RUN}-${(seq += 1)}`;
    await createTokenOrder({ orderId, merchantId: m.merchantId, tokenAmountRupees: tokens });
    return { orderId, merchant: m, tokens };
  };

  it('approves a token order: mints, credits and records the decision', async () => {
    const { orderId, merchant, tokens } = await tokenOrder({ tokens: 2000 });
    const res = await as(app, admin).post(`/merchant-token-orders/${orderId}/approve`).send({ note: 'USDT received' });
    expect(res.status, res.body.message).toBe(200);

    expect(await getMerchantTokenBalance(merchant.merchantId)).toBe(tokens);
    const order = await getTokenOrder(orderId);
    expect(order.status).toBe('APPROVED');
    expect(order.reviewedBy).toBe(admin.userId);
    expect(res.body.merchant.tokenBalance).toBe(tokens);
  });

  it('CREDITS ONCE when two admins approve the same order', async () => {
    // The mint and the credit are keyed on the ORDER, so approving twice is the
    // same act twice — and the second admin is told rather than believing they
    // made the decision.
    const { orderId, merchant, tokens } = await tokenOrder({ tokens: 1500 });
    const first = await as(app, admin).post(`/merchant-token-orders/${orderId}/approve`).send({});
    const second = await as(app, admin).post(`/merchant-token-orders/${orderId}/approve`).send({});

    expect(first.status).toBe(200);
    expect(second.status, 'a second approval was accepted as a new decision').toBe(404);
    expect(await getMerchantTokenBalance(merchant.merchantId)).toBe(tokens);
  });

  it('survives four approvals racing each other', async () => {
    const { orderId, merchant, tokens } = await tokenOrder({ tokens: 800 });
    const results = await Promise.all(
      Array.from({ length: 4 }, () => as(app, admin).post(`/merchant-token-orders/${orderId}/approve`).send({})),
    );
    expect(results.filter((r) => r.status === 200).length).toBeGreaterThanOrEqual(1);
    expect(await getMerchantTokenBalance(merchant.merchantId), 'a raced approval credited twice').toBe(tokens);
  });

  it('LEAVES THE ORDER PENDING when the mint refuses — nothing to unwind', async () => {
    // The ordering defect this route was rewritten for. It used to mark the
    // order APPROVED, then mint, then credit — and on failure roll the mint
    // back AND reset the order to PENDING, which (its own comment said) "puts
    // the order back in reach of the guard while the mint stays spent".
    //
    // The failure is real, not injected: an amount past the fixed supply cap.
    // The money moves first now, so a refusal leaves the order exactly as it
    // was and still approvable — no compensation, nothing half-applied.
    const { orderId, merchant } = await tokenOrder({ tokens: 20_000_000_000 });

    const res = await as(app, admin).post(`/merchant-token-orders/${orderId}/approve`).send({});
    expect(res.status, 'a mint past the cap was accepted').toBeGreaterThanOrEqual(400);

    expect((await getTokenOrder(orderId)).status, 'a refused approval still marked the order').toBe('PENDING');
    expect(await getMerchantTokenBalance(merchant.merchantId)).toBe(0);
  });

  it('404s an approval of an order that does not exist', async () => {
    const res = await as(app, admin).post(`/merchant-token-orders/NOSUCH-${RUN}/approve`).send({});
    expect(res.status).toBe(404);
  });

  it('does NOT credit a rejected order', async () => {
    const { orderId, merchant } = await tokenOrder({ tokens: 1000 });
    const res = await as(app, admin).post(`/merchant-token-orders/${orderId}/reject`).send({ reason: 'USDT never arrived' });
    expect(res.status).toBe(200);
    expect(res.body.order.status).toBe('REJECTED');
    expect(await getMerchantTokenBalance(merchant.merchantId)).toBe(0);
  });

  it('gives a rejected merchant a reason they can act on', async () => {
    // A rejection with no reason is one the merchant cannot fix and resubmit.
    const { orderId } = await tokenOrder();
    await as(app, admin).post(`/merchant-token-orders/${orderId}/reject`).send({ reason: 'Transaction hash does not resolve' });
    expect((await getTokenOrder(orderId)).reviewNote).toBe('Transaction hash does not resolve');
  });

  it('cannot approve an order that was already rejected', async () => {
    const { orderId, merchant } = await tokenOrder();
    await as(app, admin).post(`/merchant-token-orders/${orderId}/reject`).send({ reason: 'no' });
    const res = await as(app, admin).post(`/merchant-token-orders/${orderId}/approve`).send({});
    expect(res.status).toBe(404);
    expect(await getMerchantTokenBalance(merchant.merchantId)).toBe(0);
  });

  it('cannot reject an order that was already approved', async () => {
    const { orderId, merchant, tokens } = await tokenOrder({ tokens: 600 });
    await as(app, admin).post(`/merchant-token-orders/${orderId}/approve`).send({});
    const res = await as(app, admin).post(`/merchant-token-orders/${orderId}/reject`).send({ reason: 'changed my mind' });
    expect(res.status).toBe(404);
    expect((await getTokenOrder(orderId)).status).toBe('APPROVED');
    expect(await getMerchantTokenBalance(merchant.merchantId)).toBe(tokens);
  });

  it('lists token orders with the merchant’s WALLET balance beside them', async () => {
    // A listing that showed a stored copy would show an admin a number no
    // transfer will find.
    const m = await merchantActor({ tokensRupees: 4321 });
    const { orderId } = await tokenOrder({ merchant: m });
    const res = await as(app, admin).get('/merchant-token-orders?status=PENDING');
    expect(res.status).toBe(200);
    const row = res.body.orders.find((o) => o.orderId === orderId);
    expect(row, 'the pending order is missing from the queue').toBeTruthy();
    expect(row.merchant.tokenBalance).toBe(4321);
  });

  // ── The listing and the lifecycle routes ──────────────────────────────────
  it('lists merchants for an admin', async () => {
    const m = await merchantActor({});
    const res = await as(app, admin).get('/merchants?limit=200');
    expect(res.status).toBe(200);
    expect(res.body.merchants.some((x) => x.merchantId === m.merchantId)).toBe(true);
  });

  it('suspends and reactivates a merchant', async () => {
    const m = await merchantActor({});
    const suspended = await as(app, admin).put(`/merchants/${m.merchantId}/suspend`).send({ reason: 'under investigation' });
    expect(suspended.status, suspended.body.message).toBe(200);
    expect((await getMerchant(m.merchantId)).status).toBe('SUSPENDED');

    const activated = await as(app, admin).put(`/merchants/${m.merchantId}/activate`).send({});
    expect(activated.status, activated.body.message).toBe(200);
    expect((await getMerchant(m.merchantId)).status).toBe('ACTIVE');
  });

  it('404s a lifecycle change on a merchant that does not exist', async () => {
    const res = await as(app, admin).put(`/merchants/ghost-${RUN}/suspend`).send({ reason: 'x' });
    expect(res.status).toBe(404);
  });
});
