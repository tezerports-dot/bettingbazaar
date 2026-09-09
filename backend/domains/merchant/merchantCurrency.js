// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
// Domain: Merchant (BBEPS Phase 003 §3.3).
//
// The merchant settlement-rail vocabulary — the single module that names the
// rails a merchant can settle on and validates the credentials each rail needs.
// A merchant settles on EXACTLY ONE rail (2026-07-27 owner decision): an INR
// merchant takes UPI/bank orders, a USDT merchant takes USDT orders, never
// both. `Merchant.acceptedCurrencies` is the stored authority (GOVERNANCE §1);
// everything here is vocabulary + validation over it, never a second store.
//
// ── USDT is one token on several chains, and they are not interchangeable ───
// USDT sent to a TRC-20 address from a BEP-20 wallet is GONE — no support desk
// recovers it. So a merchant holds an address PER CHAIN, the player chooses the
// chain they actually hold funds on, and they are shown only the address that
// can receive them. A single address column made Tron the only chain anybody
// could use and made "which chain is this?" unanswerable.
//
// GOVERNANCE §4 (no duplicates): import these constants — do not re-declare
// 'INR' / 'USDT' string literals or a second address regex anywhere else.

export const MERCHANT_CURRENCY = Object.freeze({
  INR:  'INR',
  USDT: 'USDT',
});

export const MERCHANT_CURRENCIES = Object.freeze([
  MERCHANT_CURRENCY.INR,
  MERCHANT_CURRENCY.USDT,
]);

/** The chains this platform serves USDT on. */
export const USDT_CHAIN = Object.freeze({
  TRC20: 'TRC20',
  BEP20: 'BEP20',
});

export const USDT_CHAINS = Object.freeze([USDT_CHAIN.TRC20, USDT_CHAIN.BEP20]);

/**
 * How to recognise an address on each chain, and which merchant column holds
 * it. One table, so a chain added here reaches every consumer at once instead
 * of needing a branch in each of them.
 *
 * `label` is what a player is shown. It names the NETWORK, not the token,
 * because sending on the wrong network is the mistake this rail has to prevent
 * and "USDT" alone does not distinguish them.
 */
export const USDT_CHAIN_SPEC = Object.freeze({
  // 34 base58 characters beginning with 'T'. Base58 excludes 0 (zero), O
  // (capital o), I (capital i) and l (lower L) so visually similar characters
  // cannot be confused.
  [USDT_CHAIN.TRC20]: Object.freeze({
    label: 'Tron (TRC-20)',
    field: 'usdtAddressTrc20',
    column: 'usdt_address_trc20',
    pattern: /^T[1-9A-HJ-NP-Za-km-z]{33}$/,
    // A Tron transaction hash: 32 bytes of hex, no prefix.
    //
    // Case-INSENSITIVE, unlike the address above. An address is base58 and its
    // case is part of it; a hash is hex, so `AB…` and `ab…` are the SAME
    // transaction. Matching them case-sensitively would let one payment be
    // claimed twice — once in each case — which is the whole thing the registry
    // exists to prevent. References are uppercased before they are claimed, so
    // the two spellings collide on the primary key as they should.
    txPattern: /^[0-9a-fA-F]{64}$/i,
    txLabel: '64 hexadecimal characters',
  }),
  // BEP-20 is an EVM chain, so the address is the ordinary 20-byte hex form.
  // Case is NOT checked: EIP-55 mixed case is a checksum, and refusing a
  // lower-case address would reject the form most wallets copy.
  [USDT_CHAIN.BEP20]: Object.freeze({
    label: 'BNB Smart Chain (BEP-20)',
    field: 'usdtAddressBep20',
    column: 'usdt_address_bep20',
    pattern: /^0x[0-9a-fA-F]{40}$/,
    // Case-insensitive for the reason above, INCLUDING the `0x` — a reference
    // is uppercased before it is claimed, so what this actually sees is `0X…`.
    txPattern: /^0x[0-9a-fA-F]{64}$/i,
    txLabel: '0x followed by 64 hexadecimal characters',
  }),
});

export const isUsdtChain = (value) => USDT_CHAINS.includes(value);

/**
 * Is this a well-formed address on that chain?
 *
 * Format only. It does NOT verify a base58check or EIP-55 checksum, and it does
 * not ask any chain whether the address exists — it is the cheap guard that
 * stops obvious typos and cross-chain pastes (a `0x…` address in the Tron
 * field, a truncated copy) from being stored. USDT sent to a wrong address is
 * unrecoverable, so the merchant panel warns on top of this check.
 */
export function isUsdtAddress(chain, value) {
  const spec = USDT_CHAIN_SPEC[chain];
  return Boolean(spec) && typeof value === 'string' && spec.pattern.test(value.trim());
}

/**
 * Is this a well-formed transaction hash on that chain?
 *
 * The same kind of guard, at the other end of the flow. A player who mistypes
 * their hash has made a payment nobody can match, and telling them at
 * submission is the only moment it is cheap to fix.
 */
export function isUsdtTxHash(chain, value) {
  const spec = USDT_CHAIN_SPEC[chain];
  return Boolean(spec) && typeof value === 'string' && spec.txPattern.test(value.trim());
}

/** The address this merchant can receive on, for one chain. Null if they hold none. */
export function usdtAddressFor(merchant, chain) {
  const spec = USDT_CHAIN_SPEC[chain];
  if (!spec) return null;
  const value = merchant?.[spec.field];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** Every chain this merchant can actually be paid on. */
export function usdtChainsHeldBy(merchant) {
  return USDT_CHAINS.filter((chain) => usdtAddressFor(merchant, chain) !== null);
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
