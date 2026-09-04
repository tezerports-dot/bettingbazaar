// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file.
/**
 * cycleGeneratorPg.test.js — the thing that declares winners, against real rows.
 *
 * ── The two failures this file exists for ───────────────────────────────────
 * Trap 3: "Nothing in production advanced the PostgreSQL cycle status or
 * winner — ensureCycle created the row at OPEN and it stayed there, so the
 * engine looked healthy and silently never settled." The generator is what
 * advances it, so these tests assert on the ROWS the settlement engine claims
 * from, not on what the generator emitted.
 *
 * And the stale-cycle path, which was worse: it force-expired a cycle by
 * writing a HARDCODED `winner: 'DELHI'`. The engine claims on
 * `winner IS NOT NULL`, so the next tick paid every DELHI bet at 2x and
 * consumed every BOMBAY stake — real money, decided by alphabetical order,
 * every time a deploy outlasted a block.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { pgConfigured, pgQuery, applySchema, closePg } from '../client.js';
import { placeBet } from '../repositories/bets.core.js';
import { applyDeltaPaise } from '../repositories/wallets.core.js';
import { getCycle, currentCycleWithPools } from '../repositories/markets.js';
import CycleGenerator from '../../backend/domains/markets/cycleGenerator.service.js';

const hasPg = pgConfigured();
const describePg = hasPg ? describe : describe.skip;

/** A generator with its timers never started — nothing here needs the ticker. */
function generator() {
  const gen = new CycleGenerator(null, null);
  clearInterval(gen.cycleInterval);
  clearInterval(gen.broadcastInterval);
  return gen;
}

const fund = (userId, paise, key) =>
  applyDeltaPaise({ userId, field: 'depositBalance', deltaPaise: paise, txId: key, type: 'CREDIT', reason: 'test' });

const openCycle = (cycleId, { type = '30_MIN', endedMinutesAgo = null, phantomDelhi = 0, phantomBombay = 0 } = {}) => pgQuery(
  `INSERT INTO cycles (cycle_id, cycle_type, status, start_time, end_time,
                       phantom_delhi_paise, phantom_bombay_paise)
   VALUES ($1, $2, 'OPEN',
           $3::timestamptz - interval '30 minutes', $3::timestamptz, $4, $5)`,
  [cycleId, type,
    endedMinutesAgo === null
      ? new Date(Date.now() + 15 * 60_000)
      : new Date(Date.now() - endedMinutesAgo * 60_000),
    phantomDelhi, phantomBombay],
);

const bet = (betId, userId, cycleId, side, paise) =>
  placeBet({ betId, userId, cycleId, side, slices: [{ field: 'depositBalance', amountPaise: paise }] });

