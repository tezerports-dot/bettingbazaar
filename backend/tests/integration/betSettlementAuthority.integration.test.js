// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * A whole cycle settled with PostgreSQL actually authoritative for bets.
 *
 * ── Why this exists, and why the layer suites were not enough ───────────────
 * Routing bet settlement shipped with a showstopper that three suites missed,
 * each because it was looking at one side of the seam:
 *
 *   - the unit suites mocked `betPg`, so the id `settleBetOnPostgres` passed
 *     down was never checked against a real `bets` table;
 *   - the Postgres suites called `winBet` directly with the same key they had
 *     just placed with, so the two ids were never different;
 *   - the cross-store suite exercised the mirrors, not the engine.
 *
 * The defect sat exactly between them: a bet placed under Postgres authority is
 * keyed on its idempotency key with the Mongo `_id` in `mongo_id`, and
 * settlement — which reads its bets from Mongo — was handing the Mongo id
 * through as the Postgres key. Every such bet was refused `not_found` with its
 * stake still locked.
 *
 * So this drives the REAL engine over a REAL cycle with the authority flags
 * genuinely set, and asserts against both stores. It is the only test here that
 * can see that seam.
 *
 * REQUIRES MongoDB (a replica set) + PostgreSQL. CI-only.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import mongoose from 'mongoose';
import '../../models/index.js';
import { pgQuery, applySchema, closePg } from '../../postgres/pgClient.js';
import { applyDeltaPaise, getBalancesPaise } from '../../postgres/walletPg.js';
import { placeBet as placePgBet, mongoIdFor } from '../../postgres/betPgAuthority.js';
import GameEngine from '../../domains/markets/gameEngine.js';

const HAS_PG = !!process.env.DATABASE_URL;

// This suite is the end-to-end evidence behind the BETS capability flags. A
// silent skip here would report green for the one check that spans the seam.
if (process.env.CI && !HAS_PG) {
  throw new Error(
    'betSettlementAuthority.integration.test.js: DATABASE_URL is unset in CI. This suite is the '
    + 'end-to-end evidence behind the BETS flags and must never skip silently.',
  );
}
const d = HAS_PG ? describe : describe.skip;

const Bet = () => mongoose.model('Bet');
const Cycle = () => mongoose.model('Cycle');

/** BETS dependsOn WALLET and LEDGER, and LEDGER dependsOn WALLET. */
const AUTHORITY_VARS = ['MONEY_AUTHORITY_WALLET', 'MONEY_AUTHORITY_LEDGER', 'MONEY_AUTHORITY_BETS'];

// Every identifier is unique per test, and nothing here TRUNCATES. The
// integration files share one PostgreSQL and run serially, so a truncate in
// this file would delete another file's fixtures between its hooks — and
// `bet_transitions` carries an append-only trigger, so the usual targeted
// DELETE is refused by the database anyway. Unique keys sidestep both.
let RUN = 0;
// User ids must be castable to an ObjectId. `Bet.userId` is typed
// Schema.Types.ObjectId, and reverseMirrorBet writes through the model — so an
// arbitrary string throws a CastError INSIDE mirrorBack, which catches, logs and
// returns. The placement then reports success with no Mongo document behind it,
// and the engine (which reads its bets from Mongo) finds nothing to settle.
// Postgres stores user_id as TEXT and does not care either way.
// Returned BARE, never with a suffix appended. `${uid()}_win` is not an
// ObjectId, and that is exactly how this broke twice: the CastError happens
// inside mirrorBack, which catches by design, so the placement reports success
// with no Mongo document behind it.
const uid = () => new mongoose.Types.ObjectId().toString();
const tag = () => `auth_${Date.now().toString(36)}_${RUN}`;
let CYCLE;

async function seedStake(userId, paise, key) {
  await applyDeltaPaise({
    userId, field: 'depositBalance', deltaPaise: paise,
    txId: key, type: 'CREDIT', reason: 'test funding',
  });
}

