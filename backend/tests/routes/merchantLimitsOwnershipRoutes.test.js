// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
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
 * which nothing reads for any decision. Merchant assignment filters candidates
 * on `minOrder` and `maxOrder`, and only the admin route writes those. So a
 * merchant could raise their limits, be told it saved, and be offered exactly
 * the same orders as before — a control that was both wrong to offer and
 * inert.
 *
 * Asserted from both ends: the merchant route is gone, and the admin route
 * moves the number assignment actually reads.
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

  it('lets an admin set the range assignment reads', async () => {
    const admin = await actor({ isAdmin: true });
    const merchant = await merchantActor({});

    const res = await as(adminApp, admin)
      .put(`/merchants/${merchant.merchantId}/limits`)
      .send({ minOrder: 1000, maxOrder: 25000 });

    expect(res.status).toBe(200);
    // The stored row, not the response — `minOrder`/`maxOrder` are what
    // merchant.assignment.routes.js filters candidates on.
    const row = await getMerchant(merchant.merchantId);
    expect(Number(row.minOrder)).toBe(1000);
    expect(Number(row.maxOrder)).toBe(25000);
  });

  it('refuses a range that admits no amount', async () => {
    // A minimum above the maximum excludes every order. The row's CHECK is what
    // refuses it; this asserts the route reports that rather than 500ing.
    const admin = await actor({ isAdmin: true });
    const merchant = await merchantActor({});
    const before = await getMerchant(merchant.merchantId);

    const res = await as(adminApp, admin)
      .put(`/merchants/${merchant.merchantId}/limits`)
      .send({ minOrder: 90000, maxOrder: 100 });

    expect(res.status).toBe(400);
    const after = await getMerchant(merchant.merchantId);
    expect(Number(after.minOrder)).toBe(Number(before.minOrder));
    expect(Number(after.maxOrder)).toBe(Number(before.maxOrder));
  });

  it('refuses a non-admin', async () => {
    const player = await actor({});
    const merchant = await merchantActor({});
    const res = await as(adminApp, player)
      .put(`/merchants/${merchant.merchantId}/limits`)
      .send({ minOrder: 1, maxOrder: 2 });
    expect([401, 403]).toContain(res.status);
  });
});
