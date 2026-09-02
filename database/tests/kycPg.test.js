// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * KYC — domain 11, the last one, and the only one whose registry entry read
 * `concurrencyTested: false`. This suite is what changes that.
 *
 * The invariants:
 *   • a decision names the statuses it accepts, and the guard is in the
 *     UPDATE's WHERE — two reviewers acting at once produce ONE decision
 *   • a rejection cannot exist without the reason the user is shown
 *   • an approval cannot exist without the reviewer who made it
 *   • the history is append-only, so "was this user ever rejected, and why?"
 *     survives a resubmission
 *   • concurrency does not deadlock or exhaust the connection pool
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { pgConfigured, pgQuery, applySchema, closePg, getPool } from '../client.js';
import {
  KYC_STATES, KYC_ALLOWED_FROM, KYC_REVISITABLE, openKyc, transitionKyc, getKyc, getKycHistory,
  submitKyc, approveKyc, rejectKyc,
  findApprovalsMissingReviewer, findRejectionsMissingReason,
} from '../repositories/kyc.core.js';

// In CI Postgres is always provisioned, so a skip there reports green for a
// check nobody ran.
if (process.env.CI && !pgConfigured()) {
  throw new Error('kycPg.test.js: DATABASE_URL is unset in CI — this suite must not skip silently.');
}
const describePg = pgConfigured() ? describe : describe.skip;

/** A user sitting at PENDING_APPROVAL, the position a decision is taken from. */
async function awaitingReview(id) {
  await openKyc({ userId: id });
  await submitKyc({ userId: id, set: { nameOnPan: 'A PERSON', panNumber: 'ABCDE1234F' } });
}

