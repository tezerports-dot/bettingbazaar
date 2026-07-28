// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * TOTP — proven against the specifications' own test vectors.
 *
 * This code guards every privileged login, so "it seemed to work when I scanned
 * it once" is not evidence. RFC 4226 (HOTP) and RFC 6238 (TOTP) both publish
 * expected outputs for a known secret, and those are asserted here directly. If
 * these pass, the implementation agrees with what Google Authenticator computes,
 * by construction rather than by hope.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'crypto';
import {
  base32Encode, base32Decode, hotp, counterFor, generateToken, verifyToken,
  generateSecret, buildOtpauthUri, encryptSecret, decryptSecret,
  generateBackupCodes, hashBackupCode, consumeBackupCode,
  TOTP_STEP_SECONDS,
} from '../../domains/identity/totp.service.js';

// RFC 4226 Appendix D / RFC 6238 Appendix B both use the ASCII secret
// "12345678901234567890".
const RFC_SECRET_ASCII = '12345678901234567890';
const RFC_SECRET_B32 = base32Encode(Buffer.from(RFC_SECRET_ASCII, 'ascii'));

describe('TOTP service', () => {
  describe('base32 (RFC 4648)', () => {
    // Test vectors from RFC 4648 §10, minus the padding authenticators omit.
    it.each([
      ['', ''],
      ['f', 'MY'],
      ['fo', 'MZXQ'],
      ['foo', 'MZXW6'],
      ['foob', 'MZXW6YQ'],
      ['fooba', 'MZXW6YTB'],
      ['foobar', 'MZXW6YTBOI'],
    ])('encodes %o as %o', (input, expected) => {
      expect(base32Encode(Buffer.from(input, 'ascii'))).toBe(expected);
    });

    it('round-trips arbitrary bytes', () => {
      const bytes = crypto.randomBytes(20);
      expect(base32Decode(base32Encode(bytes))).toEqual(bytes);
    });

    it('accepts the lowercase, spaced form people paste from an email', () => {
      expect(base32Decode('mzxw 6ytb oi')).toEqual(Buffer.from('foobar', 'ascii'));
    });

    it('rejects characters outside the alphabet rather than guessing', () => {
      expect(() => base32Decode('MZXW6YTB1!')).toThrow(/Invalid base32/);
    });
  });

  describe('HOTP — RFC 4226 Appendix D', () => {
    // The RFC's published table for counters 0..9.
    it.each([
      [0, '755224'], [1, '287082'], [2, '359152'], [3, '969429'], [4, '338314'],
      [5, '254676'], [6, '287922'], [7, '162583'], [8, '399871'], [9, '520489'],
    ])('counter %i yields %s', (counter, expected) => {
      expect(hotp(Buffer.from(RFC_SECRET_ASCII, 'ascii'), counter)).toBe(expected);
    });
  });

  describe('TOTP — RFC 6238 Appendix B', () => {
    // The SHA-1 rows of the RFC's table: unix time → expected code.
    it.each([
      [59,          '287082'],
      [1111111109,  '081804'],
      [1111111111,  '050471'],
      [1234567890,  '005924'],
      [2000000000,  '279037'],
    ])('at unix time %i yields %s', (unixSeconds, expected) => {
      expect(generateToken(RFC_SECRET_B32, unixSeconds * 1000)).toBe(expected);
    });

    it('advances exactly once per 30-second step', () => {
      // Anchored to a step boundary on purpose: 1700000000 is 20s into a step,
      // so measuring "+29s stays in the same step" from there would straddle
      // the boundary and test nothing about the step size.
      const base = 56666666 * TOTP_STEP_SECONDS * 1000;
      expect(counterFor(base)).toBe(56666666);
      expect(counterFor(base + 29_999)).toBe(56666666);           // last instant of the step
      expect(counterFor(base + TOTP_STEP_SECONDS * 1000)).toBe(56666667); // first of the next
    });
  });

  describe('verification', () => {
    const now = 1700000000000;

    it('accepts the current code', () => {
      const token = generateToken(RFC_SECRET_B32, now);
      expect(verifyToken({ secret: RFC_SECRET_B32, token, atMs: now })).toMatchObject({ valid: true });
    });

    it('tolerates a phone clock one step out, either way', () => {
      for (const drift of [-TOTP_STEP_SECONDS, TOTP_STEP_SECONDS]) {
        const token = generateToken(RFC_SECRET_B32, now + drift * 1000);
        expect(verifyToken({ secret: RFC_SECRET_B32, token, atMs: now }).valid).toBe(true);
      }
    });

    it('refuses a code two steps out — the window stays narrow deliberately', () => {
      const token = generateToken(RFC_SECRET_B32, now + 2 * TOTP_STEP_SECONDS * 1000);
      expect(verifyToken({ secret: RFC_SECRET_B32, token, atMs: now }).valid).toBe(false);
    });

    it('rejects anything that is not six digits without touching crypto', () => {
      for (const token of ['', '12345', '1234567', 'abcdef', null, undefined, '12 34 56 7']) {
        expect(verifyToken({ secret: RFC_SECRET_B32, token, atMs: now }))
          .toMatchObject({ valid: false, reason: 'malformed' });
      }
    });

    it('accepts a code typed with spaces, as apps display it', () => {
      const token = generateToken(RFC_SECRET_B32, now);
      const spaced = `${token.slice(0, 3)} ${token.slice(3)}`;
      expect(verifyToken({ secret: RFC_SECRET_B32, token: spaced, atMs: now }).valid).toBe(true);
    });

    /**
     * The reason lastCounter exists: a code stays valid for a whole step plus
     * the drift window, so without this the same six digits work more than
     * once — exactly the window someone who shoulder-surfed or phished the code
     * needs.
     */
    it('refuses a code already spent', () => {
      const token = generateToken(RFC_SECRET_B32, now);
      const first = verifyToken({ secret: RFC_SECRET_B32, token, atMs: now });
      expect(first.valid).toBe(true);

      const replay = verifyToken({
        secret: RFC_SECRET_B32, token, atMs: now, lastCounter: first.counter,
      });
      expect(replay).toMatchObject({ valid: false, reason: 'replay' });
    });

    it('still accepts the NEXT code after one is spent', () => {
      const spent = counterFor(now);
      const next = generateToken(RFC_SECRET_B32, now + TOTP_STEP_SECONDS * 1000);
      expect(verifyToken({
        secret: RFC_SECRET_B32, token: next,
        atMs: now + TOTP_STEP_SECONDS * 1000, lastCounter: spent,
      }).valid).toBe(true);
    });

    it('rejects a code from a different secret', () => {
      const token = generateToken(generateSecret(), now);
      expect(verifyToken({ secret: RFC_SECRET_B32, token, atMs: now }).valid).toBe(false);
    });
  });

  describe('enrolment', () => {
    it('mints a 160-bit secret, the size RFC 4226 recommends', () => {
      expect(base32Decode(generateSecret())).toHaveLength(20);
    });

    it('never repeats a secret', () => {
      const seen = new Set(Array.from({ length: 200 }, () => generateSecret()));
      expect(seen.size).toBe(200);
    });

    it('builds a URI an authenticator app can scan', () => {
      const uri = buildOtpauthUri({ secret: RFC_SECRET_B32, label: 'admin@example.com' });
      expect(uri).toMatch(/^otpauth:\/\/totp\//);
      const parsed = new URL(uri);
      expect(parsed.searchParams.get('secret')).toBe(RFC_SECRET_B32);
      expect(parsed.searchParams.get('issuer')).toBe('Betting Bazaar');
      expect(parsed.searchParams.get('digits')).toBe('6');
      expect(parsed.searchParams.get('period')).toBe('30');
    });

    it('labels the account so one person holding several can pick the right code', () => {
      const uri = buildOtpauthUri({ secret: RFC_SECRET_B32, label: 'merchant-42' });
      expect(decodeURIComponent(uri)).toContain('Betting Bazaar:merchant-42');
    });

    it('refuses to build a URI without the parts that make it usable', () => {
      expect(() => buildOtpauthUri({ label: 'x' })).toThrow(/requires a secret/);
      expect(() => buildOtpauthUri({ secret: 'x' })).toThrow(/requires a label/);
    });
  });

  describe('secret storage', () => {
    const KEY = 'dGhpcy1pcy1hLTMyLWJ5dGUtdGVzdC1rZXktMDEyMzQ=';
    beforeEach(() => { process.env.TOTP_ENCRYPTION_KEY = KEY; });
    afterEach(() => { delete process.env.TOTP_ENCRYPTION_KEY; });

    it('round-trips a secret', () => {
      const secret = generateSecret();
      expect(decryptSecret(encryptSecret(secret))).toBe(secret);
    });

    it('never stores the secret in the clear', () => {
      const secret = generateSecret();
      expect(encryptSecret(secret)).not.toContain(secret);
    });

    it('produces a different ciphertext each time, so equal secrets are not detectable', () => {
      const secret = generateSecret();
      expect(encryptSecret(secret)).not.toBe(encryptSecret(secret));
    });

    it('detects tampering rather than returning wrong plaintext', () => {
      const stored = encryptSecret(generateSecret());
      const [v, iv, tag, data] = stored.split(':');
      const flipped = Buffer.from(data, 'base64');
      flipped[0] ^= 0xff;
      expect(() => decryptSecret(`${v}:${iv}:${tag}:${flipped.toString('base64')}`)).toThrow();
    });

    it('refuses a secret encrypted under a different key', () => {
      const stored = encryptSecret(generateSecret());
      process.env.TOTP_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
      expect(() => decryptSecret(stored)).toThrow();
    });

    it('fails loudly when the key is not configured, rather than storing plaintext', () => {
      delete process.env.TOTP_ENCRYPTION_KEY;
      expect(() => encryptSecret('ABC')).toThrow(/TOTP_ENCRYPTION_KEY is not set/);
    });

    // Regression: this used to hash any wrong-length value into a usable key.
    // The service started fine, users enrolled, and the moment the typo was
    // corrected every stored secret became undecryptable — a mass lockout
    // caused by FIXING the configuration.
    it('refuses a key that does not decode to exactly 32 bytes', () => {
      for (const bad of ['too-short', 'AAAA', Buffer.alloc(16).toString('base64')]) {
        process.env.TOTP_ENCRYPTION_KEY = bad;
        expect(() => encryptSecret('ABC')).toThrow(/exactly 32 bytes/);
      }
    });

    it('accepts a 32-byte key as hex as well as base64', () => {
      process.env.TOTP_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
      const secret = generateSecret();
      expect(decryptSecret(encryptSecret(secret))).toBe(secret);
    });

    it('rejects a stored value that is not the expected format', () => {
      expect(() => decryptSecret('not-encrypted')).toThrow(/expected v1 format/);
    });
  });

  describe('backup codes', () => {
    it('issues ten distinct codes', () => {
      const codes = generateBackupCodes();
      expect(codes).toHaveLength(10);
      expect(new Set(codes).size).toBe(10);
      for (const c of codes) expect(c).toMatch(/^[A-Z2-7]{4}-[A-Z2-7]{4}$/);
    });

    it('matches regardless of case, spacing or the dash', () => {
      const [code] = generateBackupCodes(1);
      const messy = code.toLowerCase().replace('-', ' ');
      expect(hashBackupCode(messy)).toBe(hashBackupCode(code));
    });

    it('spends a code exactly once', () => {
      const codes = generateBackupCodes(3);
      const hashes = codes.map(hashBackupCode);

      const first = consumeBackupCode(codes[1], hashes);
      expect(first.valid).toBe(true);
      expect(first.remaining).toHaveLength(2);

      const replay = consumeBackupCode(codes[1], first.remaining);
      expect(replay.valid).toBe(false);
      expect(replay.remaining).toHaveLength(2);
    });

    it('leaves the list untouched when the code is wrong', () => {
      const hashes = generateBackupCodes(3).map(hashBackupCode);
      const result = consumeBackupCode('AAAA-BBBB', hashes);
      expect(result).toMatchObject({ valid: false });
      expect(result.remaining).toEqual(hashes);
    });
  });
});
