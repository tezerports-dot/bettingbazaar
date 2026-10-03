// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Revoked tokens and the signup writer, against a REAL PostgreSQL.
 *
 * The Aadhaar verification queue this file used to cover was removed with KYC
 * (owner, 2026-10-02). What remains carries one property worth a database:
 * the unique index on `(mobile, account_type)` — not a prior lookup — decides
 * that one mobile holds one PLAYER account, including when two signups race.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { pgConfigured, pgQuery, applySchema, closePg } from '../client.js';
import { createUser } from '../repositories/users.js';
import {
  revokeToken, isTokenRevoked, sweepExpired, createAccountFromSignup,
} from '../repositories/identity.js';

const describePg = pgConfigured() ? describe : describe.skip;

describePg('identity (PostgreSQL)', () => {
  beforeAll(async () => { await applySchema(); });
  afterAll(async () => { await closePg(); });
  beforeEach(async () => {
    await pgQuery(`TRUNCATE token_blacklist, users
                   RESTART IDENTITY CASCADE`);
    for (let i = 1; i <= 4; i += 1) {
      await createUser({ userId: `u-${i}`, username: `u${i}`, mobile: `99900000${i}` });
    }
  });

  describe('revoked tokens', () => {
    it('revokes and reports', async () => {
      expect(await isTokenRevoked('t1')).toBe(false);
      await revokeToken('t1');
      expect(await isTokenRevoked('t1')).toBe(true);
    });

    it('is idempotent — a retried sign-out must not fail', async () => {
      await revokeToken('t1');
      await expect(revokeToken('t1')).resolves.toBeUndefined();
      expect(await isTokenRevoked('t1')).toBe(true);
    });

    it('stops reporting an EXPIRED revocation before any sweep runs', async () => {
      await revokeToken('t1', { ttlSeconds: 1 });
      await pgQuery(`UPDATE token_blacklist SET expires_at = now() - interval '1 second'`);
      // The row is still present. The READ is what decides, so a late sweep
      // cannot make a live token look revoked or a revoked one look live.
      const { rows } = await pgQuery('SELECT count(*)::int AS n FROM token_blacklist');
      expect(rows[0].n).toBe(1);
      expect(await isTokenRevoked('t1')).toBe(false);
    });

    it('sweeps only what has expired', async () => {
      await revokeToken('live');
      await revokeToken('dead');
      await pgQuery(`UPDATE token_blacklist SET expires_at = now() - interval '1 s' WHERE token='dead'`);
      expect(await sweepExpired()).toEqual({ revokedTokens: 1 });
      expect(await isTokenRevoked('live')).toBe(true);
    });
  });

  describe('creating an account from the signup form', () => {
    const signup = (over = {}) => ({
      userId: 's-1', username: 's1', mobile: '9880000001', passwordHash: 'h', ...over,
    });

    it('writes an ACTIVE PLAYER row with no KYC field at all', async () => {
      expect(await createAccountFromSignup(signup())).toEqual({ ok: true, userId: 's-1' });
      const { rows } = await pgQuery(`SELECT status, account_type FROM users WHERE user_id = 's-1'`);
      expect(rows[0]).toEqual({ status: 'ACTIVE', account_type: 'PLAYER' });
      const cols = await pgQuery(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'users' AND column_name LIKE '%kyc%'`);
      expect(cols.rows).toEqual([]);
    });

    it('refuses a second PLAYER on one mobile', async () => {
      await createAccountFromSignup(signup());
      expect(await createAccountFromSignup(signup({ userId: 's-2', username: 's2' })))
        .toEqual({ ok: false, reason: 'mobile_taken' });
    });

    it('does NOT refuse a player whose mobile a STAFF account also holds (§33.5)', async () => {
      await createUser({ userId: 'st-1', username: 'st1', mobile: '9880000001', accountType: 'STAFF' });
      expect(await createAccountFromSignup(signup())).toEqual({ ok: true, userId: 's-1' });
    });

    it('20 concurrent signups on one mobile create exactly one account', async () => {
      const results = await Promise.all(Array.from({ length: 20 }, (_, i) =>
        createAccountFromSignup(signup({ userId: `race-${i}`, username: `race${i}` }))));
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      const { rows } = await pgQuery(
        `SELECT count(*)::int AS n FROM users WHERE mobile = '9880000001' AND account_type = 'PLAYER'`);
      expect(rows[0].n).toBe(1);
    });
  });
});
