// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * cricketValue.ts — what an open cricket position is worth now, worked out on
 * the phone from the pools the server broadcasts (`cricket_odds`), so the
 * server never prices every player's positions every second (owner,
 * 2026-10-18). A §11 DISPLAY mirror of `quoteClaim` and `winningsFeePaise`
 * (backend/domains/cricket/cricketPricing.js), without the book cap: the
 * figure that counts is the server's quote, asked when the player taps Claim.
 */

export interface PoolOption { key: string; poolPaise: number }
export interface Position { optionKey: string; stakePaise: number; potentialPaise: number }

/** Mirror of `winningsFeePaise`: only on a payout above the stake, never below it. */
export function feeOn(grossPaise: number, stakePaise: number, feePercent: number): number {
  if (grossPaise <= stakePaise || feePercent <= 0) return 0;
  return Math.min(Math.floor((grossPaise * Math.round(feePercent * 100)) / 10000), grossPaise - stakePaise);
}

/**
 * The position's claim value now, net of the fee, from the pools on screen
 * (each option's `poolPaise` is the seed plus live stakes, as the server
 * sends it).
 */
export function positionValuePaise(options: PoolOption[], pos: Position, claimMarginPercent: number, feePercent: number): number {
  const total = options.reduce((t, o) => t + o.poolPaise, 0) - pos.stakePaise;
  const mine = options.find((o) => o.key === pos.optionKey);
  if (!mine || total <= 0) return 0;
  const onOption = Math.max(0, mine.poolPaise - pos.stakePaise);
  const fair = Math.floor((pos.potentialPaise * onOption) / total);
  const gross = Math.min(pos.potentialPaise, Math.floor((fair * (10000 - Math.round(claimMarginPercent * 100))) / 10000));
  return gross - feeOn(gross, pos.stakePaise, feePercent);
}

/**
 * The odds a bet of `stakePaise` on `optionKey` would get now, its own stake
 * in the pool: a §11 display mirror of `quoteBet` without the book cap
 * (backend/domains/cricket/cricketPricing.js). The server's quote is the figure.
 */
export function betOddsX100(options: PoolOption[], spreadBp: number, optionKey: string, stakePaise: number): number {
  const mine = options.find((o) => o.key === optionKey);
  if (!mine || stakePaise <= 0) return 0;
  const total = options.reduce((t, o) => t + o.poolPaise, 0) + stakePaise;
  const raw = Math.floor(((10000 - spreadBp) * total * 100) / (10000 * (mine.poolPaise + stakePaise)));
  return Math.max(101, raw); // MIN_ODDS_X100 (cricketPricing.js)
}
