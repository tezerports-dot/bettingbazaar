// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * numbers.js — the small numeric guards more than one repository needs.
 *
 * Extracted rather than copied. `nonNegative` was private to `merchants.js`
 * until the cash-link claim needed the same concurrency caps, and a second copy
 * of a guard whose whole purpose is "zero is a real answer" is exactly the
 * §5 shape: two implementations that agree today and drift the first time one
 * of them is tuned.
 */

/**
 * A non-negative number, where ZERO is a real answer.
 *
 * `Number(x) || fallback` substitutes the fallback for 0, because 0 is falsy.
 * That is harmless for a page size — a limit of zero is nonsense anyway — and
 * wrong for anything an operator might deliberately set to nothing: a
 * concurrency cap of 0 means "assign to nobody while I investigate", and `||`
 * silently re-opens the tap at the default.
 */
export const nonNegative = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};
