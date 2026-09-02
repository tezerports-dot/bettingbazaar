// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * Revoked tokens and the Aadhaar verification queue, against a REAL PostgreSQL.
 *
 * Two properties carry the weight here. The Aadhaar hash is UNIQUE, so two
 * people cannot register the same number and the database — not a prior lookup —
 * is what decides. And an export is a DISCLOSURE: numbers leave the platform,
 * so who asked, when, and which rows went out in which file has to be
 * reconstructible afterwards, including when two exports run at once.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { pgConfigured, pgQuery, applySchema, closePg } from '../client.js';
import { createUser } from '../repositories/users.js';
import {
  revokeToken, isTokenRevoked,
  getVerification, isAadhaarRegistered, submitVerification, releaseFailedSubmission,
  exportPending, importVerdicts, getBatch, verificationCounts, sweepExpired,
} from '../repositories/identity.js';

const describePg = pgConfigured() ? describe : describe.skip;

const submit = (over = {}) => ({
  userId: 'u-1', aadhaarHash: 'hash-1', aadhaarEncrypted: 'cipher-1',
  aadhaarLast4: '1234', phone: '9990000001', ...over,
});

describePg('identity (PostgreSQL)', () => {
  beforeAll(async () => { await applySchema(); });
  afterAll(async () => { await closePg(); });
  beforeEach(async () => {
    await pgQuery(`TRUNCATE kyc_batches, kyc_verifications, token_blacklist, users
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

  describe('submitting an Aadhaar', () => {
    it('accepts a first submission and reports it pending', async () => {
      const r = await submitVerification(submit());
      expect(r.ok).toBe(true);
      expect(r.verification).toMatchObject({
        userId: 'u-1', aadhaarLast4: '1234', status: 'PENDING_VERIFICATION',
      });
    });

    it('never returns the ciphertext through an ordinary read', async () => {
      await submitVerification(submit({ aadhaarEncrypted: 'AADHAARCIPHER' }));
      expect(JSON.stringify(await getVerification('u-1'))).not.toContain('AADHAARCIPHER');
    });

    it('REFUSES the same Aadhaar under a different account', async () => {
      await submitVerification(submit());
      // The no-duplicate-accounts rule, and the UNIQUE index is what enforces
      // it — not the lookup, which a concurrent signup fits past.
      expect(await submitVerification(submit({ userId: 'u-2', phone: '9990000002' })))
        .toEqual({ ok: false, reason: 'aadhaar_taken' });
    });

    it('treats a resubmission by the same person as a retry, not a duplicate', async () => {
      await submitVerification(submit());
      const again = await submitVerification(submit());
      expect(again).toMatchObject({ ok: true, idempotent: true });
    });

    it('reports a DIFFERENT number from a person who already submitted', async () => {
      await submitVerification(submit());
      expect(await submitVerification(submit({ aadhaarHash: 'hash-other', aadhaarEncrypted: 'c2' })))
        .toEqual({ ok: false, reason: 'user_already_submitted' });
    });

    it('20 concurrent submissions of one number register exactly one', async () => {
      const attempts = Array.from({ length: 20 }, (_, i) =>
        submitVerification(submit({ userId: `u-${(i % 4) + 1}`, phone: `9990000${i}` }))
          .catch(() => ({ ok: false })));
      await Promise.all(attempts);
      const { rows } = await pgQuery(
        `SELECT count(*)::int AS n FROM kyc_verifications WHERE aadhaar_hash = 'hash-1'`);
      expect(rows[0].n).toBe(1);
    });

    it('answers "is this registered" from the hash alone', async () => {
      expect(await isAadhaarRegistered('hash-1')).toBe(false);
      await submitVerification(submit());
      expect(await isAadhaarRegistered('hash-1')).toBe(true);
    });
  });

  describe('releasing a FAILED submission', () => {
    it('frees the number so its real owner is not locked out for ever', async () => {
      await submitVerification(submit());
      await importVerdicts({ batchId: 'b1', verdicts: [{ userId: 'u-1', verified: false, reason: 'mismatch' }] });

      // The whole point: a mistyped digit otherwise parks a STRANGER's Aadhaar
      // in a unique index and permanently blocks the person it belongs to.
      expect(await releaseFailedSubmission('u-1')).toBe(true);
      expect(await isAadhaarRegistered('hash-1')).toBe(false);
      expect(await submitVerification(submit({ userId: 'u-2', phone: '9990000002' })))
        .toMatchObject({ ok: true });
    });

    it('REFUSES to release a pending or verified row', async () => {
      await submitVerification(submit());
      expect(await releaseFailedSubmission('u-1')).toBe(false);   // pending
      await importVerdicts({ batchId: 'b1', verdicts: [{ userId: 'u-1', verified: true }] });
      expect(await releaseFailedSubmission('u-1')).toBe(false);   // verified
      expect(await isAadhaarRegistered('hash-1')).toBe(true);
    });
  });

  describe('exporting — a disclosure, not a query', () => {
    beforeEach(async () => {
      for (let i = 1; i <= 4; i += 1) {
        await submitVerification(submit({
          userId: `u-${i}`, aadhaarHash: `hash-${i}`, aadhaarEncrypted: `cipher-${i}`,
          phone: `99900000${i}`,
        }));
      }
    });

    it('returns the ciphertext and stamps the batch on the rows it disclosed', async () => {
      const rows = await exportPending({ batchId: 'exp-1', limit: 2, actorId: 'admin-1' });
      expect(rows).toHaveLength(2);
      expect(rows[0].aadhaarEncrypted).toMatch(/^cipher-/);
      // Traceability: a disputed result is reconstructed from which file a row
      // went out in, so the stamp and the disclosure are one statement.
      expect((await getVerification(rows[0].userId)).exportBatchId).toBe('exp-1');
    });

    it('records who asked, when, and how many rows left', async () => {
      await exportPending({ batchId: 'exp-1', limit: 3, actorId: 'admin-1', note: 'weekly' });
      expect(await getBatch('exp-1')).toMatchObject({
        kind: 'EXPORT', actorId: 'admin-1', rowCount: 3, note: 'weekly',
      });
    });

    it('does not re-export a row that has already gone out', async () => {
      await exportPending({ batchId: 'exp-1', limit: 2 });
      const second = await exportPending({ batchId: 'exp-2', limit: 10 });
      expect(second).toHaveLength(2);
      expect(second.map((r) => r.userId).sort()).toEqual(['u-3', 'u-4']);
    });

    it('two concurrent exports never disclose one Aadhaar in both files', async () => {
      const [a, b] = await Promise.all([
        exportPending({ batchId: 'exp-a', limit: 4 }),
        exportPending({ batchId: 'exp-b', limit: 4 }),
      ]);
      const ids = [...a, ...b].map((r) => r.userId);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids).toHaveLength(4);
    });
  });

  describe('importing verdicts', () => {
    beforeEach(async () => {
      for (let i = 1; i <= 3; i += 1) {
        await submitVerification(submit({
          userId: `u-${i}`, aadhaarHash: `hash-${i}`, aadhaarEncrypted: `c-${i}`,
          phone: `99900000${i}`,
        }));
      }
    });

    it('applies BOTH verdicts — the failed half is not optional', async () => {
      // Applying only the VERIFIED half leaves a player whose number did not
      // check out at PENDING for ever: never able to withdraw, never told why,
      // and absent from the queue because the batch says it handled them.
      const r = await importVerdicts({
        batchId: 'imp-1',
        verdicts: [
          { userId: 'u-1', verified: true },
          { userId: 'u-2', verified: false, reason: 'name mismatch' },
        ],
      });
      expect(r).toMatchObject({ verifiedCount: 1, failedCount: 1, skipped: 0 });
      expect((await getVerification('u-1')).status).toBe('VERIFIED');
      expect(await getVerification('u-2')).toMatchObject({
        status: 'FAILED', failureReason: 'name mismatch',
      });
    });

    it('carries the verifier\'s reason verbatim, so support need not guess', async () => {
      await importVerdicts({
        batchId: 'imp-1',
        verdicts: [{ userId: 'u-1', verified: false, reason: 'DOB does not match UIDAI record' }],
      });
      expect((await getVerification('u-1')).failureReason).toBe('DOB does not match UIDAI record');
    });

    it('counts what it actually changed, not what it was handed', async () => {
      await importVerdicts({ batchId: 'imp-1', verdicts: [{ userId: 'u-1', verified: true }] });
      // u-1 is already VERIFIED and u-404 does not exist: both are SKIPPED, and
      // the count is reconstructed from the rows the statements touched rather
      // than accumulated from the input length.
      const r = await importVerdicts({
        batchId: 'imp-2',
        verdicts: [
          { userId: 'u-1', verified: true },
          { userId: 'u-404', verified: true },
          { userId: 'u-2', verified: true },
        ],
      });
      expect(r).toMatchObject({ verifiedCount: 1, skipped: 2 });
      expect(await getBatch('imp-2')).toMatchObject({ rowCount: 3, verifiedCount: 1, skippedCount: 2 });
    });

    it('reports the queue from rows, never an accumulator', async () => {
      await importVerdicts({
        batchId: 'imp-1',
        verdicts: [{ userId: 'u-1', verified: true }, { userId: 'u-2', verified: false, reason: 'x' }],
      });
      expect(await verificationCounts()).toEqual({
        PENDING_VERIFICATION: 1, VERIFIED: 1, FAILED: 1,
      });
    });

    it('rolls the whole import back when one verdict fails', async () => {
      await expect(importVerdicts({
        batchId: 'imp-1',
        verdicts: [{ userId: 'u-1', verified: true }, { userId: null, verified: false }],
      })).rejects.toThrow();
      // A half-applied import is a batch record that disagrees with the rows.
      expect((await getVerification('u-1')).status).toBe('PENDING_VERIFICATION');
      expect(await getBatch('imp-1')).toBeNull();
    });
  });
});
