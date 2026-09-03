// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * Test-only secrets, set before any route module is imported.
 *
 * The identity modules refuse to LOAD without these — `paseto.util.js` throws
 * at import time on a missing signing key, which is correct: a money platform
 * that boots with a fallback signing key lets anyone forge a session. That
 * refusal is asserted by `validateEnv.test.js`; here it just has to be
 * satisfied.
 *
 * These are fixed, obviously-fake values. They are NOT read from the
 * environment: a test that silently used a real key from a developer's shell
 * would sign tokens with it, and a test that passed only on a machine that
 * happened to have one set is worse than no test.
 */
const FIXED = {
  JWT_SECRET: 'test-only-signing-key-not-a-real-secret-0123456789abcdef',
  ORDER_HMAC_SECRET: 'test-only-order-hmac-not-a-real-secret-0123456789abcdef',
  AADHAAR_HMAC_SECRET: 'test-only-aadhaar-hmac-not-a-real-secret-0123456789abcd',
  // 32 bytes, base64 — AES-256 needs a real key shape even in a test.
  IDENTITY_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
  TOTP_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64'),
};

for (const [key, value] of Object.entries(FIXED)) process.env[key] = value;
