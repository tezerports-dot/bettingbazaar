// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * Key rotation for identity ciphertext (Aadhaar numbers, bot tokens).
 *
 * Regulators and ISO 27001 A.5.34 expect keys to be rotatable with a documented
 * emergency procedure. Without a retirement list, "rotation" is a data-loss
 * event: the moment the env var changes every stored Aadhaar becomes
 * undecryptable and the platform cannot produce the export a regulator asked
 * for. These tests pin the property that makes rotation survivable — old
 * ciphertext still reads, new ciphertext uses the new key, and a value written
 * under a key nobody lists any more fails LOUDLY instead of silently.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'crypto';

const KEY_A = crypto.randomBytes(32).toString('base64');
const KEY_B = crypto.randomBytes(32).toString('base64');
const KEY_C = crypto.randomBytes(32).toString('base64');

let fieldCrypto;
beforeEach(async () => {
  process.env.IDENTITY_ENCRYPTION_KEY = KEY_A;
  delete process.env.IDENTITY_ENCRYPTION_PREVIOUS_KEYS;
  // Imported once; the module resolves its key PER CALL, which is what makes a
  // rotation take effect on redeploy without a code change.
  fieldCrypto = await import('../../domains/identity/fieldCrypto.util.js');
});
afterEach(() => {
  delete process.env.IDENTITY_ENCRYPTION_KEY;
  delete process.env.IDENTITY_ENCRYPTION_PREVIOUS_KEYS;
});

describe('field encryption', () => {
  it('round-trips a value', () => {
    const secret = '123456789012';
    expect(fieldCrypto.decryptField(fieldCrypto.encryptField(secret))).toBe(secret);
  });

  it('produces different ciphertext each time (random IV)', () => {
    // Equal ciphertexts would let anyone holding the database tell which players
    // share an Aadhaar without decrypting anything.
    const a = fieldCrypto.encryptField('123456789012');
    const b = fieldCrypto.encryptField('123456789012');
    expect(a).not.toBe(b);
    expect(fieldCrypto.decryptField(a)).toBe(fieldCrypto.decryptField(b));
  });

  it('refuses a key that is not exactly 32 bytes rather than deriving one', () => {
    process.env.IDENTITY_ENCRYPTION_KEY = 'too-short';
    expect(() => fieldCrypto.encryptField('x')).toThrow(/32 bytes/i);
  });

  it('detects tampering instead of returning plausible plaintext', () => {
    const stored = fieldCrypto.encryptField('123456789012');
    const [v, iv, tag, data] = stored.split(':');
    // Flip the last ciphertext byte.
    const raw = Buffer.from(data, 'base64');
    raw[raw.length - 1] ^= 0xff;
    const tampered = [v, iv, tag, raw.toString('base64')].join(':');
    expect(() => fieldCrypto.decryptField(tampered)).toThrow();
  });
});

describe('key rotation', () => {
  it('reads ciphertext written under a retired key', () => {
    const stored = fieldCrypto.encryptField('123456789012');   // under A

    // The rotation: A retires, B becomes current.
    process.env.IDENTITY_ENCRYPTION_KEY = KEY_B;
    process.env.IDENTITY_ENCRYPTION_PREVIOUS_KEYS = KEY_A;

    expect(fieldCrypto.decryptField(stored)).toBe('123456789012');
  });

  it('encrypts NEW values under the current key only', () => {
    process.env.IDENTITY_ENCRYPTION_KEY = KEY_B;
    process.env.IDENTITY_ENCRYPTION_PREVIOUS_KEYS = KEY_A;
    const fresh = fieldCrypto.encryptField('999988887777');

    // Drop the retired key entirely: a value written after the rotation must
    // not depend on it. A compromised key has to stop protecting new records
    // the instant it is retired.
    delete process.env.IDENTITY_ENCRYPTION_PREVIOUS_KEYS;
    expect(fieldCrypto.decryptField(fresh)).toBe('999988887777');
  });

  it('supports several retired keys at once', () => {
    const underA = fieldCrypto.encryptField('111122223333');
    process.env.IDENTITY_ENCRYPTION_KEY = KEY_B;
    const underB = fieldCrypto.encryptField('444455556666');

    process.env.IDENTITY_ENCRYPTION_KEY = KEY_C;
    process.env.IDENTITY_ENCRYPTION_PREVIOUS_KEYS = `${KEY_B}, ${KEY_A}`;

    expect(fieldCrypto.decryptField(underA)).toBe('111122223333');
    expect(fieldCrypto.decryptField(underB)).toBe('444455556666');
  });

  it('fails loudly when no configured key can read a value', () => {
    const orphaned = fieldCrypto.encryptField('123456789012');   // under A
    process.env.IDENTITY_ENCRYPTION_KEY = KEY_C;                 // A not retained
    expect(() => fieldCrypto.decryptField(orphaned)).toThrow(/could not be decrypted/i);
  });

  it('rewrapField migrates a value onto the current key', () => {
    const underA = fieldCrypto.encryptField('123456789012');
    process.env.IDENTITY_ENCRYPTION_KEY = KEY_B;
    process.env.IDENTITY_ENCRYPTION_PREVIOUS_KEYS = KEY_A;

    const rewrapped = fieldCrypto.rewrapField(underA);
    expect(rewrapped).not.toBe(underA);

    // The migrated value no longer needs the retired key.
    delete process.env.IDENTITY_ENCRYPTION_PREVIOUS_KEYS;
    expect(fieldCrypto.decryptField(rewrapped)).toBe('123456789012');
  });
});