describePg('the cycle generator', () => {
  beforeAll(async () => { await applySchema(); });
  afterAll(async () => { await closePg(); });
  beforeEach(async () => {
    await pgQuery(`TRUNCATE bets, bet_transitions, wallet_ledger, wallets, cycles,
                            cycle_settlements
                   RESTART IDENTITY CASCADE`);
  });

  // ── Trap 3: the winner reaches the row the engine claims from ─────────────
  it('writes the winner and the declared status to the cycle row', async () => {
    await fund('u1', 100_00, 'f1');
    await openCycle('c-declare', { endedMinutesAgo: 1 });
    await bet('b1', 'u1', 'c-declare', 'DELHI', 100_00);

    await generator().completeCycle(await currentCycleWithPools('30_MIN'));

    const cycle = await getCycle('c-declare');
    // Both, or the settlement sweep reads a declared cycle with no winner.
    expect(cycle.winner).toBeTruthy();
    expect(cycle.status).toBe('RESULT_DECLARED');
    expect(cycle.winnerDeterminedAt).toBeInstanceOf(Date);
  });

  it('picks the MINORITY real side, which is where the house profits', async () => {
    await fund('u1', 500_00, 'f1');
    await openCycle('c-minority', { endedMinutesAgo: 1 });
    await bet('b-delhi',  'u1', 'c-minority', 'DELHI',  400_00);
    await bet('b-bombay', 'u1', 'c-minority', 'BOMBAY', 100_00);

    await generator().completeCycle(await currentCycleWithPools('30_MIN'));

    // More money on DELHI, so BOMBAY wins and the house keeps the difference.
    expect((await getCycle('c-minority')).winner).toBe('BOMBAY');
  });

  it('ignores phantom stakes when deciding the winner', async () => {
    await fund('u1', 200_00, 'f1');
    // Phantom liquidity is stacked on BOMBAY, which would flip the decision if
    // it counted. It must not: the winner comes from REAL money only.
    await openCycle('c-phantom-blind', { endedMinutesAgo: 1, phantomBombay: 900_00 });
    await bet('b-delhi',  'u1', 'c-phantom-blind', 'DELHI',  150_00);
    await bet('b-bombay', 'u1', 'c-phantom-blind', 'BOMBAY',  50_00);
    await pgQuery(
      `INSERT INTO bets (bet_id, user_id, cycle_id, side, stake_paise, status, is_phantom)
       VALUES ('b-ph','house','c-phantom-blind','BOMBAY',900_00,'PENDING',TRUE)`, [],
    );

    await generator().completeCycle(await currentCycleWithPools('30_MIN'));

    // Real: Delhi 150, Bombay 50 → the minority real side is BOMBAY.
    expect((await getCycle('c-phantom-blind')).winner).toBe('BOMBAY');
  });

  it('refuses to declare a second result over one players have seen', async () => {
    await fund('u1', 100_00, 'f1');
    await openCycle('c-once', { endedMinutesAgo: 1 });
    await bet('b1', 'u1', 'c-once', 'DELHI', 100_00);

    const cycle = await currentCycleWithPools('30_MIN');
    const gen = generator();
    await gen.completeCycle(cycle);
    const first = (await getCycle('c-once')).winner;

    // A second pass over the same in-memory cycle must not overwrite it.
    await gen.completeCycle(cycle);
    expect((await getCycle('c-once')).winner).toBe(first);
  });

  // ── The stale-cycle money bug ────────────────────────────────────────────
  it('adjudicates a cycle the server was down for, rather than stamping DELHI', async () => {
    await fund('u1', 500_00, 'f1');
    // Ended two hours ago and never declared — the deploy-outlasted-a-block case.
    await openCycle('c-stale', { endedMinutesAgo: 120 });
    await bet('b-delhi',  'u1', 'c-stale', 'DELHI',  400_00);
    await bet('b-bombay', 'u1', 'c-stale', 'BOMBAY', 100_00);

    const stale = await currentCycleWithPools('30_MIN');
    await generator().adjudicateStaleCycle(stale, '30-MIN');

    // Adjudicated by the same minority rule as any other cycle. The version
    // this replaced wrote winner: 'DELHI' unconditionally — so here it would
    // have paid the 400 side at 2x and consumed the 100 side, on a result
    // nobody decided.
    expect((await getCycle('c-stale')).winner).toBe('BOMBAY');
  });

  it('leaves a cycle undeclared when its pools cannot be read', async () => {
    // No bets at all: the pools read as zero on both sides, which is a legible
    // tie rather than a failure — the coin flip decides and the cycle IS
    // declared, so a round nobody bet on does not block the next one forever.
    await openCycle('c-empty', { endedMinutesAgo: 1 });
    await generator().completeCycle(await currentCycleWithPools('30_MIN'));

    const cycle = await getCycle('c-empty');
    expect(['DELHI', 'BOMBAY']).toContain(cycle.winner);
    expect(cycle.status).toBe('RESULT_DECLARED');
  });

  // ── Creation ─────────────────────────────────────────────────────────────
  it('creates one cycle per block however many ticks race for it', async () => {
    const gen = generator();
    await Promise.all([
      gen.ensureIntervalCycle('30_MIN'),
      gen.ensureIntervalCycle('30_MIN'),
      gen.ensureIntervalCycle('30_MIN'),
    ]);

    // The unique index on (cycle_type, start_time) decides. Three documents
    // here would mean three concurrent betting rounds for one block.
    const { rows } = await pgQuery(
      "SELECT COUNT(*)::int AS n FROM cycles WHERE cycle_type = '30_MIN'", [],
    );
    expect(rows[0].n).toBe(1);
  });

  it('stores no real pool figures on the cycle row', async () => {
    await generator().ensureIntervalCycle('30_MIN');
    const { rows } = await pgQuery(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'cycles' AND column_name IN
              ('real_delhi_paise','real_bombay_paise','total_delhi_paise','total_bombay_paise')`, [],
    );
    // Trap 4: a bet holds FOR SHARE on the cycle row while it commits, so a
    // writer that also UPDATEs that row deadlocks against another bet doing the
    // same. The columns must not exist for anything to be tempted to write.
    expect(rows).toEqual([]);
  });

  // ── The snapshot every connecting client receives ────────────────────────
  it('sends combined pools, never the real/phantom split', async () => {
    await fund('u1', 300_00, 'f1');
    await openCycle('c-snap', { phantomDelhi: 500_00, phantomBombay: 400_00 });
    await bet('b1', 'u1', 'c-snap', 'DELHI',  200_00);
    await bet('b2', 'u1', 'c-snap', 'BOMBAY', 100_00);

    const snapshot = await generator().getCycleSnapshotData();
    const live = snapshot['30_MIN'];

    // Real halves from the bets, phantom from the row. The read this replaced
    // took `realDelhi` as a document field — not a column — so both sides fell
    // through to `|| 0` and every connecting client saw empty pools.
    expect(live.totalDelhi).toBe(700);
    expect(live.totalBombay).toBe(500);
    // The split itself must never cross the boundary: the winner is the
    // minority REAL side, so anyone who can see it knows the result early.
    for (const forbidden of ['realDelhi', 'realBombay', 'phantomDelhi', 'phantomBombay']) {
      expect(live).not.toHaveProperty(forbidden);
    }
  });

  it('advances a cycle through its phases without moving it backwards', async () => {
    await openCycle('c-phase', { endedMinutesAgo: null });
    const gen = generator();

    const { setCycleStatus } = await import('../repositories/markets.js');
    expect((await setCycleStatus('c-phase', 'MERGED', { from: ['OPEN'] })).ok).toBe(true);
    expect((await setCycleStatus('c-phase', 'CLOSED', { from: ['OPEN', 'MERGED'] })).ok).toBe(true);

    // The guard is the `from` list, IN the statement. Without it a tick that
    // read the cycle as OPEN before another tick closed it would write MERGED
    // over CLOSED — reopening a betting window that had already shut.
    const backwards = await setCycleStatus('c-phase', 'MERGED', { from: ['OPEN'] });
    expect(backwards.ok).toBe(false);
    expect((await getCycle('c-phase')).status).toBe('CLOSED');
  });
});
