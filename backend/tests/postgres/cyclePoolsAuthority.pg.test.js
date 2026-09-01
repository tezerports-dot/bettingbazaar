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
 * There is no Mongo path left to fall back to: PostgreSQL is the only durable
 * store, so these pools are simply the pools.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { derivePoolsOnPostgres } from '../../postgres/betPgAuthority.js';
import { derivePoolsForCycle, addPhantomToPool } from '../../postgres/cyclePg.js';
import { pgQuery, applySchema } from '../../postgres/pgClient.js';
import { givenCycle } from './_cycleFixture.js';

let seq = 0;
const nextId = () => `pools_${Date.now()}_${seq++}`;

const stake = (cycleId, side, paise, status = 'PENDING') => pgQuery(
  `INSERT INTO bets (bet_id, user_id, cycle_id, side, stake_paise, status)
   VALUES ($1,$2,$3,$4,$5,$6)`,
  [`${cycleId}_b${seq++}`, 'pools_user', cycleId, side, paise, status],
);

beforeAll(async () => { await applySchema(); });

describe('deriving the pools the result is chosen from', () => {
  // REMOVED: this asserted `null` on the Mongo path so a caller could tell
  // "not authoritative here" from "nobody bet on either side". There is no
  // Mongo path any more, so there is no ambiguity left to guard — an empty
  // cycle now simply reports zero on both sides, which the last test here
  // covers.

  it('sums both sides, in rupees, when Postgres owns the bets', async () => {
    const id = nextId();
    await givenCycle(id);
    await stake(id, 'DELHI', 250_00);   // ₹250
    await stake(id, 'BOMBAY', 100_00);  // ₹100

    expect(await derivePoolsOnPostgres(id)).toEqual({ realDelhi: 250, realBombay: 100 });
  });

  it('identifies the minority side, which is the whole decision', async () => {
    const id = nextId();
    await givenCycle(id);
    await stake(id, 'DELHI', 900_00);
    await stake(id, 'BOMBAY', 100_00);

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

    // Bombay's stake was returned, so Delhi is not the minority side by virtue
    // of money that is no longer in the pool.
    expect(await derivePoolsOnPostgres(id)).toEqual({ realDelhi: 100, realBombay: 0 });
  });

  it('reports an empty cycle as zero on both sides, not as an error', async () => {
    const id = nextId();
    await givenCycle(id);
    expect(await derivePoolsOnPostgres(id)).toEqual({ realDelhi: 0, realBombay: 0 });
  });
});
