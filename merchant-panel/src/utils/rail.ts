// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
//
// How an order's money, proof and payout are worded in the merchant panel.
//
// Every merchant serves INR: there is no merchant rail. USDT buys are paid to
// the platform at an address derived for each order and credited by the chain
// watcher (CLAUDE.md §25; owner, 2026-10-18), so no USDT order reaches this
// panel. A team's own rail (CASH or UPI_BANK) is the supervisor's, sent with
// the team (`SupervisorRail`, ../types).
import type { PaymentOrder } from '../types';

// Every user-visible string about an order's payment is defined once, here, so
// a screen never words it in its own markup.
export const PAYMENT_COPY = Object.freeze({
  /** Shown on order chips. */
  unit: 'INR',
  /** Long name for headings. */
  name: 'INR',
  /** What the merchant's own credentials are called. */
  credentialsLabel: 'Bank account',
  /** Label for the reference a user submits to prove they paid. */
  proofLabel: 'UTR',
  /** Heading above that proof in the order drawer. */
  proofSectionLabel: 'Payment proof',
  /** Where a withdrawal payout is sent. */
  payoutDestinationLabel: 'Send to bank account',
});

// `walletLabel` / `walletNote` / `formatWallet` were here, for the merchant's
// token wallet. There is no such wallet any more: a merchant holds no tokens,
// their team's pool does (PROJECT_STATUS §3.10), and the server sends no
// balance for a merchant. Deleted with the tiles that rendered them.

// ── Money ───────────────────────────────────────────────────────────────────
/** Rupees, with Indian digit grouping. */
export function formatMoney(amount: number | undefined | null): string {
  const value = Number(amount) || 0;
  return `₹${value.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
}

/** Compact form for chart axes and dense stat tiles (₹1.2L, ₹8.4k). */
export function formatMoneyCompact(amount: number | undefined | null): string {
  const value = Number(amount) || 0;
  const abs = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  if (abs >= 1e7) return `${sign}₹${(abs / 1e7).toFixed(2)}Cr`;
  if (abs >= 1e5) return `${sign}₹${(abs / 1e5).toFixed(2)}L`;
  if (abs >= 1e3) return `${sign}₹${(abs / 1e3).toFixed(1)}k`;
  return formatMoney(value);
}

/** A figure denominated in PLATFORM TOKENS (BB), never in rupees. */
export function formatTokens(amount: number | undefined | null): string {
  const value = Number(amount) || 0;
  return `${value.toLocaleString('en-IN', { maximumFractionDigits: 2 })} BB`;
}

/** The BB token figure shown beside the money amount (1:1 with rupees, fixed since 2026-07-08). */
export function tokenColumn(order: PaymentOrder): { label: string; value: string } {
  return {
    label: 'Credited as',
    value: `${(Number(order.tokenAmount) || 0).toLocaleString('en-IN')} BB`,
  };
}

/** Middle-ellipsis for long addresses and hashes that must stay recognisable. */
export function truncateMiddle(value: string, head = 10, tail = 6): string {
  const text = value || '';
  if (text.length <= head + tail + 1) return text;
  return `${text.slice(0, head)}…${text.slice(-tail)}`;
}

/**
 * How to name the user on an order.
 *
 * The backend strips the user's name and phone from every order it
 * sends a merchant (`sanitizeMerchantOrder`), and additionally strips their
 * payout details on deposits — merchants only ever see the identity they need to
 * complete the transfer in front of them. So:
 *
 *   • WITHDRAWAL → the account holder's name, which the merchant
 *     necessarily reads off the transfer.
 *   • everything else → no identity exists; the order reference is the label.
 *
 * Rendering a placeholder name here would imply the panel knows who this is. It
 * does not, by design — do not "fix" this by asking the backend to send more.
 */
export function counterpartyOf(order: PaymentOrder): { name: string; identified: boolean } {
  const holder = order.userBankDetails?.accountHolderName?.trim();
  if (holder) return { name: holder, identified: true };
  const reference = String(order.orderId || order._id || '');
  return { name: reference ? `Order ${reference}` : 'Order', identified: false };
}

