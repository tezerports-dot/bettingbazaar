// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The admin sets a merchant's limits. The merchant cannot.
 *
 * ── Why this matters ────────────────────────────────────────────────────────
 * A merchant's caps follow from what they have put up — a security deposit, or
 * the tokens they bought from the platform to trade with. A merchant who can
 * raise their own ceiling can take on more exposure than they have covered,
 * which is the platform's risk, not theirs.
 *
 * ── The route that was there, and why it was worse than it looked ───────────
 * `PUT /api/merchant/limits` let a merchant set their own. It also wrote the
 * WRONG FIELDS: `limits.minDeposit`/`maxDeposit`/`minWithdraw`/`maxWithdraw`,
 * which nothing reads for any decision. So a merchant could raise their limits,
 * be told it saved, and be offered exactly the same orders as before — a
 * control that was both wrong to offer and inert.
 *
 * ── The order RANGE that replaced it was inert too ─────────────────────────
 * This file used to assert that the admin route moved `minOrder`/`maxOrder`,
 * "the number assignment actually reads". It did not: `assignmentCandidates`
 * never named either column, and the only filter on them lived in an admin
 * SCREEN. Both are gone now — a merchant's ceiling is the tokens they hold,
 * enforced by the deposit escrow, and the floor is platform-wide.
 *
 * What is still worth asserting is the OWNERSHIP: a merchant cannot set their
 * own caps, and the admin route that can is admin-only. The cap that survives
 * and still means something is concurrency.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { pgConfigured, applySchema, closePg } from '#db/client.js';
import { getMerchant } from '#db/repositories/merchants.js';
import { mountRouter, actor, merchantActor, as } from './_harness.js';

const describePg = pgConfigured() ? describe : describe.skip;

describePg('who sets a merchant limit', () => {
  let merchantApp;
  let adminApp;

  beforeAll(async () => {
    await applySchema();
    merchantApp = mountRouter((await import('../../domains/merchant/merchant.routes.js')).default);
    adminApp = mountRouter((await import('../../domains/merchant/merchant.admin.routes.js')).default);
  }, 60_000);

  afterAll(async () => { await closePg(); });

  it('serves no merchant-side limits route', async () => {
    const merchant = await merchantActor({});
    const res = await as(merchantApp, merchant).put('/limits').send({ maxDeposit: 999999 });
    expect(res.status).toBe(404);
  });

  it('declares no merchant-side limits route in source either', () => {
    // The status alone would also be 404 for a typo in this test. This is the
    // assertion that the route is actually gone.
    const src = readFileSync(new URL('../../domains/merchant/merchant.routes.js', import.meta.url), 'utf8');
    expect(src).not.toMatch(/router\.put\(\s*['"`]\/limits['"`]/);
  });

  it('lets an admin set the cash tier, which IS read', async () => {
    // What this route still owns, and it is genuinely read: the claim query
    // gates on `cash_denomination_paise` in its own WHERE, on both the supply
    // and the claim side. The concurrency cap is set through the SCORING
    // endpoint, not here — a detail worth stating, because a test asserting it
    // against this route fails with "No limit fields provided" and reads like
    // the route being broken.
    const admin = await actor({ isAdmin: true });
    const merchant = await merchantActor({});

    const res = await as(adminApp, admin)
      .put(`/merchants/${merchant.merchantId}/limits`)
      .send({ cashDenomination: 5000 });   // ₹5,000 — a real rung of the ladder

    expect(res.status, res.body?.message).toBe(200);
    const row = await getMerchant(merchant.merchantId);
    expect(Number(row.cashDenominationPaise)).toBe(500_000);
  });

  it('no longer accepts an order range at all', async () => {
    // Sent and ignored, not stored: `minOrder`/`maxOrder` have no columns and
    // no consumer. Asserted so that removing them cannot be quietly undone by
    // re-adding a field nothing reads (§3).
    const admin = await actor({ isAdmin: true });
    const merchant = await merchantActor({});

    const res = await as(adminApp, admin)
      .put(`/merchants/${merchant.merchantId}/limits`)
      .send({ minOrder: 90000, maxOrder: 100 });

    // Refused as "no limit fields provided": the route does not merely ignore
    // them, it does not recognise them at all.
    expect(res.status).toBe(400);
    const row = await getMerchant(merchant.merchantId);
    expect(row.minOrder, 'the order range came back').toBeUndefined();
    expect(row.maxOrder, 'the order range came back').toBeUndefined();
  });

  it('refuses a non-admin', async () => {
    const player = await actor({});
    const merchant = await merchantActor({});
    const res = await as(adminApp, player)
      .put(`/merchants/${merchant.merchantId}/limits`)
      .send({ cashDenomination: 5000 });
    expect([401, 403]).toContain(res.status);
  });
});
