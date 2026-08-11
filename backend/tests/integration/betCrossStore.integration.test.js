// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * BETS across both stores — the suite the registry names as the blocker for
 * `implemented`, and the two claims only a two-store test can check.
 *
 * The single-store suites are thorough about what they can see: betPg.test.js
 * races 100 placements and 60 concurrent bets against a balance that fits 20.
 * Neither can check these:
 *
 *   1. THE DERIVED ObjectId MUST STAY STABLE. Mongo types `_id` as an ObjectId,
 *      so a replayed placement cannot mint a fresh one — it would create a
 *      SECOND Mongo document behind the one Postgres bet. `mongoIdFor` derives
 *      it from the idempotency key instead. A test with only one store cannot
 *      observe the second document, because there is no second store to hold
 *      the first.
 *
 *   2. THE `updateMany` BLIND SPOT. gameEngine settles a whole cycle's losing
 *      side in one bulk statement, and Mongoose gives a bulk update no
 *      documents to hand a post hook — so the forward mirror CANNOT see those
 *      transitions. They reach Postgres through reconcileBetStates or not at
 *      all, which makes `--backfill` the expected Phase A mode for this domain
 *      rather than an emergency repair. That claim is only testable with both
 *      stores present.
 *
 * REQUIRES MongoDB (a replica set) + PostgreSQL. CI-only; the sandbox can run
 * neither mongod nor the reverse direction.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import mongoose from 'mongoose';
import '../../models/index.js';
import { pgConfigured, pgQuery, applySchema, closePg } from '../../postgres/pgClient.js';
import { mongoIdFor } from '../../postgres/betPgAuthority.js';
import { reconcileBetStates } from '../../postgres/reconcile.js';

const HAS_PG = !!process.env.DATABASE_URL;

// A cross-store suite that silently skips reports green for a check nobody ran,
// and this one is the evidence behind the BETS flag. In CI both databases are
// always provisioned, so skipping there is a misconfiguration.
if (process.env.CI && !HAS_PG) {
  throw new Error(
    'betCrossStore.integration.test.js: DATABASE_URL is unset in CI. This suite is the evidence behind '
    + 'the BETS capability flags and must never skip silently.',
  );
}
const d = HAS_PG ? describe : describe.skip;

const Bet = () => mongoose.model('Bet');

beforeAll(() => { process.env.RECONCILE_SETTLING_WINDOW_MS = '0'; });

/** Fire-and-forget mirrors: poll until the row lands, never read once. */
async function eventually(fn, ms = 4000) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > ms) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 100));
  }
}

const pgBet = async (betId) => {
  const { rows } = await pgQuery('SELECT * FROM bets WHERE bet_id = $1', [betId]);
  return rows[0] ?? null;
};

/** A Mongo bet whose _id is DERIVED from the idempotency key, as the adapter does. */
async function mongoBet(betId, over = {}) {
  return Bet().create({
    _id: mongoIdFor(betId),
    userId: new mongoose.Types.ObjectId(),
    cycleId: 'xs_cycle_1',
    side: 'DELHI',
    amount: 100,
    status: 'PENDING',
    isPhantom: false,
    timestamp: new Date(),
    ...over,
  });
}

