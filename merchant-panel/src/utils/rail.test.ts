// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file.
/**
 * The merchant panel's settlement-rail vocabulary — money, payout addresses and
 * who the merchant is shown.
 *
 * A merchant is INR-only or USDT-only, and almost every screen worded around
 * that distinction reads it from here. The functions under test decide:
 *   - how much money is displayed and in which unit,
 *   - whether a TRC-20 payout address is well-formed (mirrors the backend rule
 *     that actually gates the transfer),
 *   - and whether the merchant is shown the counterparty's name at all, which is
 *     a privacy boundary, not a formatting choice.
 * All pure functions; typed fixtures stand in for the backend payloads.
 */
import { describe, it, expect } from 'vitest';
import {
  RAIL, railOf, railOfOrder, isUsdt, railCopy,
  formatMoney, formatMoneyCompact, formatWallet, tokenColumn,
  isTrc20Address, truncateMiddle, counterpartyOf,
} from './rail';
import type { MerchantProfile, PaymentOrder } from '../types';

const order = (o: Partial<PaymentOrder> = {}): PaymentOrder => ({
  orderId: 'ORD-1', shortId: 'A1B2', currency: 'INR', tokenAmount: 0,
  ...o,
} as PaymentOrder);

describe('which rail', () => {
  it('reads a merchant’s rail, defaulting to INR', () => {
    expect(railOf({ merchantType: 'USDT' } as MerchantProfile)).toBe('USDT');
    expect(railOf({ acceptedCurrencies: ['USDT'] } as MerchantProfile)).toBe('USDT');
    expect(railOf({ acceptedCurrencies: ['INR'] } as MerchantProfile)).toBe('INR');
    expect(railOf(null)).toBe('INR');            // no profile yet
    expect(railOf({} as MerchantProfile)).toBe('INR'); // schema default
  });

  it('reads an order’s rail, treating a pre-field order as INR', () => {
    expect(railOfOrder({ currency: 'USDT' })).toBe('USDT');
    expect(railOfOrder({ currency: undefined })).toBe('INR');
    expect(railOfOrder(null)).toBe('INR');
  });

  it('isUsdt is exactly the USDT rail', () => {
    expect(isUsdt('USDT')).toBe(true);
    expect(isUsdt('INR')).toBe(false);
  });
});

describe('formatMoney', () => {
  it('renders INR with the rupee sign and Indian grouping', () => {
    expect(formatMoney(1234567, RAIL.INR)).toBe('₹12,34,567');
    expect(formatMoney(0, RAIL.INR)).toBe('₹0');
    expect(formatMoney(null, RAIL.INR)).toBe('₹0');
  });

  it('renders USDT suffixed, with decimals ONLY when the value has them', () => {
    // A whole number of USDT should not read "100.00 USDT"; a fractional one
    // must not be truncated to look whole.
    expect(formatMoney(100, RAIL.USDT)).toBe('100 USDT');
    expect(formatMoney(100.5, RAIL.USDT)).toBe('100.50 USDT'); // 2dp once fractional
    expect(formatMoney(0, RAIL.USDT)).toBe('0 USDT');
  });
});

describe('formatMoneyCompact', () => {
  it('uses the Indian scale for INR and keeps the sign', () => {
    expect(formatMoneyCompact(12000000, RAIL.INR)).toBe('₹1.20Cr');
    expect(formatMoneyCompact(120000, RAIL.INR)).toBe('₹1.20L');
    expect(formatMoneyCompact(1200, RAIL.INR)).toBe('₹1.2k');
    expect(formatMoneyCompact(-120000, RAIL.INR)).toBe('-₹1.20L');
  });

  it('uses M/k for USDT', () => {
    expect(formatMoneyCompact(2500000, RAIL.USDT)).toBe('2.50M USDT');
    expect(formatMoneyCompact(8400, RAIL.USDT)).toBe('8.4k USDT');
  });
});

describe('formatWallet — the unit the wallet is denominated in', () => {
  it('labels the INR wallet as BB tokens, NOT rupees', () => {
    // The INR wallet holds BB tokens (1:1 with rupees but still tokens), so
    // "₹2,50,000" would mislabel what the merchant actually holds.
    expect(formatWallet(250000, RAIL.INR)).toBe('2,50,000 BB');
    expect(formatWallet(0, RAIL.INR)).toBe('0 BB');
  });

  it('labels the USDT wallet as USDT', () => {
    expect(formatWallet(1000, RAIL.USDT)).toBe('1,000 USDT');
  });
});

describe('tokenColumn — the second figure beside the amount', () => {
  it('shows the BB credit on INR and the network on USDT', () => {
    expect(tokenColumn(order({ tokenAmount: 500 }), RAIL.INR)).toEqual({ label: 'Credited as', value: '500 BB' });
    expect(tokenColumn(order(), RAIL.USDT)).toEqual({ label: 'Network', value: 'TRC-20' });
  });
});

describe('isTrc20Address — gates the USDT payout destination', () => {
  it('accepts a well-formed TRC-20 address', () => {
    // T + 33 base58 chars. Same rule the backend enforces; mirrored only for
    // immediate feedback.
    expect(isTrc20Address('TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE')).toBe(true);
    expect(isTrc20Address('  TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE  ')).toBe(true); // trimmed
  });

  it('rejects a malformed one', () => {
    expect(isTrc20Address('')).toBe(false);
    expect(isTrc20Address('0xabc123')).toBe(false);                 // ETH-style
    expect(isTrc20Address('TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLS')).toBe(false); // one short
    expect(isTrc20Address('BQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE')).toBe(false); // wrong prefix
    expect(isTrc20Address('TOn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE0')).toBe(false); // contains 0/O ambiguous + too long
  });
});

describe('truncateMiddle', () => {
  it('keeps a long address recognisable at both ends', () => {
    expect(truncateMiddle('TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE')).toBe('TQn9Y2khEs…KcbLSE'); // head 10 … tail 6
  });

  it('leaves a short value alone', () => {
    expect(truncateMiddle('short')).toBe('short');
  });
});

describe('counterpartyOf — a privacy boundary, not a label', () => {
  it('names the account holder on an INR withdrawal the merchant must pay', () => {
    const wd = order({ userBankDetails: { accountHolderName: '  Asha Rao  ' } as any });
    expect(counterpartyOf(wd)).toEqual({ name: 'Asha Rao', identified: true });
  });

  it('shows only the order reference when no identity was sent', () => {
    // The backend strips the user's identity from everything except an INR
    // withdrawal. Rendering a placeholder name would imply the panel knows who
    // this is — it does not, by design.
    expect(counterpartyOf(order({ shortId: 'Z9Y8' }))).toEqual({ name: 'Order Z9Y8', identified: false });
  });

  it('never invents a name from an empty holder field', () => {
    const wd = order({ shortId: 'K1', userBankDetails: { accountHolderName: '   ' } as any });
    expect(counterpartyOf(wd)).toEqual({ name: 'Order K1', identified: false });
  });
});

describe('railCopy — every rail-dependent string in one place', () => {
  it('gives INR and USDT distinct, complete copy', () => {
    const inr = railCopy('INR'); const usdt = railCopy('USDT');
    expect(inr.proofLabel).toBe('UTR');
    expect(usdt.proofLabel).toBe('Tx ID');
    expect(inr.credentialsLabel).toBe('UPI & bank');
    expect(usdt.credentialsLabel).toBe('TRC-20 wallet');
    // No field is left blank except the INR network note (there is no network).
    for (const [k, v] of Object.entries(usdt)) expect(v, `USDT.${k}`).toBeTruthy();
  });
});
