// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
// Unit tests: OTP / recovery-code verification and the anti-replay guard.
//
// Runs against an in-memory stand-in for the account's credentials and the two
// conditional writes the module needs, so it needs no database. The stub
// enforces the SAME conditions the SQL does — monotonic counter,
// compare-and-swap on the recovery list — so a test that passes here is
// asserting the module's logic rather than the stub's generosity.
//
// That the conditions actually hold under CONCURRENCY is not provable here and
// is not claimed: `database/tests/userPg.test.js` proves it against a real
// database, which is the only place a race can be run.
import { describe, it, expect } from 'vitest';

process.env.JWT_SECRET ||= 'test-only-paseto-seed';
process.env.TOTP_ENCRYPTION_KEY ||= Buffer.alloc(32, 7).toString('base64');

const { verifySecondFactor, SECOND_FACTOR_RESULT } =
  await import('../../domains/identity/verifySecondFactor.js');
const {
  generateSecret, encryptSecret, generateToken, counterFor,
  generateBackupCodes, hashBackupCode, TOTP_STEP_SECONDS,
} = await import('../../domains/identity/totp.service.js');

/**
 * Stand-in for an account's credentials plus the two conditional writes.
 *
 * `store` mirrors the SQL exactly: the counter only advances when the new one
 * is strictly higher, and the recovery list only changes when it still holds
 * what the caller verified against. A stub that accepted every write would let
 * a broken replay guard pass.
 */
function makeAccount(overrides = {}) {
  const secret = overrides.secret || generateSecret();
  const doc = {
    twoFactorEnabled: true,
    twoFactorSecret: encryptSecret(secret),
    twoFactorLastCounter: null,
    backupCodes: [],
    saved: 0,
    ...overrides,
  };
  const store = {
    async spendCounter(counter) {
      if (doc.twoFactorLastCounter !== null && counter <= doc.twoFactorLastCounter) return false;
      doc.twoFactorLastCounter = counter;
      doc.saved += 1;
      return true;
    },
    async consumeBackupCode({ expected, remaining }) {
      if (JSON.stringify(expected) !== JSON.stringify(doc.backupCodes)) return false;
      doc.backupCodes = remaining;
      doc.saved += 1;
      return true;
    },
  };
  return { doc, secret, store };
}

describe('verifySecondFactor — authenticator codes', () => {
  it('accepts a current code and spends its counter', async () => {
    const { doc, secret, store } = makeAccount();
    const now = Date.now();

    const r = await verifySecondFactor(doc, generateToken(secret, now), store);
    expect(r.ok).toBe(true);
    expect(r.usedBackupCode).toBe(false);
    // The counter must be PERSISTED — an in-memory-only check would not
    // survive to the next request and the replay guard would be decorative.
    expect(doc.twoFactorLastCounter).toBe(counterFor(now));
    expect(doc.saved).toBe(1);
  });

  it('refuses the SAME code a second time (replay)', async () => {
    // A TOTP code stays valid for its 30s step plus ±1 step of drift — up to
    // 90 seconds. That is the window a shoulder-surfed or phished code needs.
    const { doc, secret, store } = makeAccount();
    const now = Date.now();
    const code = generateToken(secret, now);

    expect((await verifySecondFactor(doc, code, store)).ok).toBe(true);
    const second = await verifySecondFactor(doc, code, store);
    expect(second.ok).toBe(false);
    expect(second.result).toBe(SECOND_FACTOR_RESULT.INVALID);
  });

  it('refuses an OLDER code once a newer one has been spent', async () => {
    const { doc, secret, store } = makeAccount();
    const now = Date.now();
    const older = generateToken(secret, now - TOTP_STEP_SECONDS * 1000);

    expect((await verifySecondFactor(doc, generateToken(secret, now), store)).ok).toBe(true);
    expect((await verifySecondFactor(doc, older, store)).ok).toBe(false);
  });

  it('accepts the NEXT code after one is spent', async () => {
    // The guard must not brick the account — only codes at or below the spent
    // counter are refused.
    const { doc, secret, store } = makeAccount();
    const now = Date.now();
    expect((await verifySecondFactor(doc, generateToken(secret, now), store)).ok).toBe(true);
    const next = now + TOTP_STEP_SECONDS * 1000;
    expect((await verifySecondFactor(doc, generateToken(secret, next), store)).ok).toBe(true);
    expect(doc.twoFactorLastCounter).toBe(counterFor(next));
  });

  it('refuses a wrong code without spending anything', async () => {
    const { doc, store } = makeAccount();
    const r = await verifySecondFactor(doc, '000000', store);
    expect(r.ok).toBe(false);
    expect(doc.twoFactorLastCounter).toBeNull();
    expect(doc.saved).toBe(0);       // nothing persisted on failure
  });

  it('reports NOT_ENROLLED rather than guessing', async () => {
    const { doc, store } = makeAccount({ twoFactorEnabled: false });
    expect((await verifySecondFactor(doc, '123456', store)).result).toBe(SECOND_FACTOR_RESULT.NOT_ENROLLED);

    const { doc: noSecret } = makeAccount({ twoFactorSecret: null });
    expect((await verifySecondFactor(noSecret, '123456')).result).toBe(SECOND_FACTOR_RESULT.NOT_ENROLLED);
  });

  it('distinguishes an undecryptable secret from a wrong code', async () => {
    // Wrong TOTP_ENCRYPTION_KEY: nothing the user types can ever succeed, so
    // the caller must surface an operator error instead of looping them
    // through "invalid code" forever.
    const { doc, store } = makeAccount({ twoFactorSecret: 'v1:not:valid:ciphertext' });
    expect((await verifySecondFactor(doc, '123456', store)).result)
      .toBe(SECOND_FACTOR_RESULT.MALFORMED_SECRET);
  });

  it('treats blank input as invalid, not as a match', async () => {
    const { doc, store } = makeAccount();
    for (const blank of ['', '   ', null, undefined]) {
      const r = await verifySecondFactor(doc, blank, store);
      expect(r.ok).toBe(false);
    }
    expect(doc.saved).toBe(0);
  });
});

