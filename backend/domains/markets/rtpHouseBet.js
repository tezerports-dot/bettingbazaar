// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The RTP house bet (owner, 2026-10-17): what one would cost, and whether the
 * fund can pay for it. Pure; the fund and the round row are
 * database/repositories/rtp.js, the call is cycleGenerator.placeRtpHouseBet.
 *
 * A house bet is a REAL bet, never a phantom one: the round's last bet, placed
 * once betting has closed, on the smaller real side and just big enough to
 * make it the bigger one. The lower side wins, so the side most players backed
 * wins instead. It is placed in ANY round the fund covers (owner, 2026-10-17):
 *
 *   paid back if flipped = Σ each bigger-side bet's payout BEFORE the fee (computeWinningsPayout gross)
 *   round's entry        = rate × real pool − paid back if flipped
 *   placed only when     fund available + round's entry ≥ 0
 *
 * So the fund pays the whole cost, the house's own share included, and never
 * goes below zero because of a house bet. The house bet is not in the pool,
 * moves no tokens (the house never stakes against itself) and never wins.
 */
import { computeWinningsPayout } from '../risk/riskValidation.service.js';

/** The house bet tops the smaller side to one rupee above the bigger one, so there is no tie. */
export const HOUSE_BET_MARGIN_PAISE = 100;

/**
 * @param {object} a
 * @param {{side:string, stakePaise:number}[]} a.stakes  every real player stake on the round
 * @param {number} a.rateBp            the fund's rate, basis points
 * @param {number} a.availablePaise    the fund less what unsettled house bets set aside
 * @param {number} a.feePercent        SystemConfig.winningsFeePercent
 * @param {number} a.multiplier        SystemConfig.payoutMultiplier
 * @returns {null | {side:string, stakePaise:number, reservedPaise:number, entryPaise:number}}
 */
export function planHouseBet({ stakes, rateBp, availablePaise, feePercent, multiplier }) {
  const pool = { DELHI: 0, BOMBAY: 0 };
  for (const s of stakes) pool[s.side] += s.stakePaise;
  if (pool.DELHI === pool.BOMBAY) return null; // a tie (or no bets): the draw decides, not the fund
  const bigger = pool.DELHI > pool.BOMBAY ? 'DELHI' : 'BOMBAY';
  const smaller = bigger === 'DELHI' ? 'BOMBAY' : 'DELHI';

  const paidBack = stakes
    .filter((s) => s.side === bigger)
    .reduce((sum, s) => sum + computeWinningsPayout({ amount: s.stakePaise / 100, feePercent, multiplier }).grossMinor, 0);
  const realPool = pool.DELHI + pool.BOMBAY;
  const entryPaise = Math.floor((rateBp * realPool) / 10000) - paidBack;
  if (availablePaise + entryPaise < 0) return null;

  return {
    side: smaller,
    stakePaise: pool[bigger] - pool[smaller] + HOUSE_BET_MARGIN_PAISE,
    reservedPaise: Math.max(0, -entryPaise),
    entryPaise,
  };
}