describePg('KYC decisions (PostgreSQL state machine)', () => {
  beforeAll(async () => { await applySchema(); });
  afterAll(async () => { await closePg(); });
  beforeEach(async () => {
    await pgQuery('TRUNCATE kyc_transitions, user_kyc RESTART IDENTITY CASCADE');
  });

  describe('the lifecycle', () => {
    it('walks submission → review → approval and records every step', async () => {
      await awaitingReview('u1');
      const done = await approveKyc({ userId: 'u1', actor: 'admin-7' });
      expect(done).toMatchObject({ ok: true, idempotent: false });

      const kyc = await getKyc('u1');
      expect(kyc.status).toBe(KYC_STATES.APPROVED);
      expect(kyc.reviewedBy).toBe('admin-7');
      expect(kyc.reviewedAt).toBeTruthy();

      expect((await getKycHistory('u1')).map((h) => [h.from, h.to])).toEqual([
        ['PENDING_SUBMISSION', 'PENDING_APPROVAL'],
        ['PENDING_APPROVAL', 'APPROVED'],
      ]);
    });

    it('opens idempotently — a retried registration does not un-approve anyone', async () => {
      await awaitingReview('u2');
      await approveKyc({ userId: 'u2', actor: 'admin-1' });
      const second = await openKyc({ userId: 'u2' });
      expect(second).toMatchObject({ ok: true, idempotent: true });
      expect((await getKyc('u2')).status).toBe(KYC_STATES.APPROVED);
    });

    it('refuses a decision from the wrong status and says what it would accept', async () => {
      await openKyc({ userId: 'u3' });                 // still PENDING_SUBMISSION
      const early = await approveKyc({ userId: 'u3', actor: 'admin-1' });
      expect(early).toMatchObject({
        ok: false, reason: 'invalid_transition', status: KYC_STATES.PENDING_SUBMISSION,
      });
      expect(early.allowedFrom).toEqual([KYC_STATES.PENDING_APPROVAL]);
      expect((await getKyc('u3')).status).toBe(KYC_STATES.PENDING_SUBMISSION);
    });

    it('distinguishes an unknown user from a wrong-status one', async () => {
      expect(await approveKyc({ userId: 'nobody', actor: 'a' }))
        .toEqual({ ok: false, reason: 'not_found' });
    });

    it('has no way to un-approve — that is a compliance action, not a transition', async () => {
      // Revoking an approval needs its own record. A state change back would
      // let an approval be erased rather than reversed.
      expect(KYC_ALLOWED_FROM[KYC_STATES.PENDING_APPROVAL]).not.toContain(KYC_STATES.APPROVED);
      await awaitingReview('u4');
      await approveKyc({ userId: 'u4', actor: 'admin-1' });
      expect(await rejectKyc({ userId: 'u4', actor: 'admin-2', reason: 'changed my mind' }))
        .toMatchObject({ ok: false, reason: 'invalid_transition', status: KYC_STATES.APPROVED });
    });

    it('cannot be forced into an unknown status', async () => {
      await openKyc({ userId: 'u5' });
      await expect(transitionKyc({ userId: 'u5', to: 'PROBABLY_FINE' }))
        .rejects.toThrow(/Unknown KYC status/);
      await expect(transitionKyc({ userId: 'u5', to: KYC_STATES.PENDING_SUBMISSION }))
        .rejects.toThrow(/they do not move there/);
    });
  });

  // ── The defects this domain exists to remove ─────────────────────────────

  describe('the column authorisation actually reads', () => {
    // ── The defect this pins ─────────────────────────────────────────────────
    // `user_kyc` OWNS the decision, but every gate in the app — deposit,
    // withdrawal, bet placement — checks `users.kyc_status`. Nothing wrote that
    // copy. So an admin could approve somebody, `user_kyc` would say APPROVED,
    // and the player would still be refused a withdrawal — two tables
    // disagreeing with neither obviously wrong.
    //
    // `setKycStatus` existed and DEMANDED a transaction client precisely
    // because a denormalised copy is only safe when written alongside the
    // original. It had no caller passing one. It has one now, inside
    // `transitionKyc`.
    const player = async (id) => {
      await pgQuery(
        `INSERT INTO users (user_id, username, mobile) VALUES ($1, $2, $3)
         ON CONFLICT (user_id) DO NOTHING`,
        [id, `Player ${id}`, `9${String(Date.now()).slice(-6)}${String(Math.random()).slice(2, 5)}`],
      );
      await awaitingReview(id);
    };

    it('moves users.kyc_status with the decision', async () => {
      await player('kyc-col-1');
      expect((await pgQuery('SELECT kyc_status FROM users WHERE user_id = $1', ['kyc-col-1']))
        .rows[0].kyc_status).toBe(KYC_STATES.PENDING_APPROVAL);

      await approveKyc({ userId: 'kyc-col-1', actor: 'admin-7' });

      expect((await getKyc('kyc-col-1')).status).toBe(KYC_STATES.APPROVED);
      expect((await pgQuery('SELECT kyc_status FROM users WHERE user_id = $1', ['kyc-col-1']))
        .rows[0].kyc_status).toBe(KYC_STATES.APPROVED);
    });

    it('moves it on a rejection too', async () => {
      await player('kyc-col-2');
      await rejectKyc({ userId: 'kyc-col-2', actor: 'admin-7', reason: 'Document unreadable' });
      expect((await pgQuery('SELECT kyc_status FROM users WHERE user_id = $1', ['kyc-col-2']))
        .rows[0].kyc_status).toBe(KYC_STATES.REJECTED);
    });

    it('does not move it when the decision is refused', async () => {
      await player('kyc-col-3');
      await approveKyc({ userId: 'kyc-col-3', actor: 'admin-7' });

      // APPROVED → REJECTED is not a legal move. The copy must not drift ahead
      // of a decision the state machine never made.
      const refused = await rejectKyc({ userId: 'kyc-col-3', actor: 'admin-9', reason: 'changed my mind' });
      expect(refused.ok).toBe(false);
      expect((await pgQuery('SELECT kyc_status FROM users WHERE user_id = $1', ['kyc-col-3']))
        .rows[0].kyc_status).toBe(KYC_STATES.APPROVED);
    });
  });

  describe('a decision carries the facts that justify it', () => {
    it('REFUSES a rejection with no reason', async () => {
      // The Mongo route assigns the reason to `user.kyc.rejectionReason`, and
      // the User schema has no `kyc` subdocument — only `kycData` — so the
      // guarded block never runs and every rejected user is told they were
      // rejected and never told why. Here it is not representable.
      await awaitingReview('r1');
      await expect(rejectKyc({ userId: 'r1', actor: 'admin-1' }))
        .rejects.toThrow(/requires a reason/);
      await expect(rejectKyc({ userId: 'r1', actor: 'admin-1', reason: '   ' }))
        .rejects.toThrow(/requires a reason/);
      // And nothing moved.
      expect((await getKyc('r1')).status).toBe(KYC_STATES.PENDING_APPROVAL);
    });

    it('writes the reason in the SAME statement as the status', async () => {
      await awaitingReview('r2');
      await rejectKyc({ userId: 'r2', actor: 'admin-1', reason: 'PAN photo unreadable' });
      const kyc = await getKyc('r2');
      // No window in which the user is REJECTED and the reason is not there yet.
      expect(kyc).toMatchObject({
        status: KYC_STATES.REJECTED,
        rejectionReason: 'PAN photo unreadable',
        reviewedBy: 'admin-1',
      });
    });

    it('clears a stale rejection reason when the user is later approved', async () => {
      // Otherwise an approved user carries the reason they were once refused,
      // and the panel that shows it to rejected users would show it to them.
      await awaitingReview('r3');
      await rejectKyc({ userId: 'r3', actor: 'admin-1', reason: 'blurry' });
      await submitKyc({ userId: 'r3', txId: 'r3_resubmit_2' });
      await approveKyc({ userId: 'r3', actor: 'admin-2' });
      expect(await getKyc('r3')).toMatchObject({
        status: KYC_STATES.APPROVED, rejectionReason: null,
      });
    });

    it('reports approvals with no reviewer, and rejections with no reason', async () => {
      // Both gap checks. On the Mongo path EVERY approval is anonymous, so
      // these are the queries that make that visible after a backfill.
      await pgQuery(
        `INSERT INTO user_kyc (user_id, kyc_status) VALUES ('ghost1','APPROVED'), ('ghost2','REJECTED')`);
      expect((await findApprovalsMissingReviewer()).map((r) => r.userId)).toEqual(['ghost1']);
      expect(await findRejectionsMissingReason()).toEqual(['ghost2']);

      // A decision taken through this module produces neither.
      await awaitingReview('clean');
      await approveKyc({ userId: 'clean', actor: 'admin-1' });
      expect((await findApprovalsMissingReviewer()).map((r) => r.userId)).not.toContain('clean');
    });
  });

  // ── Resubmission: the cycle ──────────────────────────────────────────────

  describe('resubmission after a rejection', () => {
    it('names exactly the statuses a user can reach more than once', () => {
      expect([...KYC_REVISITABLE].sort()).toEqual(['PENDING_APPROVAL', 'REJECTED']);
    });

    it('refuses a repeat visit that brings no key, rather than swallowing it', async () => {
      await awaitingReview('rs1');
      await rejectKyc({ userId: 'rs1', actor: 'admin-1', reason: 'blurry' });
      // Second time at PENDING_APPROVAL: the default key is taken, and colliding
      // with it would report the resubmission as "already done" — the user would
      // stay REJECTED with no error anywhere.
      await expect(submitKyc({ userId: 'rs1' })).rejects.toThrow(/requires an explicit txId/);
      expect((await getKyc('rs1')).status).toBe(KYC_STATES.REJECTED);
    });

    it('lets a rejected user resubmit and be approved, keeping both decisions', async () => {
      await awaitingReview('rs2');
      await rejectKyc({ userId: 'rs2', actor: 'admin-1', reason: 'PAN blurry' });
      await submitKyc({ userId: 'rs2', txId: 'rs2_resubmit_2' });
      await approveKyc({ userId: 'rs2', actor: 'admin-2' });

      expect((await getKyc('rs2')).status).toBe(KYC_STATES.APPROVED);
      // The rejection SURVIVES the approval. This is the compliance question a
      // single status field cannot answer once it is overwritten.
      const history = await getKycHistory('rs2');
      expect(history.map((h) => h.to)).toEqual(['PENDING_APPROVAL', 'REJECTED', 'PENDING_APPROVAL', 'APPROVED']);
      expect(history[1]).toMatchObject({ reason: 'PAN blurry', actor: 'admin-1' });
    });

    it('keeps the history append-only against direct SQL', async () => {
      await awaitingReview('rs3');
      await approveKyc({ userId: 'rs3', actor: 'admin-1' });
      await expect(pgQuery(`UPDATE kyc_transitions SET actor = 'someone else' WHERE user_id = 'rs3'`))
        .rejects.toThrow();
      await expect(pgQuery(`DELETE FROM kyc_transitions WHERE user_id = 'rs3'`)).rejects.toThrow();
    });
  });

  // ── Concurrency: what `concurrencyTested` actually asserts ───────────────

  describe('concurrency', () => {
    it('lets exactly ONE of a racing approve and reject win', async () => {
      // The defect in one line: the Mongo route reads the user, assigns the
      // status and saves. Two reviewers deciding at once both pass the read and
      // the last save wins, with no record that the other decision happened.
      await awaitingReview('c1');
      const [approved, rejected] = await Promise.all([
        approveKyc({ userId: 'c1', actor: 'admin-1' }),
        rejectKyc({ userId: 'c1', actor: 'admin-2', reason: 'not satisfied' }),
      ]);

      const winners = [approved, rejected].filter((r) => r.ok && !r.idempotent);
      expect(winners).toHaveLength(1);

      const kyc = await getKyc('c1');
      const decisions = (await getKycHistory('c1')).filter((h) => h.to !== KYC_STATES.PENDING_APPROVAL);
      expect(decisions).toHaveLength(1);
      // And the record matches whichever won — not a mixture of the two.
      expect(kyc.status).toBe(decisions[0].to);
      if (kyc.status === KYC_STATES.REJECTED) {
        expect(kyc.rejectionReason).toBe('not satisfied');
        expect(kyc.reviewedBy).toBe('admin-2');
      } else {
        expect(kyc.reviewedBy).toBe('admin-1');
      }
    });

    it('survives a 100-copy storm of one approval, applying it once', async () => {
      await awaitingReview('c2');
      const results = await Promise.all(
        Array.from({ length: 100 }, () => approveKyc({ userId: 'c2', actor: 'admin-1' })));

      expect(results.every((r) => r.ok)).toBe(true);
      expect(results.filter((r) => !r.idempotent)).toHaveLength(1);
      const { rows } = await pgQuery(
        `SELECT COUNT(*)::int n FROM kyc_transitions WHERE user_id='c2' AND to_status='APPROVED'`);
      expect(rows[0].n).toBe(1);
    });

    it('decides 60 users at once without deadlocking or exhausting the pool', async () => {
      const ids = Array.from({ length: 60 }, (_, i) => `c3_${i}`);
      for (const id of ids) await awaitingReview(id);

      await Promise.all(ids.map((id, i) => (i % 2
        ? approveKyc({ userId: id, actor: 'admin-1' })
        : rejectKyc({ userId: id, actor: 'admin-2', reason: 'documents incomplete' }))));

      const pool = await getPool();
      // A caller that held two pooled connections at once would queue here.
      expect(pool.waitingCount).toBe(0);
      const { rows } = await pgQuery(
        `SELECT kyc_status, COUNT(*)::int n FROM user_kyc WHERE user_id LIKE 'c3_%' GROUP BY kyc_status`);
      const byStatus = Object.fromEntries(rows.map((r) => [r.kyc_status, r.n]));
      expect(byStatus.APPROVED).toBe(30);
      expect(byStatus.REJECTED).toBe(30);
      // Every rejection carries its reason — none was lost under contention.
      expect(await findRejectionsMissingReason()).toEqual([]);
    });

    it('lets exactly one of a racing resubmission storm through', async () => {
      // The repeat-visit key under contention: 40 copies of one resubmission
      // must produce ONE new PENDING_APPROVAL, not forty.
      await awaitingReview('c4');
      await rejectKyc({ userId: 'c4', actor: 'admin-1', reason: 'blurry' });

      const results = await Promise.all(Array.from({ length: 40 }, () =>
        submitKyc({ userId: 'c4', txId: 'c4_resubmit_2' })));
      expect(results.every((r) => r.ok)).toBe(true);
      expect(results.filter((r) => !r.idempotent)).toHaveLength(1);

      const { rows } = await pgQuery(
        `SELECT COUNT(*)::int n FROM kyc_transitions WHERE user_id='c4' AND to_status='PENDING_APPROVAL'`);
      expect(rows[0].n).toBe(2);   // the original submission and one resubmission
    });
  });
});
