// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The staff authenticator's arithmetic (totp.service.js), against the RFCs'
 * own test vectors. The database half (single use, recovery codes, enrolment)
 * is proven against PostgreSQL in database/tests/totpPg.test.js.
 */
import { describe, it, expect } from 'vitest';

process.env.JWT_SECRET ||= 'test-only-paseto-seed';
process.env.IDENTITY_ENCRYPTION_KEY ||= Buffer.alloc(32, 7).toString('base64');

const {
  hotp, totp, matchStep, stepAt, base32Encode, base32Decode, normaliseRecoveryCode,
} = await import('../../domains/identity/totp.service.js');

// RFC 4226 appendix D and RFC 6238 appendix B use this ASCII secret for SHA-1.
const RFC_SECRET = Buffer.from('12345678901234567890', 'ascii');

describe('HOTP (RFC 4226, appendix D)', () => {
  const expected = ['755224', '287082', '359152', '969429', '338314',
    '254676', '287922', '162583', '399871', '520489'];
  it.each(expected.map((code, counter) => [counter, code]))('counter %i is %s', (counter, code) => {
    expect(hotp(RFC_SECRET, counter)).toBe(code);
  });
});

describe('TOTP (RFC 6238, appendix B, SHA-1, 8 digits)', () => {
  it.each([
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130'],
  ])('at %i s it is %s', (seconds, code) => {
    expect(totp(RFC_SECRET, seconds * 1000, 8)).toBe(code);
  });
});

describe('base32 (RFC 4648)', () => {
  it('matches the RFC examples and round-trips 20 random bytes', () => {
    expect(base32Encode(Buffer.from('foobar'))).toBe('MZXW6YTBOI');
    expect(base32Decode('MZXW6YTBOI').toString()).toBe('foobar');
    const bytes = Buffer.from(Array.from({ length: 20 }, (_, i) => (i * 37) & 255));
    expect(base32Decode(base32Encode(bytes)).equals(bytes)).toBe(true);
    expect(base32Encode(bytes)).toHaveLength(32);
  });

  it('forgives case, spaces and dashes; refuses what is not base32', () => {
    expect(base32Decode('mzxw 6ytb-oi').toString()).toBe('foobar');
    expect(() => base32Decode('MZXW1')).toThrow(/not base32/);
  });
});

describe('matchStep: the window and the shape', () => {
  const now = 1_700_000_000_000;
  const step = stepAt(now);

  it('accepts the step before, the current one and the one after, and says which', () => {
    expect(matchStep(RFC_SECRET, hotp(RFC_SECRET, step), now)).toBe(step);
    expect(matchStep(RFC_SECRET, hotp(RFC_SECRET, step - 1), now)).toBe(step - 1);
    expect(matchStep(RFC_SECRET, hotp(RFC_SECRET, step + 1), now)).toBe(step + 1);
  });

  it('refuses two steps away either side (a clock off by a minute)', () => {
    const early = hotp(RFC_SECRET, step - 2);
    const late = hotp(RFC_SECRET, step + 2);
    // Guard against a vector colliding with an in-window code by chance.
    const inWindow = [step - 1, step, step + 1].map((s) => hotp(RFC_SECRET, s));
    if (!inWindow.includes(early)) expect(matchStep(RFC_SECRET, early, now)).toBeNull();
    if (!inWindow.includes(late)) expect(matchStep(RFC_SECRET, late, now)).toBeNull();
  });

  it('refuses anything that is not six digits', () => {
    for (const bad of ['', null, undefined, '12345', '1234567', 'abcdef', ' 123456', '12 345']) {
      expect(matchStep(RFC_SECRET, bad, now), String(bad)).toBeNull();
    }
  });

  it('refuses another secret\'s code', () => {
    const other = Buffer.from('09876543210987654321', 'ascii');
    const code = hotp(other, step);
    if (![step - 1, step, step + 1].some((s) => hotp(RFC_SECRET, s) === code)) {
      expect(matchStep(RFC_SECRET, code, now)).toBeNull();
    }
  });
});

describe('recovery code input', () => {
  it('takes what a person types and gives the stored shape', () => {
    expect(normaliseRecoveryCode('abcde-fghij')).toBe('ABCDE-FGHIJ');
    expect(normaliseRecoveryCode(' ABCDE FGHIJ ')).toBe('ABCDE-FGHIJ');
    expect(normaliseRecoveryCode('ABCDEFGHIJ')).toBe('ABCDE-FGHIJ');
  });

  it('refuses anything outside the base32 alphabet or of another length', () => {
    for (const bad of ['ABCDE-FGHI', 'ABCDE-FGHIJK', 'ABCDE-FGH1J', 'ABCD0-FGHIJ', '', null]) {
      expect(normaliseRecoveryCode(bad), String(bad)).toBeNull();
    }
  });
});
