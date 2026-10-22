// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * adminHostGate (config/network.config.js): with ADMIN_HOST set, the admin
 * panel's pages, API and event stream answer only on that name; every other
 * host gets a 404 for them and keeps everything else. Unset changes nothing.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { network, adminHostGate } from '../../config/network.config.js';
import { servableHosts } from '../../config/servedHosts.js';

function app() {
  const a = express();
  a.use(adminHostGate);
  a.use((req, res) => res.status(200).send(`served ${req.path}`));
  return a;
}

const ADMIN = 'ops-7k2q.example.com';
const PLAYER = 'play.example.com';

describe('adminHostGate', () => {
  let saved;
  beforeEach(() => { saved = network.adminHost; });
  afterEach(() => { network.adminHost = saved; });

  it('changes nothing while ADMIN_HOST is unset', async () => {
    network.adminHost = '';
    for (const path of ['/admin/', '/api/admin/me', '/api/sse/admin/events', '/']) {
      const res = await request(app()).get(path).set('Host', PLAYER);
      expect(res.status, path).toBe(200);
    }
  });

  it('hides every admin path on any other host, including the bare IP', async () => {
    network.adminHost = ADMIN;
    for (const host of [PLAYER, '187.126.116.36', 'standby.example.net', `${PLAYER}:443`]) {
      for (const path of ['/admin', '/admin/', '/admin/assets/x.js', '/api/admin/login', '/api/admin/staff', '/api/sse/admin/events']) {
        const res = await request(app()).get(path).set('Host', host);
        expect(res.status, `${host}${path}`).toBe(404);
      }
      const post = await request(app()).post('/api/admin/login').set('Host', host).send({});
      expect(post.status).toBe(404);
    }
  });

  it('hides admin paths in ANY letter case, since Express routes case-insensitively (review 2026-10-22)', async () => {
    network.adminHost = ADMIN;
    for (const path of ['/ADMIN/', '/Admin/assets/x.js', '/API/ADMIN/me', '/Api/Admin/staff', '/API/SSE/ADMIN/events']) {
      const res = await request(app()).get(path).set('Host', PLAYER);
      expect(res.status, path).toBe(404);
    }
  });

  it('leaves the player and merchant panels alone on other hosts', async () => {
    network.adminHost = ADMIN;
    for (const path of ['/', '/wallet', '/merchant/', '/api/merchant/stats', '/api/administrator', '/administer']) {
      const res = await request(app()).get(path).set('Host', PLAYER);
      expect(res.status, path).toBe(200);
    }
  });

  it('serves the admin panel on its own host, any letter case, and sends / to /admin/', async () => {
    network.adminHost = ADMIN;
    for (const path of ['/admin/', '/api/admin/me', '/api/sse/admin/events']) {
      const res = await request(app()).get(path).set('Host', ADMIN.toUpperCase());
      expect(res.status, path).toBe(200);
    }
    const root = await request(app()).get('/').set('Host', ADMIN);
    expect(root.status).toBe(302);
    expect(root.headers.location).toBe('/admin/');
  });

  it('counts the admin host as servable, so it gets a certificate and CORS', async () => {
    network.adminHost = ADMIN;
    expect(await servableHosts()).toContain(ADMIN);
    network.adminHost = '';
    expect(await servableHosts()).not.toContain('');
  });
});
