// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * The stalled-settlement detector, and the reason it needed a test at all.
 *
 * `findIncompleteSettlements()` finds settlement runs marked COMPLETED while
 * bets on their cycle are still PENDING — a player's stake locked with nothing
 * coming to release it: never paid, never lost, never refunded.
 *
 * The query was written, unit-tested, described in its own module as "the
 * strongest check", and cited in four other modules' comments. **It had no
 * production call site.** Nothing ran it. The condition it detects could
 * therefore persist for as long as the platform did, silently.
 *
 * It is now called from the `ledger-reconcile` cron every 60 seconds and
 * exported as `bb_stalled_settlements`. This file pins the detection itself;
 * `cronWiring` below pins that something actually calls it, because the defect
 * being guarded is not "the query is wrong" — the query was always right — but
 * "the query is never run".
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFile } from 'node:fs/promises';
import {
  openSettlement, completeSettlement, findIncompleteSettlements,
} from '../../postgres/settlementPg.js';
import { placeBet } from '../../postgres/betPg.js';
import { pgQuery } from '../../postgres/pgClient.js';

const USER = 'stalled_user';
let seq = 0;
const nextCycle = () => `stalled_${Date.now()}_${seq++}`;

beforeAll(async () => {
  const { applySchema } = await import('../../postgres/pgClient.js');
  await applySchema();
  await pgQuery(
    `INSERT INTO wallets (user_id, deposit_paise) VALUES ($1, 100000000)
     ON CONFLICT (user_id) DO UPDATE SET deposit_paise = 100000000`,
    [USER],
  );
});

describe('findIncompleteSettlements', () => {
  it('reports a run that COMPLETED with a bet still PENDING', async () => {
    // Exactly the state the mirror race leaves behind: the bet committed in
    // Postgres, the settlement enumerated from Mongo before the mirror landed,
    // so the run finished without ever seeing it.
    const cycle = nextCycle();
    await placeBet({
      betId: `${cycle}_b1`, userId: USER, cycleId: cycle, side: 'DELHI',
      slices: [{ field: 'depositBalance', amountPaise: 5_000 }],
    });
    await openSettlement({ cycleId: cycle, winningSide: 'BOMBAY', betsTotal: 1, stakePaise: 5_000 });
    await completeSettlement({ cycleId: cycle });

    const found = (await findIncompleteSettlements()).find((s) => s.cycleId === cycle);
    expect(found, 'a locked stake went undetected').toBeDefined();
    expect(found.status).toBe('COMPLETED');
    expect(found.stillPending).toBe(1);
  });

  it('stays silent on a run that is still RUNNING', async () => {
    // An open run with pending bets is the NORMAL mid-settlement state. Paging
    // on it would make the alert meaningless within one cycle.
    const cycle = nextCycle();
    await placeBet({
      betId: `${cycle}_b1`, userId: USER, cycleId: cycle, side: 'DELHI',
      slices: [{ field: 'depositBalance', amountPaise: 5_000 }],
    });
    await openSettlement({ cycleId: cycle, winningSide: 'BOMBAY', betsTotal: 1, stakePaise: 5_000 });

    const found = (await findIncompleteSettlements()).find((s) => s.cycleId === cycle);
    expect(found, 'an in-progress settlement was reported as stalled').toBeUndefined();
  });
});

describe('cron wiring', () => {
  it('is actually called from the reconcile cron', async () => {
    // The point of this whole change. Asserted against the source rather than
    // by running the cron, because the failure being guarded is a MISSING call
    // site — and a test that mocked the cron would pass with no call site at
    // all, which is precisely the state this replaced.
    const cron = await readFile(new URL('../../startup/cronJobs.js', import.meta.url), 'utf8');
    expect(cron).toMatch(/findIncompleteSettlements\(\)/);
    expect(cron).toMatch(/stalledSettlements\.set/);
    expect(cron).toMatch(/settlement-stalled/);
  });
});
