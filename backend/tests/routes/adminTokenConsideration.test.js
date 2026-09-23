// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The other side of an admin↔merchant token trade, through a real database.
 *
 * ── What was missing ───────────────────────────────────────────────────────
 * The treasury recorded that tokens moved. Nothing recorded what they moved
 * FOR. An admin topped a merchant up and rupees (or USDT) arrived somewhere the
 * platform controls; an admin took tokens back and rupees went out. Neither
 * figure existed, so the books balanced in tokens and said nothing about money:
 * every profit-and-loss reading of the admin↔merchant leg was missing its
 * revenue side entirely.
 *
 * ── And a hole the change had to close first ───────────────────────────────
 * `POST /fund` read the recipient from the CREDIT's return value, after the
 * treasury transfer had already committed. `creditMerchantTokens` answers
 * `{ merchant: null }` for an id with no merchant row — it does not throw — so
 * the handler returned 404 and left the transfer standing. Measured against a
 * running server before the fix: funding `GHOST_ID` answered "Merchant not
 * found" while 777 tokens left TOKEN_SUPPLY and landed in MERCHANT_FLOAT,
 * credited to nobody. That is CLAUDE.md §2's conservation invariant — platform
 * holding + every merchant wallet + every player wallet = the total — broken
 * silently by a typo in a URL. Trap 19: check the recipient can receive BEFORE
 * writing the record that says they did.
 *
 * Asserted here, in both directions: the money is recorded when it should be,
 * NOTHING moves when the request is refused, the USDT figure is valued at a
 * frozen rate rather than summed as rupees (trap 15), and a redelivered request
 * books one trade rather than two.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pgConfigured, applySchema, closePg, pgQuery } from '#db/client.js';
import { db } from '#db';
import { getTreasuryBalances } from '#db/repositories/treasury.js';
import { mountRouter, actor, merchantActor, as } from './_harness.js';
import router from '../../domains/merchant/merchant.admin.routes.js';

const describePg = pgConfigured() ? describe : describe.skip;

