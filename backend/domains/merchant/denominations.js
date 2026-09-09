// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * denominations.js — the fixed amounts the ATM cash rail deals in.
 *
 * ── Why these five numbers and not a range ─────────────────────────────────
 * On the CASH_ATM rail a buy is served by a merchant standing at an ATM: they
 * initiate a UPI cash withdrawal, the machine produces a payment link for a
 * fixed amount, the player pays it, and the merchant collects the dispensed
 * cash. So the amounts are what an ATM DISPENSES, not a pricing decision — a
 * range is not expressible at a cash machine.
 *
 * ₹40,000 is a WITHDRAWAL tier only. No buy order is ever that large (the INR
 * buy ceiling is ₹10,000), so it can only ever appear as a leg of a split
 * withdrawal. That is enforced by construction rather than by a rule: the buy
 * denominations a player may choose simply do not include it, so a 40,000
 * deposit cannot be created and the assignment query never has to exclude one.
 *
 * ── One merchant, one denomination ────────────────────────────────────────
 * A merchant is approved for exactly ONE of these and works only that: they
 * supply only links of that amount, receive only orders of that amount, and see
 * only that queue's depth. There is no second approval, which is why this is a
 * single column on `merchants` rather than a child table — "cannot hold two"
 * is then a property of the row instead of a rule a writer is trusted to keep.
 *
 * ── One owner, and a test that proves the database agrees ─────────────────
 * A CHECK constraint must spell its values out in SQL, so the list necessarily
 * appears twice: here and in `schema.sql`. Two copies of a value drift, so
 * `merchantDenominationsPg.test.js` asserts the database accepts exactly this
 * set and refuses everything else. The list is not admin-editable: adding a
 * denomination means a migration, which is correct for a number the assignment
 * queue, the buy screen and every merchant's approval all key on.
 */

/** Every denomination the cash rail knows, in integer paise. */
export const CASH_DENOMINATIONS_PAISE = Object.freeze([
  50_000,     // ₹500
  100_000,    // ₹1,000
  500_000,    // ₹5,000
  1_000_000,  // ₹10,000
  4_000_000,  // ₹40,000 — withdrawal legs only
]);

/**
 * The ceiling on a single INR buy, in paise. Above this a player buys with
 * USDT instead. It is the largest BUY denomination rather than a separate
 * number, because a second number would be a second owner of the same ceiling.
 */
export const MAX_INR_BUY_PAISE = 1_000_000;

/** What a player may choose on a buy. Derived, so it cannot disagree. */
export const BUY_DENOMINATIONS_PAISE = Object.freeze(
  CASH_DENOMINATIONS_PAISE.filter((p) => p <= MAX_INR_BUY_PAISE),
);

/**
 * The two amounts a USDT buy may be, in paise: ₹50,000 and ₹100,000.
 *
 * ── Fixed, for the reason the cash amounts are fixed ───────────────────────
 * A USDT buy is served by a person sending tokens from their own wallet and
 * being reimbursed. Two sizes means a merchant knows what they are being asked
 * for before they accept, and the queue at each size is legible — the same
 * reason a cash merchant is approved for one denomination. A free range would
 * make every order a negotiation.
 *
 * ── The gap between the rails is deliberate ───────────────────────────────
 * INR serves up to ₹10,000. USDT serves exactly ₹50,000 or ₹100,000. Nothing
 * serves ₹10,001–₹49,999, and the refusal SAYS SO by naming both rails'
 * choices — a player told only "invalid amount" would try again and again.
 */
export const USDT_BUY_DENOMINATIONS_PAISE = Object.freeze([
  5_000_000,   // ₹50,000
  10_000_000,  // ₹100,000
]);

export const isUsdtBuyDenomination = (paise) =>
  USDT_BUY_DENOMINATIONS_PAISE.includes(Number(paise));

/** What a withdrawal may be split into — every tier, largest first. */
export const WITHDRAWAL_DENOMINATIONS_PAISE = Object.freeze(
  [...CASH_DENOMINATIONS_PAISE].sort((a, b) => b - a),
);

/**
 * The smallest leg a split will produce unless the remainder forces it lower.
 * Splitting ₹100,000 into two hundred ₹500 legs would need two hundred
 * merchants; the floor is what keeps a large withdrawal servable.
 */
export const SPLIT_FLOOR_PAISE = 500_000; // ₹5,000

export const isCashDenomination = (paise) =>
  CASH_DENOMINATIONS_PAISE.includes(Number(paise));

export const isBuyDenomination = (paise) =>
  BUY_DENOMINATIONS_PAISE.includes(Number(paise));

