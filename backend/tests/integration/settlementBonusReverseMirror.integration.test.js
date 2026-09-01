// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * The reverse mirror for settlements and bonuses — Postgres row → Mongo document.
 *
 * ── What this file used to be, and why half of it is gone ───────────────────
 * This was settlementBonusCrossStore.integration.test.js, and it tested two
 * directions. The forward direction (Mongo → Postgres, via dualWrite) and the
 * cross-store reconcilers built on top of it have been REMOVED from this suite,
 * because both stopped being able to fail:
 *
 *   - `mirrorCycleSettlement` and `mirrorBonusGrant` open with
 *     `if (isPostgresAuthoritative(...)) return;`. Postgres is now
 *     unconditionally authoritative, so the forward mirror is a no-op — and
 *     correctly so. A stale Mongo document must not be allowed to overwrite the
 *     row Postgres just wrote authoritatively.
 *   - `reconcileCycleSettlements` and `reconcileBonusGrants` have NO call site
 *     outside this file. Nothing schedules them, and nothing reads their
 *     result.
 *   - Even if something did, the comparison no longer has two independent
 *     sides. Postgres writes the settlement; the reverse mirror copies it into
 *     Mongo; the reconciler then compares Postgres against that copy. A check
 *     that reads a value against a copy of itself cannot report drift, and a
 *     check that cannot fail is worse than no check — it reports green.
 *
 * ── What remains, and why it is still load-bearing ──────────────────────────
 * The reverse direction is live. `settlementPgAuthority` calls
 * `reverseMirrorCycleSettlement` on every settlement close, and gameEngine
 * still reads its cycles from Mongo — so this write is what stops
 * payoutRecoveryTask sweeping up a cycle that has already been paid. The day
 * the engine reads `cycles` from Postgres, this file goes too.
 *
 * REQUIRES MongoDB (a replica set) + PostgreSQL. CI-only; the sandbox can run
 * neither mongod nor the reverse direction.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import mongoose from 'mongoose';
import '../../models/index.js';
import { pgQuery, applySchema, closePg } from '../../postgres/pgClient.js';
import {
  reverseMirrorCycleSettlement, reverseMirrorBonusGrant,
} from '../../postgres/reverseMirror.js';

const HAS_PG = !!process.env.DATABASE_URL;
const d = HAS_PG ? describe : describe.skip;

const Cycle = () => mongoose.model('Cycle');
const BonusRecord = () => mongoose.model('BonusRecord');

/** A Cycle needs more than the settlement fields to satisfy its schema. */
const cycle = (over = {}) => Cycle().create({
  cycleId: 'xs_c1', type: '30_MIN', startTime: Date.now(), endTime: Date.now() + 60_000,
  status: 'RESULT_DECLARED', winner: 'DELHI', isSettled: 'PENDING', ...over,
});

d('settlement and bonus rollback into MongoDB', () => {
  beforeAll(async () => { await applySchema(); });
  afterAll(async () => { await closePg(); });

  beforeEach(async () => {
    await pgQuery(`DELETE FROM cycle_settlements WHERE cycle_id LIKE 'xs_%'`);
    await pgQuery(`DELETE FROM bonus_grants WHERE grant_id LIKE 'bg_%' OR grant_id LIKE 'xs_%'`);
    await Cycle().deleteMany({ cycleId: /^xs_/ });
    await BonusRecord().deleteMany({});
  });

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
