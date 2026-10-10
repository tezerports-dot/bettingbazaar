// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * What a stream is sent the moment it opens, now that it is the player app's
 * only live connection (2026-10-10; the app opens no socket).
 *
 * The opening `system_config` and `branding` used to be whatever a SOCKET had
 * last cached in the same process (`global.cachedSystemConfig`,
 * `global.cachedBranding`), the config filtered through a second field list of
 * the stream's own. With no socket, nothing fills those caches, so the stream
 * must read both itself, through the one builder each (§5).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { pgConfigured, applySchema, closePg } from '#db/client.js';
import { actor, mountRouter } from './_harness.js';

const describePg = pgConfigured() ? describe : describe.skip;

/** Open a stream on the real route; collect its opening events, then end it. */
async function open(path) {
  const { initSSERoutes } = await import('../../routes/sse.routes.js');
  const events = [];
  let stream = null;
  let histories = 0;
  const sse = {
    addClient: (res) => { stream = res; return 1; },
    addUserClient: () => {},
    sendToClient: (_id, event, data) => {
      events.push({ event, data });
      // History is the last thing the opening sends, once per audience.
      if (event === 'cycle_history' && (histories += 1) === 2) stream.end();
    },
  };
  const app = express();
  app.use(cookieParser());
  app.use('/sse', initSSERoutes(sse, { getCycleSnapshotData: async () => ({}) }));
  const res = await request(app).get(path);
  return { status: res.status, events };
}

describePg('a stream’s opening', () => {
  beforeAll(async () => {
    await applySchema();
    delete global.cachedSystemConfig;
    delete global.cachedBranding;
  }, 60_000);
  afterAll(async () => { await closePg(); });

  it('sends the full system config and the branding with no socket ever connected', async () => {
    const { systemConfigPayload } = await import('../../domains/configuration/systemConfigPayload.js');
    const { getSystemConfig } = await import('#db/repositories/config.js');
    const s = await open('/sse/events');
    expect(s.status).toBe(200);
    const names = s.events.map((e) => e.event);
    expect(names).toEqual(['cycle_snapshot', 'cycle_snapshot', 'system_config', 'branding', 'cycle_history', 'cycle_history']);
    // The builder's whole payload — the fields the old eight-field filter dropped included.
    const config = s.events.find((e) => e.event === 'system_config').data;
    expect(Object.keys(config).sort()).toEqual(Object.keys(systemConfigPayload(await getSystemConfig())).sort());
    expect(config).toHaveProperty('footerPages');
    expect(s.events.find((e) => e.event === 'branding').data).toEqual(expect.any(Object));
  });

  it("the player stream opens with the same public events as the visitor's", async () => {
    const p = await actor({});
    const s = await open(`/sse/player/events?token=${encodeURIComponent(p.token)}`);
    expect(s.status).toBe(200);
    expect(s.events.map((e) => e.event)).toEqual(
      ['cycle_snapshot', 'cycle_snapshot', 'system_config', 'branding', 'cycle_history', 'cycle_history']);
  });

  // What the app ASKED over the socket it asks over HTTP now (§28: a call
  // that resolves to no route is a live defect).
  it('serves the published promos of a location over HTTP, and no draft', async () => {
    const content = await import('#db/repositories/content.js');
    const tag = `sse-open-${Date.now().toString(36)}`;
    const live = await content.upsertPromo({ title: `${tag}-live`, location: 'RULES_PAGE', status: 'PUBLISHED', isActive: true, priority: 999, fileUrl: 'https://cdn.example.com/p.webp' });
    const draft = await content.upsertPromo({ title: `${tag}-draft`, location: 'RULES_PAGE', status: 'DRAFT', isActive: true, priority: 999 });
    try {
      const app = mountRouter((await import('../../domains/user/user.routes.js')).default);
      // Lower case, as a screen may send it: the route upper-cases.
      const res = await request(app).get('/v1/content/promo/rules_page');
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const titles = res.body.content.map((c) => c.title);
      expect(titles).toContain(`${tag}-live`);
      expect(titles).not.toContain(`${tag}-draft`);
      // Each screen's frame, from the server's one list, beside the cards.
      const { PROMO_DEVICES } = await import('#db/spec/promoDevices.js');
      expect(res.body.devices).toEqual(JSON.parse(JSON.stringify(PROMO_DEVICES)));
    } finally {
      await content.deletePromo(live.promoId);
      await content.deletePromo(draft.promoId);
    }
  });
});
