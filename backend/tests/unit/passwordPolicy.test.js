// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * What a staff password may be.
 *
 * There was no rule at all: `POST /api/admin/sub-admins`, merchant signup and
 * admin-creates-merchant each took whatever `password` the body held and hashed
 * it. One character was accepted.
 *
 * That matters because of what it connects to, not on its own — nothing makes a
 * staff account enrol a second factor, a session lasts 24 hours, and a
 * sub-admin reaches 51 admin routes without a permission key being checked. The
 * password IS the credential guarding the player base.
 */
import { describe, it, expect } from 'vitest';
import { assertStaffPassword, STAFF_PASSWORD_MIN_LENGTH } from '../../domains/identity/passwordPolicy.js';

/**
 * Returns the policy's refusal, or null when the password was accepted.
 *
 * It re-throws anything that is NOT a policy refusal, and that matters: an
 * earlier version returned every caught error, so when a refactor left a
 * `ReferenceError: lowered is not defined` in the context check, every test
 * asserting `toBeTruthy()` still passed — a crash read exactly like a correct
 * refusal, and the whole file went green while the function was broken. The pg
 * route suite is what caught it. A helper that cannot tell a crash from a
 * refusal is worse than no helper.
 */
const refuses = (pw, ctx = {}) => {
  try { assertStaffPassword(pw, ctx, 'sub-admin'); return null; }
  catch (e) {
    if (e?.code !== 'WEAK_PASSWORD') throw e;
    return e;
  }
};

describe('assertStaffPassword', () => {
  it('accepts a long passphrase with no symbols in it', () => {
    // No composition requirement, deliberately. NIST 800-63B advises against
    // them: they produce `Password1!`, which is predictable to a cracker and
    // irritating to a human, while length is what actually costs an attacker.
    const pw = 'correct horse battery staple';
    expect(assertStaffPassword(pw, {}, 'sub-admin')).toBe(pw);
  });

  it('refuses anything under the floor, and accepts exactly at it', () => {
    // Built to be one SHORT of the floor and not a repeated or sequential run,
    // so it is the length rule being tested and nothing else.
    const filler = 'xq7vn2pk4rmz9tbw';
    const under = filler.slice(0, STAFF_PASSWORD_MIN_LENGTH - 1);
    const at = filler.slice(0, STAFF_PASSWORD_MIN_LENGTH);
    expect(under).toHaveLength(STAFF_PASSWORD_MIN_LENGTH - 1);

    const e = refuses(under);
    expect(e, `${under} was accepted below the floor`).toBeTruthy();
    expect(e.message).toMatch(new RegExp(String(STAFF_PASSWORD_MIN_LENGTH)));

    // The boundary itself passes — an off-by-one here would refuse a password
    // the message says is acceptable.
    expect(refuses(at), `${at} was refused at the floor`).toBeNull();
  });

  it('carries a 400 and a code so a route answers without inventing one', () => {
    const e = refuses('short');
    expect(e.status).toBe(400);
    expect(e.code).toBe('WEAK_PASSWORD');
  });

  it('refuses a run of one repeated character, however long', () => {
    expect(refuses('a'.repeat(40))).toBeTruthy();
  });

  it('refuses a straight sequential run in either direction', () => {
    expect(refuses('abcdefghijklmnop')).toBeTruthy();
    expect(refuses('ponmlkjihgfedcba')).toBeTruthy();
  });

  it('refuses length made only of whitespace', () => {
    expect(refuses(' '.repeat(20)).message).toMatch(/only spaces/);
  });

  it('refuses an obvious word wearing digits, including this platform\'s own name', () => {
    for (const pw of ['password1234', 'qwertyqwerty12', 'bettingbazaar1', 'Admin-Admin-1']) {
      expect(refuses(pw), `${pw} was accepted`).toBeTruthy();
    }
  });

  it('does NOT punish a real passphrase for containing an obvious word', () => {
    // The rule this replaced matched as a SUBSTRING and refused
    // `a-long-enough-password-123` — a 26-character passphrase — because
    // "password" appears inside it. That is the composition-rule mistake this
    // policy exists to avoid, arriving through the back door: it punishes a
    // long memorable phrase while a short cryptic one sails through.
    for (const pw of ['a-long-enough-password-123', 'my secret admin notebook', 'the qwerty keyboard is old']) {
      expect(refuses(pw), `${pw} was refused`).toBeNull();
    }
  });

  it('refuses a password that contains the account\'s own mobile or username', () => {
    // Public knowledge about the account, so it is not a secret.
    expect(refuses('9876543210xyzab', { mobile: '9876543210' })).toBeTruthy();
    expect(refuses('rakeshrakeshrak', { username: 'rakesh' })).toBeTruthy();
  });

  it('does not treat a short context value as a substring to ban', () => {
    // A two-character username must not make every password containing those
    // two letters unusable.
    expect(refuses('a quiet blue mountain', { username: 'ab' })).toBeNull();
  });

  it('refuses null and undefined rather than hashing them', () => {
    expect(refuses(undefined)).toBeTruthy();
    expect(refuses(null)).toBeTruthy();
  });
});