/**
 * Split a withdrawal into legs, largest denomination first.
 *
 * ── The floor is a property here, not a branch ─────────────────────────────
 * The rule is "never below ₹5,000 unless the remainder is itself below it".
 * The first version of this function implemented that as a guard that stopped
 * the greedy pass at the floor and then ran a second pass for the remainder.
 * A mutation that deleted the guard changed NO output, which is how it was
 * found: under largest-first, a denomination is only ever reached once every
 * larger one no longer fits, so the rule holds without being enforced. The
 * branch was dead, and dead logic that looks like a safeguard is worse than
 * none — somebody edits around it believing it does something.
 *
 * So the floor stays as the documented rule and `splitWithdrawal` is plain
 * greedy. `merchantDenominationsPg.test.js` asserts the property directly for
 * every amount, which is the honest way to hold a rule that emerges rather
 * than one that is imposed.
 *
 * ── One completeness check, not two ────────────────────────────────────────
 * An early "is it a multiple of the smallest denomination" test was here too.
 * A mutation of EITHER check changed no output, because each caught what the
 * other did — two guards for one property, and the mutation harness could kill
 * neither while the other stood.
 *
 * The one that survives is `left !== 0`, because it is the general statement:
 * it holds whatever the denomination ladder is, while the divisibility test is
 * only correct as long as every denomination happens to be a whole multiple of
 * the smallest. Add ₹300 to the ladder one day and the divisibility test starts
 * refusing amounts that are perfectly payable.
 *
 * What it protects against is the worst outcome this function has: returning
 * the legs it managed to assemble and paying the player LESS than they asked
 * for, successfully.
 */
export function splitWithdrawal(totalPaise) {
  const total = Number(totalPaise);
  const smallest = CASH_DENOMINATIONS_PAISE[0];
  if (!Number.isInteger(total) || total < smallest) return null;

  const legs = [];
  let left = total;
  for (const d of WITHDRAWAL_DENOMINATIONS_PAISE) {
    while (left >= d) {
      legs.push(d);
      left -= d;
    }
  }

  // The legs must add up to exactly what was asked for. A split that loses
  // paise is a player short-paid, silently, by a function that returned
  // successfully.
  if (left !== 0) return null;
  return legs.length ? legs : null;
}

/**
 * Spread a payout fee across the parts of a split withdrawal.
 *
 * ── Why this exists at all ─────────────────────────────────────────────────
 * What reaches a cash machine must be a DENOMINATION, so the split is computed
 * on the fiat figure — the cash — and each part's fiat is fixed by the ladder.
 * The fee is the difference between that and the tokens the player gives up, so
 * it has to land somewhere, and "somewhere" cannot be a part's fiat without
 * making it an amount no machine dispenses.
 *
 * So it lands on the TOKEN side, part by part: each part debits its own share
 * of the player's balance and pays out its own denomination in cash.
 *
 * The first version of the split refused to run at all while a payout fee was
 * set, because a parent container held one lock for the whole withdrawal and
 * the fee was the part no leg accounted for. Flat siblings do not have that
 * problem — each is an ordinary withdrawal with its own lock — so the refusal
 * is gone and this is what replaces it.
 *
 * ── Integer paise, and the remainder goes somewhere explicit ───────────────
 * A proportional share does not divide evenly, and money is integer paise. The
 * shares are floored and the leftover paise are added to the FIRST part, which
 * is the largest under a largest-first split. That is a decision rather than a
 * rounding accident: the alternative is a fractional paise that has to vanish,
 * and a fee that quietly loses paise is a player charged an amount no row adds
 * up to.
 *
 * The identity this guarantees, and which its test asserts directly:
 *   sum(part.fiatPaise)  === sum(partsPaise)              (the cash is intact)
 *   sum(part.tokenPaise) === sum(partsPaise) + feePaise   (the fee is charged once)
 *
 * @param {number[]} partsPaise the denominations, largest first
 * @param {number} feePaise the whole fee, in paise
 */
export function shareFeeAcrossParts(partsPaise, feePaise) {
  const fee = Math.max(Math.trunc(Number(feePaise) || 0), 0);
  const cash = partsPaise.reduce((sum, p) => sum + Number(p), 0);
  if (!partsPaise.length || cash <= 0) return null;

  const parts = partsPaise.map((paise) => ({
    fiatPaise: Number(paise),
    tokenPaise: Number(paise) + Math.floor((fee * Number(paise)) / cash),
  }));

  // Whatever the flooring left over. Added, never dropped.
  const assigned = parts.reduce((sum, p) => sum + p.tokenPaise, 0) - cash;
  parts[0].tokenPaise += fee - assigned;
  return parts;
}
