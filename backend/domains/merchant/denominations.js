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
 * One size per order, no splitting. The SIZE is what puts an order on its
 * rail, so the rail is derived here and nowhere else
 * (`orderRails.paymentModeFor`).
 *
 * ── Fixed universe, admin-chosen offer, per direction ───────────────────────
 * Which of the seven are ON OFFER is the admin's, separately for buys
 * (`SystemConfig.buyOrderSizes`) and sells (`SystemConfig.sellOrderSizes`;
 * owner, Phase A of the merchants-and-agents plan), each declared with this
 * list as its only legal values. The seven themselves are not editable: a cash
 * machine dispenses fixed notes, and a size no team is organised to serve is
 * not a size an operator can conjure by typing it.
 *
 * ── How each rail is paid (CLAUDE.md §2 "How each rail is paid") ────────────
 * `RAIL_PAYMENT_METHOD` is the one sentence per rail and direction the player
 * app and the admin's Order Sizes card show under the sizes. The panels render
 * it from the server and keep no copy (§5). It describes what the code does:
 * a cash buy is paid through the ATM's QR the member scans onto the order
 * (`setCashLink`), a UPI/bank buy by bank transfer into the member's own
 * account (`PLAYER_PAY_TO_BANK_FIELDS`), and every sell by bank transfer to
 * the player's account. Change it in the same commit as the behaviour.
 *
 * ── Under merchant accounts (owner, 2026-10-11) ─────────────────────────────
 * When the admin sends INR to merchant accounts (`inrRoutingMode` MERCHANTS)
 * every size, 500 to 500,000, is one rail: UPI QR or bank transfer
 * (`railForSize`, `MERCHANTS_PAYMENT_METHOD`). Agents keep the split above.
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

/** Every size an INR order may be, ascending. The only legal `buyOrderSizes` / `sellOrderSizes` values. */
export const ORDER_SIZES = Object.freeze([...CASH_SIZES, ...UPI_BANK_SIZES]);

/**
 * Who serves INR orders (owner, 2026-10-11): AGENTS (supervisors' teams; the
 * cash sizes at an ATM) or MERCHANTS (merchant accounts; every size by UPI QR
 * or bank transfer). The admin's `SystemConfig.inrRoutingMode`; USDT is never
 * affected.
 */
export const INR_ROUTING = Object.freeze({ AGENTS: 'AGENTS', MERCHANTS: 'MERCHANTS' });
export const INR_ROUTING_MODES = Object.freeze(Object.values(INR_ROUTING));

/** The INR routing mode the config row says, or the schema default. */
export function inrRoutingOf(cfg) {
  const mode = cfg?.inrRoutingMode;
  return INR_ROUTING_MODES.includes(mode) ? mode : INR_ROUTING.AGENTS; // schema default: AGENTS
}

/**
 * Which rail serves a size under a routing mode: 'CASH', 'UPI_BANK', or null
 * for anything that is not a size. Under MERCHANTS every size is UPI_BANK
 * (a merchant account is paid by UPI QR or bank transfer, never cash at an
 * ATM); under AGENTS the size decides. The same rule `paymentModeFor` stamps.
 */
export function railForSize(tokens, mode) {
  if (!INR_ROUTING_MODES.includes(mode)) {
    throw new TypeError(`railForSize: mode must be one of ${INR_ROUTING_MODES.join(', ')}, got ${mode}`);
  }
  const n = Number(tokens);
  if (!ORDER_SIZES.includes(n)) return null;
  if (mode === INR_ROUTING.MERCHANTS) return 'UPI_BANK';
  return CASH_SIZES.includes(n) ? 'CASH' : 'UPI_BANK';
}

/** The config field holding each direction's sizes on offer. */
export const SIZE_FIELD = Object.freeze({ DEPOSIT: 'buyOrderSizes', WITHDRAWAL: 'sellOrderSizes' });

/**
 * The sizes on offer now for one direction ('DEPOSIT' or 'WITHDRAWAL'),
 * ascending, from the config row.
 *
 * Filtered through the universe, so a value that reached the row some other way
 * (a direct UPDATE, an old backup) is ignored rather than honoured. A row with
 * no list at all is a fresh install: every size, the spec's declared default.
 * An unknown direction throws: answering it with either list would be a guess.
 */
export function offeredSizes(cfg, direction) {
  const field = SIZE_FIELD[direction];
  if (!field) throw new TypeError(`offeredSizes: direction must be DEPOSIT or WITHDRAWAL, got ${direction}`);
  const stored = cfg?.[field];
  const list = Array.isArray(stored) ? stored.map(Number) : ORDER_SIZES; // schema default: all seven
  return ORDER_SIZES.filter((size) => list.includes(size));
}

/** The sizes on offer for one direction that a given rail serves. */
export function offeredSizesFor(cfg, rail, direction) {
  return offeredSizes(cfg, direction).filter((size) => railForSize(size, inrRoutingOf(cfg)) === rail);
}

/** How a player pays (buy) or is paid (sell) on each rail. See the header. */
export const RAIL_PAYMENT_METHOD = Object.freeze({
  CASH: Object.freeze({
    DEPOSIT: 'Cash at an ATM: pay the ATM QR the member scans, in any UPI app',
    WITHDRAWAL: 'Bank transfer to your bank account',
  }),
  UPI_BANK: Object.freeze({
    DEPOSIT: "Bank transfer (IMPS, NEFT or RTGS) to the member's bank account",
    WITHDRAWAL: 'Bank transfer to your bank account',
  }),
});

/**
 * How a player pays (buy) or is paid (sell) when INR goes to merchant
 * accounts: one sentence per direction, no rail (owner, 2026-10-11). A buy is
 * paid by the UPI QR link or into the bank account the order names
 * (`playerOrderView.js`); every sell by bank transfer to the player's account.
 */
export const MERCHANTS_PAYMENT_METHOD = Object.freeze({
  DEPOSIT: 'UPI or bank transfer',
  WITHDRAWAL: 'Bank transfer to your bank account',
});

/**
 * The seven sizes grouped by rail, with each rail's name and payment method,
 * for the admin's Order Sizes card (served by GET /api/admin/system/config).
 * The card ticks from this list rather than keeping its own (§5).
 */
export const ORDER_SIZE_RAILS = Object.freeze([
  Object.freeze({ rail: 'CASH', label: 'Cash (member at an ATM)', sizes: CASH_SIZES, methods: RAIL_PAYMENT_METHOD.CASH }),
  Object.freeze({ rail: 'UPI_BANK', label: 'UPI / bank', sizes: UPI_BANK_SIZES, methods: RAIL_PAYMENT_METHOD.UPI_BANK }),
]);

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
