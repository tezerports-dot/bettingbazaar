// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Cross-site request forgery (owner, 2026-10-21): a session travels only in the
 * Authorization header. A browser attaches cookies to a request another site
 * makes, never that header, so a token in a cookie must prove nothing. Through
 * the real routers (cookie parser mounted as server.js mounts it) and a real
 * database; the bearer header still works (the opposite behaviour).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pgConfigured, applySchema, closePg } from '#db/client.js';
import { mountRouter, actor } from './_harness.js';
import request from 'supertest';

const describePg = pgConfigured() ? describe : describe.skip;

describePg('a session is never read from a cookie', () => {
  let player; let userApp;

  beforeAll(async () => {
    await applySchema();
    userApp = mountRouter((await import('../../domains/user/user.routes.js')).default, { prefix: '/api' });
    player = await actor({});
  }, 60_000);

  afterAll(async () => { await closePg(); });

  it('a valid token in the auth_token cookie is refused 401', async () => {
    const res = await request(userApp).get('/api/user/maintenance-pass').set('Cookie', `auth_token=${player.token}`);
    expect(res.status).toBe(401);
  });

  it('the same token in the Authorization header is admitted', async () => {
    const res = await request(userApp).get('/api/user/maintenance-pass').set('Authorization', player.auth);
    expect(res.status).toBe(200);
  });
});
