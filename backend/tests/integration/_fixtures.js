// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * Fixtures for the integration suites that place real bets.
 *
 * Both helpers here exist for the same reason: these files predate the money
 * path moving to PostgreSQL, and each declares its world in MongoDB alone. A
 * cycle document without a `cycles` row is not bettable, and a user document
 * with `depositBalance: 500` has no money — the balance the debit reads lives
 * in `wallets`.
 */

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
import { applyDeltaPaise } from '../../postgres/walletPg.js';

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

/** The pockets a fixture can declare on a Mongo user document. */
const POCKETS = ['depositBalance', 'winningsBalance', 'reserveBalance'];

/**
 * Give a user the money their Mongo document says they have.
 *
 * `User.create({ depositBalance: 500 })` funds nothing: `betPg.placeBet` debits
 * the `wallets` row under that user's lock, and a user with no row has a
 * balance of zero. The placement is refused `insufficient`, and the route
 * answers 400 — which reads as a wallet problem in a test whose wallet was
 * never the subject.
 *
 * This MIRRORS whatever the document declares rather than taking its own
 * amounts, so each suite keeps stating its intent where it already states it —
 * including `betFlow`'s deliberately underfunded user, whose ₹9 across three
 * pockets is the whole point of that case.
 *
 *     const user = await funded(User.create({ …, depositBalance: 100 }));
 */
export async function funded(pending) {
  const user = await pending;
  if (!user?._id) throw new Error('funded(): needs a user document with an _id');
  for (const field of POCKETS) {
    const paise = Math.round(Number(user[field] || 0) * 100);
    if (paise <= 0) continue;
    await applyDeltaPaise({
      userId: String(user._id), field, deltaPaise: paise,
      // Keyed on the user and pocket, so a suite that re-runs against a shared
      // database credits once rather than compounding.
      txId: `fixture_fund_${user._id}_${field}`,
      type: 'CREDIT', reason: 'integration fixture funding',
    });
  }
  return user;
}
