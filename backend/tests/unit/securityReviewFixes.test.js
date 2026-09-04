// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
// Regression coverage for the 2026-07-16 security review fixes.
import { describe, it, expect } from 'vitest';
import { sanitizeInPlace } from '../../middleware/inputSanitize.js';
import { parseTrustProxy } from '../../config/network.config.js';

describe('security review regressions', () => {
  it('strips prototype-pollution keys while preserving safe nested values', () => {
    const body = JSON.parse(`{
      "username": "alice",
      "__proto__": { "polluted": true },
      "nested": {
        "constructor": { "prototype": { "admin": true } },
        "keep": "safe"
      },
      "list": [{ "prototype": { "injected": true }, "value": 42 }]
    }`);

    sanitizeInPlace(body);

    expect(Object.prototype.hasOwnProperty.call(body, '__proto__')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(body.nested, 'constructor')).toBe(false);
    expect(body.nested.keep).toBe('safe');
    expect(body.list[0].prototype).toBeUndefined();
    expect(body.list[0].value).toBe(42);
  });

  it('fails closed for trust proxy unless explicitly configured', () => {
    expect(parseTrustProxy(undefined)).toBe(false);
    expect(parseTrustProxy('')).toBe(false);
    expect(parseTrustProxy('direct')).toBe(false);
    expect(parseTrustProxy('false')).toBe(false);
    expect(parseTrustProxy('1')).toBe(1);
    expect(parseTrustProxy('10.0.0.0/8')).toBe('10.0.0.0/8');
  });
});