d('bets across MongoDB and PostgreSQL', () => {
  beforeAll(async () => { await applySchema(); });
  afterAll(async () => {
    delete process.env.RECONCILE_SETTLING_WINDOW_MS;
    await closePg();
  });

  beforeEach(async () => {
    await pgQuery(`DELETE FROM bet_transitions WHERE bet_id LIKE 'xs_%'`);
    await pgQuery(`DELETE FROM bets WHERE bet_id LIKE 'xs_%'`);
    await Bet().deleteMany({ cycleId: /^xs_/ });
  });

  // ── Claim 1: the derived ObjectId ────────────────────────────────────────

  describe('the derived Mongo _id', () => {
    it('is stable across calls, and a valid ObjectId', () => {
      const a = mongoIdFor('xs_bet_1');
      const b = mongoIdFor('xs_bet_1');
      expect(a).toBe(b);
      expect(mongoose.Types.ObjectId.isValid(a)).toBe(true);
      expect(mongoIdFor('xs_bet_2')).not.toBe(a);
    });

    it('makes a REPLAYED placement collide instead of creating a second document', async () => {
      // The property the whole derivation exists for. With a fresh ObjectId per
      // attempt, a dropped connection leaves the user with two Mongo bets
      // behind one Postgres bet — and two debits, since each document is a
      // different bet as far as Mongo is concerned.
      await mongoBet('xs_bet_replay');
      await expect(mongoBet('xs_bet_replay')).rejects.toThrow();   // duplicate _id

      expect(await Bet().countDocuments({ _id: mongoIdFor('xs_bet_replay') })).toBe(1);
    });

    it('survives a round trip through the string form Postgres stores', async () => {
      // bets.bet_id is TEXT and the Mongo _id is an ObjectId. If the two ever
      // stopped agreeing on the string, reconcileBetStates would report every
      // bet as missing rather than as drift.
      const doc = await mongoBet('xs_bet_roundtrip');
      expect(String(doc._id)).toBe(mongoIdFor('xs_bet_roundtrip'));
    });
  });

  // ── Claim 2: the updateMany blind spot ───────────────────────────────────

  describe('the bulk-settlement blind spot', () => {
    it('the forward mirror does NOT see Bet.updateMany', async () => {
      // Not a bug to fix here — a documented property of Mongoose that the
      // reconcile pass exists to cover. Asserting it means a future Mongoose
      // version that DID fire the hook would show up as a surprise here rather
      // than as double-mirroring in production.
      const doc = await mongoBet('xs_bulk_1');
      await eventually(async () => (await pgBet(String(doc._id)))?.status === 'PENDING');

      await Bet().updateMany({ cycleId: 'xs_cycle_1', status: 'PENDING' }, { $set: { status: 'LOST' } });
      expect((await Bet().findById(doc._id).lean()).status).toBe('LOST');

      // Postgres is still PENDING — the hook never fired.
      await new Promise((r) => setTimeout(r, 300));
      expect((await pgBet(String(doc._id))).status).toBe('PENDING');
    });

    it('reconcileBetStates REPORTS the resulting disagreement', async () => {
      const doc = await mongoBet('xs_bulk_2');
      await eventually(async () => (await pgBet(String(doc._id))) !== null);
      await Bet().updateMany({ _id: doc._id }, { $set: { status: 'LOST' } });

      const report = await reconcileBetStates();
      expect(report.disagreeing).toBeGreaterThan(0);
      expect(report.sample.some((s) => String(s.betId) === String(doc._id))).toBe(true);
    });

    it('--backfill closes it, which is why it is the expected Phase A mode here', async () => {
      const doc = await mongoBet('xs_bulk_3');
      await eventually(async () => (await pgBet(String(doc._id))) !== null);
      await Bet().updateMany({ _id: doc._id }, { $set: { status: 'LOST' } });

      const repaired = await reconcileBetStates({ backfill: true });
      expect(repaired.repaired).toBeGreaterThan(0);
      expect((await pgBet(String(doc._id))).status).toBe('LOST');

      // And the stores now agree, so a second pass is clean.
      expect(await reconcileBetStates()).toMatchObject({ disagreeing: 0 });
    });

    it('refuses opposite repair directions in one pass', async () => {
      await expect(reconcileBetStates({ backfill: true, repairMongo: true }))
        .rejects.toThrow(/opposite directions/);
    });
  });

  // ── Claim 3: the repair must not destroy what it is repairing ────────────

  describe('what a --backfill repair carries with the status', () => {
    it('preserves a settled bet\'s payout and retained fee', async () => {
      // The repair fetches the Mongo document and hands it to `mirrorBet`,
      // whose `ON CONFLICT DO UPDATE` writes what it is given. It used to fetch
      // with `.select('status')`, so the document arrived with a status and
      // nothing else — and repairing a status disagreement ZEROED the payout
      // and the fee in Postgres. betSettlementPg.test.js proves the mirror
      // behaves that way; this proves the reconcile no longer feeds it a
      // document that triggers it.
      const doc = await mongoBet('xs_repair_keeps', {
        status: 'WON', payout: 198, platformFee: 2, settledAt: new Date(),
      });
      await eventually(async () => (await pgBet(String(doc._id))) !== null);

      // Drive the two stores apart on STATUS only, leaving the money fields
      // correct on the Mongo side.
      await pgQuery(`UPDATE bets SET status = 'PENDING' WHERE bet_id = $1`, [String(doc._id)]);

      const repaired = await reconcileBetStates({ backfill: true });
      expect(repaired.repaired).toBeGreaterThan(0);

      const row = await pgBet(String(doc._id));
      expect(row.status).toBe('WON');
      expect(Number(row.payout_paise)).toBe(19_800);
      expect(Number(row.platform_fee_paise)).toBe(200);
    });
  });

  // ── Claim 4: the fee round-trips, so cycle revenue cannot read zero ──────

  describe('the retained platform fee across both stores', () => {
    it('reaches the Mongo document through the reverse mirror', async () => {
      // `Cycle.totalPlatformFees` is summed from `Bet.platformFee` over the
      // cycle's WON bets. Once Postgres settles the bet, the reverse mirror is
      // the ONLY thing that puts the fee back on the document — so without this
      // leg every Postgres-settled cycle reports zero platform revenue while
      // every state check stays green, because no state check looks at the fee.
      const { reverseMirrorBetRow } = await import('../../postgres/reverseMirror.js');
      const doc = await mongoBet('xs_fee_reverse');

      await reverseMirrorBetRow({
        bet_id: String(doc._id), mongo_id: String(doc._id),
        user_id: String(doc.userId), cycle_id: doc.cycleId, side: doc.side,
        stake_paise: 10_000, payout_paise: 19_800, platform_fee_paise: 200,
        status: 'WON', settled_at: new Date(), placed_at: doc.timestamp,
      });

      const after = await eventually(async () => {
        const b = await Bet().findById(doc._id).lean();
        return b?.status === 'WON' ? b : null;
      });
      expect(after.payout).toBe(198);
      expect(after.platformFee).toBe(2);
    });

    it('and a cycle total derived from Mongo then agrees with what Postgres retained', async () => {
      // The number that actually ships: gameEngine derives totalPlatformFees by
      // aggregating the stamped WON bets. This is that aggregation, over bets
      // whose fees arrived only via the reverse mirror.
      const { reverseMirrorBetRow } = await import('../../postgres/reverseMirror.js');
      const cycleId = 'xs_fee_cycle';
      const made = [];
      for (const [i, fee] of [200, 100, 0].entries()) {
        const doc = await mongoBet(`xs_fee_total_${i}`, { cycleId });
        made.push({ doc, fee });
      }
      for (const { doc, fee } of made) {
        await reverseMirrorBetRow({
          bet_id: String(doc._id), mongo_id: String(doc._id),
          user_id: String(doc.userId), cycle_id: cycleId, side: doc.side,
          stake_paise: 10_000, payout_paise: 20_000 - fee, platform_fee_paise: fee,
          status: 'WON', settled_at: new Date(), placed_at: doc.timestamp,
        });
      }

      await eventually(async () =>
        (await Bet().countDocuments({ cycleId, status: 'WON' })) === 3 || null);

      const [totals] = await Bet().aggregate([
        { $match: { cycleId, status: 'WON', isPhantom: false } },
        { $group: { _id: null, fees: { $sum: '$platformFee' }, paid: { $sum: '$payout' } } },
      ]);
      // ₹2.00 + ₹1.00 + ₹0.00 — the third is the one a truthiness guard would
      // have dropped, leaving a bet WON with a stale fee under it.
      expect(Math.round(totals.fees * 100) / 100).toBe(3);
      expect(Math.round(totals.paid * 100) / 100).toBe(597);
    });
  });
});
