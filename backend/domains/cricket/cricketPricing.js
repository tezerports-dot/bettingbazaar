// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * cricketPricing.js — the arithmetic of a cricket poll (owner, 2026-10-18;
 * docs/reference/CRICKET_OPINION_DESIGN.md §1–2). Pure and integer: money in
 * paise, odds ×100 (288 = 2.88), rates in basis points. The repository
 * (`database/repositories/cricket.js`) calls these under the poll's lock, and
 * the schema's `bb_cricket_book_bound` holds the result at commit.
 *
 *   odds_i   = (1 − spread) × T / P_i      T, P_i: seeds + live real stakes
 *   book_i   = stakes taken − claims paid − owed if option i wins
 *   bound    : book_i ≥ −(seed × options) for every option, always
 *
 * A bet's odds are worked out with its own stake already in the pool, then cut
 * to what the bound allows; below 1.01 the option takes no bet. A claim is the
 * position's payout × the option's pool share once the position's stake is
 * taken out, less the claim margin, held to the same bound and never more
 * than the payout.
 */

export const MIN_ODDS_X100 = 101;
const BP = 10000;

const big = (v) => BigInt(v);
const num = (v) => Number(v);

/** The poll's total pool, seeds included: every option's seed + its live stakes. */
function totalPool(seedPaise, pools) {
  return Object.values(pools).reduce((t, p) => t + seedPaise + p, 0);
}

/** floor((1 − spread) × total / onOption), ×100, in BigInt so no product overflows. */
function rawOddsX100(spreadBp, total, onOption) {
  if (onOption <= 0) return 0;
  return num((big(BP - spreadBp) * big(total) * 100n) / (big(BP) * big(onOption)));
}

/** The odds shown for every option now (a reference: a bet is priced again when it executes). */
export function displayOddsX100({ spreadBp, seedPaise, pools }) {
  const total = totalPool(seedPaise, pools);
  return Object.fromEntries(Object.entries(pools).map(([k, p]) => (
    [k, Math.max(MIN_ODDS_X100, rawOddsX100(spreadBp, total, seedPaise + p))])));
}

/** How far the house may still go on one option before the poll's bound. */
function roomOn(book, liabilityPaise) {
  return book.stakesPaise - book.claimsPaidPaise - liabilityPaise + book.seedPaise * book.optionCount;
}

/** `book` = { seedPaise, optionCount, stakesPaise, claimsPaidPaise } of the poll. */
export function quoteBet({ spreadBp, book, pools, liabilities, optionKey, stakePaise }) {
  if (!(optionKey in pools)) return { ok: false, reason: 'UNKNOWN_OPTION' };
  if (!Number.isInteger(stakePaise) || stakePaise <= 0) return { ok: false, reason: 'BAD_STAKE' };
  const total = totalPool(book.seedPaise, pools) + stakePaise;
  const onOption = book.seedPaise + pools[optionKey] + stakePaise;
  const raw = rawOddsX100(spreadBp, total, onOption);
  // floor(stake × odds / 100) must not exceed the room left on this option
  // once this stake is in: odds ≤ ((room + 1) × 100 − 1) / stake.
  const room = roomOn(book, liabilities[optionKey]) + stakePaise;
  const cap = room < 0 ? 0 : num((big(room + 1) * 100n - 1n) / big(stakePaise));
  const oddsX100 = Math.min(raw, cap);
  if (oddsX100 < MIN_ODDS_X100) return { ok: false, reason: 'OPTION_SUSPENDED' };
  return {
    ok: true, oddsX100, capped: oddsX100 < raw,
    potentialPaise: num((big(stakePaise) * big(oddsX100)) / 100n),
  };
}

/**
 * The winnings fee (the platform's global percent) on a payout: on the whole
 * payout, stake and profit together, rounded down, as on the board games
 * (`computeWinningsPayout`; owner, 2026-10-19).
 */
export function winningsFeePaise(grossPaise, feeBp) {
  if (grossPaise <= 0 || feeBp <= 0) return 0;
  return num((big(grossPaise) * big(feeBp)) / big(BP));
}

/**
 * What claiming one open position pays now. `bet` = { optionKey, stakePaise,
 * potentialPaise }. Returns the gross value, the fee and what reaches the
 * player (net), all held to the poll's bound after the claim.
 */
export function quoteClaim({ book, pools, liabilities, bet, feeBp }) {
  const { optionKey, stakePaise, potentialPaise } = bet;
  const total = totalPool(book.seedPaise, pools) - stakePaise;
  const onOption = book.seedPaise + pools[optionKey] - stakePaise;
  const fair = total <= 0 ? 0 : num((big(potentialPaise) * big(Math.max(0, onOption))) / big(total));
  // No margin on a claim: the spread was taken when the bet was placed (owner, 2026-10-19).
  let gross = Math.min(potentialPaise, fair);
  // After the claim, every option's room must stay ≥ 0 with what the house pays.
  const after = { ...liabilities, [optionKey]: liabilities[optionKey] - potentialPaise };
  const maxPay = Math.min(...Object.values(after).map((l) => roomOn(book, l)));
  let fee = winningsFeePaise(gross, feeBp);
  if (gross - fee > maxPay) {
    gross = Math.max(0, maxPay);
    fee = winningsFeePaise(gross, feeBp);
  }
  return { grossPaise: gross, feePaise: fee, netPaise: gross - fee };
}
