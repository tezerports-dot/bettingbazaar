// GOVERNANCE: Read CLAUDE.md before editing this file.
/**
 * The merchant panel's settlement-rail vocabulary — money and who the merchant
 * is shown.
 *
 * A merchant is INR-only or USDT-only, and almost every screen worded around
 * that distinction reads it from here. The functions under test decide:
 *   - how much money is displayed and in which unit,
 *   - and whether the merchant is shown the counterparty's name at all, which is
 *     a privacy boundary, not a formatting choice.
 * All pure functions; typed fixtures stand in for the backend payloads.
 */
import { describe, it, expect } from 'vitest';
import {
  RAIL, railOf, railOfOrder, isUsdt, railCopy,
  formatMoney, formatMoneyCompact, formatTokens, tokenColumn,
  truncateMiddle, counterpartyOf,
} from './rail';
import type { MerchantProfile, PaymentOrder } from '../types';

const order = (o: Partial<PaymentOrder> = {}): PaymentOrder => ({
  orderId: 'ORD-1', currency: 'INR', tokenAmount: 0,
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

describe('formatTokens — a token figure is BB on either rail', () => {
  it('renders tokens as BB with Indian grouping, NOT rupees', () => {
    // Tokens are 1:1 with rupees but still tokens, so "₹2,50,000" would
    // mislabel a token count.
    expect(formatTokens(250000)).toBe('2,50,000 BB');
    expect(formatTokens(0)).toBe('0 BB');
    expect(formatTokens(null)).toBe('0 BB');
  });

  it('takes no rail, because the rail is not the unit', () => {
    // A USDT order moves TOKENS on the platform; USDT is what the player sends
    // the member off-platform. At ₹90 per USDT a "USDT" suffix on a token
    // figure overstates it ninety times — trap 15 in the line a human reads.
    // formatTokens has no rail parameter, so the suffix cannot be chosen.
    expect(formatTokens.length).toBe(1);
    expect(formatTokens(900000)).toBe('9,00,000 BB');
  });
});

describe('tokenColumn — the second figure beside the amount', () => {
  it('shows the BB credit, on either rail', () => {
    expect(tokenColumn(order({ tokenAmount: 500 }))).toEqual({ label: 'Credited as', value: '500 BB' });
    // A USDT order's chain is not sent to a merchant: the platform receives it
    // (owner, 2026-10-18), so the panel has no network to state.
    expect(tokenColumn(order({ currency: 'USDT', tokenAmount: 9000 }))).toEqual({ label: 'Credited as', value: '9,000 BB' });
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
    expect(counterpartyOf(order({ orderId: 'Z9Y8' }))).toEqual({ name: 'Order Z9Y8', identified: false });
  });

  it('never invents a name from an empty holder field', () => {
    const wd = order({ orderId: 'K1', userBankDetails: { accountHolderName: '   ' } as any });
    expect(counterpartyOf(wd)).toEqual({ name: 'Order K1', identified: false });
  });
});

describe('railCopy — every rail-dependent string in one place', () => {
  it('gives INR and USDT distinct, complete copy', () => {
    const inr = railCopy('INR'); const usdt = railCopy('USDT');
    expect(inr.proofLabel).toBe('UTR');
    expect(usdt.proofLabel).toBe('Tx hash');
    expect(inr.credentialsLabel).toBe('Bank account');
    // A merchant on the old USDT rail serves nothing and holds no address.
    expect(usdt.credentialsLabel).toMatch(/no orders/);
    expect(usdt.credentialsLabel).not.toMatch(/TRC|BEP|wallet/);
    // No field is left blank except the INR network note (there is no network).
    for (const [k, v] of Object.entries(usdt)) expect(v, `USDT.${k}`).toBeTruthy();
  });
});
