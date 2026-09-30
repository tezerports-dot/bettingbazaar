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
const telegram = read('../../domains/telegram/telegram.routes.js');
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

  it('keeps the three session routes every page load depends on', () => {
    expect(routes).toMatch(/router\.get\(\s*'\/me'/);
    expect(routes).toMatch(/router\.post\(\s*'\/logout'/);
    expect(routes).toMatch(/router\.get\(\s*'\/health'/);
  });
});

describe('NOTHING in the Telegram surface can grant access', () => {
  /**
   * The security half of the change. A sign-in bot is now one of hundreds of
   * tokens sitting in a database; any one of them being compromised must not be
   * an account takeover, and a token that can mint a session is exactly that.
   */
  it('deleted the login-link and login-code services outright', () => {
    expect(existsSync(path('../../domains/telegram/telegramLogin.service.js'))).toBe(false);
    expect(existsSync(path('../../domains/telegram/telegramOtp.service.js'))).toBe(false);
  });

  it('dropped the tables that held those credentials', () => {
    expect(schema).not.toMatch(/CREATE TABLE IF NOT EXISTS telegram_login_tokens/);
    expect(schema).not.toMatch(/CREATE TABLE IF NOT EXISTS telegram_login_codes/);
  });

  it('issues no session from any Telegram route', () => {
    // `issueSession` was imported by the exchange and the OTP verify. Neither
    // exists; the import must not survive either, because an import is how the
    // next "just one small login shortcut" gets written.
    expect(telegram).not.toMatch(/issueSession/);
    expect(telegram).not.toMatch(/router\.post\('\/exchange'/);
    expect(telegram).not.toMatch(/router\.post\('\/otp\//);
  });

  it('takes no Aadhaar number over the sign-in conversation', () => {
    // The account exists before the bot is opened, so the bot has nothing to
    // collect.
    //
    // Scoped to the sign-in HANDLERS, not to the file. The recovery bot does
    // still take an Aadhaar — it is the one path that proves an identity in
    // order to move a link to a new Telegram account — so its helper and the
    // hashing import it needs both live in this file, above the handlers that
    // use them. A file-wide match reported those and called it a failure, which
    // is a gate measuring the wrong thing (§28).
    const from = telegram.indexOf('async function handleUpdate');
    const to   = telegram.indexOf('const RECOVERY_SESSION_SECONDS');
    expect(from).toBeGreaterThan(-1);
    expect(to).toBeGreaterThan(from);
    expect(telegram.slice(from, to)).not.toMatch(/aadhaar/i);
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
    expect((routes.match(/door\.admits\(user\)/g) || []).length).toBe(2);
  });

  it('defaults an unmounted call to the STAFF door, never to "anyone"', () => {
    expect(routes).toMatch(/req\.loginDoor \|\| LOGIN_DOOR\.STAFF/);
  });

  it('checks the door AFTER the password, never before', () => {
    // Ordering is the whole privacy property: the 403 must only be reachable by
    // somebody who already knows the password, or the endpoint becomes a way to
    // sort phone numbers into staff and non-staff.
    const handler = routes.slice(routes.indexOf('export async function loginHandler'),
                                 routes.indexOf('export async function issueSession'));
    const pwAt   = handler.indexOf('verifyPassword');
    const doorAt = handler.indexOf('door.admits(user)');
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
