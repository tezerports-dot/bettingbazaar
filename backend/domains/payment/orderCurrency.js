// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
// Domain: Payment.
//
// The currency an ORDER is paid in, and the chain a USDT order is paid on.
// `order_states.currency` is the stored authority (CLAUDE.md §2 "An order's
// currency"); this module is the vocabulary over it, never a second store.
//
// An INR order is served by an agent or a merchant account. A USDT buy is paid
// to the PLATFORM, at an address derived for that order alone on BNB Smart
// Chain, and the chain watcher credits it (`usdtDeposit.service.js`; owner,
// 2026-10-18). No merchant, agent or team is on USDT: merchants have no rail.
//
// GOVERNANCE §4 (no duplicates): import these constants — do not re-declare
// 'INR' / 'USDT' string literals anywhere else.

export const ORDER_CURRENCY = Object.freeze({
  INR:  'INR',
  USDT: 'USDT',
});

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
  return order?.currency === ORDER_CURRENCY.USDT ? `${shown} USDT` : `₹${shown}`;
}
