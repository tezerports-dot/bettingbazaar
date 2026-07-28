// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
// Domain: Merchant (BBEPS Phase 003 §3.3).
//
// The merchant settlement-rail vocabulary — the single module that names the
// rails a merchant can settle on and validates the credentials each rail needs.
// A merchant settles on EXACTLY ONE rail (2026-07-27 owner decision): an INR
// merchant takes UPI/bank orders, a USDT merchant takes TRC-20 orders, never
// both. `Merchant.acceptedCurrencies` is the stored authority (GOVERNANCE §1);
// everything here is vocabulary + validation over it, never a second store.
//
// GOVERNANCE §4 (no duplicates): import these constants — do not re-declare
// 'INR' / 'USDT' string literals or a second TRC-20 regex anywhere else.

export const MERCHANT_CURRENCY = Object.freeze({
  INR:  'INR',
  USDT: 'USDT',
});

export const MERCHANT_CURRENCIES = Object.freeze([
  MERCHANT_CURRENCY.INR,
  MERCHANT_CURRENCY.USDT,
]);

// Base58 alphabet — excludes 0 (zero), O (capital o), I (capital i) and l
// (lower L) so visually similar characters cannot be confused.
const TRC20_ADDRESS = /^T[1-9A-HJ-NP-Za-km-z]{33}$/;

/**
 * isTrc20Address — true for a well-formed TRC-20 (Tron) address.
 *
 * Format only: 34 base58 characters beginning with 'T'. This does NOT verify
 * the base58check checksum or that the address exists on-chain — it is the
 * cheap guard that stops obvious typos and non-Tron addresses (an ERC-20 `0x…`
 * address, a truncated paste) from being stored. USDT sent to a wrong address
 * is unrecoverable, so the merchant panel warns on top of this check.
 */
export function isTrc20Address(value) {
  return typeof value === 'string' && TRC20_ADDRESS.test(value.trim());
}

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
