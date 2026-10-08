// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The form is the door, and the bot cannot mint a session.
 *
 * ── What this replaces, and why it had to be replaced rather than fixed ─────
 * `telegramOnlyAuth.test.js` asserted the OPPOSITE of every property below: no
 * player password, no `/login`, no `/register`, and a one-time link built to
 * leak as little as possible. All of that was correct until 2026-09-23 and is
 * now exactly wrong. A test that pins a design decision has to be rewritten by
 * the change that reverses the decision, or it fails as a false alarm and gets
 * deleted by somebody in a hurry — which loses the properties that DID survive.
 *
 * Three survived, and they are the ones that matter most here:
 *
 *   • one session issuer, still (`issueSession`, one `res.cookie` in the file);
 *   • the role check still runs AFTER the password, so the 403 cannot be used
 *     to sort phone numbers into staff and non-staff;
 *   • it still runs on BOTH legs of the login, so a challenge minted at one
 *     door cannot be redeemed at the other.
 *
 * Everything else here is about ABSENCE, which is what an ordinary test cannot
 * see: a happy-path suite for the form login passes just as well with a bot
 * that still hands out one-time links sitting beside it.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const here = dirname(fileURLToPath(import.meta.url));
const path = (p) => join(here, p);
// ONE stripper, in `sourceText.js`. This file is where the bug surfaced: an
// unanchored block-comment pattern paired the opener in a line comment with
// `server.js`'s one real closer and reported
// `app.use('/api/v1/auth', playerAuthRoutes)` MISSING, a mount plainly on line
// 532. Every suite that reads source now shares the fixed one.
import { stripComments } from './sourceText.js';

const read = (p) => stripComments(readFileSync(path(p), 'utf8'));

const routes   = read('../../routes.js');
const server   = read('../../server.js');
const player   = read('../../domains/identity/playerAuth.routes.js');
const telegram = read('../../domains/telegram/miniApp.routes.js');
const schema   = read('../../../database/schema.sql');

describe('a player signs up and signs in with a form', () => {
  it('serves /register, /login and /login/2fa on the player router', () => {
    expect(player).toMatch(/router\.post\('\/register'/);
    expect(player).toMatch(/router\.post\('\/login'/);
    expect(player).toMatch(/router\.post\('\/login\/2fa'/);
  });

  it('mounts that router under /api/v1/auth', () => {
    expect(server).toMatch(/app\.use\('\/api\/v1\/auth',\s*playerAuthRoutes\)/);
  });

  it('keeps the two session routes every page load depends on', () => {
    expect(routes).toMatch(/router\.get\(\s*'\/me'/);
    expect(routes).toMatch(/router\.post\(\s*'\/logout'/);
    // `/health` was the third. No panel called it and the server's own health
    // check is `/api/v1/health`; deleted 2026-10-01 (route coverage).
    expect(routes).not.toMatch(/router\.get\(\s*'\/health'/);
  });
});

describe('the Telegram surface grants access only through the one issuer', () => {
  /**
   * Step 3 (owner, 2026-10-07): "add also login with telegram button too". A
   * Telegram sign-in is now deliberate, and so it goes through the SAME
   * `issueSession` every door uses, with `amr` naming Telegram — never a
   * second minting path, and never on a bot's word alone: the proof is the
   * Mini App's signed initData (miniAppAuth.js), checked on the server.
   */
  it('deleted the login-link and login-code services outright', () => {
    expect(existsSync(path('../../domains/telegram/telegramLogin.service.js'))).toBe(false);
    expect(existsSync(path('../../domains/telegram/telegramOtp.service.js'))).toBe(false);
    expect(existsSync(path('../../domains/telegram/telegram.routes.js'))).toBe(false);
  });

  it('dropped the tables that held those credentials', () => {
    expect(schema).not.toMatch(/CREATE TABLE IF NOT EXISTS telegram_login_tokens/);
    expect(schema).not.toMatch(/CREATE TABLE IF NOT EXISTS telegram_login_codes/);
  });

  it('the Mini App mints no token of its own: it calls the one issuer, naming Telegram', () => {
    expect(telegram).not.toMatch(/signToken/);
    expect(telegram).toMatch(/import \{ issueSession \} from '\.\.\/\.\.\/routes\.js'/);
    for (const call of telegram.match(/issueSession\([^)]*\)/g) || []) expect(call).toMatch(/'tg'/);
    expect(telegram).not.toMatch(/router\.post\('\/exchange'/);
    expect(telegram).not.toMatch(/router\.post\('\/otp\//);
  });

  it('takes no Aadhaar number anywhere in the Telegram surface', () => {
    expect(telegram).not.toMatch(/aadhaar/i);
  });
});

describe('one session issuer, and a door that says who it admits', () => {
  it('mints sessions in exactly one place', () => {
    expect(routes).toMatch(/export async function issueSession/);
    expect((routes.match(/res\.cookie\('auth_token'/g) || []).length).toBe(1);
  });

  it('states the guest list as a DOOR rather than a hardcoded predicate', () => {
    // Two doors now — staff and player — and they differ in exactly one thing.
    // Writing the second as a second handler would copy the password read, the
    // blocked-account refusal, the argon2 upgrade and the 2FA decision, and §5
    // says what happens next.
    expect(routes).toMatch(/export const LOGIN_DOOR/);
    expect(routes).toMatch(/STAFF:\s*\{/);
    expect(routes).toMatch(/PLAYER:\s*\{/);
  });

  it('applies the door on BOTH legs of the login', () => {
    // A challenge proves a password was right five minutes ago. If only the
    // password leg checked the door, a player's valid challenge posted to the
    // staff endpoint would be redeemed by the staff handler.
    // Step 3: one `accountRefusal` asks it, and every leg calls that.
    expect((routes.match(/door\.admits\(user\)/g) || []).length).toBe(1);
    expect((routes.match(/accountRefusal\(door, user/g) || []).length).toBeGreaterThanOrEqual(4);
  });

  it('defaults an unmounted call to the STAFF door, never to "anyone"', () => {
    expect(routes).toMatch(/req\.loginDoor \|\| LOGIN_DOOR\.STAFF/);
  });

  it('checks the door AFTER the password, never before', () => {
    // Ordering is the whole privacy property: the 403 must only be reachable by
    // somebody who already knows the password, or the endpoint becomes a way to
    // sort phone numbers into staff and non-staff.
    const handler = routes.slice(routes.indexOf('export async function loginHandler'),
                                 routes.indexOf('export async function loginTwoFactorHandler'));
    const pwAt   = handler.indexOf('verifyPassword');
    const doorAt = handler.indexOf('accountRefusal(door, user');
    expect(pwAt).toBeGreaterThan(-1);
    expect(doorAt).toBeGreaterThan(pwAt);
  });
});

describe('the old recovery system is gone, not merely unmounted', () => {
  it('is not imported by the server', () => {
    expect(server).not.toMatch(/account-recovery\.routes/);
    expect(server).not.toMatch(/recoveryRoutes/);
  });
});
