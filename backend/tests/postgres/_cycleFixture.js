// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * A cycle row for tests that place bets.
 *
 * `betPg.placeBet` takes the cycle's row lock and refuses when there is no row:
 * a stake on a cycle that does not exist belongs to nothing. Before the
 * `cycles` table existed the money tests bet against bare cycle-id strings,
 * which was only possible because nothing in the transaction consulted the
 * cycle — so these fixtures are not scaffolding around a new restriction, they
 * are the tests finally describing a state the system can actually be in.
 *
 * The window is far in the future by default, because most of these tests are
 * about money and not about the clock; the ones that ARE about the clock pass
 * an `endTime` of their own.
 */
import { ensureCycle, getCycle } from '../../postgres/cyclePg.js';

let block = 0;

/**
 * Create the cycle for `cycleId` and return it.
 *
 * Each call takes its own (type, start_at) block so the unique index cannot
 * collide between tests sharing the database.
 */
export async function givenCycle(cycleId, { type = '30_MIN', endTime = null, startTime = null } = {}) {
  // Idempotent on the cycle ID, not on the time block: several suites share one
  // fixed id ('cyc1') across many tests, and `ensureCycle` conflicts on
  // (type, start_at) — so a second call with a fresh block would try to insert
  // a duplicate cycle_id and fail the primary key rather than return the row.
  const existing = await getCycle(cycleId);
  if (existing) return existing;

  const start = startTime ?? (Date.now() - 3_600_000 + (block++ * 60_000));
  const { cycle } = await ensureCycle({
    cycleId,
    type,
    startTime: start,
    endTime: endTime ?? Date.now() + 86_400_000,
  });
  return cycle;
}
