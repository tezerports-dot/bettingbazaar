// GOVERNANCE: Read CLAUDE.md before editing this file.
/**
 * Sign-in is paced, and the refusal says how long to wait.
 *
 * ── Why a pace, on top of the failure budgets ───────────────────────────────
 * `adminAuthLimiter` and `twoFactorLimiter` both set
 * `skipSuccessfulRequests`, so they count FAILURES and act as a lockout. Between
 * two failures an attacker may submit as fast as the network allows, and it is
 * the RATE that decides whether an automated guess is worth attempting.
 *
 * ── Which accounts this protects ───────────────────────────────────────────
 * The one door with a password: staff sign in with a mobile and a password,
 * then type an authenticator code (owner, 2026-10-13). Players and merchants
 * type nothing: they Continue with Telegram (owner, 2026-10-14), and those
 * legs carry their own limits, asserted below.
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
    // Players and merchants have no password, so no password budget of their
    // own (owner, 2026-10-14).
    expect(RATE_LIMIT_TIERS.merchantAuth).toBeUndefined();
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
  const TELEGRAM_LEGS = [['/telegram', 'telegram'], ['/telegram/complete', 'telegramComplete'], ['/telegram/ticket', 'telegramTicket']];
  const STAFF_LEGS = [['', 'login'], ['/totp', 'totp'], ['/totp/setup', 'totpSetup'], ['/totp/activate', 'totpActivate']];

  it('every door mounts its legs through doorRoute', () => {
    const mounts = {
      'server.js': ['/api/admin/login', 'STAFF', STAFF_LEGS],
      'domains/merchant/merchant.routes.js': ['/auth/login', 'MERCHANT', TELEGRAM_LEGS],
      'domains/identity/playerAuth.routes.js': ['/login', 'PLAYER', TELEGRAM_LEGS],
    };
    for (const [file, [path, door, legs]] of Object.entries(mounts)) {
      const src = read(file);
      for (const [suffix, leg] of legs) {
        expect(src, `${file} ${path}${suffix}`).toContain(`('${path}${suffix}', ...doorRoute('${door}', '${leg}'))`);
      }
    }
  });

  it('the staff door has no Telegram leg, and no other door a password or an authenticator leg', async () => {
    // Staff: password + authenticator, no Telegram (owner, 2026-10-13).
    // Players and merchants: Continue with Telegram only (owner, 2026-10-14).
    const { doorRoute } = await import('../../domains/identity/loginDoors.js');
    for (const leg of ['telegram', 'telegramComplete', 'telegramTicket']) {
      expect(() => doorRoute('STAFF', leg), leg).toThrow(/no .* leg/);
    }
    for (const door of ['PLAYER', 'MERCHANT']) {
      for (const leg of ['login', 'totp', 'totpSetup', 'totpActivate']) {
        expect(() => doorRoute(door, leg), `${door} ${leg}`).toThrow(/no .* leg/);
      }
    }
    // The password's Telegram second factor is gone with the password.
    for (const door of ['PLAYER', 'STAFF', 'MERCHANT']) {
      expect(() => doorRoute(door, 'twoFactor'), door).toThrow(/unknown leg/);
    }
    const src = read('server.js');
    expect(src).not.toContain("'/api/admin/login/2fa'");
    expect(src).not.toContain("'/api/admin/login/telegram'");
  });

  it('paces the staff password BEFORE its failure budget', async () => {
    const { doorRoute } = await import('../../domains/identity/loginDoors.js');
    const sec = await import('../../middleware/security.js');
    const chain = doorRoute('STAFF', 'login');
    expect(chain[0]).toBe(sec.loginPaceLimiter);
    expect(chain.indexOf(sec.adminAuthLimiter)).toBeGreaterThan(0);
  });

  it('asks for a captcha at the player door only, where a sign-in opens (owner, 2026-10-08: staff and merchants "only need 2FA")', async () => {
    const { doorRoute } = await import('../../domains/identity/loginDoors.js');
    const hasCaptcha = (chain) => chain.some((fn) => fn.name === 'captchaGate');
    expect(hasCaptcha(doorRoute('PLAYER', 'telegram'))).toBe(true);
    expect(hasCaptcha(doorRoute('MERCHANT', 'telegram'))).toBe(false);
    expect(hasCaptcha(doorRoute('STAFF', 'login'))).toBe(false);
    for (const door of ['PLAYER', 'MERCHANT']) {
      for (const leg of ['telegramComplete', 'telegramTicket']) {
        expect(hasCaptcha(doorRoute(door, leg)), `${door} ${leg}`).toBe(false);
      }
    }
    for (const leg of ['totp', 'totpSetup', 'totpActivate']) {
      expect(hasCaptcha(doorRoute('STAFF', leg)), `STAFF ${leg}`).toBe(false);
    }
  });

  it('bounds the Telegram poll and the second-factor budget, and the ticket per address', async () => {
    const { doorRoute } = await import('../../domains/identity/loginDoors.js');
    const sec = await import('../../middleware/security.js');
    for (const door of ['PLAYER', 'MERCHANT']) {
      const chain = doorRoute(door, 'telegramComplete');
      expect(chain.indexOf(sec.challengePollLimiter), door).toBe(0);
      expect(chain.indexOf(sec.twoFactorLimiter), door).toBe(1);
      expect(doorRoute(door, 'telegram')[0]).toBe(sec.telegramLoginLimiter);
      expect(doorRoute(door, 'telegramTicket')[0]).toBe(sec.telegramLoginLimiter);
    }
  });

  it('puts every staff code leg on the second-factor budget, keyed on the account', async () => {
    const { doorRoute } = await import('../../domains/identity/loginDoors.js');
    const sec = await import('../../middleware/security.js');
    expect(doorRoute('STAFF', 'totp')[0]).toBe(sec.twoFactorLimiter);
    expect(doorRoute('STAFF', 'totpActivate')[0]).toBe(sec.twoFactorLimiter);
    const setup = doorRoute('STAFF', 'totpSetup');
    expect(setup[0]).toBe(sec.challengePollLimiter);
    expect(setup[1]).toBe(sec.twoFactorLimiter);
  });
});
