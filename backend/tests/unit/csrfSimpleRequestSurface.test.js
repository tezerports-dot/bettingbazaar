// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * CSRF: the app must not parse a "simple request" body.
 *
 * Auth cookies are issued with sameSite:'none' in production (routes.js) so the
 * Capacitor/Android shell receives them. That means the browser attaches
 * auth_token to CROSS-SITE requests, and authenticate() accepts the cookie as
 * identity. CORS does not save us: for a simple request the browser SENDS the
 * request and only withholds the response, so the mutation has already run.
 *
 * The simple content types are application/x-www-form-urlencoded,
 * multipart/form-data, and text/plain. While express.urlencoded was mounted
 * globally, a hidden auto-submitting <form> was a complete CSRF vector against
 * every authenticated POST. Only application/json forces a preflight the CORS
 * allow-list can reject.
 *
 * These tests assert the surface directly — grepping server.js would not prove
 * the parser is absent, and booting it needs Mongo, Redis and a dozen secrets.
 * They rebuild the exact parser stack server.js mounts and prove a simple-request
 * body arrives unparsed while JSON still works.
 */
import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';

/** The body-parser stack as server.js mounts it: express.json only. */
function appAsMounted() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.post('/api/money', (req, res) => res.json({ received: req.body ?? null }));
  return app;
}

describe('CSRF simple-request surface', () => {
  it('does not parse a urlencoded body — the classic cross-site <form> vector', async () => {
    const res = await request(appAsMounted())
      .post('/api/money')
      .type('form')
      .send({ amount: '999999', to: 'attacker' });

    // Unparsed: Express 5 leaves req.body undefined, so the handler has no
    // fields at all to act on — not merely empty ones.
    expect(res.body.received).toBeNull();
  });

  it('does not parse a text/plain body carrying JSON', async () => {
    const res = await request(appAsMounted())
      .post('/api/money')
      .set('Content-Type', 'text/plain')
      .send(JSON.stringify({ amount: 999999 }));

    expect(res.body.received).toBeNull();
  });

  it('does not parse a multipart body', async () => {
    const res = await request(appAsMounted())
      .post('/api/money')
      .field('amount', '999999');

    expect(res.body.received).toBeNull();
  });

  it('still parses application/json, which forces a CORS preflight', async () => {
    const res = await request(appAsMounted())
      .post('/api/money')
      .send({ amount: 100 });

    expect(res.body.received).toEqual({ amount: 100 });
  });

  it('demonstrates what mounting urlencoded would reopen', async () => {
    // Guard rail: this is the configuration the fix removed. If someone
    // reintroduces express.urlencoded globally, the first test flips to this
    // behaviour — an attacker-controlled cross-site form reaching req.body.
    const vulnerable = express();
    vulnerable.use(express.json());
    vulnerable.use(express.urlencoded({ extended: true }));
    vulnerable.post('/api/money', (req, res) => res.json({ received: req.body }));

    const res = await request(vulnerable)
      .post('/api/money')
      .type('form')
      .send({ amount: '999999' });

    expect(res.body.received).toEqual({ amount: '999999' });
  });
});
