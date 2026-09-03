// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file.
/**
 * The admin console's input guards.
 *
 * These decide what an operator can submit: a mobile that is not a real Indian
 * number, an IFSC in the wrong shape, an Aadhaar that is not twelve digits.
 * The IFSC rule in particular is the same shape the backend stores (uppercased,
 * bank code + 0 + branch), so a value that passes here is one the withdrawal
 * path can actually pay to.
 */
import { describe, it, expect } from 'vitest';
import { validators } from './validators';

describe('validators.mobile — Indian mobile numbers', () => {
  it('accepts a ten-digit number starting 6-9', () => {
    for (const n of ['9876543210', '6000000000', '7123456789', '8888888888']) {
      expect(validators.mobile(n), n).toBe(true);
    }
  });

  it('rejects the wrong length or a leading digit below 6', () => {
    for (const n of ['5876543210', '1234567890', '987654321', '98765432100', '', 'abcdefghij']) {
      expect(validators.mobile(n), n).toBe(false);
    }
  });
});

describe('validators.ifsc — the withdrawal destination code', () => {
  it('accepts the canonical shape, case-insensitively', () => {
    // Four letters, a zero, then six alphanumerics. Lowercase is accepted
    // because it is uppercased before the test — matching how the backend
    // stores it.
    expect(validators.ifsc('HDFC0001234')).toBe(true);
    expect(validators.ifsc('hdfc0001234')).toBe(true);
    expect(validators.ifsc('SBIN0A00001')).toBe(true);
  });

  it('rejects a code whose fifth character is not 0, or the wrong length', () => {
    expect(validators.ifsc('HDFC1001234')).toBe(false);
    expect(validators.ifsc('HDF0001234')).toBe(false);
    expect(validators.ifsc('HDFC000123')).toBe(false);
    expect(validators.ifsc('')).toBe(false);
  });
});

describe('validators.aadhaar and pan', () => {
  it('accepts twelve digits for Aadhaar, ignoring spaces', () => {
    expect(validators.aadhaar('1234 5678 9012')).toBe(true);
    expect(validators.aadhaar('123456789012')).toBe(true);
    expect(validators.aadhaar('12345')).toBe(false);
  });

  it('accepts the PAN shape case-insensitively', () => {
    expect(validators.pan('ABCDE1234F')).toBe(true);
    expect(validators.pan('abcde1234f')).toBe(true);
    expect(validators.pan('ABCD1234F')).toBe(false);
  });
});

describe('validators.amount', () => {
  it('enforces a floor and an optional ceiling', () => {
    expect(validators.amount(500, 100, 1000)).toBe(true);
    expect(validators.amount(50, 100)).toBe(false);
    expect(validators.amount(5000, 100, 1000)).toBe(false);
  });

  it('accepts the boundary values', () => {
    expect(validators.amount(100, 100, 1000)).toBe(true);
    expect(validators.amount(1000, 100, 1000)).toBe(true);
  });
});

describe('validators.url', () => {
  it('accepts an absolute URL and rejects a bare word', () => {
    expect(validators.url('https://example.com/path')).toBe(true);
    expect(validators.url('not a url')).toBe(false);
  });
});
