// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Players and merchants Continue with Telegram; only staff type a password.
 *
 * ── What this replaces ──────────────────────────────────────────────────────
 * `playerFormAuth.test.js` pinned the form (owner, 2026-09-23): `/register`,
 * `/login`, `/login/2fa`. The owner reversed that on 2026-10-14: one "Continue
 * with Telegram" button, signup and sign-in the same action, and the password
 * deleted for players and merchants. A test that pins a design decision is
 * rewritten by the change that reverses it, keeping what survived:
 *
 *   • one session issuer, still (`issueSession`), and no session cookie;
 *   • the door is asked on every leg, so an approval opened at one door cannot
 *     be redeemed at another;
 *   • a handler mounted without a door refuses rather than defaulting.
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

describe('a player continues with Telegram, and types nothing', () => {
  it('serves only the Telegram legs on the player router: no form, no password', () => {
    expect(player).toMatch(/router\.post\('\/login\/telegram'/);
    expect(player).toMatch(/router\.post\('\/login\/telegram\/complete'/);
    expect(player).toMatch(/router\.post\('\/login\/telegram\/ticket'/);
    expect(player).not.toMatch(/router\.post\('\/register'/);
    expect(player).not.toMatch(/router\.post\('\/login'[,)]/);
    expect(player).not.toMatch(/router\.post\('\/login\/2fa'/);
    expect(player).not.toMatch(/password/i);
  });

  it('keeps no password for anybody but staff, in the schema itself', () => {
    expect(schema).toMatch(/CONSTRAINT users_password_staff_only\s+CHECK \(account_type = 'STAFF' OR password_hash IS NULL\)/);
    expect(schema).toMatch(/DROP TABLE IF EXISTS password_resets/);
  });

  it('deleted the player and merchant password services outright', () => {
    expect(existsSync(path('../../domains/identity/passwordReset.service.js'))).toBe(false);
    expect(existsSync(path('../../domains/identity/accountTelegram.js'))).toBe(false);
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

  it('the Mini App mints no session at all: the website redeems, through the one issuer', () => {
    // The Mini App answers a sign-in; the browser that asked (or the site the
    // ticket opens) is signed in by routes.js, with `amr` naming Telegram.
    expect(telegram).not.toMatch(/signToken/);
    expect(telegram).not.toMatch(/issueSession|issueMerchantSession/);
    expect(routes).toMatch(/sessionFor\(door, user, res, \{ amr: \['tg'\]/);
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
  });

  it('sets no session cookie and reads the bearer header only (cross-site request forgery)', () => {
    expect(routes).not.toMatch(/res\.cookie\(/);
    expect(routes).not.toMatch(/req\.cookies/);
    expect(routes).toMatch(/return req\.headers\.authorization\?\.replace\('Bearer ', ''\) \|\| null;/);
  });

  it('states the guest list as a DOOR rather than a hardcoded predicate', () => {
    // Three doors, one table: which legs each has is `DOOR_LEGS`.
    expect(routes).toMatch(/export const LOGIN_DOOR/);
    expect(routes).toMatch(/STAFF:\s*\{/);
    expect(routes).toMatch(/PLAYER:\s*\{/);
  });

  it('asks the door on every leg that signs in', () => {
    // One `accountRefusal` asks it: the staff password leg, and the one place
    // every Telegram redemption (poll or ticket) passes through.
    expect((routes.match(/door\.admits\(user\)/g) || []).length).toBe(1);
    expect(routes).toMatch(/async function signInRedeemed\(door, userId, res\) \{\s*const user = await db\.users\.getUser\(userId\);\s*const refused = accountRefusal\(door, user\)/);
    expect((routes.match(/return signInRedeemed\(door, /g) || []).length).toBe(2);
  });

  it('refuses a Telegram leg mounted without a player or merchant door, never defaulting', () => {
    expect(routes).toMatch(/const door = req\.loginDoor;\s*if \(!door \|\| !TELEGRAM_AUDIENCES\.includes\(door\.accountType\)\)/);
    expect(routes).toMatch(/const door = LOGIN_DOOR\.STAFF;/);
  });

  it('checks the door AFTER the password, never before', () => {
    // Ordering is the whole privacy property: the 403 must only be reachable by
    // somebody who already knows the password, or the endpoint becomes a way to
    // sort phone numbers into staff and non-staff.
    const handler = routes.slice(routes.indexOf('export async function loginHandler'),
                                 routes.indexOf('async function staffCodeRequired'));
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
