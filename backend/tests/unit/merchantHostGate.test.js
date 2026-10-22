// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * merchantHostGate (config/network.config.js): with MERCHANT_HOST set, the
 * merchant panel's pages, API and event stream answer only on that name; every
 * other host gets a 404 for them and keeps everything else. Verify's link and a
 * merchant HANDOFF follow the host. Unset changes nothing.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { network, adminHostGate, merchantHostGate } from '../../config/network.config.js';
import { servableHosts } from '../../config/servedHosts.js';
import { deliveryFor, destinationFor } from '../../domains/identity/telegramChallenge.service.js';

function app() {
  const a = express();
  a.use(adminHostGate);
  a.use(merchantHostGate);
  a.use((req, res) => res.status(200).send(`served ${req.path}`));
  return a;
}

const MERCHANT = 'desk-9m4t.example.com';
const ADMIN = 'ops-7k2q.example.com';
const PLAYER = 'play.example.com';

describe('merchantHostGate', () => {
  let saved;
  let savedOrigin;
  beforeEach(() => {
    saved = { merchant: network.merchantHost, admin: network.adminHost };
    savedOrigin = process.env.PUBLIC_APP_ORIGIN;
    process.env.PUBLIC_APP_ORIGIN = `https://${PLAYER}`;
  });
  afterEach(() => {
    network.merchantHost = saved.merchant;
    network.adminHost = saved.admin;
    if (savedOrigin === undefined) delete process.env.PUBLIC_APP_ORIGIN;
    else process.env.PUBLIC_APP_ORIGIN = savedOrigin;
  });

  it('changes nothing while MERCHANT_HOST is unset', async () => {
    network.merchantHost = '';
    for (const path of ['/merchant/', '/api/merchant/stats', '/api/sse/merchant/events', '/']) {
      const res = await request(app()).get(path).set('Host', PLAYER);
      expect(res.status, path).toBe(200);
    }
    expect(destinationFor('MERCHANT')).toBe(`https://${PLAYER}/merchant/`);
  });

  it('hides every merchant path on any other host, the admin host and the bare IP included', async () => {
    network.merchantHost = MERCHANT;
    network.adminHost = ADMIN;
    for (const host of [PLAYER, ADMIN, '187.126.116.36', `${PLAYER}:443`]) {
      for (const path of ['/merchant', '/merchant/', '/merchant/assets/x.js', '/api/merchant/auth/login/telegram', '/api/sse/merchant/events']) {
        const res = await request(app()).get(path).set('Host', host);
        expect(res.status, `${host}${path}`).toBe(404);
      }
      const post = await request(app()).post('/api/merchant/auth/login/telegram').set('Host', host).send({});
      expect(post.status).toBe(404);
    }
  });

  it('leaves the player panel alone on other hosts, and the admin panel on its own', async () => {
    network.merchantHost = MERCHANT;
    network.adminHost = ADMIN;
    for (const path of ['/', '/wallet', '/api/merchants-public', '/merchantx']) {
      const res = await request(app()).get(path).set('Host', PLAYER);
      expect(res.status, path).toBe(200);
    }
    expect((await request(app()).get('/api/admin/me').set('Host', ADMIN)).status).toBe(200);
    // The admin panel is not on the merchant host either.
    expect((await request(app()).get('/api/admin/me').set('Host', MERCHANT)).status).toBe(404);
  });

  it('serves the merchant panel on its own host, any letter case, and sends / to /merchant/', async () => {
    network.merchantHost = MERCHANT;
    for (const path of ['/merchant/', '/api/merchant/stats', '/api/sse/merchant/events']) {
      const res = await request(app()).get(path).set('Host', MERCHANT.toUpperCase());
      expect(res.status, path).toBe(200);
    }
    const root = await request(app()).get('/').set('Host', MERCHANT);
    expect(root.status).toBe(302);
    expect(root.headers.location).toBe('/merchant/');
  });

  it('counts the merchant host as servable, and sends Verify and a HANDOFF there', async () => {
    network.merchantHost = MERCHANT;
    expect(await servableHosts()).toContain(MERCHANT);
    expect(destinationFor('MERCHANT', 'tkt')).toBe(`https://${MERCHANT}/merchant/#/tg/tkt`);
    expect(destinationFor('PLAYER', 'tkt')).toBe(`https://${PLAYER}/#/tg/tkt`);
    expect(deliveryFor('HANDOFF', `https://${MERCHANT}`, 'MERCHANT')).toBe('HANDOFF');
    // The player site is no longer where a merchant opens again.
    expect(deliveryFor('HANDOFF', `https://${PLAYER}`, 'MERCHANT')).toBe('MATCH');
    expect(deliveryFor('HANDOFF', `https://${PLAYER}`, 'PLAYER')).toBe('HANDOFF');
    network.merchantHost = '';
    expect(await servableHosts()).not.toContain('');
  });
});
