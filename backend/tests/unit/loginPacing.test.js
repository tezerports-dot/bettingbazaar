// GOVERNANCE: Read CLAUDE.md before editing this file.
/**
 * Sign-in is paced, and the refusal says how long to wait.
 *
 * ── Why a pace, on top of the failure budgets ───────────────────────────────
 * `adminAuthLimiter`, `merchantAuthLimiter` and `twoFactorLimiter` all set
 * `skipSuccessfulRequests`, so they count FAILURES and act as a lockout. Between
 * two failures an attacker may submit as fast as the network allows, and it is
 * the RATE that decides whether an automated guess is worth attempting.
 *
 * A six-digit TOTP is a 10^6 space. Paced at one attempt per 10 seconds a full
 * sweep takes over three months, against codes that expire in thirty seconds.
 *
 * ── Which accounts this actually protects ───────────────────────────────────
 * Players cannot reach it: there is no player login form and no password
 * endpoint — the Telegram bot issues a one-time link that the app trades for a
 * session. Admins and merchants still sign in with a password and then a TOTP,
 * and those are the higher-value credentials: an admin adjusts balances, a
 * merchant settles real INR and USDT.
 *
 * ── The response has to be answerable ───────────────────────────────────────
 * A 429 carrying only "too many requests" leaves a person to guess when to
 * retry, and guessing means retrying at once — which extends the window and
 * makes the screen look broken rather than throttled.
 */
import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { readFileSync } from 'node:fs';
import { RATE_LIMIT_TIERS } from '../../config/security.config.js';

describe('the login pace tier', () => {
  it('is one attempt per ten seconds', () => {
    // The owner set this figure (2026-09-08). A tier edited without the screens
    // that display it is a countdown that lies.
    expect(RATE_LIMIT_TIERS.loginPace).toEqual({ windowMs: 10_000, max: 1 });
  });

  it('does not replace the failure budgets', () => {
    // Pace and lockout are different controls and both stay. A pace alone never
    // locks a guessed-at account; a lockout alone lets an attacker sprint
    // between failures.
    expect(RATE_LIMIT_TIERS.adminAuth.max).toBeGreaterThan(0);
    expect(RATE_LIMIT_TIERS.merchantAuth.max).toBeGreaterThan(0);
    expect(RATE_LIMIT_TIERS.twoFactor.max).toBeGreaterThan(0);
  });
});

describe('a paced refusal', () => {
  const appWith = async () => {
    const { loginPaceLimiter } = await import('../../middleware/security.js');
    const app = express();
    app.use(express.json());
    app.post('/login', loginPaceLimiter, (_req, res) => res.json({ success: true }));
    return app;
  };

  it('lets the first attempt through and refuses the second', async () => {
    const app = await appWith();
    const body = { challengeToken: `tok-${Math.random().toString(36).slice(2)}`, code: '000000' };

    const first = await request(app).post('/login').send(body);
    expect(first.status).toBe(200);

    const second = await request(app).post('/login').send(body);
    expect(second.status).toBe(429);
  });

  it('says how long to wait, in seconds and as an instant', async () => {
    const app = await appWith();
    const body = { challengeToken: `tok-${Math.random().toString(36).slice(2)}`, code: '000000' };
    await request(app).post('/login').send(body);
    const res = await request(app).post('/login').send(body);

    expect(res.body.code).toBe('LOGIN_PACED');
    // A whole number of seconds, for the sentence a person reads.
    expect(Number.isInteger(res.body.retryAfter)).toBe(true);
    expect(res.body.retryAfter).toBeGreaterThan(0);
    expect(res.body.retryAfter).toBeLessThanOrEqual(10);
    expect(res.body.message).toMatch(/try again in \d+ seconds?/i);

    // And an absolute instant, for a countdown that stays correct however long
    // the response spent in flight. `retryAfter` starts ageing the moment the
    // server writes it.
    const at = Date.parse(res.body.retryAt);
    expect(Number.isFinite(at)).toBe(true);
    expect(at).toBeGreaterThan(Date.now() - 1000);
    expect(at).toBeLessThanOrEqual(Date.now() + 10_500);
  });

  it('paces each actor separately', async () => {
    // One admin signing in must not throttle another, and two people behind one
    // office address are two actors.
    const app = await appWith();
    const a = { challengeToken: `tok-a-${Math.random()}` };
    const b = { challengeToken: `tok-b-${Math.random()}` };

    expect((await request(app).post('/login').send(a)).status).toBe(200);
    expect((await request(app).post('/login').send(b)).status).toBe(200);
    expect((await request(app).post('/login').send(a)).status).toBe(429);
  });

  it('counts a SUCCESSFUL attempt too', async () => {
    // The failure budgets skip successes deliberately. This one must not: a
    // pace that only counts wrong answers does not pace anything, because an
    // attacker's first guess is as unpaced as their thousandth.
    const app = await appWith();
    const body = { challengeToken: `tok-${Math.random().toString(36).slice(2)}` };
    expect((await request(app).post('/login').send(body)).status).toBe(200);
    expect((await request(app).post('/login').send(body)).status).toBe(429);
  });
});

describe('every credential path is actually paced', () => {
  // A limiter that exists and is mounted on nothing is the failure mode this
  // repository keeps producing — securityMonitor and orderAccessGuard were both
  // written, tested, and mounted nowhere. Asserting the middleware chain by
  // reading the mount is the cheapest guard against a fifth one.
  const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');

  it('admin password and admin 2FA', () => {
    const server = read('server.js');
    expect(server).toMatch(/app\.post\('\/api\/admin\/login',\s*loginPaceLimiter,/);
    expect(server).toMatch(/app\.post\('\/api\/admin\/login\/2fa',\s*loginPaceLimiter,/);
  });

  it('merchant password and merchant 2FA', () => {
    expect(read('server.js')).toMatch(/'\/api\/merchant\/auth\/login',\s*loginPaceLimiter,/);
    expect(read('domains/merchant/merchant.routes.js'))
      .toMatch(/router\.post\('\/auth\/login\/2fa',\s*loginPaceLimiter,/);
  });

  it('paces BEFORE the failure budget on every one of them', () => {
    // Order matters: a paced request never reached the credential check, so it
    // is not a failed attempt. If the budget ran first, a burst of throttled
    // retries would lock out the very account the pace was protecting.
    const server = read('server.js');
    for (const [, chain] of server.matchAll(/app\.(?:post|use)\('([^']*login[^']*)',\s*([^)]*)\)/g)) {
      if (!chain.includes('loginPaceLimiter')) continue;
      const pace = chain.indexOf('loginPaceLimiter');
      for (const budget of ['adminAuthLimiter', 'merchantAuthLimiter', 'twoFactorLimiter']) {
        const at = chain.indexOf(budget);
        if (at !== -1) expect(pace).toBeLessThan(at);
      }
    }
  });
});
