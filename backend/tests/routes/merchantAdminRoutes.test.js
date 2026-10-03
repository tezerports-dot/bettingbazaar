// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The admin's merchant routes: who may reach them, the listing, and the
 * lifecycle (suspend, activate, reject).
 *
 * ── What used to be here, and where it went ─────────────────────────────────
 * This file was mostly the admin's TREASURY over merchants: minting tokens into
 * a merchant's wallet (`/merchants/:id/fund`), taking them back (`/deduct`), and
 * deciding a merchant's own token purchase (`/merchant-token-orders`). It kept
 * two defects dead — a fund route keyed on `random()` so every retry funded
 * twice, and an approve route that marked the order before the money moved.
 *
 * None of that machinery exists any more (PROJECT_STATUS §3.10, 2c). Merchants
 * hold no tokens: a TEAM's pool does, and the only way tokens reach one is a
 * supervisor's request an admin fulfils (`team.admin.routes.js`), whose
 * once-only guard is the request's own PENDING → FULFILLED flip. That path is
 * asserted in teamPoolRoutesPg.test.js and adminTokenConsideration.test.js.
 * What stays here is what still applies to every merchant: the doors, the
 * listing, and the lifecycle — and that the treasury routes stay gone.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pgConfigured, applySchema, closePg } from '#db/client.js';
import { getMerchant } from '#db/repositories/merchants.js';
import { historyFor } from '#db/repositories/audit.js';
import { mountRouter, actor, merchantActor, as, request } from './_harness.js';

const describePg = pgConfigured() ? describe : describe.skip;

