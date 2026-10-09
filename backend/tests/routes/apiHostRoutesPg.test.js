// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Admin > Settings > API Host, through the real routers and a real database.
 *
 * What this pins:
 *   · the admin config GET offers exactly the deployment's approved hosts;
 *   · saving a host outside that list is refused 400 by name, and nothing is
 *     written — an admin picks among hosts the operator serves, never adds one;
 *   · `GET /api/v1/client/endpoint` (the app's discovery answer) serves the
 *     saved choice as `https://<host>`, and stops serving it the moment the
 *     host leaves the approved list (404, the app falls back to its primary).
 *
 * Trap 10: the setting is restored in afterAll to what this file found.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { pgConfigured, applySchema, closePg } from '#db/client.js';
import { getConfig, setConfigPath } from '#db/repositories/config.js';
import { mountRouter, actor, as } from './_harness.js';

const describePg = pgConfigured() ? describe : describe.skip;

describePg('the API host setting and the discovery answer', () => {
  let adminApp; let endpointApp; let admin;
  let storedBefore;
  const envBefore = process.env.API_ALLOWED_HOSTS;

  beforeAll(async () => {
    await applySchema();
    adminApp = mountRouter((await import('../../routes/admin/system.admin.routes.js')).default);
    endpointApp = mountRouter((await import('../../routes/clientEndpoint.routes.js')).default, { prefix: '/api' });
    admin = await actor({ isAdmin: true });
    storedBefore = (await getConfig('system', { fresh: true })).apiHost;
    process.env.API_ALLOWED_HOSTS = 'api.example.com, API-Backup.example.net, *.bad.example, 10.0.0.1';
  }, 60_000);

  afterAll(async () => {
    process.env.API_ALLOWED_HOSTS = envBefore;
    if (envBefore === undefined) delete process.env.API_ALLOWED_HOSTS;
    await setConfigPath('system', 'apiHost', storedBefore ?? '');
    await closePg();
  });

  it('the admin GET offers the approved hosts only (no wildcard, no address)', async () => {
    const res = await as(adminApp, admin).get('/system/config');
    expect(res.status).toBe(200);
    expect(res.body.config.apiHostChoices).toEqual(['api.example.com', 'api-backup.example.net']);
    expect(res.body.config).toHaveProperty('apiHost');
  });

  it('saving an unapproved host is refused by name, and nothing is written', async () => {
    await setConfigPath('system', 'apiHost', '');
    const res = await as(adminApp, admin).put('/system/config').send({ apiHost: 'evil.example.com' });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/apiHost/);
    expect(res.body.message).toMatch(/api\.example\.com/);
    expect((await getConfig('system', { fresh: true })).apiHost).toBe('');
  });

  it('an approved host is saved and served as the discovery answer', async () => {
    const save = await as(adminApp, admin).put('/system/config').send({ apiHost: 'api-backup.example.net' });
    expect(save.status).toBe(200);
    const res = await request(endpointApp).get('/api/v1/client/endpoint');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ url: 'https://api-backup.example.net' });
    expect(res.headers['cache-control']).toMatch(/max-age=60/);
  });

  it('a host removed from the approved list is no longer served', async () => {
    await setConfigPath('system', 'apiHost', 'api-backup.example.net');
    process.env.API_ALLOWED_HOSTS = 'api.example.com';
    const res = await request(endpointApp).get('/api/v1/client/endpoint');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NO_API_HOST');
    process.env.API_ALLOWED_HOSTS = 'api.example.com,api-backup.example.net';
  });

  it('no choice (the default) answers 404, and clearing the choice is allowed', async () => {
    const clear = await as(adminApp, admin).put('/system/config').send({ apiHost: '' });
    expect(clear.status).toBe(200);
    const res = await request(endpointApp).get('/api/v1/client/endpoint');
    expect(res.status).toBe(404);
  });
});
