// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║                        GAME_CORE.ts  — v1.0.0                          ║
 * ║              SINGLE SOURCE OF TRUTH FOR ALL GAME LOGIC                 ║
 * ╠══════════════════════════════════════════════════════════════════════════╣
 * ║  THIS FILE IS THE AUTHORITY. Every cycle phase, payout formula,        ║
 * ║  winner rule, celebration timing, and phantom equalizer behaviour       ║
 * ║  is defined here and ONLY here.                                         ║
 * ║                                                                          ║
 * ║  HOW TO USE                                                              ║
 * ║  ──────────                                                              ║
 * ║  Place this file at: src/GAME_CORE.ts  (root of your source tree)      ║
 * ║                                                                          ║
 * ║  Then import in every file that needs it:                               ║
 * ║    import { PHASE, WINNER, PAYOUT, CELEBRATION } from '../GAME_CORE';   ║
 * ║                                                                          ║
 * ║  Files that MUST import from here:                                       ║
 * ║    services/GameContext.tsx   — calculateStatus(), tick()               ║
 * ║    components/Game/CycleControl.tsx — status labels                     ║
 * ║    components/Game/BettingCard.tsx  — isLocked, celebration display     ║
 * ║    components/Game/WinnerCelebration.tsx — timing + display             ║
 * ║    services/realBackend.ts          — (reference only, server enforces) ║
 * ║                                                                          ║
 * ║  DO NOT copy-paste these values into individual files.                  ║
 * ║  DO NOT override these values in GameContext or anywhere else.          ║
 * ║  IF you need to change a timing, change it HERE and ONLY HERE.         ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 */

import { CycleType, GameState, BettingSide } from './types';

// ─────────────────────────────────────────────────────────────────────────────
// 1. CYCLE PHASE TIMINGS
//    All values are in MILLISECONDS from the END of the cycle.
//    Example: THIRTY_MIN.MERGE_AT = 180000 means the MERGED phase starts
//    when there are 180 000 ms (3 minutes) left on the timer.
// ─────────────────────────────────────────────────────────────────────────────

export const PHASE = Object.freeze({

  THIRTY_MIN: Object.freeze({
    /** Total cycle duration: 30 minutes */
    DURATION_MS: 30 * 60 * 1000,                    // 1 800 000 ms

    /**
     * MERGED phase starts when timer shows 03:00.
     * At this point the displayed pools are combined so users cannot see
     * which side has more real bets. Real bets can still be placed (blind).
     */
    MERGE_AT_MS: 3 * 60 * 1000,                     // 180 000 ms  →  timer: 03:00

    /**
     * Phantom Equalizer fires at 02:00.
     * Server matches the lower phantom side up to the higher phantom side.
     * After this moment no new phantom bets are accepted.
     * This is SERVER-SIDE ONLY — the client just stays in MERGED state.
     * Included here for documentation and admin tooling reference.
     */
    PHANTOM_EQUALIZER_AT_MS: 2 * 60 * 1000,         // 120 000 ms  →  timer: 02:00

    /**
     * CLOSED phase starts when timer shows 00:30.
     * All real bets are locked. No new bets of any kind accepted.
     */
    CLOSE_AT_MS: 30 * 1000,                          // 30 000 ms   →  timer: 00:30

    /**
     * RESULT_DECLARED / Winner Celebration starts when timer shows 00:10.
     * Winner is announced, fireworks + shimmer begin, payouts are processed.
     * This phase lasts exactly 10 seconds until the next cycle starts.
     */
    CELEBRATE_AT_MS: 10 * 1000,                     // 10 000 ms   →  timer: 00:10
  }),

  FULL_DAY: Object.freeze({
    /** Total cycle duration: 24 hours, ends at 18:00 IST */
    DURATION_MS: 24 * 60 * 60 * 1000,               // 86 400 000 ms

    /**
     * MERGED phase starts when timer shows 05:00:00.
     * Same blind-betting rules as 30-MIN.
     */
    MERGE_AT_MS: 5 * 60 * 1000,                     // 300 000 ms  →  timer: 05:00

    /**
     * Phantom Equalizer at 04:00 remaining (server-side only).
     */
    PHANTOM_EQUALIZER_AT_MS: 2 * 60 * 1000,         // 120 000 ms  →  timer: 02:00

    /**
     * CLOSED phase at 00:30 remaining.
     */
    CLOSE_AT_MS: 30 * 1000,                          // 30 000 ms   →  timer: 00:30

    /**
     * Celebration starts at 00:10 remaining.
     */
    CELEBRATE_AT_MS: 10 * 1000,                     // 10 000 ms   →  timer: 00:10
  }),

});

