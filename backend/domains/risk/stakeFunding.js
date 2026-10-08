// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * stakeFunding.js — which pockets a stake is drawn from, in integer paise.
 *
 * THE arithmetic of the bet-funding rule (owner specification §6, Phase A
 * 2026-07-10), with nothing to import and nothing to read, so the two places
 * that take a stake apply the same rule rather than two copies of it:
 *
 *   a board bet    `computeBetFundingPlan` (riskValidation.service.js), which
 *                  validates the request and plans the split for `placeBet`
 *   a casino BET   `recordCallback` (database/repositories/casino.core.js),
 *                  which splits the stake from the wallet row its transaction
 *                  holds locked (owner, 2026-10-08: "Yes, like boards")
 *
 * and the two places that say how much a player may stake read the same
 * ceiling: `computeMaxStake` (the board's bet limits) and the balance a casino
 * provider is told (`casino.spendableBalance`).
 *
 * The rule:
 *   - `reserveBp` basis points of the stake (`SystemConfig.betReservePercent`),
 *     floored, from the reserve — as far as the reserve covers it; a shortfall
 *     shifts to the main part (Spec 5.2C);
 *   - the main part from the deposit first, then winnings as overflow;
 *   - a main part deposit and winnings together cannot cover is refused.
 *
 * Validation of the inputs is the caller's: these take integers already.
 */

/** A percent (0–100, up to two decimals) as integer basis points. */
export function reserveBasisPoints(reservePercent) {
  return Math.round(reservePercent * 100);
}

/**
 * Split a stake of `amountMinor` paise across the three pockets.
 *
 * @returns {{fromReserveMinor:number, fromDepositMinor:number, fromWinningsMinor:number} | null}
 *          null when deposit and winnings cannot cover the main part — the
 *          stake is refused, never partly funded.
 */
export function splitStakeMinor({ amountMinor, reserveBp, depositMinor, winningsMinor, reserveMinor }) {
  const mainMinor         = mainNeededForMinor(amountMinor, reserveBp, reserveMinor);
  const fromReserveMinor  = amountMinor - mainMinor;
  const fromDepositMinor  = Math.min(mainMinor, depositMinor);
  const fromWinningsMinor = mainMinor - fromDepositMinor;
  if (fromWinningsMinor > winningsMinor) return null;
  return { fromReserveMinor, fromDepositMinor, fromWinningsMinor };
}

/**
 * How much of a stake of `amountMinor` deposit and winnings must cover, given
 * the reserve available. The one expression `splitStakeMinor` and
 * `maxStakeMinor` share, so the ceiling shown is the ceiling applied: two
 * expressions of "how much main does this stake need" would drift the first
 * time either is touched, and a player told they can bet ₹206 would be refused
 * at ₹206.
 */
function mainNeededForMinor(amountMinor, reserveBp, reserveMinor) {
  return amountMinor - Math.min(Math.floor(amountMinor * reserveBp / 10000), reserveMinor);
}

/**
 * The largest stake these pockets can fund, in paise.
 *
 * A search rather than algebra: `A − min(⌊A·bp/10000⌋, reserve)` is monotonic
 * but not invertible in closed form once the floor and the clamp are both in
 * play, and the boundary is exactly the number shown to the player. The search
 * is exact in ~40 integer steps and applies the same expression the split does.
 */
export function maxStakeMinor({ reserveBp, depositMinor, winningsMinor, reserveMinor }) {
  const mainAvailMinor = depositMinor + winningsMinor;
  let lo = 0;
  let hi = mainAvailMinor + reserveMinor;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (mainNeededForMinor(mid, reserveBp, reserveMinor) <= mainAvailMinor) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}
