// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * Domains 6 and 8 ACROSS BOTH STORES — the suite that decides whether
 * `reconciled` and `rollback` may be claimed for settlements and bonuses.
 *
 * The Postgres-only suite proves the mirrors write the right rows. It cannot
 * prove the two halves that need Mongo, and those are the ones the capability
 * flags actually assert:
 *
 *   reconciled  Given the same event, do the stores AGREE — and when they do
 *               not, does the reconciler say so instead of reporting clean?
 *   rollback    Can Mongo be brought back up to date from Postgres, so a
 *               fallback is a redeploy rather than a data recovery?
 *
 * Every domain that got a suite like this found a real bug — M-6 and M-8 both
 * surfaced this way, each on a path that read as obviously correct and had
 * never once worked. That is the reason this exists rather than a claim in a
 * registry note.
 *
 * REQUIRES MongoDB (a replica set) + PostgreSQL. CI-only; the sandbox can run
 * neither mongod nor the reverse direction.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import mongoose from 'mongoose';
import '../../models/index.js';
import { pgConfigured, pgQuery, applySchema, closePg } from '../../postgres/pgClient.js';
import { mirrorCycleSettlement, mirrorBonusGrant } from '../../postgres/dualWrite.js';
import {
  reverseMirrorCycleSettlement, reverseMirrorBonusGrant,
} from '../../postgres/reverseMirror.js';
import { reconcileCycleSettlements, reconcileBonusGrants } from '../../postgres/reconcile.js';
import { getCycleSettlement } from '../../postgres/settlementPg.js';

const HAS_PG = !!process.env.DATABASE_URL;
const d = HAS_PG ? describe : describe.skip;

const Cycle = () => mongoose.model('Cycle');
const BonusRecord = () => mongoose.model('BonusRecord');

/**
 * The settling window exists so a mirror that is milliseconds behind is not
 * called drift. It is a delay, not an exemption — but a test that waits 30s per
 * assertion proves nothing extra, so it is switched off here and the window's
 * own behaviour is covered by its own tests.
 */
beforeAll(() => { process.env.RECONCILE_SETTLING_WINDOW_MS = '0'; });

/** A Cycle needs more than the settlement fields to satisfy its schema. */
const cycle = (over = {}) => Cycle().create({
  cycleId: 'xs_c1', type: '30_MIN', startTime: Date.now(), endTime: Date.now() + 60_000,
  status: 'RESULT_DECLARED', winner: 'DELHI', isSettled: 'PENDING', ...over,
});

