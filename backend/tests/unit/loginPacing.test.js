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
 * ── Which accounts this protects ───────────────────────────────────────────
 * Every door (Step 3): a player, a staff member and a merchant all sign in with
 * a mobile and a password; staff and merchants then approve in Telegram.
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

  // Step 3: every door's legs come from ONE table (loginDoors.js), mounted by
  // each panel's router. So the chain is asserted on the table, and the mounts
  // on the source.
  it('every door mounts all four legs through doorRoute', () => {
    const mounts = {
      'server.js': ['/api/admin/login', 'STAFF'],
      'domains/merchant/merchant.routes.js': ['/auth/login', 'MERCHANT'],
      'domains/identity/playerAuth.routes.js': ['/login', 'PLAYER'],
    };
    for (const [file, [path, door]] of Object.entries(mounts)) {
      const src = read(file);
      for (const [suffix, leg] of [['', 'login'], ['/2fa', 'twoFactor'], ['/telegram', 'telegram'], ['/telegram/complete', 'telegramComplete']]) {
        expect(src, `${file} ${path}${suffix}`).toContain(`('${path}${suffix}', ...doorRoute('${door}', '${leg}'))`);
      }
    }
  });

  it('paces the password BEFORE the failure budget and the captcha, at every door', async () => {
    const { doorRoute } = await import('../../domains/identity/loginDoors.js');
    const sec = await import('../../middleware/security.js');
    const budgets = { PLAYER: sec.authLimiter, STAFF: sec.adminAuthLimiter, MERCHANT: sec.merchantAuthLimiter };
    for (const door of ['PLAYER', 'STAFF', 'MERCHANT']) {
      const chain = doorRoute(door, 'login');
      expect(chain[0], door).toBe(sec.loginPaceLimiter);
      expect(chain.indexOf(budgets[door]), door).toBeGreaterThan(0);
    }
  });

  it('asks for a captcha at the player door only (owner, 2026-10-08: staff and merchants "only need 2FA")', async () => {
    const { doorRoute } = await import('../../domains/identity/loginDoors.js');
    const hasCaptcha = (chain) => chain.some((fn) => fn.name === 'captchaGate');
    expect(hasCaptcha(doorRoute('PLAYER', 'login'))).toBe(true);
    expect(hasCaptcha(doorRoute('STAFF', 'login'))).toBe(false);
    expect(hasCaptcha(doorRoute('MERCHANT', 'login'))).toBe(false);
    for (const door of ['PLAYER', 'STAFF', 'MERCHANT']) {
      for (const leg of ['twoFactor', 'telegram', 'telegramComplete']) {
        expect(hasCaptcha(doorRoute(door, leg)), `${door} ${leg}`).toBe(false);
      }
    }
  });

  it('bounds the Telegram poll and the second-factor budget on both polling legs', async () => {
    const { doorRoute } = await import('../../domains/identity/loginDoors.js');
    const sec = await import('../../middleware/security.js');
    for (const door of ['PLAYER', 'STAFF', 'MERCHANT']) {
      for (const leg of ['twoFactor', 'telegramComplete']) {
        const chain = doorRoute(door, leg);
        expect(chain.indexOf(sec.challengePollLimiter), `${door} ${leg}`).toBe(0);
        expect(chain.indexOf(sec.twoFactorLimiter), `${door} ${leg}`).toBe(1);
      }
      expect(doorRoute(door, 'telegram')[0]).toBe(sec.telegramLoginLimiter);
    }
  });
});
