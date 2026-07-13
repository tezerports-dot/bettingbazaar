// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
// Unit tests for the AQ-8 password authority. The load-bearing property: a
// legacy bcrypt hash must still verify (nobody is locked out) AND report
// needsRehash so the login handler can upgrade it to argon2id.
import { describe, it, expect } from 'vitest';
import bcrypt from 'bcryptjs';
import { hashPassword, verifyPassword, isArgon2 } from '../../domains/identity/password.util.js';

describe('hashPassword', () => {
  it('produces an argon2id hash', async () => {
    const h = await hashPassword('correct horse');
    expect(h.startsWith('$argon2id$')).toBe(true);
    expect(isArgon2(h)).toBe(true);
  });
});

describe('verifyPassword — argon2id', () => {
  it('accepts the right password, needsRehash false', async () => {
    const h = await hashPassword('s3cret!');
    expect(await verifyPassword(h, 's3cret!')).toEqual({ valid: true, needsRehash: false });
  });
  it('rejects the wrong password', async () => {
    const h = await hashPassword('s3cret!');
    expect((await verifyPassword(h, 'nope')).valid).toBe(false);
  });
});

describe('verifyPassword — legacy bcrypt (no lockout + upgrade signal)', () => {
  it('accepts a valid bcrypt hash and flags needsRehash', async () => {
    const legacy = await bcrypt.hash('oldpass', 12);
    const r = await verifyPassword(legacy, 'oldpass');
    expect(r.valid).toBe(true);
    expect(r.needsRehash).toBe(true); // → login handler upgrades to argon2id
  });
  it('rejects a wrong password against a bcrypt hash', async () => {
    const legacy = await bcrypt.hash('oldpass', 12);
    expect((await verifyPassword(legacy, 'WRONG')).valid).toBe(false);
  });
});

describe('verifyPassword — defensive', () => {
  it('returns invalid for empty/undefined/garbage hashes without throwing', async () => {
    expect(await verifyPassword('', 'x')).toEqual({ valid: false, needsRehash: false });
    expect(await verifyPassword(undefined, 'x')).toEqual({ valid: false, needsRehash: false });
    expect((await verifyPassword('not-a-hash', 'x')).valid).toBe(false);
  });
});
