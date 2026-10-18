// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
// Domain: Merchant (BBEPS Phase 003 §3.3).
//
// The merchant settlement-rail vocabulary — the single module that names the
// rails a merchant can settle on and validates the credentials each rail needs.
// A merchant settles on EXACTLY ONE rail (2026-07-27 owner decision): an INR
// merchant takes UPI/bank orders, a USDT merchant takes USDT orders, never
// both. `Merchant.acceptedCurrencies` is the stored authority (GOVERNANCE §1);
// everything here is vocabulary + validation over it, never a second store.
//
// ── USDT is paid to the PLATFORM, on one chain (owner, 2026-10-18) ──────────
// A USDT buy is no longer served by a merchant: the player pays an address
// derived for that order alone on BNB Smart Chain, and the chain watcher
// credits it (`payment/usdtDeposit.service.js`). Merchants hold no USDT
// address and see no USDT buy. A merchant still on the USDT rail is one an
// admin set before that date; no new one can be made (`SETTABLE_MERCHANT_CURRENCIES`).
//
// GOVERNANCE §4 (no duplicates): import these constants — do not re-declare
// 'INR' / 'USDT' string literals anywhere else.

export const MERCHANT_CURRENCY = Object.freeze({
  INR:  'INR',
  USDT: 'USDT',
});

export const MERCHANT_CURRENCIES = Object.freeze([
  MERCHANT_CURRENCY.INR,
  MERCHANT_CURRENCY.USDT,
]);

/** The chain USDT buys are paid on. One: BNB Smart Chain (owner, 2026-10-18). */
export const USDT_CHAIN = Object.freeze({
  BEP20: 'BEP20',
});

export const USDT_CHAINS = Object.freeze([USDT_CHAIN.BEP20]);

/**
 * What a player is shown for each chain. `label` names the NETWORK, not the
 * token, because sending on the wrong network is the mistake that loses money
 * and "USDT" alone does not say which.
 */
export const USDT_CHAIN_SPEC = Object.freeze({
  [USDT_CHAIN.BEP20]: Object.freeze({ label: 'BNB Smart Chain (BEP-20)' }),
});

export const isUsdtChain = (value) => USDT_CHAINS.includes(value);

/**
 * The rails an admin may PUT a merchant on now: INR only. USDT stays in
 * `MERCHANT_CURRENCIES` so a merchant set to it before 2026-10-18 still reads
 * correctly until an admin moves them.
 */
export const SETTABLE_MERCHANT_CURRENCIES = Object.freeze([MERCHANT_CURRENCY.INR]);

/**
 * merchantTypeOf — the merchant's single rail as a scalar ('INR' | 'USDT').
 *
 * Reads `acceptedCurrencies[0]`, which the schema validates to exactly one
 * entry. Falls back to INR for legacy documents written before the exclusivity
 * rule (schema default: ['INR']).
 */
export function merchantTypeOf(merchant) {
  const rail = merchant?.acceptedCurrencies?.[0];
  return MERCHANT_CURRENCIES.includes(rail) ? rail : MERCHANT_CURRENCY.INR;
}

/**
 * isUsdtMerchant / isInrMerchant — readable guards over merchantTypeOf.
 */
export function isUsdtMerchant(merchant) {
  return merchantTypeOf(merchant) === MERCHANT_CURRENCY.USDT;
}

export function isInrMerchant(merchant) {
  return merchantTypeOf(merchant) === MERCHANT_CURRENCY.INR;
}

/**
 * What the payer sends, written in the currency they send it in.
 *
 * ── Why this is a function and not a template at each call site ────────────
 * `fiat_amount_paise` is "what the payer sends, in the ORDER's currency". Every
 * screen and message that renders it therefore has to ask which currency, and
 * the ones that forgot all made the SAME mistake in the same direction: "₹500"
 * shown for a payment of 500 USDT. The merchant's order card asked; the
 * player's confirmation message did not, and the accounting description did
 * not.
 *
 * One formatter, so a place that renders the amount cannot render it without
 * answering the question. `en-IN` grouping, matching every other money figure
 * on this platform.
 */
export function formatOrderFiat(order) {
  const amount = Number(order?.fiatAmount ?? 0);
  const shown = Number.isFinite(amount) ? amount.toLocaleString('en-IN') : String(order?.fiatAmount ?? '');
  return order?.currency === MERCHANT_CURRENCY.USDT ? `${shown} USDT` : `₹${shown}`;
}
