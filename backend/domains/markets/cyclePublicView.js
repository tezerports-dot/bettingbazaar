// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
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
 * ── Store-independent, so it survives the money flip ────────────────────────
 * This projects whatever a cycle object carries, so it does not care whether
 * the pool totals come from Mongo `$inc`, the derived-from-bets projection
 * (`cyclePool.service.js`), or a Postgres counter after the money-authority
 * cutover. The public boundary is the same in every mode.
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

/**
 * ms epoch, whatever the field's runtime type. `startTime`/`endTime` are Number
 * on the schema, but a hydrated Date or an ISO string has slipped through
 * before and made the client countdown read NaN — normalise here once.
 */
const toMs = (d) => (d instanceof Date ? d.getTime() : Number(d));

/**
 * The safe pool numbers: combined totals only, never the real/phantom split.
 * Returned as both `delhiPool`/`bombayPool` and `totalDelhi`/`totalBombay` so
 * either frontend generation reads a value rather than `undefined` → 0.
 */
export function publicCyclePools(cycle) {
  const delhiPool = cycle.totalDelhi || 0;
  const bombayPool = cycle.totalBombay || 0;
  return { delhiPool, bombayPool };
}

/**
 * The standard public shape for a cycle, used by the user-facing HTTP routes.
 * Byte-for-byte the object `sanitiseCycleForUser` used to build by hand.
 */
export function publicCycleView(cycle) {
  const { delhiPool, bombayPool } = publicCyclePools(cycle);
  return {
    id:          cycle.cycleId,
    type:        cycle.type,
    status:      cycle.status,
    startTime:   toMs(cycle.startTime),
    endTime:     toMs(cycle.endTime),
    delhiPool,
    bombayPool,
    totalDelhi:  delhiPool,
    totalBombay: bombayPool,
    totalPool:   delhiPool + bombayPool,
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
  }
  return payload;
}
