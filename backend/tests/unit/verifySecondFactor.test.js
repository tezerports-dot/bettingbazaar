// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
// Unit tests: OTP / recovery-code verification and the anti-replay guard.
//
// Runs against a hand-rolled stand-in for a Mongoose document rather than a
// real one, so it needs no mongod: the module only ever touches the 2FA
// fields and .save(), and those are exactly what the stub provides. That also
// lets each test assert on what was PERSISTED, which is the part that
// actually stops a replay.
import { describe, it, expect } from 'vitest';

process.env.JWT_SECRET ||= 'test-only-paseto-seed';
process.env.TOTP_ENCRYPTION_KEY ||= Buffer.alloc(32, 7).toString('base64');

const { verifySecondFactor, SECOND_FACTOR_RESULT } =
  await import('../../domains/identity/verifySecondFactor.js');
const {
  generateSecret, encryptSecret, generateToken, counterFor,
  generateBackupCodes, hashBackupCode, TOTP_STEP_SECONDS,
} = await import('../../domains/identity/totp.service.js');

/** Minimal stand-in for a User/Merchant document. */
function makeAccount(overrides = {}) {
  const secret = overrides.secret || generateSecret();
  const doc = {
    _id: 'acct-1',
    twoFactorEnabled: true,
    twoFactorSecret: encryptSecret(secret),
    twoFactorLastCounter: null,
    backupCodes: [],
    saved: 0,
    async save() { this.saved++; },
    ...overrides,
  };
  return { doc, secret };
}

describe('verifySecondFactor — authenticator codes', () => {
  it('accepts a current code and spends its counter', async () => {
    const { doc, secret } = makeAccount();
    const now = Date.now();

    const r = await verifySecondFactor(doc, generateToken(secret, now));
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
    const { doc, secret } = makeAccount();
    const now = Date.now();
    const code = generateToken(secret, now);

    expect((await verifySecondFactor(doc, code)).ok).toBe(true);
    const second = await verifySecondFactor(doc, code);
    expect(second.ok).toBe(false);
    expect(second.result).toBe(SECOND_FACTOR_RESULT.INVALID);
  });

  it('refuses an OLDER code once a newer one has been spent', async () => {
    const { doc, secret } = makeAccount();
    const now = Date.now();
    const older = generateToken(secret, now - TOTP_STEP_SECONDS * 1000);

    expect((await verifySecondFactor(doc, generateToken(secret, now))).ok).toBe(true);
    expect((await verifySecondFactor(doc, older)).ok).toBe(false);
  });

  it('accepts the NEXT code after one is spent', async () => {
    // The guard must not brick the account — only codes at or below the spent
    // counter are refused.
    const { doc, secret } = makeAccount();
    const now = Date.now();
    expect((await verifySecondFactor(doc, generateToken(secret, now))).ok).toBe(true);
    const next = now + TOTP_STEP_SECONDS * 1000;
    expect((await verifySecondFactor(doc, generateToken(secret, next))).ok).toBe(true);
    expect(doc.twoFactorLastCounter).toBe(counterFor(next));
  });

  it('refuses a wrong code without spending anything', async () => {
    const { doc } = makeAccount();
    const r = await verifySecondFactor(doc, '000000');
    expect(r.ok).toBe(false);
    expect(doc.twoFactorLastCounter).toBeNull();
    expect(doc.saved).toBe(0);       // nothing persisted on failure
  });

  it('reports NOT_ENROLLED rather than guessing', async () => {
    const { doc } = makeAccount({ twoFactorEnabled: false });
    expect((await verifySecondFactor(doc, '123456')).result).toBe(SECOND_FACTOR_RESULT.NOT_ENROLLED);

    const { doc: noSecret } = makeAccount({ twoFactorSecret: null });
    expect((await verifySecondFactor(noSecret, '123456')).result).toBe(SECOND_FACTOR_RESULT.NOT_ENROLLED);
  });

  it('distinguishes an undecryptable secret from a wrong code', async () => {
    // Wrong TOTP_ENCRYPTION_KEY: nothing the user types can ever succeed, so
    // the caller must surface an operator error instead of looping them
    // through "invalid code" forever.
    const { doc } = makeAccount({ twoFactorSecret: 'v1:not:valid:ciphertext' });
    expect((await verifySecondFactor(doc, '123456')).result)
      .toBe(SECOND_FACTOR_RESULT.MALFORMED_SECRET);
  });

  it('treats blank input as invalid, not as a match', async () => {
    const { doc } = makeAccount();
    for (const blank of ['', '   ', null, undefined]) {
      const r = await verifySecondFactor(doc, blank);
      expect(r.ok).toBe(false);
    }
    expect(doc.saved).toBe(0);
  });
});

describe('verifySecondFactor — recovery codes', () => {
  it('accepts a recovery code and consumes exactly one', async () => {
    const codes = generateBackupCodes(3);
    const { doc } = makeAccount({ backupCodes: codes.map(hashBackupCode) });

    const r = await verifySecondFactor(doc, codes[1]);
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
    const { doc } = makeAccount({ backupCodes: codes.map(hashBackupCode) });

    expect((await verifySecondFactor(doc, codes[0])).ok).toBe(true);
    expect((await verifySecondFactor(doc, codes[0])).ok).toBe(false);
    expect(doc.backupCodes).toHaveLength(1);
  });

  it('does NOT burn a recovery code when the authenticator works', async () => {
    // Recovery codes are checked only after the OTP path fails, so a working
    // handset never silently eats the user's finite supply.
    const codes = generateBackupCodes(5);
    const { doc, secret } = makeAccount({ backupCodes: codes.map(hashBackupCode) });

    const r = await verifySecondFactor(doc, generateToken(secret, Date.now()));
    expect(r.ok).toBe(true);
    expect(r.usedBackupCode).toBe(false);
    expect(doc.backupCodes).toHaveLength(5);
  });

  it('is case- and dash-insensitive, matching how codes are shown', async () => {
    const codes = generateBackupCodes(1);
    const { doc } = makeAccount({ backupCodes: codes.map(hashBackupCode) });
    const messy = ` ${codes[0].toLowerCase().replace('-', '')} `;
    expect((await verifySecondFactor(doc, messy)).ok).toBe(true);
  });

  it('fails closed when the code list is empty', async () => {
    const { doc } = makeAccount({ backupCodes: [] });
    expect((await verifySecondFactor(doc, 'AAAA-BBBB')).ok).toBe(false);
  });
});
