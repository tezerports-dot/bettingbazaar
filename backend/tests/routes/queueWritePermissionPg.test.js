// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The three queue WRITES are gated on a permission, not on a tier (R6, F-042).
 *
 * Assigning a queued order, reassigning an order and editing the merchant pool
 * decide which merchant a player's money goes to. They carried
 * `isAdminOrSubAdminOrQueueManager`, a TIER check, so a sub-admin holding only
 * `canModerateChatPublic` could send any player's order anywhere — F-001's
 * shape, on a middleware name the audit gate did not count.
 *
 * Admission only: an order id that does not exist gets past the gate and is
 * refused by the handler (not 403), which is the line this test draws.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pgConfigured, applySchema, closePg } from '#db/client.js';
import { actor, mountRouter, as } from './_harness.js';

const describePg = pgConfigured() ? describe : describe.skip;

const WRITES = [
  ['post', '/payment-orders/ORD-does-not-exist/reassign', { merchantId: 'nobody' }],
  ['post', '/queue/assign/ORD-does-not-exist', { merchantId: 'nobody' }],
  ['put', '/queue/merchant-pool', { merchantIds: [] }],
];

describePg('queue writes require canManageMerchants (or the queue-manager role)', () => {
  let app;
  const who = {};

  beforeAll(async () => {
    await applySchema();
    app = mountRouter((await import('../../domains/merchant/merchant.assignment.routes.js')).default);
    who.chatModerator = await actor({ isSubAdmin: true, permissions: { canModerateChatPublic: true } });
    who.merchantManager = await actor({ isSubAdmin: true, permissions: { canManageMerchants: true } });
    who.queueManager = await actor({ isQueueManager: true });
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

  it('keeps ASSIGN to queue managers and admins, whatever a sub-admin holds', async () => {
    // The handler's own rule, stricter than the gate, and unchanged: first
    // assignment of a queued order is the queue manager's job.
    const res = await as(app, who.merchantManager).post('/queue/assign/ORD-does-not-exist').send({ merchantId: 'nobody' });
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/Queue manager access required/);
  });

  it.each(WRITES)('admits a queue manager, whose role this screen is for: %s %s', async (method, path, body) => {
    const res = await as(app, who.queueManager)[method](path).send(body);
    expect(res.status, JSON.stringify(res.body)).not.toBe(403);
  });
});
