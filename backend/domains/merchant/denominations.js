// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
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
 * ₹40,000 is dealt by a machine but sits above the cash-rail ceiling
 * (₹10,000), so no cash order is ever that large: the buy denominations a
 * player may choose simply do not include it, and a cash withdrawal must itself
 * be one of the buy denominations (there is no splitting, owner 2026-10-02).
 *
 * ── Who works which amount ──────────────────────────────────────────────────
 * Nobody is approved for one denomination any more: a cash order goes to a
 * member of a CASH team who has pressed Ready (`teamRouting.js`, PROJECT_STATUS
 * §3.10 2c). Step 2d replaces this fixed list with the admin's own list.
 *
 * ── One owner ───────────────────────────────────────────────────────────────
 * Not admin-editable today, and not repeated in `schema.sql`: every reader
 * imports it from here.
 */

/** Every denomination the cash rail knows, in integer paise. */
export const CASH_DENOMINATIONS_PAISE = Object.freeze([
  50_000,     // ₹500
  100_000,    // ₹1,000
  500_000,    // ₹5,000
  1_000_000,  // ₹10,000
  4_000_000,  // ₹40,000 — dealt by a machine, above the cash-rail ceiling
]);

/**
 * The ceiling on a CASH-RAIL buy, in paise: ₹10,000.
 *
 * It is the ATM's limit, not a limit on buying. A cash machine dispenses one of
 * a fixed set and ₹10,000 is the largest of them, so this is the largest amount
 * a merchant standing at one can serve. Derived as the largest BUY denomination
 * rather than written as its own number, because a second number would be a
 * second owner of the same ceiling.
 *
 * It was called `MAX_INR_BUY_PAISE` and applied to EVERY INR buy, on both
 * rails. On the UPI rail there is no machine and no dispensing limit — a
 * purchase there is bounded by the configured min/max deposit like any other,
 * and refusing ₹12,000 on it was refusing something nothing prevented.
 */
export const MAX_CASH_BUY_PAISE = 1_000_000;

/** What a player may choose on a cash buy. Derived, so it cannot disagree. */
export const BUY_DENOMINATIONS_PAISE = Object.freeze(
  CASH_DENOMINATIONS_PAISE.filter((p) => p <= MAX_CASH_BUY_PAISE),
);

/**
 * The three sizes a USDT buy may be, in PLATFORM TOKENS.
 *
 * ── Tokens, not rupees ────────────────────────────────────────────────────
 * A USDT buy is denominated in what the player RECEIVES — 50,000, 100,000 or
 * 500,000 platform tokens — and what they SEND is derived from the admin's
 * rate. At 100 tokens per USDT those are 500, 1,000 and 5,000 USDT.
 *
 * Stored in paise like every other money column (1 token = ₹1, so 50,000
 * tokens is 5,000,000 paise) because that is the platform's unit of account and
 * the split, the ledger and the wallet all speak it. The USDT figure is DERIVED
 * at creation and never kept as a second denomination list — the rate is
 * admin-editable, so a stored USDT amount would be a second owner that drifts
 * the moment the rate changes.
 *
 * ── Fixed, for the reason the cash amounts are fixed ───────────────────────
 * A USDT buy is served by a person sending tokens from their own wallet and
 * being reimbursed. Three sizes means a merchant knows what they are being
 * asked for before they accept, and the queue at each size is legible — the
 * same reason a cash merchant is approved for one denomination. A free range
 * would make every order a negotiation.
 */
export const USDT_BUY_DENOMINATIONS_PAISE = Object.freeze([
  5_000_000,   //  50,000 tokens
  10_000_000,  // 100,000 tokens
  50_000_000,  // 500,000 tokens
]);

export const isUsdtBuyDenomination = (paise) =>
  USDT_BUY_DENOMINATIONS_PAISE.includes(Number(paise));

export const isCashDenomination = (paise) =>
  CASH_DENOMINATIONS_PAISE.includes(Number(paise));

export const isBuyDenomination = (paise) =>
  BUY_DENOMINATIONS_PAISE.includes(Number(paise));
