// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The STAFF authenticator (owner, 2026-10-13) against a REAL PostgreSQL:
 * `staff_totp` and its one writer (repositories/totp.js), through the service
 * that checks codes (totp.service.js), and the break-glass script.
 *
 * The properties are the database's: a code's 30-second step is spent once
 * (`last_counter < step` in the UPDATE's WHERE), so of N identical codes
 * arriving together exactly one wins; a recovery code is spent once; a pending
 * secret lapses by the DATABASE clock; only a STAFF account can hold a row;
 * and a staff account can hold no Telegram link or challenge, on a database
 * that had one before as much as on a new one (§32 S31).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pgConfigured, pgQuery, applySchema, closePg } from '../client.js';
import { createUser, getUser, newUserId } from '../repositories/users.js';
import * as totpRepo from '../repositories/totp.js';

process.env.IDENTITY_ENCRYPTION_KEY ||= Buffer.alloc(32, 7).toString('base64');
process.env.JWT_SECRET ||= 'test-only-paseto-seed';

const svc = await import('../../backend/domains/identity/totp.service.js');
const { resetStaffAccess } = await import('../../scripts/reset-staff-access.mjs');

const describePg = pgConfigured() ? describe : describe.skip;

const mobile = () => `9${String(Date.now()).slice(-5)}${String(Math.floor(Math.random() * 1e4)).padStart(4, '0')}`;

async function staff(over = {}) {
  const userId = newUserId();
  const m = mobile();
  await createUser({
    userId, username: `st${userId.slice(-6)}`, mobile: m, passwordHash: '$argon2id$fake',
    accountType: 'STAFF', status: 'ACTIVE', ...over,
  });
  return { userId, mobile: m };
}

/** Enrol through the service, as the first sign-in does; answers the secret and the codes. */
async function enrolled(user) {
  const { secret } = await svc.beginEnrolment(user, { issuer: 'Test' });
  const key = svc.base32Decode(secret);
  const { recoveryCodes } = await svc.completeEnrolment(user, svc.totp(key, Date.now() - 30_000));
  return { key, recoveryCodes };
}

const rowOf = async (userId) => (await pgQuery('SELECT * FROM staff_totp WHERE user_id = $1', [userId])).rows[0] ?? null;
const settled = (promises) => Promise.allSettled(promises);