describePg('what the platform got, or gave, for a merchant\'s tokens', () => {
  let app, admin, merchant, restoreRate;

  // One key per call, or a second deliberate top-up collides with the first.
  let seq = 0;
  const key = () => `atc-test-${Date.now()}-${++seq}`;

  const fund = (body, k = key()) => as(app, admin)
    .post(`/api/merchants/${merchant.merchantId}/fund`)
    .set('Idempotency-Key', k).send(body);

  const deduct = (body, k = key()) => as(app, admin)
    .post(`/api/merchants/${merchant.merchantId}/deduct`)
    .set('Idempotency-Key', k).send(body);

  const balance = () => db.merchantWallets.getMerchantTokenBalance(merchant.merchantId);

  beforeAll(async () => {
    await applySchema();
    app = mountRouter(router, { prefix: '/api' });
    admin = await actor({ isAdmin: true });
    merchant = await merchantActor({ tokensRupees: 50000 });

    // Trap 10 / S19: `config_documents` is ONE row holding the platform's live
    // rules, so a suite that writes one changes the rules for every suite after
    // it in the same process. Take the baseline, put it back in `afterAll`, and
    // SET what this suite needs rather than reading whatever the database
    // happened to hold — a USDT assertion that passes only on a database
    // somebody had already priced is asserting nothing.
    const before = await db.config.getSystemConfig();
    restoreRate = before?.usdtPricing?.merchantAdminBuyInr ?? 1;
    await db.config.applyConfig({
      scope: 'system', actor: 'test', patch: { usdtPricing: { merchantAdminBuyInr: 90 } },
    });
  });

  afterAll(async () => {
    // Outside any assertion: a restore that only runs when the suite passed is
    // the one that matters least.
    await db.config.applyConfig({
      scope: 'system', actor: 'test', patch: { usdtPricing: { merchantAdminBuyInr: restoreRate } },
    }).catch(() => {});
    await closePg();
  });

  // ── The hole this change had to close first ──────────────────────────────

  it('moves NOTHING when the merchant does not exist', async () => {
    const before = await getTreasuryBalances();
    const res = await as(app, admin)
      .post('/api/merchants/GHOST_MERCHANT_NOT_REAL/fund')
      .set('Idempotency-Key', key())
      .send({ tokenAmount: 777, settlementAmount: 777 });

    expect(res.status).toBe(404);
    const after = await getTreasuryBalances();
    // Both legs, not just one: the defect moved tokens OUT of the platform's
    // holding AND into the merchant float, and asserting only the first would
    // pass against a version that credited the float from somewhere else.
    expect(after.TOKEN_SUPPLY).toBe(before.TOKEN_SUPPLY);
    expect(after.MERCHANT_FLOAT).toBe(before.MERCHANT_FLOAT);
  });

  // ── The figure is required, and refusing costs nothing ───────────────────

  it('refuses a top-up that does not say what the platform received', async () => {
    const tokens = await balance();
    const treasury = await getTreasuryBalances();

    const res = await fund({ tokenAmount: 1000 });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/received/i);
    // §14: the operator must be able to act on it. "Enter 0" is the instruction.
    expect(res.body.message).toMatch(/0 if no money changed hands/i);

    expect(await balance()).toBe(tokens);
    expect((await getTreasuryBalances()).TOKEN_SUPPLY).toBe(treasury.TOKEN_SUPPLY);
  });

  it('refuses a deduction that does not say what the platform paid', async () => {
    const tokens = await balance();
    const res = await deduct({ tokenAmount: 100, reason: 'correction' });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/paid/i);
    expect(await balance()).toBe(tokens);
  });

  it('takes ZERO as a real answer — a correction moved tokens for no money', async () => {
    const before = await balance();
    const res = await fund({ tokenAmount: 100, settlementAmount: 0, note: 'mis-keyed earlier' });
    expect(res.status).toBe(200);
    expect(await balance()).toBe(before + 100);
    expect(res.body.settlement).toMatchObject({ currency: 'INR', amount: 0, inrValue: 0 });
  });

  // ── The money is recorded, both directions ───────────────────────────────

  it('records what came in for a rupee top-up, against the same movement', async () => {
    const k = key();
    const res = await fund({ tokenAmount: 1000, settlementAmount: 950, settlementCurrency: 'INR' }, k);
    expect(res.status).toBe(200);

    const row = await db.adminTokenConsiderations.considerationFor(`mint_${k}`);
    expect(row).toMatchObject({
      direction: 'RECEIVED', currency: 'INR',
      fiatAmountMinor: 95000, inrEquivalentPaise: 95000,
      tokenAmountPaise: 100000, rateUsed: null,
      merchantId: merchant.merchantId,
    });
  });

  it('records what went out for a rupee deduction', async () => {
    const k = key();
    const res = await deduct({ tokenAmount: 500, reason: 'off-boarding', settlementAmount: 500 }, k);
    expect(res.status).toBe(200);

    const row = await db.adminTokenConsiderations.considerationFor(`mw_deduct_${k}`);
    expect(row).toMatchObject({
      direction: 'PAID', currency: 'INR',
      fiatAmountMinor: 50000, inrEquivalentPaise: 50000, rateUsed: null,
    });
  });

  // ── Trap 15, which is the whole reason there are two amount columns ──────

  it('values a USDT receipt at the frozen rate, and never as rupees', async () => {
    const k = key();
    const res = await fund({ tokenAmount: 9000, settlementAmount: 100, settlementCurrency: 'USDT' }, k);
    expect(res.status).toBe(200);

    const row = await db.adminTokenConsiderations.considerationFor(`mint_${k}`);
    // 100 USDT is 10,000 hundredths; at ₹90 that is 900,000 paise = ₹9,000.
    expect(row.fiatAmountMinor).toBe(10000);
    expect(row.inrEquivalentPaise).toBe(900000);
    // The figure a human is shown must NOT be the figure anything sums: booking
    // 100 USDT as ₹100 is the hundredfold understatement that reached the
    // commission engine.
    expect(row.inrEquivalentPaise).not.toBe(row.fiatAmountMinor);
    expect(row.rateUsed).toBe(90);
  });

  it('freezes the rate, so a later config edit cannot restate a settled trade', async () => {
    const k = key();
    await fund({ tokenAmount: 900, settlementAmount: 10, settlementCurrency: 'USDT' }, k);
    const at90 = await db.adminTokenConsiderations.considerationFor(`mint_${k}`);

    await db.config.applyConfig({
      scope: 'system', actor: 'test', patch: { usdtPricing: { merchantAdminBuyInr: 50 } },
    });
    const reread = await db.adminTokenConsiderations.considerationFor(`mint_${k}`);
    expect(reread.rateUsed).toBe(at90.rateUsed);
    expect(reread.inrEquivalentPaise).toBe(at90.inrEquivalentPaise);

    await db.config.applyConfig({
      scope: 'system', actor: 'test', patch: { usdtPricing: { merchantAdminBuyInr: 90 } },
    });
  });

  it('refuses a USDT receipt BY NAME when the rate is unset, rather than pricing it at the peg', async () => {
    // The schema default is 1, which means "1 USDT = ₹1" — not a price. §25's
    // precedent: a purchase that cannot be priced is refused by name, because
    // the fallback is worse than the refusal.
    await db.config.applyConfig({
      scope: 'system', actor: 'test', patch: { usdtPricing: { merchantAdminBuyInr: 1 } },
    });
    const tokens = await balance();

    const res = await fund({ tokenAmount: 1000, settlementAmount: 11, settlementCurrency: 'USDT' });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/USDT buy rate is not set/i);
    // And it says what to do about it, both ways out (§14).
    expect(res.body.message).toMatch(/System Settings/);
    expect(res.body.message).toMatch(/record this settlement in INR/i);
    expect(await balance()).toBe(tokens);

    await db.config.applyConfig({
      scope: 'system', actor: 'test', patch: { usdtPricing: { merchantAdminBuyInr: 90 } },
    });
  });

  it('refuses a USDT PAYOUT — the platform buys its tokens back in rupees', async () => {
    const tokens = await balance();
    const res = await deduct({
      tokenAmount: 100, reason: 'test', settlementAmount: 1, settlementCurrency: 'USDT',
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/pays merchants back in INR/i);
    expect(await balance()).toBe(tokens);
  });

  // ── One movement, one trade ──────────────────────────────────────────────

  it('books ONE trade for a redelivered top-up, not two', async () => {
    const k = key();
    const first  = await fund({ tokenAmount: 200, settlementAmount: 190 }, k);
    const after  = await balance();
    const second = await fund({ tokenAmount: 200, settlementAmount: 190 }, k);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await balance()).toBe(after);

    const rows = await db.adminTokenConsiderations.listForMerchant(merchant.merchantId, { limit: 500 });
    expect(rows.filter((r) => r.movementId === `mint_${k}`)).toHaveLength(1);
  });

  // ── What the P&L reads ───────────────────────────────────────────────────

  it('adds the trades up in rupees, and keeps the settled currencies apart', async () => {
    // Own rows only, against a merchant nobody else in this suite touches —
    // trap 10: never assert a global invariant over a shared table.
    const solo = await merchantActor({ tokensRupees: 10000 });
    const post = (path, body, k) => as(app, admin)
      .post(`/api/merchants/${solo.merchantId}/${path}`)
      .set('Idempotency-Key', k).send(body);

    await post('fund',   { tokenAmount: 1000, settlementAmount: 950 },                        key());
    await post('fund',   { tokenAmount: 9000, settlementAmount: 100, settlementCurrency: 'USDT' }, key());
    await post('deduct', { tokenAmount: 500, reason: 'buy-back', settlementAmount: 480 },      key());

    const t = await db.adminTokenConsiderations.merchantConsiderationTotals(solo.merchantId);
    // ₹950 + (100 USDT × 90 = ₹9,000) = ₹9,950 in; ₹480 out.
    expect(t.receivedInrPaise).toBe(95000 + 900000);
    expect(t.paidInrPaise).toBe(48000);
    expect(t.netInrPaise).toBe(95000 + 900000 - 48000);
    expect(t.tokensSoldPaise).toBe(1000000);
    expect(t.tokensBoughtBackPaise).toBe(50000);
    // The settled figures stay apart, because only apart do they mean anything.
    expect(t.byCurrency.INR.receivedMinor).toBe(95000);
    expect(t.byCurrency.USDT.receivedMinor).toBe(10000);
    expect(t.byCurrency.INR.paidMinor).toBe(48000);
  });

  it('serves those figures to the screen that shows them', async () => {
    const res = await as(app, admin).get(`/api/merchants/${merchant.merchantId}/profit-engine`);
    expect(res.status).toBe(200);
    const trade = res.body?.data?.platformTokenTrade;
    expect(trade).toBeTruthy();
    // Rupees, not paise — the panel renders this straight.
    expect(trade.receivedInr).toBeGreaterThan(0);
    expect(trade.netInr).toBe(trade.receivedInr - trade.paidInr);
    expect(trade.byCurrency).toBeTruthy();
  });

  // ── Append-only, because this is what the books reconcile from ───────────

  it('cannot be edited after the fact', async () => {
    const k = key();
    await fund({ tokenAmount: 100, settlementAmount: 100 }, k);
    await expect(pgQuery(
      `UPDATE admin_token_considerations SET inr_equivalent_paise = 1 WHERE movement_id = $1`,
      [`mint_${k}`],
    )).rejects.toThrow();
    await expect(pgQuery(
      `DELETE FROM admin_token_considerations WHERE movement_id = $1`, [`mint_${k}`],
    )).rejects.toThrow();
  });
});