describe('verifySecondFactor — recovery codes', () => {
  it('accepts a recovery code and consumes exactly one', async () => {
    const codes = generateBackupCodes(3);
    const { doc, store } = makeAccount({ backupCodes: codes.map(hashBackupCode) });

    const r = await verifySecondFactor(doc, codes[1], store);
    expect(r.ok).toBe(true);
    expect(r.usedBackupCode).toBe(true);
    expect(r.backupCodesRemaining).toBe(2);
    expect(doc.backupCodes).toHaveLength(2);
    expect(doc.backupCodes).not.toContain(hashBackupCode(codes[1]));
    // The others still work.
    expect(doc.backupCodes).toContain(hashBackupCode(codes[0]));
  });

  it('refuses the same recovery code twice — single use is the point', async () => {
    const codes = generateBackupCodes(2);
    const { doc, store } = makeAccount({ backupCodes: codes.map(hashBackupCode) });

    expect((await verifySecondFactor(doc, codes[0], store)).ok).toBe(true);
    expect((await verifySecondFactor(doc, codes[0], store)).ok).toBe(false);
    expect(doc.backupCodes).toHaveLength(1);
  });

  it('does NOT burn a recovery code when the authenticator works', async () => {
    // Recovery codes are checked only after the OTP path fails, so a working
    // handset never silently eats the user's finite supply.
    const codes = generateBackupCodes(5);
    const { doc, secret, store } = makeAccount({ backupCodes: codes.map(hashBackupCode) });

    const r = await verifySecondFactor(doc, generateToken(secret, Date.now()), store);
    expect(r.ok).toBe(true);
    expect(r.usedBackupCode).toBe(false);
    expect(doc.backupCodes).toHaveLength(5);
  });

  it('is case- and dash-insensitive, matching how codes are shown', async () => {
    const codes = generateBackupCodes(1);
    const { doc, store } = makeAccount({ backupCodes: codes.map(hashBackupCode) });
    const messy = ` ${codes[0].toLowerCase().replace('-', '')} `;
    expect((await verifySecondFactor(doc, messy, store)).ok).toBe(true);
  });

  it('fails closed when the code list is empty', async () => {
    const { doc, store } = makeAccount({ backupCodes: [] });
    expect((await verifySecondFactor(doc, 'AAAA-BBBB', store)).ok).toBe(false);
  });
});
