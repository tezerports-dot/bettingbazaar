// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
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
 * ║  Place this file at: user-panel/src/GAME_CORE.ts      ║
 * ║                                                                          ║
 * ║  Then import in every file that needs it:                               ║
 * ║    import { WINNER, PAYOUT } from '../GAME_CORE';                       ║
 * ║                                                                          ║
 * ║  Files that MUST import from here:                                       ║
 * ║    redesign/GameScreen.tsx    — canPlaceBet (stop offering a late bet)   ║
 * ║    types.ts                   — the shared phase/winner unions           ║
 * ║                                                                          ║
 * ║  This roster named components/Game/{CycleControl,BettingCard,            ║
 * ║  WinnerCelebration}.tsx. None had been mounted since RedesignShell       ║
 * ║  replaced Layout/Header, and that directory no longer exists. It is      ║
 * ║  rebuilt from what actually imports this file (§14: no committed         ║
 * ║  artifact describes something that is not there).                        ║
 * ║                                                                          ║
 * ║  DO NOT copy-paste these values into individual files.                  ║
 * ║  DO NOT override these values in GameContext or anywhere else.          ║
 * ║  IF you need to change a timing, change it HERE and ONLY HERE.         ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 */

import { BettingSide } from './types';

// ─────────────────────────────────────────────────────────────────────────────
// 1. CYCLE PHASE TIMINGS
//    Each board's own (`GET /api/v1/boards`, the server's `boards` row): an
//    admin creates boards with their own timers (owner, 2026-10-08), so there is
//    no fixed per-board table here. The panel reads `board.phases`.
// ─────────────────────────────────────────────────────────────────────────────

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
// 5. WHEN TO STOP OFFERING A BET
//    The cycle's PHASE is server-authoritative (cycle_update events); the client
//    derives none of it. What the client does own is a courtesy: stop offering a
//    stake it cannot land in time. See §11 of CLAUDE.md — display only.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Safety margin between when the CLIENT stops accepting a stake and when the
 * SERVER stops accepting one.
 *
 * The server closes betting on the clock at `endTime - closeBeforeEndSec`
 * (bet.routes.js), and `canPlaceBet` below reads the same offset from the same
 * wall clock, so in principle they agree — but a stake
 * submitted at T−5.2s does not ARRIVE at T−5.2s. It crosses a mobile network
 * first, and lands at T−4.8s, where the server correctly rejects it.
 *
 * Without this margin the player sees an open board, taps, and gets an error
 * for a bet they placed in time. The fix is not to loosen the server (its
 * cutoff is what stops a stake landing after the pools are balanced) but to
 * have the client stop offering the bet slightly earlier than the deadline it
 * cannot make.
 *
 * Absolute, not proportional: it models network latency and clock-sync error,
 * neither of which scales with how long a cycle runs. 1.5s covers a slow
 * Indian mobile round trip with room to spare, and costs a 60-second board
 * 1.5 of its 55 betting seconds.
 *
 * This is a COURTESY, never a control. The server gate is the only thing that
 * actually stops a late bet — anything the client enforces can be skipped by
 * calling the API directly.
 */
export const BET_SUBMIT_MARGIN_MS = 1500;

/**
 * Whether the client should still OFFER a bet on this cycle.
 *
 * Not the cycle's phase — that comes from the server, so the countdown and the
 * MERGED/CLOSED labels stay honest. This is the narrower question of whether a
 * tap right now would still arrive in time.
 */
export function canPlaceBet(closeBeforeEndSec: number, nowMs: number, endTimeMs: number): boolean {
  return (endTimeMs - nowMs) > (closeBeforeEndSec * 1000 + BET_SUBMIT_MARGIN_MS);
}