// ─────────────────────────────────────────────────────────────────────────────
// 2. WINNER DETERMINATION RULE
//    THE SIDE WITH FEWER REAL BETS WINS.
//    Phantom bets are equalizer bets — they balance the display pool but
//    are NOT counted in winner determination. Only realDelhi and realBombay
//    matter here.
//
//    Tiebreaker: if realDelhi === realBombay the server picks DELHI by default
//    (configurable on server, but client must honour whatever the server sends).
// ─────────────────────────────────────────────────────────────────────────────

export const WINNER = Object.freeze({

  /**
   * Client-side winner calculation.
   * Call this ONLY if the server has not yet sent a winner (e.g. preview).
   * In production the server's winner field is always the authority.
   *
   * @param realDelhi  - total REAL bets placed on Delhi (no phantom included)
   * @param realBombay - total REAL bets placed on Bombay (no phantom included)
   * @returns the winning BettingSide
   */
  determine(realDelhi: number, realBombay: number): BettingSide {
    // Lower real bets side wins
    if (realDelhi < realBombay) return BettingSide.DELHI;
    if (realBombay < realDelhi) return BettingSide.BOMBAY;
    // Exact tie → DELHI wins (house tiebreaker, matches server)
    return BettingSide.DELHI;
  },

  /**
   * Human-readable description of the rule.
   * Use this in the rules/FAQ page so it is always in sync with the code.
   */
  RULE_DESCRIPTION: 'The side with fewer total real bets placed wins the cycle.',

  /**
   * Tiebreaker description.
   */
  TIE_DESCRIPTION:  'In the event of an exact tie, DELHI wins by default.',
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. PAYOUT FORMULA  ★ FIXED ★
//
//    RULE: Winners receive exactly 2× their bet amount.
//          Losers forfeit their entire bet.
//          House profit = realHigherPool − realLowerPool
//                       = the surplus on the losing side that was never matched.
//
//    Phantom bets are NEVER included in any payout calculation.
//    Only realDelhi and realBombay matter here.
//
//    Example A — Delhi wins (lower real bets):
//      realDelhi  = 1 000  ← winner
//      realBombay = 2 000  ← loser
//      A user bet ₹100 on Delhi  → payout = ₹100 × 2 = ₹200
//      A user bet ₹500 on Bombay → payout = ₹0  (lost)
//      House profit = 2 000 − 1 000 = ₹1 000
//        (the 1 000 on Delhi is fully matched by 1 000 of the Bombay pool;
//         the remaining 1 000 from Bombay is unmatched → house keeps it)
//
//    Example B — Bombay wins (lower real bets):
//      realDelhi  = 5 000  ← loser
//      realBombay = 3 000  ← winner
//      A user bet ₹200 on Bombay → payout = ₹200 × 2 = ₹400
//      House profit = 5 000 − 3 000 = ₹2 000
// ─────────────────────────────────────────────────────────────────────────────

export const PAYOUT = Object.freeze({

  /**
   * Display/estimate mirror of the payout multiplier. The AUTHORITATIVE value is
   * server-side: SystemConfig.payoutMultiplier (Business Config Audit 2026-07-11),
   * read by markets/gameEngine.js at settlement and pushed to clients in the
   * `system_config` event's payoutMultiplier field. This 2 is the default/offline
   * fallback only — prefer the server-pushed value for any user-facing number.
   * Do not treat this constant as the source of truth for real credited amounts.
   */
  MULTIPLIER: 2,

  /**
   * Calculate the payout for a single winning bet.
   *
   * @param userBetAmount - the BB Token amount this user bet on the winning side
   * @returns             - what gets credited to the user's winningsBalance
   *
   * Formula: userBetAmount × MULTIPLIER
   * The stake is included in the return (i.e. user gets back bet + equal profit).
   */
  calculate(userBetAmount: number): number {
    return Math.floor(userBetAmount * PAYOUT.MULTIPLIER);
  },

  /**
   * Calculate the house profit for an entire cycle.
   * Called server-side after winner is determined.
   *
   * @param realWinnerPool - total REAL bets on the winning (lower) side
   * @param realLoserPool  - total REAL bets on the losing  (higher) side
   * @returns              - tokens kept by the house
   *
   * Formula: realLoserPool − realWinnerPool
   *   The winner pool is fully matched (winners get 2× back, funded by losers).
   *   The unmatched excess from the loser pool is house profit.
   */
  houseProfit(realWinnerPool: number, realLoserPool: number): number {
    // losers always outnumber winners (winner = lower side), so this is always ≥ 0
    return Math.max(0, realLoserPool - realWinnerPool);
  },

  /**
   * Human-readable payout rule. Use this on the Rules/FAQ page so it is
   * always in sync with the actual code.
   */
  RULE_DESCRIPTION:
    'Winners receive 2× their bet in BB Tokens. ' +
    'Losers forfeit their entire bet. ' +
    'The house earns the difference between the two sides\' real bet pools.',

  /** Label shown on bet chips / UI */
  MULTIPLIER_LABEL: '2×',
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. PHANTOM EQUALIZER RULES
//
//    WHAT ARE PHANTOM BETS?
//      Phantom bets are fake bets placed by phantom managers (special admin role).
//      They exist purely to inflate the displayed pool sizes so real users
//      cannot see the true imbalance between sides.
//      Phantom bets NEVER win. Phantom managers NEVER receive payouts.
//      They only affect totalDelhi / totalBombay (the display numbers).
//
//    THE FOUR POOL FIELDS IN THE DATABASE:
//      realDelhi    — actual money bet by real users on Delhi
//      realBombay   — actual money bet by real users on Bombay
//      phantomDelhi — fake bets placed by phantom managers on Delhi
//      phantomBombay— fake bets placed by phantom managers on Bombay
//      totalDelhi   = realDelhi  + phantomDelhi   ← what USER PANEL shows
//      totalBombay  = realBombay + phantomBombay  ← what USER PANEL shows
//      Admin panel shows realDelhi and realBombay separately (the real split).
//
//    FULL WORKED EXAMPLE (what the user sees vs what actually matters):
//      User A bets ₹100 on Delhi        → realDelhi        = 100
//      User B bets ₹200 on Bombay       → realBombay       = 200
//      Phantom mgr bets ₹100,000 Delhi  → phantomDelhi     = 100,000
//      Phantom mgr bets ₹200,000 Bombay → phantomBombay    = 200,000
//
//      User panel shows:   Delhi ₹100,100  |  Bombay ₹200,200
//      Admin panel shows:  Delhi ₹100 real |  Bombay ₹200 real
//
//    THE EQUALIZER (runs at PHANTOM_EQUALIZER_AT_MS before cycle end):
//      RULE: raise the LOWER phantom side to match the HIGHER phantom side.
//            i.e. both sides = max(phantomDelhi, phantomBombay)
//
//      Before equalizer: phantomDelhi=100,000   phantomBombay=200,000
//      After  equalizer: phantomDelhi=200,000   phantomBombay=200,000  ← both = max
//
//      New displayed totals after equalizer:
//        Delhi  = realDelhi(100)  + phantomDelhi(200,000)  = 200,100
//        Bombay = realBombay(200) + phantomBombay(200,000) = 200,200
//
//      Users now see near-equal pools and CANNOT tell Delhi has fewer real bets.
//      After equalization: no new phantom bets (phantomBetsClosed = true).
//      Real user bets CAN still be placed during MERGED phase (blind betting).
//      The phantom_equalized event is sent to ADMIN ROOM ONLY — never to users.
//
//    WINNER RULE (unchanged by phantom — only real bets decide):
//      Winner = the side with FEWER real bets.
//      realDelhi=100, realBombay=200 → DELHI WINS (100 < 200)
//      The phantom bets (200,100 vs 200,200) are completely irrelevant to the winner.
//      See section 2 (WINNER) above for the full determination logic.
//
//    PAYOUT (phantom bets excluded entirely):
//      Only real users on the winning side get 2x payouts.
//      House profit = realBombay(200) − realDelhi(100) = ₹100
//      The phantom amounts (₹200,000 each side) do not enter the profit formula.
//      See section 3 (PAYOUT) above for the full formula.
// ─────────────────────────────────────────────────────────────────────────────

export const PHANTOM = Object.freeze({

  /**
   * Apply the phantom equalization rule.
   * This mirrors exactly what the server does.
   * Use for admin preview / server validation reference only.
   *
   * @param phantomDelhi  - phantom bets currently on Delhi
   * @param phantomBombay - phantom bets currently on Bombay
   * @returns { newPhantomDelhi, newPhantomBombay } after equalization
   */
  equalize(phantomDelhi: number, phantomBombay: number): { newPhantomDelhi: number; newPhantomBombay: number } {
    const maxPhantom = Math.max(phantomDelhi, phantomBombay);
    return { newPhantomDelhi: maxPhantom, newPhantomBombay: maxPhantom };
  },

  /**
   * Phantom bets are NEVER counted in winner determination.
   * Phantom bets are NEVER counted in payout calculations.
   * They only affect the displayed pool totals shown to users.
   */
  COUNTS_FOR_WINNER:  false,
  COUNTS_FOR_PAYOUT:  false,
  COUNTS_FOR_DISPLAY: true,
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. CELEBRATION & FIREWORKS CONFIG
//    Controls how the winner celebration looks and how long it runs.
// ─────────────────────────────────────────────────────────────────────────────

export const CELEBRATION = Object.freeze({

  /**
   * Celebration starts this many ms before cycle end (matches CELEBRATE_AT_MS).
   * It runs until the cycle ends and the next one starts.
   */
  DURATION_MS: 10 * 1000,  // 10 seconds

  /** Number of particle bursts rendered on screen simultaneously */
  PARTICLE_COUNT: 40,

  /** Each burst re-fires every N milliseconds while celebration is active */
  BURST_INTERVAL_MS: 2500,

  /** Colors for the Delhi (red) winning celebration */
  DELHI_COLORS:  ['#E53935', '#FF6659', '#FFD700', '#FFFFFF', '#FF8A65'] as const,

  /** Colors for the Bombay (blue) winning celebration */
  BOMBAY_COLORS: ['#1E88E5', '#64B5F6', '#FFD700', '#FFFFFF', '#80DEEA'] as const,

  /** Fallback gold colors when winner is not yet known */
  NEUTRAL_COLORS: ['#FFD700', '#FFF176', '#FFCA28', '#FFFFFF', '#FFB300'] as const,

  /** Card shimmer animation duration in seconds */
  SHIMMER_DURATION_S: 1.8,

  /** Second shimmer pass delay (gold sweep) in seconds */
  SHIMMER_DELAY_S: 1.1,
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. PHASE STATE MACHINE
//    The single function every component must use to determine the current
//    GameState from a cycle's endTime and the current server-corrected time.
//    NEVER reimplement this inline — always import and call PHASE.getStatus().
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Derive the current GameState from timing alone.
 *
 * @param type      CycleType.THIRTY_MIN | CycleType.FULL_DAY
 * @param nowMs     Current time in ms — MUST be server-corrected (Date.now() + serverTimeOffset)
 * @param endTimeMs The cycle's endTime in ms
 * @returns         The correct GameState for this moment
 */
export function getPhaseStatus(type: CycleType, nowMs: number, endTimeMs: number): GameState {
  const cfg      = type === CycleType.THIRTY_MIN ? PHASE.THIRTY_MIN : PHASE.FULL_DAY;
  const timeLeft = endTimeMs - nowMs;

  if (timeLeft <= 0)                    return GameState.RESULT_DECLARED; // cycle over
  if (timeLeft <= cfg.CELEBRATE_AT_MS)  return GameState.RESULT_DECLARED; // 00:10 → celebrate
  if (timeLeft <= cfg.CLOSE_AT_MS)      return GameState.CLOSED;           // 00:30 → lock bets
  if (timeLeft <= cfg.MERGE_AT_MS)      return GameState.MERGED;           // 03:00 / 05:00 → merge
  return GameState.OPEN;
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. PHASE LABELS & UI COLOURS
//    Used by CycleControl and any other component that shows phase status.
//    Import PHASE_UI instead of writing ternary chains in components.
// ─────────────────────────────────────────────────────────────────────────────

export const PHASE_UI = Object.freeze({
  [GameState.OPEN]: Object.freeze({
    label:    'NEXT RESULT IN',
    color:    '#25D366',           // green
    dotClass: 'bg-[#25D366] shadow-[#25D366]',
    textClass:'text-[#25D366]',
  }),
  [GameState.MERGED]: Object.freeze({
    label:    '⚡ POOLS MERGED',
    color:    '#FB8C00',           // orange
    dotClass: 'bg-orange-400 shadow-orange-400',
    textClass:'text-orange-400',
  }),
  [GameState.CLOSED]: Object.freeze({
    label:    '🔒 BETS CLOSED',
    color:    '#EF5350',           // red
    dotClass: 'bg-red-400 shadow-red-400',
    textClass:'text-red-400',
  }),
  [GameState.RESULT_DECLARED]: Object.freeze({
    label:    '🎉 WINNER DECLARED',
    color:    '#FFD700',           // gold
    dotClass: 'bg-[#FFD700] shadow-[#FFD700]',
    textClass:'text-[#FFD700]',
  }),
  [GameState.PAUSED]: Object.freeze({
    label:    '⏸ PAUSED',
    color:    '#9E9E9E',
    dotClass: 'bg-gray-400 shadow-gray-400',
    textClass:'text-gray-400',
  }),
  [GameState.CANCELLED]: Object.freeze({
    label:    '✖ CANCELLED',
    color:    '#9E9E9E',
    dotClass: 'bg-gray-500 shadow-gray-500',
    textClass:'text-gray-500',
  }),
} as Record<GameState, { label: string; color: string; dotClass: string; textClass: string }>);

// ─────────────────────────────────────────────────────────────────────────────
// 8. BETTING LOCK RULES
//    Defines exactly which phases allow which bet types.
//    Import BETTING_ALLOWED instead of writing phase checks inline.
// ─────────────────────────────────────────────────────────────────────────────

export const BETTING_ALLOWED = Object.freeze({
  /**
   * Can a REAL bet be placed in this phase?
   * OPEN  → yes.  MERGED → yes (blind).  CLOSED / RESULT_DECLARED → NO.
   */
  realBet(state: GameState): boolean {
    return state === GameState.OPEN || state === GameState.MERGED;
  },

  /**
   * Can a PHANTOM (admin) bet be placed in this phase?
   * OPEN → yes.  MERGED → yes BUT only until PHANTOM_EQUALIZER_AT_MS (server enforces).
   * CLOSED / RESULT_DECLARED → NO.
   */
  phantomBet(state: GameState): boolean {
    return state === GameState.OPEN || state === GameState.MERGED;
  },

  /**
   * Should the betting card UI show as locked (disabled buttons + overlay)?
   * Only CLOSED and RESULT_DECLARED lock the UI.
   */
  uiLocked(state: GameState): boolean {
    return state === GameState.CLOSED || state === GameState.RESULT_DECLARED;
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. CYCLE RESET
//    After a cycle ends (timer hits 00:00:000) the next cycle starts
//    automatically. The server creates the new cycle and emits 'new_cycle'.
//    The client's tick() resets when nowMs >= endTime.
//    New cycle timer starts from DURATION_MS (30:00 or 24:00:00).
// ─────────────────────────────────────────────────────────────────────────────

export const CYCLE_RESET = Object.freeze({
  /**
   * After this delay the new cycle is expected to be live on the server.
   * The client will retry refreshCycles() every RETRY_INTERVAL_MS
   * until it receives a valid new cycle ID.
   */
  GRACE_MS: 1000,           // 1 second — allow server to commit new cycle
  RETRY_INTERVAL_MS: 2000,  // retry every 2 seconds if server hasn't responded
  MAX_RETRIES: 5,
});

// ─────────────────────────────────────────────────────────────────────────────
// 10. QUICK REFERENCE — complete timeline in plain English
// ─────────────────────────────────────────────────────────────────────────────
//
//  ── 30-MINUTE CYCLE ────────────────────────────────────────────────────────
//
//  30:00  Cycle starts. State = OPEN.
//         Real bets: ✅ allowed
//         Phantom bets: ✅ allowed
//         Pools: shown separately (Delhi total | Bombay total)
//
//  03:00  State → MERGED.
//         Real bets: ✅ still allowed (blind — user cannot see pool sizes)
//         Phantom bets: ✅ still allowed (until 02:00)
//         Pools: merged display — users see combined total only
//
//  02:00  Phantom Equalizer fires (SERVER-SIDE ONLY).
//         Server sets both phantom sides to max(phantomDelhi, phantomBombay).
//         No new phantom bets accepted after this point.
//         Client state stays MERGED — no visible change on UI.
//
//  00:30  State → CLOSED.
//         Real bets: ❌ locked
//         Phantom bets: ❌ locked
//         UI: "BETS CLOSED" overlay on betting card
//
//  00:10  State → RESULT_DECLARED.
//         Winner = side with FEWER real bets (e.g. realDelhi < realBombay → DELHI wins)
//         Fireworks + shimmer start on winner card.
//         Full-screen WinnerCelebration overlay appears.
//         Payouts begin processing:
//           • Winners receive 2× their bet credited to winningsBalance
//           • Losers forfeit entire bet
//           • House profit = realLoserPool − realWinnerPool
//
//  00:00  Cycle ends. Next cycle created immediately.
//         Timer resets to 30:00. State → OPEN.
//
//  ── FULL-DAY CYCLE ─────────────────────────────────────────────────────────
//
//  Same as above except:
//    MERGED at 05:00 remaining (not 03:00)
//    Phantom Equalizer at 04:00 remaining (not 02:00)
//    CLOSED at 00:30 remaining (same)
//    RESULT_DECLARED at 00:10 remaining (same)
//    Cycle ends at 18:00 IST daily.
//
// ─────────────────────────────────────────────────────────────────────────────
