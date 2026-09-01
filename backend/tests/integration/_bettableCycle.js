// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * A cycle a bet can actually be placed on.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * A cycle lives in two places while MongoDB is being removed, and a bet needs
 * BOTH. `betPg.placeBet` takes the `cycles` row's shared lock and reads the
 * cycle's state under it — that lock is what makes a bet and a settlement
 * mutually exclusive — so a cycle that exists only as a Mongo document is
 * refused with `cycle_not_found` before any money moves.
 *
 * Every integration fixture here predates the `cycles` table and creates the
 * Mongo document alone. They were therefore asking `/api/bet/place` for a 200
 * it could not return, and the route's answer looked like an unrelated problem:
 * a refused cycle fell into the same branch as a refused debit and came back as
 * "Insufficient balance", pointing at a wallet that was fine.
 *
 * Wrap the create and both rows exist:
 *
 *     const cycle = await bettable(Cycle.create({ … }));
 *
 * It is deliberately a wrapper rather than a `createCycle(...)` of its own, so
 * each suite keeps the Mongo document exactly as it had it — several assert on
 * fields (`realDelhi`, `isSettled`, `phantomBetsClosed`) that this helper has no
 * business choosing for them.
 */
import { ensureCycle } from '../../postgres/cyclePg.js';

/**
 * @param pending the in-flight `Cycle.create(...)`, or the document itself
 * @returns the Mongo document, once its PostgreSQL row exists
 */
export async function bettable(pending) {
  const doc = await pending;
  if (!doc?.cycleId) throw new Error('bettable(): needs a cycle document with a cycleId');
  await ensureCycle({
    cycleId: doc.cycleId,
    type: doc.type,
    startTime: new Date(doc.startTime).getTime(),
    endTime:   new Date(doc.endTime).getTime(),
  });
  return doc;
}