/** Place through the ROUTED adapter, so the bet gets its two real identities. */
async function place(userId, side, rupees, key) {
  const r = await placePgBet({
    betId: key, userId, cycleId: CYCLE, side, amount: rupees,
    slices: [{ field: 'depositBalance', amount: rupees }],
  });
  expect(r.ok).toBe(true);
  // Asserted here rather than left to a later countDocuments, because these
  // two are the only ways the bet can fail to reach Mongo and they need
  // telling apart. placeBet mirrors back ONLY when the placement was new, and
  // reverseMirrorBet swallows its own failures by design — so an idempotent
  // result and a failed mirror both surface as "no document" several
  // assertions later, pointing at the engine instead of at the placement.
  expect({ key, idempotent: r.idempotent }).toEqual({ key, idempotent: false });
  const { rows } = await pgQuery('SELECT bet_id, mongo_id FROM bets WHERE bet_id = $1', [key]);
  expect({ key, rows: rows.length }).toEqual({ key, rows: 1 });
  expect(rows[0].mongo_id).toBe(mongoIdFor(key));

  const doc = await Bet().findById(mongoIdFor(key)).lean();
  expect({ key, mirrored: Boolean(doc) }).toEqual({ key, mirrored: true });
  return r;
}

d('a cycle settled with Postgres authoritative for bets', () => {
  let engine;
  let saved;

  beforeAll(async () => { await applySchema(); });
  afterAll(async () => { await closePg(); });

  beforeEach(async () => {
    saved = Object.fromEntries(AUTHORITY_VARS.map((v) => [v, process.env[v]]));
    for (const v of AUTHORITY_VARS) process.env[v] = 'postgres';

    RUN += 1;
    CYCLE = `${tag()}_cycle`;
    engine = new GameEngine(null);
    // Stop the timers immediately. The constructor starts a 1s tick that
    // sweeps exactly the cycles these tests create, so leaving it running would
    // race every explicit pass below — the cycle lock would resolve it
    // correctly and the assertions would still be timing-dependent, which is a
    // worse way to find that out.
    engine.stop();
  });

  afterEach(() => {
    engine?.stop();
    for (const v of AUTHORITY_VARS) {
      if (saved[v] === undefined) delete process.env[v]; else process.env[v] = saved[v];
    }
  });

  const makeCycle = () => Cycle().create({
    cycleId: CYCLE, type: '30_MIN',
    startTime: Date.now() - 3600_000, endTime: Date.now() - 1800_000,
    status: 'RESULT_DECLARED', winner: 'DELHI', isSettled: 'PENDING',
    realDelhi: 100, realBombay: 100,
  });

  it('settles both sides in Postgres and leaves no stake locked', async () => {
    const winner = uid();
    const loser  = uid();
    await seedStake(winner, 100_00, `${winner}_fund`);
    await seedStake(loser,  100_00, `${loser}_fund`);

    // The identities that broke it: the Postgres key and the Mongo _id are
    // DIFFERENT strings for a routed placement, and settlement only ever holds
    // the second one.
    const winKey  = `bet_${winner}_k1`;
    const loseKey = `bet_${loser}_k1`;
    await place(winner, 'DELHI',  100, winKey);
    await place(loser,  'BOMBAY', 100, loseKey);
    expect(mongoIdFor(winKey)).not.toBe(winKey);

    // The engine reads its bets from Mongo, so they must be there first — the
    // routed placement mirrors them back, awaited, before returning.
    expect(await Bet().countDocuments({ cycleId: CYCLE })).toBe(2);

    await engine.processPayoutsOptimized(await makeCycle());

    // ── Postgres: the authoritative lifecycle ────────────────────────────────
    const { rows } = await pgQuery(
      `SELECT bet_id, status, payout_paise, platform_fee_paise FROM bets WHERE cycle_id = $1 ORDER BY bet_id`,
      [CYCLE]);
    const byId = Object.fromEntries(rows.map((r) => [r.bet_id, r]));
    expect(byId[winKey].status).toBe('WON');
    expect(byId[loseKey].status).toBe('LOST');
    // Settled by the transition, not stamped afterwards: a payout of zero here
    // would mean the bet moved state without the money moving with it.
    expect(Number(byId[winKey].payout_paise)).toBeGreaterThan(0);

    // ── The stake actually left `locked`, on BOTH sides ──────────────────────
    // The failure this whole file exists for looked exactly like a clean run
    // except for this: a refused settlement leaves the stake locked forever.
    expect(Number((await getBalancesPaise(winner)).lockedBalance)).toBe(0);
    expect(Number((await getBalancesPaise(loser)).lockedBalance)).toBe(0);
    // The winner was paid into winnings; the loser's stake was consumed.
    expect(Number((await getBalancesPaise(winner)).winningsBalance)).toBe(Number(byId[winKey].payout_paise));
    expect(Number((await getBalancesPaise(loser)).winningsBalance)).toBe(0);

    // ── Mongo: kept current by the reverse mirror, under the RIGHT _id ───────
    // Writing the Postgres key as the document id would upsert a second
    // document and leave these two at PENDING.
    const wonDoc  = await Bet().findById(mongoIdFor(winKey)).lean();
    const lostDoc = await Bet().findById(mongoIdFor(loseKey)).lean();
    expect(wonDoc.status).toBe('WON');
    expect(lostDoc.status).toBe('LOST');
    expect(await Bet().countDocuments({ cycleId: CYCLE })).toBe(2);
  });

  it('carries the retained fee onto the Mongo document, so the cycle total is real', async () => {
    const u = uid();
    await seedStake(u, 100_00, `${u}_fund`);
    const key = `bet_${u}_k1`;
    await place(u, 'DELHI', 100, key);

    await engine.processPayoutsOptimized(await makeCycle());

    const doc = await Bet().findById(mongoIdFor(key)).lean();
    expect(doc.status).toBe('WON');
    // gameEngine derives Cycle.totalPlatformFees by summing THIS field over the
    // cycle's WON bets. Before `bets.platform_fee_paise` existed it read zero
    // for every Postgres-settled cycle, with every state check still green.
    expect(doc.platformFee).toBeGreaterThanOrEqual(0);
    expect(doc.payout).toBeGreaterThan(0);

    const settled = await Cycle().findOne({ cycleId: CYCLE }).lean();
    expect(settled.isSettled).toBe('COMPLETED');
    expect(settled.totalPaidOut).toBe(doc.payout);
    expect(settled.totalPlatformFees).toBe(doc.platformFee);
  });

  it('is safe to re-run — a second pass settles nothing further', async () => {
    // payoutRecoveryTask re-admits a PROCESSING cycle on purpose, so two passes
    // over one cycle is a supported scenario and money safety rests on the
    // per-bet guard being real rather than on the pass running once.
    const u = uid();
    const key = `bet_${u}_k1`;
    await seedStake(u, 100_00, `${u}_fund`);
    await place(u, 'DELHI', 100, key);

    const cycle = await makeCycle();
    await engine.processPayoutsOptimized(cycle);
    const after = await getBalancesPaise(u);

    await Cycle().updateOne({ cycleId: CYCLE }, { $set: { isSettled: 'PROCESSING' } });
    await engine.processPayoutsOptimized(await Cycle().findOne({ cycleId: CYCLE }));

    expect(await getBalancesPaise(u)).toMatchObject({
      winningsBalance: after.winningsBalance,
      lockedBalance: after.lockedBalance,
    });
    const { rows } = await pgQuery(
      `SELECT count(*)::int AS n FROM bet_transitions WHERE bet_id = $1`, [key]);
    // place + win, for THIS bet. A third row would mean the guard let the same
    // bet settle twice.
    expect(rows[0].n).toBe(2);
  });
});
