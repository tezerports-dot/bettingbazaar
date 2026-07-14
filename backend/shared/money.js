// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * shared/money.js — the Integer Money Engine (capability #9).
 *
 * Money is represented as an INTEGER number of paise (the smallest INR unit).
 * Every arithmetic helper here enforces three invariants and throws on any
 * violation, so a precision bug becomes a loud error instead of a silent
 * rounding drift in someone's wallet:
 *   1. integer      — paise are whole numbers (no fractional paise at rest);
 *   2. finite       — never NaN/Infinity;
 *   3. within range — |paise| ≤ MAX_SAFE_PAISE, so a runaway computation can't
 *      silently exceed IEEE-754 integer safety (overflow protection).
 *
 * SCOPE (per the A/B/C plan): this is the canonical engine and the paise
 * boundary for the Postgres money layer (pgClient.paise delegates here). The
 * MongoDB wallet still stores float rupees at rest; converting that store to
 * integer-paise-at-rest is the Postgres cutover step (single source of truth) —
 * NOT a live rewrite of the proven float paths, which would create two money
 * representations mid-migration. New money code should use these helpers.
 */

// MAX_SAFE_INTEGER paise ≈ ₹90.07 trillion — far above any real balance, but a
// hard ceiling so an overflow bug is caught, not wrapped.
export const MAX_SAFE_PAISE = Number.MAX_SAFE_INTEGER;

/** Assert a value is a safe integer count of paise. Returns it for chaining. */
export function assertSafePaise(paise, label = 'amount') {
  if (typeof paise !== 'number' || !Number.isFinite(paise)) {
    throw new TypeError(`${label} must be a finite number of paise, got ${String(paise)}`);
  }
  if (!Number.isInteger(paise)) {
    throw new RangeError(`${label} must be an integer number of paise, got ${paise}`);
  }
  if (Math.abs(paise) > MAX_SAFE_PAISE) {
    throw new RangeError(`${label} exceeds MAX_SAFE_PAISE (overflow risk): ${paise}`);
  }
  return paise;
}

/** Rupees(float) → integer paise. Rounds at the paise boundary (kills float dust). */
export function rupeesToPaise(rupees) {
  if (typeof rupees !== 'number' || !Number.isFinite(rupees)) {
    throw new TypeError(`rupees must be a finite number, got ${String(rupees)}`);
  }
  return assertSafePaise(Math.round(rupees * 100), 'rupeesToPaise');
}

/** Integer paise → rupees(float). For display/interop only — never for at-rest math. */
export function paiseToRupees(paise) {
  assertSafePaise(paise, 'paiseToRupees');
  return paise / 100;
}

/** Sum any number of paise amounts, checking overflow at every step. */
export function addPaise(...amounts) {
  let sum = 0;
  for (const a of amounts) {
    assertSafePaise(a, 'addPaise operand');
    sum += a;
    assertSafePaise(sum, 'addPaise result');
  }
  return sum;
}

/** a − b in paise, range-checked. */
export function subPaise(a, b) {
  assertSafePaise(a, 'subPaise a');
  assertSafePaise(b, 'subPaise b');
  return assertSafePaise(a - b, 'subPaise result');
}

/** paise × integer factor (e.g. a 2× payout), range-checked. */
export function mulPaise(paise, factor) {
  assertSafePaise(paise, 'mulPaise amount');
  if (!Number.isInteger(factor)) throw new RangeError(`mulPaise factor must be an integer, got ${factor}`);
  return assertSafePaise(paise * factor, 'mulPaise result');
}

/**
 * A percentage of a paise amount, FLOORED — never rounds up against the user
 * (mirrors the risk/fee arithmetic). `percent` may be fractional (e.g. 1.5).
 */
export function percentOfPaise(paise, percent) {
  assertSafePaise(paise, 'percentOfPaise amount');
  if (typeof percent !== 'number' || !Number.isFinite(percent)) {
    throw new TypeError(`percent must be finite, got ${String(percent)}`);
  }
  return assertSafePaise(Math.floor((paise * percent) / 100), 'percentOfPaise result');
}

/** Fixed-2 rupees string for display/receipts. */
export function formatRupees(paise) {
  assertSafePaise(paise, 'formatRupees');
  return (paise / 100).toFixed(2);
}

export default {
  MAX_SAFE_PAISE, assertSafePaise, rupeesToPaise, paiseToRupees,
  addPaise, subPaise, mulPaise, percentOfPaise, formatRupees,
};
