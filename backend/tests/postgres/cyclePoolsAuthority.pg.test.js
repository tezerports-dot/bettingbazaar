// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * The pools the WINNER is chosen from come from the store that owns the bets.
 *
 * ── Why this is the one that matters ────────────────────────────────────────
 * The winner is the minority REAL-bet side, computed server-side at declare
 * time. Everything else in a settlement follows from that one comparison, so a
 * pool read that is even slightly behind does not produce a slightly wrong
 * number — it can produce the WRONG WINNER, and every payout after it is
 * consistent with a result that should not have been declared.
 *
 * `computeRealPools` summed Mongo `Bet` documents. Under Postgres bet
 * authority those are a lagging mirror written after the Postgres COMMIT, so a
 * stake could be committed, settled and paid while being absent from the pools
 * its own result was chosen from.
 *
 * The Mongo path is preserved by returning `null` rather than zeroes, because
 * "not authoritative here" and "nobody bet on either side" must never collapse
 * into the same answer: the second one silently declares a winner from an empty
 * pool.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { derivePoolsOnPostgres } from '../../postgres/betPgAuthority.js';
import { derivePoolsForCycle, addPhantomToPool } from '../../postgres/cyclePg.js';
import { pgQuery, applySchema } from '../../postgres/pgClient.js';
import { givenCycle } from './_cycleFixture.js';

const AUTHORITY = ['MONEY_AUTHORITY_WALLET', 'MONEY_AUTHORITY_LEDGER', 'MONEY_AUTHORITY_BETS'];
let seq = 0;
const nextId = () => `pools_${Date.now()}_${seq++}`;
let saved;

const onPg = () => {
  saved = Object.fromEntries(AUTHORITY.map((v) => [v, process.env[v]]));
  for (const v of AUTHORITY) process.env[v] = 'postgres';
};

const stake = (cycleId, side, paise, status = 'PENDING') => pgQuery(
  `INSERT INTO bets (bet_id, user_id, cycle_id, side, stake_paise, status)
   VALUES ($1,$2,$3,$4,$5,$6)`,
  [`${cycleId}_b${seq++}`, 'pools_user', cycleId, side, paise, status],
);

beforeAll(async () => { await applySchema(); });

afterEach(() => {
  if (!saved) return;
  for (const v of AUTHORITY) {
    if (saved[v] === undefined) delete process.env[v]; else process.env[v] = saved[v];
  }
  saved = undefined;
});

describe('deriving the pools the result is chosen from', () => {
  it('returns null on the Mongo path — never zeroes', async () => {
    // The distinction the winner depends on. Zeroes here would make the caller
    // compare 0 against 0 and declare a coin-flip result on a cycle that may
    // have had thousands of rupees on one side.
    const id = nextId();
    await givenCycle(id);
    await stake(id, 'DELHI', 10_000);

    expect(await derivePoolsOnPostgres(id)).toBeNull();
  });

  it('sums both sides, in rupees, when Postgres owns the bets', async () => {
    const id = nextId();
    await givenCycle(id);
    await stake(id, 'DELHI', 250_00);   // ₹250
    await stake(id, 'BOMBAY', 100_00);  // ₹100

    onPg();
    expect(await derivePoolsOnPostgres(id)).toEqual({ realDelhi: 250, realBombay: 100 });
  });

  it('identifies the minority side, which is the whole decision', async () => {
    const id = nextId();
    await givenCycle(id);
    await stake(id, 'DELHI', 900_00);
    await stake(id, 'BOMBAY', 100_00);

    onPg();
    const { realDelhi, realBombay } = await derivePoolsOnPostgres(id);
    expect(realBombay).toBeLessThan(realDelhi);
  });

  it('never counts a phantom stake toward the real pools', async () => {
    // Absent by construction, not by filter: dualWrite never writes a phantom
    // bet to Postgres, so summing `bets` cannot include one. The Mongo
    // aggregate needs an explicit isPhantom:false and would return the phantom
    // pool if that clause were ever dropped — which would hand the result to
    // the side the house padded.
    const id = nextId();
    await givenCycle(id);
    await stake(id, 'DELHI', 100_00);
    await addPhantomToPool({ cycleId: id, side: 'BOMBAY', amountPaise: 500_00, betCount: 5 });

    onPg();
    expect(await derivePoolsOnPostgres(id)).toEqual({ realDelhi: 100, realBombay: 0 });

    // The phantom stake is still in the PUBLIC total — that is what it is for.
    const pools = await derivePoolsForCycle(id);
    expect(pools.totalBombayPaise).toBe(500_00);
    expect(pools.realBombayPaise).toBe(0);
  });

  it('excludes a refunded stake from the decision', async () => {
    const id = nextId();
    await givenCycle(id);
    await stake(id, 'DELHI', 100_00);
    await stake(id, 'BOMBAY', 900_00, 'REFUNDED');

    onPg();
    // Bombay's stake was returned, so Delhi is not the minority side by virtue
    // of money that is no longer in the pool.
    expect(await derivePoolsOnPostgres(id)).toEqual({ realDelhi: 100, realBombay: 0 });
  });

  it('reports an empty cycle as zero on both sides, not as an error', async () => {
    const id = nextId();
    await givenCycle(id);
    onPg();
    expect(await derivePoolsOnPostgres(id)).toEqual({ realDelhi: 0, realBombay: 0 });
  });
});
