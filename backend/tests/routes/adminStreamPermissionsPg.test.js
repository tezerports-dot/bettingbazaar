// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The admin live stream, as a real HTTP stream against the real database.
 *
 * On connect it pushes `queue_snapshot`: every pending order with its player.
 * It went to every staff account that connected — a sub-admin trusted with the
 * FAQ page received the payment queue. Now it goes to the staff who work the
 * queue, and every later event to the areas `staffEventAreas.js` names.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import express from 'express';
import { pgConfigured, applySchema, closePg } from '#db/client.js';
import SSEManager from '../../domains/notification/sseManager.service.js';
import { actor } from './_harness.js';

const describePg = pgConfigured() ? describe : describe.skip;

describePg('the admin live stream, by area', () => {
  let server;
  let port;
  let sse;

  /** Open the stream as `who`, read for a moment, close it, return the frames. */
  const listen = (who, ms = 400) => new Promise((resolve, reject) => {
    const req = http.get({ port, path: `/sse/admin/events?token=${encodeURIComponent(who.token)}` }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      setTimeout(() => { req.destroy(); resolve({ status: res.statusCode, events: [...body.matchAll(/^event: (.+)$/gm)].map((m) => m[1]) }); }, ms);
    });
    req.on('error', (e) => { if (e.code !== 'ECONNRESET') reject(e); });
  });

  beforeAll(async () => {
    await applySchema();
    const { initSSERoutes } = await import('../../routes/sse.routes.js');
    sse = new SSEManager();
    const app = express();
    app.use('/sse', initSSERoutes(sse, {}));
    server = app.listen(0);
    port = server.address().port;
  }, 60_000);

  afterAll(async () => {
    sse.destroy();
    await new Promise((r) => server.close(r));
    await closePg();
  });

  it('sends the queue snapshot to staff who work the queue', async () => {
    const merchants = await actor({ isSubAdmin: true, permissions: { canManageMerchants: true } });
    const qm = await actor({ isQueueManager: true });
    const admin = await actor({ isAdmin: true });
    for (const who of [merchants, qm, admin]) {
      const { status, events } = await listen(who);
      expect(status).toBe(200);
      expect(events).toContain('queue_snapshot');
    }
  });

  it('does not send it to a sub-admin who was given other areas', async () => {
    const content = await actor({ isSubAdmin: true, permissions: { canManageContent: true } });
    const { status, events } = await listen(content);
    // Connected — the stream still carries what their areas need — but no queue.
    expect(status).toBe(200);
    expect(events).not.toContain('queue_snapshot');
  });
});