d('domains 6 and 8 across MongoDB and PostgreSQL', () => {
  beforeAll(async () => { await applySchema(); });
  afterAll(async () => {
    delete process.env.RECONCILE_SETTLING_WINDOW_MS;
    await closePg();
  });

  beforeEach(async () => {
    await pgQuery(`DELETE FROM cycle_settlements WHERE cycle_id LIKE 'xs_%'`);
    await pgQuery(`DELETE FROM bonus_grants WHERE grant_id LIKE 'bg_%' OR grant_id LIKE 'xs_%'`);
    await Cycle().deleteMany({ cycleId: /^xs_/ });
    await BonusRecord().deleteMany({});
  });

  // ── reconciled: the stores agree, and disagreement is reported ────────────

  describe('reconcile (domain 6)', () => {
    it('reports clean when the mirror kept up', async () => {
      const c = await cycle({ isSettled: 'COMPLETED', settledAt: new Date(), totalPaidOut: 250.5 });
      await mirrorCycleSettlement(c);

      const r = await reconcileCycleSettlements();
      expect(r.checked).toBeGreaterThan(0);
      expect(r.disagreeing).toBe(0);
    });

    it('catches a payout total that drifted apart', async () => {
      const c = await cycle({ isSettled: 'COMPLETED', settledAt: new Date(), totalPaidOut: 100 });
      await mirrorCycleSettlement(c);
      // Mongo now says a different number. This is the check's whole reason for
      // existing: Mongo re-derives its total from the stamped WON bets and
      // Postgres accumulates it per settled bet, so the two are reached
      // independently and a mismatch is a real statement about money.
      await Cycle().updateOne({ cycleId: 'xs_c1' }, { $set: { totalPaidOut: 175 } });

      const r = await reconcileCycleSettlements();
      expect(r.disagreeing).toBe(1);
      expect(r.sample[0]).toMatchObject({
        cycleId: 'xs_c1', mongoPayoutPaise: 17500, pgPayoutPaise: 10000, driftPaise: 7500,
      });
    });

    it('catches a run Mongo thinks is still processing', async () => {
      const c = await cycle({ isSettled: 'COMPLETED', settledAt: new Date(), totalPaidOut: 10 });
      await mirrorCycleSettlement(c);
      await Cycle().updateOne({ cycleId: 'xs_c1' }, { $set: { isSettled: 'PROCESSING' } });

      // This one decides whether payoutRecoveryTask picks the cycle up and
      // re-runs a payout that already finished.
      const r = await reconcileCycleSettlements();
      expect(r.sample[0]).toMatchObject({ mongoStatus: 'PROCESSING', pgStatus: 'COMPLETED' });
    });

    it('--backfill repairs Postgres from Mongo', async () => {
      const c = await cycle({ isSettled: 'COMPLETED', settledAt: new Date(), totalPaidOut: 100 });
      await mirrorCycleSettlement(c);
      await Cycle().updateOne({ cycleId: 'xs_c1' }, { $set: { totalPaidOut: 175 } });

      const r = await reconcileCycleSettlements({ backfill: true });
      expect(r.repaired).toBe(1);
      expect((await getCycleSettlement('xs_c1')).payoutPaise).toBe(17500);
      // And the next pass is clean, which is what makes it a repair rather
      // than a report.
      expect((await reconcileCycleSettlements()).disagreeing).toBe(0);
    });

    it('does not report a cycle Postgres has never settled', async () => {
      await cycle({ isSettled: 'PENDING' });
      // No run exists. Reporting it here would double-count the table check's
      // finding and make a clean report impossible to recognise.
      expect((await reconcileCycleSettlements()).disagreeing).toBe(0);
    });
  });

  describe('reconcile (domain 8)', () => {
    it('reports clean when a grant mirrored faithfully', async () => {
      const rec = await BonusRecord().create({
        userId: new mongoose.Types.ObjectId(), type: 'GIFT_CODE', amount: 40, refId: 'X40',
      });
      await mirrorBonusGrant(rec);

      expect((await reconcileBonusGrants()).disagreeing).toBe(0);
    });

    it('catches a grant whose amounts disagree, and repairs Postgres', async () => {
      const rec = await BonusRecord().create({
        userId: new mongoose.Types.ObjectId(), type: 'GIFT_CODE', amount: 40,
      });
      await mirrorBonusGrant(rec);
      await pgQuery(`UPDATE bonus_grants SET amount_paise = 9999 WHERE grant_id = $1`, [`bg_${rec._id}`]);

      const before = await reconcileBonusGrants();
      expect(before.disagreeing).toBe(1);
      expect(before.sample[0]).toMatchObject({ mongoPaise: 4000, pgPaise: 9999 });

      // The forward repair is an explicit UPDATE, NOT a re-run of the mirror:
      // the mirror is INSERT … ON CONFLICT DO NOTHING, so re-running it would
      // change nothing and report a repair that did not happen.
      const after = await reconcileBonusGrants({ backfill: true });
      expect(after.repaired).toBe(1);
      expect((await reconcileBonusGrants()).disagreeing).toBe(0);
    });

    it('ignores a grant born in Postgres', async () => {
      await pgQuery(
        `INSERT INTO bonus_grants (grant_id, user_id, kind, pool, amount_paise, status)
         VALUES ('xs_native', 'u1', 'PROMO', 'BONUS_POOL', 500, 'PAID')`);
      // It has no Mongo counterpart by definition. Counting it as drift would
      // report the cutover itself as a fault.
      expect((await reconcileBonusGrants()).disagreeing).toBe(0);
    });
  });

  // ── rollback: Mongo can be rebuilt from Postgres ──────────────────────────

  describe('reverse mirror (domain 6)', () => {
    it('brings a stale cycle back up to date', async () => {
      await cycle({ isSettled: 'PROCESSING', totalPaidOut: 0 });

      await reverseMirrorCycleSettlement({
        cycle_id: 'xs_c1', status: 'COMPLETED', payout_paise: 42150,
        completed_at: new Date('2026-08-01T00:00:00Z'), updated_at: new Date(),
      });

      const c = await Cycle().findOne({ cycleId: 'xs_c1' }).lean();
      expect(c.isSettled).toBe('COMPLETED');
      // Paise became rupees at the boundary, in the one direction the float
      // representation is allowed to reappear.
      expect(c.totalPaidOut).toBe(421.5);
      expect(c.settledAt).toBeTruthy();
    });

    it('writes VOIDED, so a voided cycle is not swept back into a payout', async () => {
      await cycle({ isSettled: 'PROCESSING' });
      await reverseMirrorCycleSettlement({
        cycle_id: 'xs_c1', status: 'VOIDED', payout_paise: 0, updated_at: new Date(),
      });

      const c = await Cycle().findOne({ cycleId: 'xs_c1' }).lean();
      // Mongo's enum has no VOIDED and updateOne does not run validators, which
      // is deliberate. Leaving it PROCESSING is the dangerous alternative:
      // payoutRecoveryTask sweeps every PROCESSING cycle, so a fallback would
      // resurrect the payout of a cycle that was deliberately voided.
      expect(c.isSettled).toBe('VOIDED');
      expect(await Cycle().countDocuments({ isSettled: 'PROCESSING' })).toBe(0);
    });

    it('does not conjure a Cycle that never existed', async () => {
      await reverseMirrorCycleSettlement({
        cycle_id: 'xs_ghost', status: 'COMPLETED', payout_paise: 100, updated_at: new Date(),
      });
      // A Cycle with no type, no start time and no pools is one the engine
      // would then try to run.
      expect(await Cycle().findOne({ cycleId: 'xs_ghost' }).lean()).toBeNull();
    });
  });

  describe('reverse mirror (domain 8)', () => {
    it('recreates a Postgres-born grant exactly once, however often it runs', async () => {
      const row = {
        grant_id: 'xs_native2', user_id: String(new mongoose.Types.ObjectId()),
        kind: 'PROMO', pool: 'BONUS_POOL', amount_paise: 2500, status: 'PAID',
        granted_at: new Date(), updated_at: new Date(),
      };

      await reverseMirrorBonusGrant(row);
      await reverseMirrorBonusGrant(row);
      await reverseMirrorBonusGrant(row);

      // THE regression this guards. Keying the upsert on a freshly minted
      // ObjectId would match nothing on every pass, so each reconcile run would
      // add another copy of the same grant.
      const found = await BonusRecord().find({ refId: 'grant:xs_native2' }).lean();
      expect(found).toHaveLength(1);
      expect(found[0].amount).toBe(25);
    });

    it('records a clawback as its own negative row, leaving the grant intact', async () => {
      const row = {
        grant_id: 'xs_native3', user_id: String(new mongoose.Types.ObjectId()),
        kind: 'PROMO', pool: 'BONUS_POOL', amount_paise: 6000, status: 'CLAWED_BACK',
        granted_at: new Date(), updated_at: new Date(),
      };
      await reverseMirrorBonusGrant(row);
      await reverseMirrorBonusGrant(row); // replayed — must not double the reversal

      const grant = await BonusRecord().findOne({ refId: 'grant:xs_native3' }).lean();
      const claw  = await BonusRecord().findOne({ refId: 'xs_native3:clawback' }).lean();

      // "Was this user ever given a signup bonus?" is what fraud review asks,
      // and rewriting the original to zero destroys the answer.
      expect(grant.amount).toBe(60);
      expect(claw.amount).toBe(-60);
      expect(await BonusRecord().countDocuments({ refId: 'xs_native3:clawback' })).toBe(1);
    });

    it('lands a mirrored grant on its own document rather than a duplicate', async () => {
      const rec = await BonusRecord().create({
        userId: new mongoose.Types.ObjectId(), type: 'GIFT_CODE', amount: 15,
      });
      await reverseMirrorBonusGrant({
        grant_id: `bg_${rec._id}`, user_id: String(rec.userId),
        kind: 'PROMO', pool: 'BONUS_POOL', amount_paise: 1500, status: 'PAID',
        granted_at: new Date(), updated_at: new Date(),
      });

      expect(await BonusRecord().countDocuments({})).toBe(1);
    });
  });
});
