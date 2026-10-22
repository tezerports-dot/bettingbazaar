// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The queue WRITES are gated on a permission, not on a tier (R6, F-042).
 *
 * Offering a queued order to the teams now and taking an assigned order off
 * its member decide who serves a player's money. They carried
 * `isAdminOrSubAdminOrQueueManager`, a TIER check, so a sub-admin holding only
 * `canModerateChatPublic` could move any player's order — F-001's shape, on a
 * middleware name the audit gate did not count.
 *
 * Neither takes a merchant any more: every order is routed through the teams
 * (PROJECT_STATUS §3.10, 2c), so the bodies below are empty. The third write
 * this file once covered — `PUT /queue/merchant-pool`, the hand-kept pool of
 * merchants a queue manager could pick from — was deleted with the picker, and
 * the route is gone (404 to everybody), so it is no longer listed here.
 *
 * Admission only: an order id that does not exist gets past the gate and is
 * refused by the handler (not 403), which is the line this test draws.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pgConfigured, applySchema, closePg } from '#db/client.js';
import { actor, mountRouter, as } from './_harness.js';

const describePg = pgConfigured() ? describe : describe.skip;

const WRITES = [
  ['post', '/payment-orders/ORD-does-not-exist/reassign', {}],
  ['post', '/queue/assign/ORD-does-not-exist', {}],
];

describePg('queue writes require canManageMerchants (there is no queue-manager role; owner, 2026-10-21)', () => {
  let app;
  const who = {};

  beforeAll(async () => {
    await applySchema();
    app = mountRouter((await import('../../domains/merchant/merchant.assignment.routes.js')).default);
    who.chatModerator = await actor({ isSubAdmin: true, permissions: { canModerateChatPublic: true } });
    who.merchantManager = await actor({ isSubAdmin: true, permissions: { canManageMerchants: true } });
  }, 60_000);
  afterAll(async () => { await closePg(); });

  it.each(WRITES)('refuses a sub-admin without the key: %s %s', async (method, path, body) => {
    const res = await as(app, who.chatModerator)[method](path).send(body);
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.requiredPermission).toBe('canManageMerchants');
  });

  it.each(WRITES.filter(([, p]) => !p.startsWith('/queue/assign')))(
    'admits a sub-admin holding canManageMerchants: %s %s', async (method, path, body) => {
      const res = await as(app, who.merchantManager)[method](path).send(body);
      expect(res.status, JSON.stringify(res.body)).not.toBe(403);
    });

  it('lets a sub-admin holding the area ASSIGN too — the gate is the only answer', async () => {
    // The handler used to refuse every sub-admin AFTER the gate admitted them,
    // so the payment queue screen the panel offered them failed on load. Owner,
    // 2026-10-01: a sub-admin works in the areas they were given. It is now
    // the gate alone; past it, the handler answers on the ORDER.
    const res = await as(app, who.merchantManager).post('/queue/assign/ORD-does-not-exist').send({});
    expect(res.status).toBe(404);
    expect(res.body.message).toBe('Order not found');
  });
});

// ── The queue's own LIST, which the Payment Queue screen loads first ─────────
// `GET /api/admin/payment-queue` was once gated on canViewTransactions, so the
// screen the panel offered by the merchants area answered 403. The writes above
// were right; the read they depend on was not.
describePg('the payment queue list', () => {
  let app;
  const who = {};
  beforeAll(async () => {
    await applySchema();
    app = mountRouter((await import('../../domains/payment/paymentOrder.routes.js')).default);
    who.merchantManager = await actor({ isSubAdmin: true, permissions: { canManageMerchants: true } });
    who.chatModerator = await actor({ isSubAdmin: true, permissions: { canModerateChat: true } });
  }, 60_000);

  it('loads for a sub-admin holding the merchants area, as the other queue routes do', async () => {
    const res = await as(app, who.merchantManager).get('/payment-queue');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });

  it('is refused to a sub-admin given only another area (the opposite case)', async () => {
    expect((await as(app, who.chatModerator).get('/payment-queue')).status).toBe(403);
  });
});
