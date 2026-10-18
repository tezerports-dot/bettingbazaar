// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
//
// Settlement-rail vocabulary for the merchant panel.
//
// A merchant is INR-only (bank account) or, on a row from before USDT buys went
// to the platform (owner, 2026-10-18), USDT — never both. The
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
}

// `walletLabel` / `walletNote` / `formatWallet` were here, for the merchant's
// token wallet. There is no such wallet any more: a merchant holds no tokens,
// their team's pool does (PROJECT_STATUS §3.10), and the server sends no
// balance for a merchant. Deleted with the tiles that rendered them.


const COPY: Record<MerchantRail, RailCopy> = {
  INR: {
    unit: 'INR',
    name: 'INR',
    credentialsLabel: 'Bank account',
    proofLabel: 'UTR',
    proofSectionLabel: 'Payment proof',
    payoutDestinationLabel: 'Send to bank account',
  },
  USDT: {
    unit: 'USDT',
    name: 'USDT',
    // USDT buys are paid to the platform and credited by themselves (CLAUDE.md
    // §25); a merchant on this rail serves nothing and holds no address.
    credentialsLabel: 'no orders (USDT retired)',
    proofLabel: 'Tx hash',
    proofSectionLabel: 'On-chain proof',
    payoutDestinationLabel: 'No USDT sell rail',
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
 * A figure denominated in PLATFORM TOKENS, on either rail.
 *
 * ── The unit does not change with the rail. The rail is not the unit ───────
 * Every token count on this platform is BB tokens, whether the order settled in
 * rupees or in USDT. So a figure
 * counted in tokens is rendered in BB on both rails, never with the rail's
 * currency suffix: "900,000 USDT" for 900,000 tokens at ₹90 per USDT is a
 * ninety-fold overstatement, CLAUDE.md trap 15 in the line a human reads.
 */
export function formatTokens(amount: number | undefined | null): string {
  const value = Number(amount) || 0;
  return `${value.toLocaleString('en-IN', { maximumFractionDigits: 2 })} BB`;
}

/**
 * The BB token figure shown beside the money amount. Tokens are 1:1 with rupees
 * (fixed since 2026-07-08). A USDT order's chain is not sent to a merchant: the
 * platform, not a member, receives it (CLAUDE.md §25).
 */
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
  const reference = String(order.orderId || order._id || '');
  return { name: reference ? `Order ${reference}` : 'Order', identified: false };
}

