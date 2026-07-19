// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
import { afterEach, describe, expect, it } from 'vitest';
import { hashAadhaar, hashAadhaarCandidates } from '../../domains/identity/aadhaarHash.util.js';

const originalCurrent = process.env.AADHAAR_HMAC_SECRET;
const originalPrevious = process.env.AADHAAR_HMAC_PREVIOUS_SECRETS;

afterEach(() => {
  if (originalCurrent === undefined) delete process.env.AADHAAR_HMAC_SECRET;
  else process.env.AADHAAR_HMAC_SECRET = originalCurrent;
  if (originalPrevious === undefined) delete process.env.AADHAAR_HMAC_PREVIOUS_SECRETS;
  else process.env.AADHAAR_HMAC_PREVIOUS_SECRETS = originalPrevious;
});

describe('Aadhaar HMAC hashing', () => {
  it('normalizes spacing and hyphens before using the active HMAC secret', () => {
    process.env.AADHAAR_HMAC_SECRET = 'current-secret';
    expect(hashAadhaar('1234-5678 9012')).toHaveLength(64);
    expect(hashAadhaar('1234-5678 9012')).toBe(hashAadhaar('123456789012'));
    expect(hashAadhaar('12345678901')).toBeNull();
  });

  it('includes retained secrets for comparisons during secret rotation', () => {
    process.env.AADHAAR_HMAC_SECRET = 'current-secret';
    process.env.AADHAAR_HMAC_PREVIOUS_SECRETS = 'previous-secret';
    const candidates = hashAadhaarCandidates('123456789012');
    expect(candidates).toHaveLength(2);
    expect(candidates).toContain(hashAadhaar('123456789012'));
  });
});
