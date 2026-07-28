// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
//
// Settlement-rail vocabulary for the merchant panel.
//
// A merchant is INR-only (UPI + bank) or USDT-only (TRC-20) — never both. The
// backend authority is `Merchant.acceptedCurrencies`, which holds exactly one
// entry, surfaced on the profile payload as `merchantType`
// (backend/domains/merchant/merchantCurrency.js). This module is the mirror
// permitted by GOVERNANCE §4: one place in the panel that knows what each rail
// is called and how its money, proof and payout destination are worded.
// The `MerchantRail` type itself is declared in ../types alongside the other
// backend enum mirrors.
import type { MerchantProfile, MerchantRail, PaymentOrder } from '../types';

export type { MerchantRail };

export const RAIL: Record<MerchantRail, MerchantRail> = { INR: 'INR', USDT: 'USDT' };

/** The rail a merchant settles on. Mirrors backend merchantTypeOf(). */
export function railOf(merchant?: MerchantProfile | null): MerchantRail {
  const type = merchant?.merchantType ?? merchant?.acceptedCurrencies?.[0];
  return type === RAIL.USDT ? RAIL.USDT : RAIL.INR; // schema default: ['INR']
}

/** The rail an order settles on. Orders written before the field existed are INR. */
export function railOfOrder(order?: Pick<PaymentOrder, 'currency'> | null): MerchantRail {
  return order?.currency === RAIL.USDT ? RAIL.USDT : RAIL.INR; // schema default: 'INR'
}

export function isUsdt(rail: MerchantRail): boolean {
  return rail === RAIL.USDT;
}

// ── Copy that differs between the two rails ─────────────────────────────────
// Every user-visible string that depends on the rail is defined once, here, so
// a screen never branches on the currency in its own markup.
interface RailCopy {
  /** 'INR' | 'USDT' — shown on order chips. */
  unit: string;
  /** Long name for headings and empty states. */
  name: string;
  /** What the merchant's own credentials are called. */
  credentialsLabel: string;
  /** Label for the reference a user submits to prove they paid. */
  proofLabel: string;
  /** Heading above that proof in the order drawer. */
  proofSectionLabel: string;
  /** Where a withdrawal payout is sent. */
  payoutDestinationLabel: string;
  /** Sub-line under a copied payment address, if any. */
  networkNote: string;
  /** Wallet card heading on Dashboard/Profile. */
  walletLabel: string;
  /** Sub-line under the wallet balance. */
  walletNote: string;
}

const COPY: Record<MerchantRail, RailCopy> = {
  INR: {
    unit: 'INR',
    name: 'INR',
    credentialsLabel: 'UPI & bank',
    proofLabel: 'UTR',
    proofSectionLabel: 'Payment proof',
    payoutDestinationLabel: 'Send to bank account',
    networkNote: '',
    walletLabel: 'BB Token balance',
    walletNote: 'Funded by admin · 1:1 with INR',
  },
  USDT: {
    unit: 'USDT',
    name: 'USDT',
    credentialsLabel: 'TRC-20 wallet',
    proofLabel: 'Tx ID',
    proofSectionLabel: 'On-chain proof',
    payoutDestinationLabel: 'Send USDT to user address',
    networkNote: 'TRC-20 network',
    walletLabel: 'USDT balance',
    walletNote: 'TRC-20 settlement wallet',
  },
};

export function railCopy(rail: MerchantRail): RailCopy {
  return COPY[rail];
}

// ── Money ───────────────────────────────────────────────────────────────────
// INR amounts render as ₹ with Indian digit grouping; USDT amounts render as a
// suffixed unit with 2 decimals only when the value actually has them.
export function formatMoney(amount: number | undefined | null, rail: MerchantRail): string {
  const value = Number(amount) || 0;
  if (rail === RAIL.USDT) {
    const hasFraction = Math.abs(value % 1) > 1e-9;
    return `${value.toLocaleString('en-US', {
      minimumFractionDigits: hasFraction ? 2 : 0,
      maximumFractionDigits: 2,
    })} USDT`;
  }
  return `₹${value.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
}

/** Compact form for chart axes and dense stat tiles (₹1.2L, 8.4k USDT). */
export function formatMoneyCompact(amount: number | undefined | null, rail: MerchantRail): string {
  const value = Number(amount) || 0;
  const abs = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  if (rail === RAIL.USDT) {
    if (abs >= 1e6) return `${sign}${(abs / 1e6).toFixed(2)}M USDT`;
    if (abs >= 1e3) return `${sign}${(abs / 1e3).toFixed(1)}k USDT`;
    return formatMoney(value, RAIL.USDT);
  }
  if (abs >= 1e7) return `${sign}₹${(abs / 1e7).toFixed(2)}Cr`;
  if (abs >= 1e5) return `${sign}₹${(abs / 1e5).toFixed(2)}L`;
  if (abs >= 1e3) return `${sign}₹${(abs / 1e3).toFixed(1)}k`;
  return formatMoney(value, RAIL.INR);
}

/**
 * The merchant's wallet balance, in the unit the wallet is actually denominated
 * in. On the INR rail the wallet holds BB tokens (1:1 with rupees since
 * 2026-07-08, but still counted as tokens, so "₹2.50L" would mislabel it); on
 * the USDT rail it holds USDT.
 */
export function formatWallet(balance: number | undefined | null, rail: MerchantRail): string {
  const value = Number(balance) || 0;
  if (rail === RAIL.USDT) return formatMoney(value, RAIL.USDT);
  return `${value.toLocaleString('en-IN', { maximumFractionDigits: 2 })} BB`;
}

/**
 * The BB token figure shown beside the money amount. On the INR rail tokens are
 * 1:1 with rupees (fixed since 2026-07-08) and worth stating; on the USDT rail
 * the second column shows the network instead, since the token count is not the
 * useful number there.
 */
export function tokenColumn(order: PaymentOrder, rail: MerchantRail): { label: string; value: string } {
  if (rail === RAIL.USDT) return { label: 'Network', value: 'TRC-20' };
  return {
    label: 'Credited as',
    value: `${(Number(order.tokenAmount) || 0).toLocaleString('en-IN')} BB`,
  };
}

/**
 * TRC-20 address check — the same format rule the backend enforces
 * (backend/domains/merchant/merchantCurrency.js). Mirrored here only to give
 * immediate feedback in the address form; the backend remains the authority and
 * rejects anything malformed regardless of what the panel allows.
 */
const TRC20_ADDRESS = /^T[1-9A-HJ-NP-Za-km-z]{33}$/;
export function isTrc20Address(value: string): boolean {
  return TRC20_ADDRESS.test((value || '').trim());
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
 * The backend strips the user's name, phone and KYC snapshot from every order it
 * sends a merchant (`sanitizeMerchantOrder`), and additionally strips their
 * payout details on deposits — merchants only ever see the identity they need to
 * complete the transfer in front of them. So:
 *
 *   • WITHDRAWAL on the INR rail → the account holder's name, which the merchant
 *     necessarily reads off the transfer.
 *   • everything else → no identity exists; the order reference is the label.
 *
 * Rendering a placeholder name here would imply the panel knows who this is. It
 * does not, by design — do not "fix" this by asking the backend to send more.
 */
export function counterpartyOf(order: PaymentOrder): { name: string; identified: boolean } {
  const holder = order.userBankDetails?.accountHolderName?.trim();
  if (holder) return { name: holder, identified: true };
  const reference = String(order.shortId || order.orderId || order._id || '');
  return { name: reference ? `Order ${reference}` : 'Order', identified: false };
}
