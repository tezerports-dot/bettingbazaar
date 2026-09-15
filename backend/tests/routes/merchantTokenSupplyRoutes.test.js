// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * A merchant buying platform tokens: the quote, and the request.
 *
 * ── What these keep dead ────────────────────────────────────────────────────
 *
 * 1. A REQUEST THAT COULD NEVER BE APPROVED. The transaction hash was optional
 *    at creation, and `merchant_token_orders_approved_has_hash` refuses to
 *    approve a purchase that has a `usdt_amount` and no transaction on it —
 *    which every merchant-created purchase does. The approve path mints and
 *    credits BEFORE it writes the status, so what actually happened was: the
 *    merchant is paid, the CHECK rejects the status write, the handler 500s,
 *    and the order sits PENDING with the tokens already delivered. The
 *    one-per-day index then locked the merchant out of filing a corrected one.
 *
 * 2. A SECOND COPY OF THE PRICE. The panel needs the figure before the request
 *    exists — the merchant sends the USDT first — so there are two readers of
 *    the same arithmetic. They come from one function, and the test that
 *    matters is that the quote a merchant was shown is the quote that got
 *    written (§5).
 *
 * Nothing below the HTTP boundary is mocked: the reference is really claimed,
 * the row is really written, the unique index really refuses the second one.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pgConfigured, applySchema, closePg } from '#db/client.js';
import { getTokenOrder } from '#db/repositories/paymentConfig.js';
import { mountRouter, merchantActor, as, request } from './_harness.js';
import { randomBytes } from 'node:crypto';

const describePg = pgConfigured() ? describe : describe.skip;