describePg('staff authenticator (PostgreSQL)', () => {
  beforeAll(async () => { await applySchema(); });
  afterAll(async () => { await closePg(); });

  // ── The schema ─────────────────────────────────────────────────────────
  describe('the schema', () => {
    it('applies twice and converges: a staff Telegram link or challenge left from before is deleted', async () => {
      const s = await staff();
      // A database from before this change: the CHECKs allowed STAFF.
      await pgQuery('ALTER TABLE telegram_links DROP CONSTRAINT telegram_links_audience_check');
      await pgQuery('ALTER TABLE telegram_challenges DROP CONSTRAINT telegram_challenges_audience_check');
      try {
        await pgQuery(
          `INSERT INTO telegram_links (user_id, audience, telegram_user_id, phone)
           VALUES ($1, 'STAFF', $2, $3)`, [s.userId, `tg${s.userId}`, s.mobile]);
        await pgQuery(
          `INSERT INTO telegram_challenges (challenge_id, audience, user_id, expires_at, delivery)
           VALUES ($1, 'STAFF', $2, now() + interval '5 minutes', 'HANDOFF')`, [`c${s.userId}`, s.userId]);
      } finally {
        await applySchema();
        await applySchema();
      }
      expect((await pgQuery('SELECT 1 FROM telegram_links WHERE user_id = $1', [s.userId])).rowCount).toBe(0);
      expect((await pgQuery('SELECT 1 FROM telegram_challenges WHERE user_id = $1', [s.userId])).rowCount).toBe(0);
      const { rows } = await pgQuery(
        `SELECT conname FROM pg_constraint
          WHERE conname IN ('telegram_links_audience_check', 'telegram_challenges_audience_check',
                            'staff_totp_staff_only', 'staff_totp_account', 'staff_totp_has_secret',
                            'staff_totp_enrolled_shape', 'staff_totp_recovery_array')`);
      expect(rows.map((r) => r.conname).sort()).toEqual([
        'staff_totp_account', 'staff_totp_enrolled_shape', 'staff_totp_has_secret',
        'staff_totp_recovery_array', 'staff_totp_staff_only',
        'telegram_challenges_audience_check', 'telegram_links_audience_check',
      ]);
    });

    it('refuses a STAFF Telegram link and a STAFF challenge', async () => {
      const s = await staff();
      await expect(pgQuery(
        `INSERT INTO telegram_links (user_id, audience, telegram_user_id, phone)
         VALUES ($1, 'STAFF', $2, $3)`, [s.userId, `tg${s.userId}`, s.mobile],
      )).rejects.toMatchObject({ constraint: 'telegram_links_audience_check' });
      await expect(pgQuery(
        `INSERT INTO telegram_challenges (challenge_id, audience, user_id, expires_at, delivery)
         VALUES ($1, 'STAFF', $2, now() + interval '5 minutes', 'HANDOFF')`, [`c${s.userId}`, s.userId],
      )).rejects.toMatchObject({ constraint: 'telegram_challenges_audience_check' });
    });

    it('refuses an authenticator row for a player or merchant account', async () => {
      for (const accountType of ['PLAYER', 'MERCHANT']) {
        const userId = newUserId();
        await createUser({ userId, username: `p${userId.slice(-6)}`, mobile: mobile(), accountType });
        await expect(totpRepo.savePending(userId, 'v1:x:y:z'), accountType).rejects.toMatchObject({ code: '23503' });
        await expect(pgQuery(
          `INSERT INTO staff_totp (user_id, account_type, pending_secret_enc, pending_at)
           VALUES ($1, $2, 'v1:x:y:z', now())`, [userId, accountType],
        ), accountType).rejects.toMatchObject({ code: '23514' });
      }
    });

    it('refuses a row with no secret, or a secret without its enrolment date', async () => {
      const s = await staff();
      await expect(pgQuery('INSERT INTO staff_totp (user_id) VALUES ($1)', [s.userId]))
        .rejects.toMatchObject({ constraint: 'staff_totp_has_secret' });
      await expect(pgQuery(
        "INSERT INTO staff_totp (user_id, secret_enc) VALUES ($1, 'v1:x:y:z')", [s.userId],
      )).rejects.toMatchObject({ constraint: 'staff_totp_enrolled_shape' });
    });
  });

  // ── Enrolment ──────────────────────────────────────────────────────────
  describe('enrolment', () => {
    it('stores the secret encrypted, activates on the first right code, and answers ten recovery codes once', async () => {
      const s = await staff();
      const begun = await svc.beginEnrolment(s, { issuer: 'Betting Bazaar' });
      expect(begun.secret).toMatch(/^[A-Z2-7]{32}$/);
      expect(begun.otpauthUri).toContain(`otpauth://totp/Betting%20Bazaar%3A${s.mobile}?secret=${begun.secret}`);
      expect(begun.qrDataUrl.startsWith('data:image/png;base64,')).toBe(true);
      const pending = await rowOf(s.userId);
      expect(pending.pending_secret_enc.startsWith('v1:')).toBe(true);
      expect(pending.pending_secret_enc).not.toContain(begun.secret);
      expect((await totpRepo.getState(s.userId)).enrolled).toBe(false);

      const { recoveryCodes } = await svc.completeEnrolment(s, svc.totp(svc.base32Decode(begun.secret)));
      expect(recoveryCodes).toHaveLength(10);
      for (const c of recoveryCodes) expect(c).toMatch(/^[A-Z2-7]{5}-[A-Z2-7]{5}$/);
      const row = await rowOf(s.userId);
      expect(row.secret_enc).toBe(pending.pending_secret_enc);
      expect(row.pending_secret_enc).toBeNull();
      expect(row.recovery_hashes).toHaveLength(10);
      for (const h of row.recovery_hashes) expect(h.startsWith('$argon2id$')).toBe(true);
      expect(JSON.stringify(row.recovery_hashes)).not.toContain(recoveryCodes[0]);
      expect(await totpRepo.getState(s.userId)).toMatchObject({ enrolled: true, recoveryCodesLeft: 10 });
    });

    it('refuses a wrong first code and keeps the pending secret', async () => {
      const s = await staff();
      const { secret } = await svc.beginEnrolment(s, { issuer: 'T' });
      const right = svc.totp(svc.base32Decode(secret));
      const wrong = right === '000000' ? '111111' : '000000';
      await expect(svc.completeEnrolment(s, wrong)).rejects.toMatchObject({ status: 401, code: 'TOTP_INVALID' });
      expect((await rowOf(s.userId)).secret_enc).toBeNull();
      await svc.completeEnrolment(s, right);
      expect((await totpRepo.getState(s.userId)).enrolled).toBe(true);
    });

    it('lets a pending secret lapse after 30 minutes by the database clock', async () => {
      const s = await staff();
      const { secret } = await svc.beginEnrolment(s, { issuer: 'T' });
      await pgQuery("UPDATE staff_totp SET pending_at = now() - interval '31 minutes' WHERE user_id = $1", [s.userId]);
      await expect(svc.completeEnrolment(s, svc.totp(svc.base32Decode(secret))))
        .rejects.toMatchObject({ status: 409, code: 'TOTP_SETUP_EXPIRED' });
      // A new setup replaces it and works.
      const again = await svc.beginEnrolment(s, { issuer: 'T' });
      await svc.completeEnrolment(s, svc.totp(svc.base32Decode(again.secret)));
      expect((await totpRepo.getState(s.userId)).enrolled).toBe(true);
    });

    it('refuses to replace an enrolled secret: only a reset does', async () => {
      const s = await staff();
      await enrolled(s);
      const before = await rowOf(s.userId);
      await expect(svc.beginEnrolment(s, { issuer: 'T' })).rejects.toMatchObject({ status: 409, code: 'TOTP_ALREADY_ENROLLED' });
      expect((await rowOf(s.userId)).secret_enc).toBe(before.secret_enc);
      expect((await rowOf(s.userId)).pending_secret_enc).toBeNull();
    });

    it('activates only the secret the code was checked against (a second setup in between wins)', async () => {
      const s = await staff();
      const first = await svc.beginEnrolment(s, { issuer: 'T' });
      const firstEnc = (await rowOf(s.userId)).pending_secret_enc;
      await svc.beginEnrolment(s, { issuer: 'T' });
      expect(await totpRepo.activate(s.userId, {
        pendingSecretEnc: firstEnc, step: svc.stepAt(), recoveryHashes: [],
      })).toBe(false);
      await expect(svc.completeEnrolment(s, svc.totp(svc.base32Decode(first.secret))))
        .rejects.toMatchObject({ code: 'TOTP_INVALID' });
    });
  });

  // ── Sign-in codes: single use ──────────────────────────────────────────
  describe('a sign-in code is spent once', () => {
    it('accepts a code once; the same code again is refused', async () => {
      const s = await staff();
      const { key } = await enrolled(s);
      const code = svc.totp(key);
      expect(await svc.checkSignInCode(s, code)).toEqual({ method: 'otp' });
      await expect(svc.checkSignInCode(s, code)).rejects.toMatchObject({ status: 401, code: 'TOTP_INVALID' });
    });

    it('of five identical codes arriving together, exactly one wins', async () => {
      const s = await staff();
      const { key } = await enrolled(s);
      const code = svc.totp(key);
      const results = await settled(Array.from({ length: 5 }, () => svc.checkSignInCode(s, code)));
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      for (const r of results.filter((x) => x.status === 'rejected')) expect(r.reason.code).toBe('TOTP_INVALID');
    });

    it('refuses an older code once a newer one was accepted', async () => {
      const s = await staff();
      const { key } = await enrolled(s);
      const now = Date.now();
      await svc.checkSignInCode(s, svc.totp(key, now + 30_000), { now });   // the next step
      await expect(svc.checkSignInCode(s, svc.totp(key, now), { now })).rejects.toMatchObject({ code: 'TOTP_INVALID' });
    });

    it('refuses a code when nothing is enrolled', async () => {
      const s = await staff();
      await expect(svc.checkSignInCode(s, '123456')).rejects.toMatchObject({ status: 409, code: 'TOTP_NOT_ENROLLED' });
    });
  });

  // ── Recovery codes ─────────────────────────────────────────────────────
  describe('recovery codes', () => {
    it('signs in once per code, however it is typed; the second use is refused', async () => {
      const s = await staff();
      const { recoveryCodes } = await enrolled(s);
      const typed = recoveryCodes[3].toLowerCase().replace('-', ' ');
      expect(await svc.checkSignInCode(s, typed)).toEqual({ method: 'recovery', recoveryCodesLeft: 9 });
      await expect(svc.checkSignInCode(s, recoveryCodes[3])).rejects.toMatchObject({ code: 'TOTP_INVALID' });
      expect((await totpRepo.getState(s.userId)).recoveryCodesLeft).toBe(9);
    });

    it('of three racing uses of one code, exactly one wins', async () => {
      const s = await staff();
      const { recoveryCodes } = await enrolled(s);
      const results = await settled([0, 1, 2].map(() => svc.checkSignInCode(s, recoveryCodes[0])));
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect((await totpRepo.getState(s.userId)).recoveryCodesLeft).toBe(9);
    });

    it('new codes need a current authenticator code, never a recovery code, and replace the old ones', async () => {
      const s = await staff();
      const { key, recoveryCodes } = await enrolled(s);
      await expect(svc.regenerateRecoveryCodes(s, recoveryCodes[0])).rejects.toMatchObject({ code: 'TOTP_INVALID' });
      expect((await totpRepo.getState(s.userId)).recoveryCodesLeft).toBe(10);
      const { recoveryCodes: fresh } = await svc.regenerateRecoveryCodes(s, svc.totp(key));
      expect(fresh).toHaveLength(10);
      expect(fresh).not.toContain(recoveryCodes[0]);
      await expect(svc.checkSignInCode(s, recoveryCodes[0])).rejects.toMatchObject({ code: 'TOTP_INVALID' });
      expect(await svc.checkSignInCode(s, fresh[0])).toMatchObject({ method: 'recovery', recoveryCodesLeft: 9 });
    });
  });

  // ── Reset ──────────────────────────────────────────────────────────────
  describe('reset', () => {
    it('forgets the authenticator and moves the session cutoff in one transaction', async () => {
      const s = await staff();
      await enrolled(s);
      const before = await getUser(s.userId);
      const out = await svc.resetEnrolment(s.userId);
      expect(out).toEqual({ ok: true, hadAuthenticator: true });
      expect(await rowOf(s.userId)).toBeNull();
      const after = await getUser(s.userId);
      expect(after.sessionsValidFrom).not.toBeNull();
      if (before.sessionsValidFrom) {
        expect(new Date(after.sessionsValidFrom).getTime()).toBeGreaterThan(new Date(before.sessionsValidFrom).getTime());
      }
      // The next sign-in enrols again.
      await enrolled(s);
      expect((await totpRepo.getState(s.userId)).enrolled).toBe(true);
    });

    it('touches nothing for an account that is not STAFF', async () => {
      const userId = newUserId();
      await createUser({ userId, username: `p${userId.slice(-6)}`, mobile: mobile(), accountType: 'PLAYER' });
      expect(await svc.resetEnrolment(userId)).toEqual({ ok: false, hadAuthenticator: false });
      expect((await getUser(userId)).sessionsValidFrom ?? null).toBeNull();
    });

    it('says which accounts are enrolled, never a secret', async () => {
      const a = await staff();
      const b = await staff();
      await enrolled(a);
      await svc.beginEnrolment(b, { issuer: 'T' });           // pending, not enrolled
      const set = await totpRepo.enrolledAmong([a.userId, b.userId, 'nobody']);
      expect([...set]).toEqual([a.userId]);
      expect(Object.keys(await totpRepo.getState(a.userId)).sort())
        .toEqual(['enrolled', 'enrolledAt', 'recoveryCodesLeft', 'recoveryGeneratedAt']);
    });
  });

  // ── The break-glass script ─────────────────────────────────────────────
  describe('scripts/reset-staff-access.mjs', () => {
    it('refuses a weak NEW_STAFF_PASSWORD before anything changes', async () => {
      const s = await staff();
      await enrolled(s);
      const out = await resetStaffAccess({ mobile: s.mobile, newPassword: 'short' });
      expect(out.ok).toBe(false);
      expect(out.reason).toMatch(/Nothing was changed/);
      expect((await totpRepo.getState(s.userId)).enrolled).toBe(true);
    });

    it('resets the authenticator, ends the sessions, replaces the password and records it', async () => {
      const s = await staff();
      await enrolled(s);
      const out = await resetStaffAccess({ mobile: s.mobile, newPassword: 'Break-Glass-Pass-91x!' });
      expect(out).toMatchObject({ ok: true, userId: s.userId, hadAuthenticator: true, passwordChanged: true });
      expect(await rowOf(s.userId)).toBeNull();
      const { rows: [cred] } = await pgQuery('SELECT password_hash FROM users WHERE user_id = $1', [s.userId]);
      expect(cred.password_hash.startsWith('$argon2id$')).toBe(true);
      const { rows: audit } = await pgQuery(
        "SELECT details FROM enhanced_audit_logs WHERE action = 'STAFF_ACCESS_RESET_CLI' AND target_id = $1", [s.userId]);
      expect(audit).toHaveLength(1);
      expect(audit[0].details).toMatchObject({ hadAuthenticator: true, passwordChanged: true });
    });

    it('finds no staff account behind a player\'s mobile', async () => {
      const userId = newUserId();
      const m = mobile();
      await createUser({ userId, username: `p${userId.slice(-6)}`, mobile: m, accountType: 'PLAYER' });
      expect(await resetStaffAccess({ mobile: m })).toMatchObject({ ok: false });
    });
  });
});
