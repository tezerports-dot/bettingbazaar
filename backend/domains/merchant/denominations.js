// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * denominations.js — the sizes an order may be, and the rail each one runs on.
 *
 * ── The owner's rule (PROJECT_STATUS §3.10, Step 2d) ─────────────────────────
 * An INR order, buy or sell, is exactly ONE of seven sizes, in tokens:
 *
 *   CASH       500 · 1,000 · 5,000 · 10,000     (a member at a cash machine)
 *   UPI_BANK   50,000 · 100,000 · 500,000        (bank transfer to the member's account)
 *
 * The same sizes for buys and sells, one size per order, no splitting. The SIZE
 * is what puts an order on its rail, so the rail is derived here and nowhere
 * else (`orderRails.paymentModeFor`).
 *
 * ── Fixed universe, admin-chosen offer ──────────────────────────────────────
 * Which of the seven are ON OFFER is the admin's (`SystemConfig.orderSizes`,
 * declared with this list as its only legal values). The seven themselves are
 * not editable: a cash machine dispenses fixed notes, and a size no team is
 * organised to serve is not a size an operator can conjure by typing it.
 *
 * ── USDT ────────────────────────────────────────────────────────────────────
 * Buy only, priced in USDT: a whole number of `USDT_BUY_STEP` (100) between the
 * admin's minimum and maximum (`SystemConfig.usdtBuy`, defaults 100 and 10,000).
 * The step is fixed for the reason the cash notes are: a member sending USDT
 * knows the shape of what they are being asked for.
 */

/** The cash rail's sizes, in TOKENS (1 token = ₹1). */
export const CASH_SIZES = Object.freeze([500, 1_000, 5_000, 10_000]);

/** The UPI/bank rail's sizes, in TOKENS. */
export const UPI_BANK_SIZES = Object.freeze([50_000, 100_000, 500_000]);

/** Every size an INR order may be, ascending. The only legal `orderSizes` values. */
export const ORDER_SIZES = Object.freeze([...CASH_SIZES, ...UPI_BANK_SIZES]);

/** Which rail serves a size: 'CASH', 'UPI_BANK', or null for anything else. */
export function railForSize(tokens) {
  const n = Number(tokens);
  if (CASH_SIZES.includes(n)) return 'CASH';
  if (UPI_BANK_SIZES.includes(n)) return 'UPI_BANK';
  return null;
}

/**
 * The sizes on offer now, ascending, from the config row.
 *
 * Filtered through the universe, so a value that reached the row some other way
 * (a direct UPDATE, an old backup) is ignored rather than honoured. A row with
 * no list at all is a fresh install: every size, the spec's declared default.
 */
export function offeredSizes(cfg) {
  const stored = cfg?.orderSizes;
  const list = Array.isArray(stored) ? stored.map(Number) : ORDER_SIZES; // schema default: all seven
  return ORDER_SIZES.filter((size) => list.includes(size));
}

/** The sizes on offer that a given rail serves. */
export function offeredSizesFor(cfg, rail) {
  return offeredSizes(cfg).filter((size) => railForSize(size) === rail);
}

/** A USDT buy is a whole number of this many USDT. */
export const USDT_BUY_STEP = 100;

/**
 * The USDT buy bounds, in whole USDT, from the config row. Both are whole
 * multiples of the step and `min <= max` (the spec and the admin route refuse
 * anything else); the defaults are the spec's own.
 */
export function usdtBuyBounds(cfg) {
  return {
    min:  cfg?.usdtBuy?.minUsdt ?? 100,    // schema default: 100
    max:  cfg?.usdtBuy?.maxUsdt ?? 10_000, // schema default: 10,000
    step: USDT_BUY_STEP,
  };
}

/** True when `usdt` is a legal USDT buy under these bounds. */
export function isUsdtBuyAmount(usdt, bounds) {
  const n = Number(usdt);
  return Number.isInteger(n) && n % USDT_BUY_STEP === 0 && n >= bounds.min && n <= bounds.max;
}