describePg('merchant token supply routes', () => {
  let app;

  beforeAll(async () => {
    await applySchema();
    const mod = await import('../../domains/merchant/merchant.routes.js');
    app = mountRouter(mod.default);
  }, 60_000);

  afterAll(async () => { await closePg(); });

  /**
   * A 64-hex-character transaction, unique per call.
   *
   * Every one has to be different: the registry is the point, and `utr_registry`
   * keeps a reference for GOOD (§27), so a hash this file has already used can
   * never be used again — on any database it has ever run against. The database
   * is shared and never reset between files (trap 10).
   *
   * ── Why this is `randomBytes` and not a filtered `RUN` ─────────────────────
   * It used to be `${RUN}${seq}`.replace(/[^0-9a-f]/gi, '') padded with 'a'.
   * `RUN` is `Math.random().toString(36)` — BASE 36 — and that character class
   * strips 20 of its 36 symbols. About 45% of runs were left with three
   * characters or fewer of real uniqueness and about 3% with one or none, at
   * which point the "unique" hash is a run of 'a's identical to the one an
   * earlier degenerate run already claimed. The file then fails with a 409 on a
   * database it had passed against the day before.
   *
   * The safeguard was defeated by its own sanitiser. Generating hex rather than
   * filtering down to it removes the failure mode instead of narrowing it.
   */
  const txHash = () => randomBytes(32).toString('hex');

  // The quote figures are NOT asserted as literals. `usdtPricing` is a shared
  // configuration document, so pinning a number here would make this file
  // depend on what every other suite left in it — and would be asserting a
  // global invariant over shared state, which trap 10 forbids. What is asserted
  // is the SHAPE and the AGREEMENT between the two readers.
  const quoteFor = (who, tokenAmount) =>
    as(app, who).get(`/admin-token-orders/quote?tokenAmount=${tokenAmount}`);

  it('prices an amount without creating anything', async () => {
    const m = await merchantActor({});
    const res = await quoteFor(m, 100000);

    expect(res.status, res.body.message).toBe(200);
    expect(res.body.quote.ok, res.body.quote.message).toBe(true);
    expect(res.body.quote.usdtRate).toBeGreaterThan(0);
    // Merchants pay in whole tens of USDT, rounded UP, so the platform is never
    // undercharged by the rounding.
    expect(res.body.quote.usdtAmount % 10).toBe(0);
    expect(res.body.quote.usdtAmount).toBeGreaterThanOrEqual(res.body.quote.minPurchaseUsdt);

    const listed = await as(app, m).get('/admin-token-orders');
    expect(listed.body.orders, 'pricing an amount created a request').toEqual([]);
  });

  it('refuses to price a non-amount, as an answer rather than an error', async () => {
    // 200 with `ok: false` on purpose: this is a merchant typing into a field,
    // and the bounds are what they need while they are still choosing. An error
    // status would have the panel render a failure where the answer is "not
    // that amount".
    const m = await merchantActor({});
    for (const bad of ['0', '-5', 'lots', '']) {
      const res = await quoteFor(m, bad);
      expect(res.status).toBe(200);
      expect(res.body.quote.ok, `"${bad}" was priced`).toBe(false);
      expect(String(res.body.quote.message).length).toBeGreaterThan(0);
    }
  });

  it('refuses an amount below the minimum, and names the bound', async () => {
    const m = await merchantActor({});
    const res = await quoteFor(m, 1);

    expect(res.body.quote.ok).toBe(false);
    // The refusal speaks the rail's own vocabulary (§25) — a merchant told only
    // "invalid amount" tries the same thing again.
    expect(res.body.quote.message).toMatch(/USDT/);
  });

  it('files a request at exactly the quoted figures', async () => {
    const m = await merchantActor({});
    const quote = (await quoteFor(m, 100000)).body.quote;
    const hash = txHash();

    const res = await as(app, m).post('/admin-token-orders')
      .send({ tokenAmount: 100000, usdtTxHash: hash });

    expect(res.status, res.body.message).toBe(200);
    // The panel showed one number and the row recorded another would be the
    // whole defect: the merchant sent real USDT against the first.
    expect(res.body.order.usdtAmount).toBe(quote.usdtAmount);
    expect(res.body.order.usdtRate).toBe(quote.usdtRate);
    expect(res.body.order.tokenAmount).toBe(100000);
    expect(res.body.order.status).toBe('PENDING');

    const stored = await getTokenOrder(res.body.order.orderId);
    expect(stored.usdtTxHash.toUpperCase()).toBe(hash.toUpperCase());
  });

  it('REFUSES a request with no transaction on it', async () => {
    // The row cannot approve one, and the one-per-day index means it cannot be
    // re-filed. Accepting it costs the merchant their day and — because the
    // approve path pays before it records — could pay them on an order that
    // stays PENDING.
    const m = await merchantActor({});
    const res = await as(app, m).post('/admin-token-orders').send({ tokenAmount: 100000 });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('REFERENCE_REQUIRED');

    const listed = await as(app, m).get('/admin-token-orders');
    expect(listed.body.orders, 'a hashless request was still written').toEqual([]);
  });

  it('refuses a transaction that is not one', async () => {
    const m = await merchantActor({});
    for (const bad of ['not-a-hash', 'abc123', '0x' + 'f'.repeat(63)]) {
      const res = await as(app, m).post('/admin-token-orders')
        .send({ tokenAmount: 100000, usdtTxHash: bad });
      expect(res.status, `"${bad}" was accepted as a transaction`).toBe(400);
    }
    expect((await as(app, m).get('/admin-token-orders')).body.orders).toEqual([]);
  });

  it('ONE PAYMENT, ONE PURCHASE — the same hash cannot fund a second merchant', async () => {
    const first = await merchantActor({});
    const second = await merchantActor({});
    const hash = txHash();

    const a = await as(app, first).post('/admin-token-orders')
      .send({ tokenAmount: 100000, usdtTxHash: hash });
    expect(a.status, a.body.message).toBe(200);

    const b = await as(app, second).post('/admin-token-orders')
      .send({ tokenAmount: 100000, usdtTxHash: hash });
    expect(b.status, 'one USDT payment funded two purchases of platform inventory').toBe(409);
    expect((await as(app, second).get('/admin-token-orders')).body.orders).toEqual([]);
  });

  it('one live request per day, decided by the index rather than a lookup', async () => {
    const m = await merchantActor({});
    const first = await as(app, m).post('/admin-token-orders')
      .send({ tokenAmount: 100000, usdtTxHash: txHash() });
    expect(first.status, first.body.message).toBe(200);

    const second = await as(app, m).post('/admin-token-orders')
      .send({ tokenAmount: 100000, usdtTxHash: txHash() });
    expect(second.status).toBe(429);

    // Exactly one, not two — a check-then-insert would have written both.
    expect((await as(app, m).get('/admin-token-orders')).body.orders).toHaveLength(1);
  });

  it('a merchant sees only their OWN requests', async () => {
    const mine = await merchantActor({});
    const theirs = await merchantActor({});
    await as(app, mine).post('/admin-token-orders')
      .send({ tokenAmount: 100000, usdtTxHash: txHash() });

    const res = await as(app, theirs).get('/admin-token-orders');
    expect(res.status).toBe(200);
    expect(res.body.orders).toEqual([]);
  });

  it('refuses every token-supply route without a merchant token', async () => {
    for (const call of [
      () => request(app).get('/admin-token-orders'),
      () => request(app).get('/admin-token-orders/quote?tokenAmount=100000'),
      () => request(app).post('/admin-token-orders').send({ tokenAmount: 100000 }),
    ]) {
      expect((await call()).status, 'an unauthenticated call reached a handler').toBe(401);
    }
  });

  it('refuses a merchant who is not approved and active', async () => {
    // Buying platform inventory is not something a pending or suspended
    // merchant does. The quote is readable — it is just a price — but filing is
    // not.
    for (const who of [
      await merchantActor({ approval: 'PENDING' }),
      await merchantActor({ status: 'SUSPENDED' }),
    ]) {
      const res = await as(app, who).post('/admin-token-orders')
        .send({ tokenAmount: 100000, usdtTxHash: txHash() });
      expect(res.status).toBe(403);
    }
  });
});
