// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file.
/**
 * The USDT rail, through the real routers against a real database.
 *
 * ── Why not a mocked settle ────────────────────────────────────────────────
 * "Do not mock the boundary that carries money. A suite that mocks the
 * settlement writer and asserts on its arguments once reported settlement
 * working while the real function threw on every call." The webhook path here
 * touches nothing outside this process — the row, the treasury, the wallet — so
 * it is exercised for real. Only the OUTBOUND half is stubbed, because BTCPay
 * is another machine on the internet.
 *
 * ── The app is built from the server's own parser rule ─────────────────────
 * `usesRawBody` is imported, not reimplemented. The webhook verifies an HMAC
 * over raw bytes: if the JSON parser reaches it first, `req.body` is an object,
 * the digest is taken over the text `[object Object]`, and every legitimate
 * callback is refused while this suite — mounting its own raw parser — stays
 * green. One owner, read by both.
 *
 * ── Deltas, never global invariants (trap 10) ──────────────────────────────
 * The database is shared and never reset between files, and a mutation run
 * leaves its rows behind. Every money assertion here is a difference against a
 * baseline this test took itself.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { pgConfigured, applySchema, closePg } from '#db/client.js';
import { db } from '#db';
import { actor, as } from './_harness.js';
import { usesRawBody } from '../../domains/funding/webhookRawBody.js';
import { signBtcpayBody } from '../../domains/funding/btcpaySignature.js';
import { btcpay } from '../../config/btcpay.config.js';
import { getBalances } from '#db/repositories/wallets.js';
import { getSystemConfig, applySystemConfig } from '#db/repositories/config.js';

const describePg = pgConfigured() ? describe : describe.skip;

const SECRET = 'usdt-webhook-secret-for-the-route-suite';

// The outbound half only. Everything inbound is real.
const { fakeInvoice } = vi.hoisted(() => ({ fakeInvoice: vi.fn() }));
vi.mock('../../domains/funding/btcpay.client.js', () => ({
  createInvoice: (...args) => fakeInvoice(...args),
  getInvoice: vi.fn(),
}));

describePg('the USDT deposit rail', () => {
  let app;
  let priorPricing = null;
  let seq = 0;
  const invoiceId = () => `inv-${Date.now().toString(36)}-${(seq += 1)}`;

  /** The app the SERVER builds, with the same parser decision. */
  function mountUsdt(router) {
    const a = express();
    const raw = express.raw({ type: '*/*', limit: '256kb' });
    const json = express.json();
    a.use((req, res, next) => (usesRawBody(req.originalUrl.split('?')[0]) ? raw : json)(req, res, next));
    a.use(cookieParser());
    a.use('/api/payment', router);
    a.use((err, _req, res, _next) => res.status(err.status || 500).json({ success: false, message: err.message }));
    return a;
  }

  const post = (body, { secret = SECRET, sign = true } = {}) => {
    const raw = typeof body === 'string' ? body : JSON.stringify(body);
    const req = request(app).post('/api/payment/usdt/webhook')
      .set('content-type', 'application/json');
    if (sign) req.set('BTCPay-Sig', signBtcpayBody(secret, raw));
    return req.send(raw);
  };

  /** A player with an open invoice, created through the real route. */
  const openInvoice = async ({ tokenAmount = 25_000 } = {}) => {
    const who = await actor({});
    const id = invoiceId();
    fakeInvoice.mockResolvedValueOnce({
      invoiceId: id,
      checkoutLink: `https://pay.example/i/${id}`,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    const res = await as(app, who).post('/api/payment/usdt/deposit/create').send({ tokenAmount });
    return { who, id, res };
  };

  // A `mockResolvedValueOnce` left unconsumed by one test is taken by the NEXT
  // one's creation, which then holds an invoice id that test never saw — every
  // later assertion about it then reads "unknown invoice" and passes for the
  // wrong reason. Reset between tests so a queue cannot leak forward.
  beforeEach(() => { fakeInvoice.mockReset(); });

  beforeAll(async () => {
    await applySchema();
    // The config object is read at request time, so setting it here is what a
    // configured deployment looks like to every module under test.
    Object.assign(btcpay, {
      serverUrl: 'https://pay.example',
      storeId: 'store-1',
      apiKey: 'key-1',
      webhookSecret: SECRET,
      invoiceCurrency: 'USDT',
      invoiceExpiryMinutes: 60,
    });
    // A rate must exist or every creation refuses. `system_config` is SHARED
    // and never reset between files, so the previous value is captured and put
    // back — a suite that leaves a rate behind changes what the next one prices
    // with (trap 10, in its configuration form).
    priorPricing = (await getSystemConfig())?.usdtPricing ?? null;
    await applySystemConfig(
      { usdtPricing: { ...(priorPricing ?? {}), userMerchantBuyInr: 90 } },
      { actor: 'usdt-route-suite' },
    );
    app = mountUsdt((await import('../../domains/funding/usdtDeposit.routes.js')).default);
  }, 60_000);

  afterAll(async () => {
    if (priorPricing) await applySystemConfig({ usdtPricing: priorPricing }, { actor: 'usdt-route-suite' });
    await closePg();
  });

  // ── Creation ─────────────────────────────────────────────────────────────
  it('opens an invoice above the INR ceiling and quotes it in USDT', async () => {
    const { res } = await openInvoice({ tokenAmount: 25_000 });
    expect(res.status, res.body.message).toBe(200);
    expect(res.body.deposit.tokenAmount).toBe(25_000);
    // ₹25,000 at ₹90 per USDT, rounded UP to six places — never against the
    // platform, and never a long float in a payment request.
    expect(res.body.deposit.usdtAmount).toBeCloseTo(277.777778, 6);
    expect(res.body.deposit.usdtRateInr).toBe(90);
    expect(res.body.deposit.checkoutLink).toMatch(/^https:\/\/pay\.example\//);
    expect(res.body.deposit.status).toBe('AWAITING_PAYMENT');
  });

  it('REFUSES an amount the INR rail serves', async () => {
    // ₹10,000 is the largest a cash machine dispenses and the largest a
    // merchant is approved for. USDT starts one paise above it, derived from
    // the same constant, so the two rails meet exactly and leave no gap.
    const who = await actor({});
    const res = await as(app, who).post('/api/payment/usdt/deposit/create').send({ tokenAmount: 10_000 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('BELOW_USDT_FLOOR');
  });

  it('serves the amount one paise above the ceiling', async () => {
    const who = await actor({});
    const id = invoiceId();
    fakeInvoice.mockResolvedValueOnce({ invoiceId: id, checkoutLink: null, expiresAt: null });
    const res = await as(app, who).post('/api/payment/usdt/deposit/create').send({ tokenAmount: 10_000.01 });
    expect(res.status, res.body.message).toBe(200);
  });

  it('REFUSES to price a purchase when no USDT rate is set', async () => {
    // The schema default is 0 and 0 is not a rate. Dividing by it gives
    // Infinity USDT; substituting 1 would sell tokens at the INR peg for a
    // currency that is not pegged to it. A caller that cannot price a purchase
    // must refuse it by NAME, not guess — and not 500, which tells the player
    // nothing and the operator nothing either.
    //
    // `system_config` is shared, so the rate is put back in the same test
    // rather than at the end of the file: anything running in between would
    // otherwise be pricing against a rail this test switched off.
    await applySystemConfig({ usdtPricing: { userMerchantBuyInr: 0 } }, { actor: 'usdt-route-suite' });
    try {
      const who = await actor({});
      const res = await as(app, who).post('/api/payment/usdt/deposit/create').send({ tokenAmount: 25_000 });
      expect(res.status).toBe(503);
      expect(res.body.code).toBe('USDT_RATE_UNSET');
      // And nothing was created: a row with no price is a deposit nobody can
      // settle.
      expect(await db.usdtDeposits.countOpenForUser(who.userId)).toBe(0);
    } finally {
      await applySystemConfig({ usdtPricing: { userMerchantBuyInr: 90 } }, { actor: 'usdt-route-suite' });
    }
  });

  it('allows only ONE open invoice per player', async () => {
    const { who } = await openInvoice();
    const second = await as(app, who).post('/api/payment/usdt/deposit/create').send({ tokenAmount: 30_000 });
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('USDT_BUY_ALREADY_OPEN');
  });

  it('closes the row when BTCPay refuses, so the player is not locked out', async () => {
    // An open row blocks the next attempt. One upstream hiccup must not mean a
    // player who can never buy again.
    const who = await actor({});
    fakeInvoice.mockRejectedValueOnce(Object.assign(new Error('upstream'), { status: 502, code: 'BTCPAY_CREATE_FAILED' }));
    const failed = await as(app, who).post('/api/payment/usdt/deposit/create').send({ tokenAmount: 20_000 });
    expect(failed.status).toBe(502);

    const id = invoiceId();
    fakeInvoice.mockResolvedValueOnce({ invoiceId: id, checkoutLink: null, expiresAt: null });
    const retry = await as(app, who).post('/api/payment/usdt/deposit/create').send({ tokenAmount: 20_000 });
    expect(retry.status, retry.body.message).toBe(200);
  });

  // ── The webhook: what stands between the internet and a mint ─────────────
  it('refuses an UNSIGNED callback', async () => {
    const res = await post({ type: 'InvoiceSettled', invoiceId: 'anything' }, { sign: false });
    expect(res.status).toBe(401);
  });

  it('refuses a callback signed with the wrong secret', async () => {
    const res = await post({ type: 'InvoiceSettled', invoiceId: 'anything' }, { secret: 'not-the-secret' });
    expect(res.status).toBe(401);
  });

  it('refuses a body altered after signing', async () => {
    const body = JSON.stringify({ type: 'InvoiceSettled', invoiceId: 'INV_A' });
    const res = await request(app).post('/api/payment/usdt/webhook')
      .set('content-type', 'application/json')
      .set('BTCPay-Sig', signBtcpayBody(SECRET, body))
      .send(body.replace('INV_A', 'INV_B'));
    expect(res.status).toBe(401);
  });

  it('acknowledges an invoice it never created, and creates nothing', async () => {
    // A well-signed body for an invoice that is not ours. Answered 200 on
    // purpose: retrying will not make it ours. It must never mint.
    const before = await db.usdtDeposits.listAll({ limit: 500 });
    const res = await post({ type: 'InvoiceSettled', invoiceId: `never-ours-${Date.now()}` });
    expect(res.status).toBe(200);
    expect(res.body.ignored).toBe('unknown_invoice');
    const after = await db.usdtDeposits.listAll({ limit: 500 });
    expect(after.length).toBe(before.length);
  });

  // ── The money ────────────────────────────────────────────────────────────
  it('credits the player exactly once, and mints exactly what the ROW says', async () => {
    const { who, id } = await openInvoice({ tokenAmount: 50_000 });

    const walletBefore = await getBalances(who.userId);
    const supplyBefore = await db.treasury.circulatingSupplyPaise();

    const res = await post({ type: 'InvoiceSettled', invoiceId: id, deliveryId: 'd-1' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const walletAfter = await getBalances(who.userId);
    const supplyAfter = await db.treasury.circulatingSupplyPaise();

    const credited = (walletAfter.depositBalance - walletBefore.depositBalance)
      + (walletAfter.reserveBalance - walletBefore.reserveBalance);
    expect(credited).toBe(50_000);
    // A DELTA, not a total: the table is shared and other suites move it.
    expect(supplyAfter - supplyBefore).toBe(50_000 * 100);

    const row = await db.usdtDeposits.getDepositByInvoice(id);
    expect(row.state).toBe('SETTLED');
    expect(row.settledAt).toBeTruthy();
    // Settled AND credited are different facts. The gap between them is the
    // crash window, and it must be visible.
    expect(row.creditedAt).toBeTruthy();
  });

  it('credits NOTHING on a replayed delivery — the same signed body, twice', async () => {
    // The signature verifies forever. What stops the second one paying anybody
    // is the guarded transition and the UNIQUE tx_id, not the HMAC.
    const { who, id } = await openInvoice({ tokenAmount: 15_000 });
    const body = { type: 'InvoiceSettled', invoiceId: id, deliveryId: 'd-replay' };

    const first = await post(body);
    expect(first.status).toBe(200);
    const afterFirst = await getBalances(who.userId);
    const supplyAfterFirst = await db.treasury.circulatingSupplyPaise();

    const second = await post(body);
    // 200, because "you already told me" is a success from BTCPay's side — a
    // 4xx or 5xx here has it redeliver forever.
    expect(second.status).toBe(200);

    const afterSecond = await getBalances(who.userId);
    expect(afterSecond.depositBalance).toBe(afterFirst.depositBalance);
    expect(afterSecond.reserveBalance).toBe(afterFirst.reserveBalance);
    expect(await db.treasury.circulatingSupplyPaise()).toBe(supplyAfterFirst);
  });

  it('does not let the CALLBACK decide the amount', async () => {
    // The one rule that makes a webhook safe to trust with a mint. Whoever can
    // produce a valid signature — including a replay of a real one — must not
    // be able to name the number of tokens.
    const { who, id } = await openInvoice({ tokenAmount: 12_000 });
    const before = await getBalances(who.userId);

    await post({
      type: 'InvoiceSettled', invoiceId: id,
      amount: '999999', tokenAmount: 999_999, tokenPaise: 99_999_900,
    });

    const after = await getBalances(who.userId);
    const credited = (after.depositBalance - before.depositBalance)
      + (after.reserveBalance - before.reserveBalance);
    expect(credited).toBe(12_000);
  });

  // ── The states that must not look alike ──────────────────────────────────
  it('marks a seen-but-unconfirmed payment PROCESSING and moves no money', async () => {
    const { who, id } = await openInvoice();
    const before = await getBalances(who.userId);

    const res = await post({ type: 'InvoiceProcessing', invoiceId: id });
    expect(res.status).toBe(200);

    expect((await db.usdtDeposits.getDepositByInvoice(id)).state).toBe('PROCESSING');
    const after = await getBalances(who.userId);
    expect(after.depositBalance).toBe(before.depositBalance);
  });

  it('settles a deposit that had already gone PROCESSING', async () => {
    const { who, id } = await openInvoice({ tokenAmount: 11_000 });
    await post({ type: 'InvoiceProcessing', invoiceId: id });
    const before = await getBalances(who.userId);
    const res = await post({ type: 'InvoiceSettled', invoiceId: id });
    expect(res.status).toBe(200);
    const after = await getBalances(who.userId);
    expect((after.depositBalance - before.depositBalance) + (after.reserveBalance - before.reserveBalance))
      .toBe(11_000);
  });

  it('closes an expired invoice and owes nothing', async () => {
    const { who, id } = await openInvoice();
    const before = await getBalances(who.userId);
    const res = await post({ type: 'InvoiceExpired', invoiceId: id });
    expect(res.status).toBe(200);
    expect((await db.usdtDeposits.getDepositByInvoice(id)).state).toBe('EXPIRED');
    const after = await getBalances(who.userId);
    expect(after.depositBalance).toBe(before.depositBalance);
    // And the player may start another, because the row is no longer open.
    fakeInvoice.mockResolvedValueOnce({ invoiceId: invoiceId(), checkoutLink: null, expiresAt: null });
    const next = await as(app, who).post('/api/payment/usdt/deposit/create').send({ tokenAmount: 20_000 });
    expect(next.status, next.body.message).toBe(200);
  });

  it('refuses to settle an invoice that already expired', async () => {
    const { id } = await openInvoice();
    await post({ type: 'InvoiceExpired', invoiceId: id });
    const res = await post({ type: 'InvoiceSettled', invoiceId: id });
    // The transition is refused, so nothing is credited and BTCPay is told to
    // come back — an expired invoice that settles is a contradiction a person
    // should look at, not something to swallow.
    expect(res.status).toBe(500);
    expect((await db.usdtDeposits.getDepositByInvoice(id)).state).toBe('EXPIRED');
  });

  it('ignores an event type it does not act on, without retrying it forever', async () => {
    const { id } = await openInvoice();
    const res = await post({ type: 'InvoicePaymentSettled', invoiceId: id });
    expect(res.status).toBe(200);
    expect(res.body.ignored).toBe('InvoicePaymentSettled');
  });

  // ── Ownership ────────────────────────────────────────────────────────────
  it('does not answer another player who names the deposit id', async () => {
    // A deposit id appears in logs and in a checkout URL. It is not a
    // capability, so ownership is checked and not assumed.
    const { res } = await openInvoice();
    const stranger = await actor({});
    const seen = await as(app, stranger).get(`/api/payment/usdt/deposit/${res.body.deposit.depositId}`);
    expect(seen.status).toBe(404);
  });

  it('tells the panel the floor and whether the rail is open', async () => {
    const who = await actor({});
    const res = await as(app, who).get('/api/payment/usdt/availability');
    expect(res.status).toBe(200);
    expect(res.body.available).toBe(true);
    // Derived from the INR ceiling on the SERVER. A panel that hard-coded it
    // would be a second owner of a money rule.
    expect(res.body.minTokenAmount).toBe(10_000.01);
  });

  // ── The parser in front of the handler ───────────────────────────────────
  it('routes the webhook path to the RAW body parser', () => {
    // If the JSON parser reaches it first, `req.body` is an object, the digest
    // is taken over the text `[object Object]`, and every real callback is
    // refused — with a route suite mounting its own raw parser staying green.
    expect(usesRawBody('/api/payment/usdt/webhook')).toBe(true);
    expect(usesRawBody('/api/payment/deposit/create')).toBe(false);
  });
});
