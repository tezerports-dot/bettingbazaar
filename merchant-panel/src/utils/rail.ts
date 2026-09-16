// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
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
  /**
   * Wallet card heading on Dashboard/Profile.
   *
   * The same on both rails, because the wallet IS the same on both rails: it
   * holds BB tokens (see `formatTokens`). This said "USDT balance" for a USDT
   * merchant, which put a heading and its own figure in different currencies
   * on one tile.
   */
  walletLabel: string;
  /** Sub-line under the wallet balance. */
  walletNote: string;
}

// `networkNote` was declared here and set on both rails — 'TRC-20 network' on
// the USDT one — and READ BY NOTHING. A constant with no consumer is §3, and
// this one was also wrong: a merchant serving a BEP-20 order would have been
// told Tron by it. Deleted rather than corrected, because the chain belongs to
// the ORDER (`tokenColumn` reads `order.usdtChain`) and a rail-level copy
// string cannot know it.


const COPY: Record<MerchantRail, RailCopy> = {
  INR: {
    unit: 'INR',
    name: 'INR',
    credentialsLabel: 'UPI & bank',
    proofLabel: 'UTR',
    proofSectionLabel: 'Payment proof',
    payoutDestinationLabel: 'Send to bank account',
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
    walletLabel: 'BB Token balance',
    // What the merchant HOLDS is tokens; what a player SENDS them is USDT. The
    // note says both so the tile answers "why is my USDT float shown in BB".
    walletNote: 'Funded by admin · you settle player orders in USDT',
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
 * `merchant_wallets` holds BB tokens for every merchant — an admin top-up of
 * 1,000,000 writes 100,000,000 paise of TOKENS whether that merchant settles
 * in rupees or in USDT — and the deposit escrow reserves tokens against every
 * order. USDT is what a PLAYER SENDS on a USDT order; it is not what the
 * merchant's float is counted in.
 *
 * This said "on the USDT rail it holds USDT" and rendered `<n> USDT`. On a live
 * server at ₹90 per USDT, a merchant's 900,000-token float reads as
 * "900,000 USDT" — a float actually worth about 10,000 USDT, overstated ninety
 * times, on the merchant's own balance tile. That is `CLAUDE.md` trap 15 in the
 * line a human reads: the same number is true in one currency and a lie in the
 * other, and nothing about it looks wrong.
 *
 * Sharper still, the two defects hid each other. The balance was never sent
 * (`formatMerchant` read it off the merchant row, which does not carry it), so
 * this rendered 0 — and "0 USDT" is correct-looking in every currency. Fixing
 * the backend alone would have turned a zero into a ninety-fold overstatement.
 */
export function formatTokens(amount: number | undefined | null): string {
  const value = Number(amount) || 0;
  return `${value.toLocaleString('en-IN', { maximumFractionDigits: 2 })} BB`;
}

/**
 * The merchant's wallet balance.
 *
 * Tokens on both rails — see `formatTokens`. Kept as its own name because the
 * call sites read as "the wallet", and because the next person to wonder what
 * unit a USDT merchant's wallet is in should land on that explanation.
 */
export function formatWallet(balance: number | undefined | null, _rail?: MerchantRail): string {
  return formatTokens(balance);
}

/**
 * The BB token figure shown beside the money amount. On the INR rail tokens are
 * 1:1 with rupees (fixed since 2026-07-08) and worth stating; on the USDT rail
 * the second column shows the network instead, since the token count is not the
 * useful number there.
 */
export function tokenColumn(order: PaymentOrder, rail: MerchantRail): { label: string; value: string } {
  if (rail === RAIL.USDT) {
    // THE ORDER'S OWN CHAIN. This was the literal 'TRC-20', so every USDT order
    // in the panel announced Tron — including a BEP-20 order, whose merchant
    // would then be watching the wrong wallet for a payment that is not coming.
    // `CLAUDE.md` §25.3: the address and its network always travel together,
    // and a network stated from anywhere but the order is not the order's.
    const chain = (order as { usdtChain?: string }).usdtChain as UsdtChain | undefined;
    return { label: 'Network', value: chain ? USDT_CHAIN_INFO[chain]?.label ?? chain : '—' };
  }
  return {
    label: 'Credited as',
    value: `${(Number(order.tokenAmount) || 0).toLocaleString('en-IN')} BB`,
  };
}

/**
 * The chains USDT is served on, and how to recognise an address on each.
 *
 * The same rules the backend enforces (backend/domains/merchant/
 * merchantCurrency.js). Mirrored here ONLY to give immediate feedback in the
 * address form; the backend remains the authority and rejects anything
 * malformed regardless of what this panel allows.
 *
 * Two chains and not one, because they are separate networks: USDT sent to a
 * Tron address from a BEP-20 wallet is gone. A merchant holds an address for
 * each chain they are willing to be paid on, and receives orders only on those.
 */
export const USDT_CHAINS = ['TRC20', 'BEP20'] as const;
export type UsdtChain = typeof USDT_CHAINS[number];

export const USDT_CHAIN_INFO: Record<UsdtChain, {
  label: string; field: 'usdtAddressTrc20' | 'usdtAddressBep20'; pattern: RegExp; hint: string;
}> = {
  // Base58 excludes 0, O, I and l so visually similar characters cannot be
  // confused. Case-SENSITIVE: base58 case is part of the address.
  TRC20: {
    label: 'Tron (TRC-20)',
    field: 'usdtAddressTrc20',
    pattern: /^T[1-9A-HJ-NP-Za-km-z]{33}$/,
    hint: '34 characters starting with “T”',
  },
  // An ordinary EVM address. Case is NOT checked — EIP-55 mixed case is a
  // checksum, and refusing a lower-case one would reject the form most wallets
  // copy.
  BEP20: {
    label: 'BNB Smart Chain (BEP-20)',
    field: 'usdtAddressBep20',
    pattern: /^0x[0-9a-fA-F]{40}$/,
    hint: '“0x” followed by 40 hexadecimal characters',
  },
};

export function isUsdtAddress(chain: UsdtChain, value: string): boolean {
  return USDT_CHAIN_INFO[chain]?.pattern.test((value || '').trim()) ?? false;
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
  const reference = String(order.orderId || order._id || '');
  return { name: reference ? `Order ${reference}` : 'Order', identified: false };
}


/**
 * The merchant's own receiving address for ONE order.
 *
 * Keyed on the order's chain, not on "the merchant's USDT address" — there is
 * no such single thing any more. A merchant may hold both, and showing the
 * wrong one tells a player to send on a network the address does not exist on.
 */
export function receivingAddressFor(
  merchant: { usdtAddressTrc20?: string; usdtAddressBep20?: string } | null | undefined,
  chain: string | null | undefined,
): { address: string; label: string } | null {
  const info = USDT_CHAIN_INFO[chain as UsdtChain];
  if (!info) return null;
  const address = (merchant?.[info.field] || '').trim();
  return address ? { address, label: info.label } : null;
}
