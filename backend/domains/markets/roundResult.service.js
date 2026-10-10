// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Each player's own result for a round, the moment the winner is declared
 * (owner, 2026-10-10: "one user one cycle", not one notice per bet).
 *
 * Settlement moves the money afterwards and can take seconds on a busy round;
 * nothing about what a player won waits on it. The winner is decided, every
 * stake is fixed, and the payout rule is `computeWinningsPayout` — the same
 * function, fee and multiplier settlement uses — so the figure announced is
 * the figure paid. `payout_success` still follows from settlement with the
 * balances, and the player's screen prefers that amount once it lands.
 *
 * One `round_result` per player who staked on the cycle, down their own SSE
 * stream (`emitToPlayer`), summed over all their bets:
 *   { cycleId, winner, stakedPaise, payoutPaise }
 * payoutPaise > 0 is a win (net of the fee); 0 with a stake is a loss.
 *
 * Called by both paths that declare a winner (the engine's adjudication and
 * the admin FORCE_RESULT), after `cycle_result`. Best-effort: the declaration
 * has committed, and a failed announcement must never reach it.
 */
import { db } from '#db';
import { getRiskRules, computeWinningsPayout } from '../risk/riskValidation.service.js';
import { emitToPlayer } from '../notification/realtimeEmitters.js';

/** Players per event-loop turn while fanning out. */
const ANNOUNCE_CHUNK = 500;

/**
 * Per player, from one row per bet: total staked and the net payout of the
 * bets on the winning side, each through `computeWinningsPayout` (the fee is
 * floored per bet, so summing stakes first would announce a different number).
 *
 * @param {Array<{userId:string, side:string, stakePaise:number}>} stakes
 * @param {string} winner  DELHI | BOMBAY
 * @param {{winningsFeePercent:number, payoutMultiplier:number}} rules
 * @returns {Array<{userId:string, stakedPaise:number, payoutPaise:number}>}
 */
export function roundResultsFor(stakes, winner, { winningsFeePercent, payoutMultiplier }) {
  const byUser = new Map();
  for (const s of stakes) {
    if (!(s.stakePaise > 0)) continue;
    const r = byUser.get(s.userId) ?? { userId: s.userId, stakedPaise: 0, payoutPaise: 0 };
    r.stakedPaise += s.stakePaise;
    if (s.side === winner) {
      // `net`, never a `payout` key — trap 1.
      r.payoutPaise += computeWinningsPayout({
        amount: s.stakePaise / 100, feePercent: winningsFeePercent, multiplier: payoutMultiplier,
      }).netMinor;
    }
    byUser.set(s.userId, r);
  }
  return [...byUser.values()];
}

/** @returns {Promise<number>} players told */
export async function announceRoundResults({ cycleId, winner }) {
  try {
    if (winner !== 'DELHI' && winner !== 'BOMBAY') return 0;
    const [rules, stakes] = await Promise.all([getRiskRules(), db.bets.cycleStakesByPlayer(cycleId)]);
    const results = roundResultsFor(stakes, winner, rules);
    for (let i = 0; i < results.length; i += 1) {
      const r = results[i];
      emitToPlayer(r.userId, 'round_result', {
        cycleId: String(cycleId), winner, stakedPaise: r.stakedPaise, payoutPaise: r.payoutPaise,
      });
      if ((i + 1) % ANNOUNCE_CHUNK === 0) await new Promise((res) => setImmediate(res));
    }
    return results.length;
  } catch (err) {
    console.warn(`[roundResult] announcement for ${cycleId} failed:`, err.message);
    return 0;
  }
}