describePg('merchant admin routes', () => {
  let app; let admin;
  const RUN = Math.random().toString(36).slice(2, 8);

  beforeAll(async () => {
    await applySchema();
    const mod = await import('../../domains/merchant/merchant.admin.routes.js');
    app = mountRouter(mod.default);
    admin = await actor({ isAdmin: true, roles: ['admin'] });
  }, 60_000);

  afterAll(async () => { await closePg(); });

  // ── Authorisation ─────────────────────────────────────────────────────────
  it('refuses every merchant route without a token', async () => {
    for (const call of [
      () => request(app).get('/merchants'),
      () => request(app).get('/merchants/m'),
      () => request(app).put('/merchants/m/suspend').send({ reason: 'r' }),
      () => request(app).put('/merchants/m/activate').send({}),
      () => request(app).put('/merchants/m/reject').send({ reason: 'r' }),
    ]) {
      expect((await call()).status, 'an unauthenticated call must never reach a handler').toBe(401);
    }
  });

  it('refuses the merchant routes to a signed-in NON-admin, and changes nothing', async () => {
    const nobody = await actor({});
    const m = await merchantActor({});
    expect((await as(app, nobody).get('/merchants')).status).toBe(403);
    const res = await as(app, nobody).put(`/merchants/${m.merchantId}/suspend`).send({ reason: 'not mine to do' });
    expect(res.status).toBe(403);
    expect((await getMerchant(m.merchantId)).status).toBe('ACTIVE');
  });

  it('refuses staff who hold only the team-pool area — money is not merchant management', async () => {
    // `canFundMerchants` now means "Team pool requests" (§3.10). It used to
    // reach the fund/deduct routes on THIS router; it must reach nothing here.
    const funder = await actor({ isSubAdmin: true, permissions: { canFundMerchants: true } });
    const m = await merchantActor({});
    expect((await as(app, funder).get('/merchants')).status).toBe(403);
    expect((await as(app, funder).put(`/merchants/${m.merchantId}/suspend`).send({ reason: 'x' })).status).toBe(403);
    expect((await getMerchant(m.merchantId)).status).toBe('ACTIVE');
  });

  // ── The treasury over merchants is gone, and stays gone ───────────────────
  it('serves none of the deleted treasury routes', async () => {
    // A merchant holds no tokens, so there is nothing to fund, deduct or sell
    // them, and nothing to rank them by. Any of these answering would be a
    // second way into a pool's money beside the supervisor's request (§2).
    const m = await merchantActor({});
    for (const [method, path] of [
      ['post', `/merchants/${m.merchantId}/fund`],
      ['post', `/merchants/${m.merchantId}/deduct`],
      ['put', `/merchants/${m.merchantId}/limits`],
      ['get', `/merchants/${m.merchantId}/profit-engine`],
      ['get', `/merchants/${m.merchantId}/scoring`],
      ['get', '/merchant-token-orders'],
      ['post', '/merchant-token-orders/o/approve'],
      ['post', '/merchant-token-orders/o/reject'],
    ]) {
      const res = await as(app, admin)[method](path).set('Idempotency-Key', `rt-${RUN}-gone`)
        .send({ tokenAmount: 100, reason: 'r', settlementAmount: 0 });
      expect(res.status, `${method.toUpperCase()} ${path} is still served`).toBe(404);
    }
  });

  // ── The listing ───────────────────────────────────────────────────────────
  it('lists merchants for an admin, with no token balance on the row', async () => {
    // The Wallet column read `tokenBalance` off these rows. A member holds no
    // tokens (§3.10) — the team's pool does — so a balance here would be a
    // number no movement can find (§32 S9). The pool is on the Teams screen.
    const m = await merchantActor({});
    const res = await as(app, admin).get('/merchants?limit=200');
    expect(res.status).toBe(200);
    const row = res.body.merchants.find((x) => x.merchantId === m.merchantId);
    expect(row, 'the new merchant is missing from the listing').toBeTruthy();
    expect(row).toMatchObject({ status: 'ACTIVE', merchantApprovalStatus: 'APPROVED' });
    for (const gone of ['tokenBalance', 'scoring', 'limits', 'cashDenomination',
      'maxConcurrentDepositOrders', 'maxConcurrentWithdrawalOrders']) {
      expect(row, `the listing still carries ${gone}`).not.toHaveProperty(gone);
    }
  });

  it('serves one merchant, and no balance on it either', async () => {
    const m = await merchantActor({});
    const res = await as(app, admin).get(`/merchants/${m.merchantId}`);
    expect(res.status).toBe(200);
    expect(res.body.merchant.merchantId).toBe(m.merchantId);
    expect(res.body.merchant).not.toHaveProperty('tokenBalance');
    expect((await as(app, admin).get(`/merchants/ghost-${RUN}`)).status).toBe(404);
  });

  // ── The lifecycle routes ──────────────────────────────────────────────────
  it('suspends and reactivates a merchant, and records who did it', async () => {
    const m = await merchantActor({});
    const suspended = await as(app, admin).put(`/merchants/${m.merchantId}/suspend`).send({ reason: 'under investigation' });
    expect(suspended.status, suspended.body.message).toBe(200);
    const row = await getMerchant(m.merchantId);
    expect(row.status).toBe('SUSPENDED');
    expect(row.suspensionReason).toBe('under investigation');

    const activated = await as(app, admin).put(`/merchants/${m.merchantId}/activate`).send({});
    expect(activated.status, activated.body.message).toBe(200);
    const back = await getMerchant(m.merchantId);
    expect(back.status).toBe('ACTIVE');
    // Cleared in the same statement: ACTIVE while still reading "suspended for
    // …" is a row saying two things at once.
    expect(back.suspensionReason ?? null).toBeNull();

    const actions = (await historyFor(m.merchantId)).map((e) => [e.action, e.performedBy]);
    expect(actions).toContainEqual(['MERCHANT_SUSPENDED', admin.userId]);
    expect(actions).toContainEqual(['MERCHANT_ACTIVATED', admin.userId]);
  });

  it('refuses a suspension with no reason — nobody could appeal it', async () => {
    const m = await merchantActor({});
    for (const reason of [undefined, '', '   ']) {
      const res = await as(app, admin).put(`/merchants/${m.merchantId}/suspend`).send({ reason });
      expect(res.status, `accepted reason=${JSON.stringify(reason)}`).toBe(400);
    }
    expect((await getMerchant(m.merchantId)).status).toBe('ACTIVE');
  });

  it('refuses a blank-looking rejection reason as the admin\'s mistake, not a 500', async () => {
    // The route tested `!reason`; the writer requires `reason.trim()`. A reason
    // of spaces passed the first and threw a bare Error from the second, which
    // answered "Something went wrong" to a request that can never succeed.
    const m = await merchantActor({});
    const res = await as(app, admin).put(`/merchants/${m.merchantId}/reject`).send({ reason: '   ' });
    expect(res.status, res.body.message).toBe(400);
    expect((await getMerchant(m.merchantId)).status).toBe('ACTIVE');
  });

  it('404s a lifecycle change on a merchant that does not exist', async () => {
    for (const [path, body] of [
      [`/merchants/ghost-${RUN}/suspend`, { reason: 'x' }],
      [`/merchants/ghost-${RUN}/activate`, {}],
      [`/merchants/ghost-${RUN}/reject`, { reason: 'x' }],
    ]) {
      const res = await as(app, admin).put(path).send(body);
      expect(res.status, `${path} answered ${res.status}`).toBe(404);
    }
  });
});
