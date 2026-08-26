// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * The player password surface was removed, and it has to STAY removed.
 *
 * Every property here is about absence, which is exactly what an ordinary test
 * cannot see: a happy-path suite for Telegram login passes just as well with a
 * `/register` route quietly sitting beside it. Deleting a door is only worth
 * anything if nothing re-opens it a year from now because "the panel needed a
 * fallback login".
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(here, p), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');

const routes = read('../../routes.js');
const server = read('../../server.js');
const login  = read('../../domains/telegram/telegramLogin.service.js');

describe('players cannot reach a password', () => {
  it('registers no /login or /register on the player router', () => {
    expect(routes).not.toMatch(/router\.post\(\s*'\/login'/);
    expect(routes).not.toMatch(/router\.post\(\s*'\/register'/);
    expect(routes).not.toMatch(/router\.post\(\s*'\/login\/2fa'/);
  });

  it('keeps the three routes every page load depends on', () => {
    // Removing the doors must not remove session restore and sign-out; those
    // are what the panels call on literally every load.
    expect(routes).toMatch(/router\.get\(\s*'\/me'/);
    expect(routes).toMatch(/router\.post\(\s*'\/logout'/);
    expect(routes).toMatch(/router\.get\(\s*'\/health'/);
  });

  it('creates no User anywhere in the auth router', () => {
    // The old /register was the only thing here that minted accounts. Accounts
    // are now created by the Telegram onboarding service, after a contact share
    // has proved the phone number.
    expect(routes).not.toMatch(/User\.create\(/);
  });
});

describe('the password door that remains is staff-only', () => {
  it('refuses any account without a staff role', () => {
    expect(routes).toMatch(/function isStaffAccount/);
    expect(routes).toMatch(/if \(!isStaffAccount\(user\)\)/);
  });

  it('applies that check on BOTH legs of the login', () => {
    // The 2FA leg re-loads the user and issues the session on its own. A staff
    // check on the password leg alone would be bypassed by anyone holding a
    // challenge token from before their role was removed.
    expect((routes.match(/!isStaffAccount\(user\)/g) || []).length).toBe(2);
  });

  it('checks the role AFTER the password, never before', () => {
    // Ordering is the whole privacy property: the 403 must only be reachable by
    // someone who already knows the password, or the endpoint becomes a way to
    // sort phone numbers into staff and non-staff.
    const handler = routes.slice(routes.indexOf('export async function loginHandler'),
                                 routes.indexOf('function isStaffAccount') > 0
                                   ? routes.indexOf('export async function issueSession')
                                   : routes.length);
    const pwAt   = handler.indexOf('verifyPassword');
    const roleAt = handler.indexOf('isStaffAccount(user)');
    expect(pwAt).toBeGreaterThan(-1);
    expect(roleAt).toBeGreaterThan(pwAt);
  });
});

describe('one session issuer, three callers', () => {
  it('mints sessions in exactly one place', () => {
    // Staff password, staff post-OTP, and Telegram exchange all route through
    // issueSession. A second minting site is how one door quietly starts
    // granting claims the others refuse.
    expect(routes).toMatch(/export async function issueSession/);
    expect((routes.match(/res\.cookie\('auth_token'/g) || []).length).toBe(1);
  });
});

describe('the login link is built to leak as little as possible', () => {
  it('carries the token in the fragment, not the query string', () => {
    // A query string reaches the server: it lands in access logs, in the proxy's
    // log, and in the Referer header of whatever the page loads next. A
    // fragment is never sent.
    expect(login).toMatch(/\/#\/auth\/telegram\?token=/);
    expect(login).not.toMatch(/\$\{root\}\/auth\/telegram\?token=/);
  });
});

describe('the old recovery system is gone, not merely unmounted', () => {
  it('is not imported by the server', () => {
    expect(server).not.toMatch(/account-recovery\.routes/);
    expect(server).not.toMatch(/recoveryRoutes/);
  });
});
