// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * domains/markets/cyclePublicView.js — the ONE public projection of a cycle.
 *
 * ── Why this is a security boundary, not a formatting helper ─────────────────
 * The winner is the MINORITY real-bet side (`cycleGenerator.completeCycle`), so
 * `realDelhi`/`realBombay` DISCLOSE THE OUTCOME before it is declared — a player
 * who can see the real pools knows which side will win and can bet it.
 * `phantomDelhi`/`phantomBombay` expose the house's balancing, and
 * `phantomBetsClosed`/`phantomBalanced` leak the same by timing.
 *
 * None of these may EVER reach a browser. The frontend is public code, so "the
 * panel doesn't render it" is not protection — if the field is in the HTTP body
 * or the socket payload, it is exposed in devtools regardless. The only safe
 * thing to send is the COMBINED total (`real + phantom`), which is what users
 * were already watching during betting and reveals nothing.
 *
 * ── One boundary, on purpose ────────────────────────────────────────────────
 * Every public HTTP response and public socket/SSE emit about a cycle goes
 * through here. Admin routes and `emitAdmin`/`admin-room` keep the raw six
 * fields — that is their job. Before this module the whitelist was hand-written
 * in three places (`sanitiseCycleForUser`, the history route, the snapshot
 * builder); three copies are three chances to forget a field, which is exactly
 * how a leak ships. `cyclePublicView.test.js` asserts no forbidden field can
 * cross this line.
 *
 * ── Independent of where the totals come from ───────────────────────────────
 * This projects whatever a cycle object carries, so it does not care whether
 * the pool totals are the phantom figures on the row or the real ones derived
 * from `bets` (`cyclePool.service.js`). The public boundary is the same either
 * way — which matters, because the real totals are exactly what must not
 * cross it.
 */

/**
 * Fields that must never appear in a payload sent to a non-admin client.
 * Frozen so a caller cannot mutate the list out from under the guard.
 */
export const FORBIDDEN_PUBLIC_CYCLE_FIELDS = Object.freeze([
  'realDelhi', 'realBombay',
  'phantomDelhi', 'phantomBombay',
  'phantomBetsClosed', 'phantomBalanced',
]);

/** The per-side pool fields, under every name a public payload has used. */
const HIDDEN_SIDE_FIELDS = Object.freeze([
  'delhiPool', 'bombayPool', 'totalDelhi', 'totalBombay', 'newTotalDelhi', 'newTotalBombay',
]);

/**
 * ms epoch, whatever the field's runtime type. `startTime`/`endTime` are Number
 * on the schema, but a hydrated Date or an ISO string has slipped through
 * before and made the client countdown read NaN — normalise here once.
 */
const toMs = (d) => (d instanceof Date ? d.getTime() : Number(d));

/**
 * Whether a cycle's per-side pools are withheld from players (owner,
 * 2026-10-08): from the merge until a winner is declared, and on any cycle
 * whose house pools are already balanced, i.e. an OPEN cycle the ticker has not
 * yet moved to MERGED.
 *
 * `equalizePhantomPools` sets both house pools to the same figure, so after it
 * the two combined sides differ by real money alone, and the smaller one is the
 * winner (`cycleGenerator.completeCycle`) while blind betting is still open.
 * The screen hiding them was not enough: they were still in every payload.
 */
export function poolsHidden(cycle) {
  if (cycle.winner) return false;
  return cycle.status === 'MERGED' || cycle.status === 'CLOSED' || cycle.phantomBalanced === true;
}

/**
 * The safe pool numbers: combined totals only, never the real/phantom split,
 * and while `poolsHidden` the total of both sides alone (`poolsHidden: true`,
 * `totalPool`, no side). Otherwise both `delhiPool`/`bombayPool` and
 * `totalDelhi`/`totalBombay`, so either frontend generation reads a value
 * rather than `undefined` → 0.
 */
export function publicCyclePools(cycle) {
  const delhi = cycle.totalDelhi || 0;
  const bombay = cycle.totalBombay || 0;
  const totalPool = delhi + bombay;
  if (poolsHidden(cycle)) return { poolsHidden: true, totalPool };
  return {
    poolsHidden: false,
    delhiPool: delhi, bombayPool: bombay,
    totalDelhi: delhi, totalBombay: bombay,
    totalPool,
  };
}

/**
 * The standard public shape for a cycle, used by the user-facing HTTP routes.
 * Byte-for-byte the object `sanitiseCycleForUser` used to build by hand.
 */
export function publicCycleView(cycle) {
  return {
    id:          cycle.cycleId,
    type:        cycle.type,
    audience:    cycle.audience,
    status:      cycle.status,
    startTime:   toMs(cycle.startTime),
    endTime:     toMs(cycle.endTime),
    ...publicCyclePools(cycle),
    winner:      cycle.winner    || null,
    isSettled:   cycle.isSettled || 'PENDING',
    // NEVER included: realDelhi, realBombay, phantomDelhi, phantomBombay,
    // phantomBetsClosed, phantomBalanced — see FORBIDDEN_PUBLIC_CYCLE_FIELDS.
  };
}

/**
 * Last line of defence for a HAND-BUILT public payload (the live emits that add
 * timing fields and cannot use `publicCycleView` verbatim). Throws if any
 * forbidden field is present, so a leak fails loudly in tests and dev rather
 * than shipping silently to a browser. Returns the payload for chaining.
 */
export function assertPublicCycleSafe(payload) {
  if (payload && typeof payload === 'object') {
    for (const key of Object.keys(payload)) {
      // Naming-independent: catches the canonical `realDelhi` AND the broadcast
      // variants (`newRealDelhi`, `newPhantomBombay`, …). No legitimate public
      // cycle field contains "real" or "phantom" — the safe pools are `total*`
      // / `*Pool`, the timing is `timeRemaining*`, so this cannot false-positive
      // on anything a user is meant to see.
      if (/real|phantom/i.test(key)) {
        throw new Error(
          `cyclePublicView: forbidden field '${key}' in a public cycle payload — `
          + 'real/phantom pools must never reach a non-admin client (they reveal the winner).',
        );
      }
    }
    // A hidden cycle carries its total alone (`poolsHidden`): a side figure
    // beside the flag is the leak the flag exists to stop.
    if (payload.poolsHidden === true) {
      for (const key of HIDDEN_SIDE_FIELDS) {
        if (key in payload) {
          throw new Error(`cyclePublicView: '${key}' in a public payload whose pools are hidden.`);
        }
      }
    }
  }
  return payload;
}
