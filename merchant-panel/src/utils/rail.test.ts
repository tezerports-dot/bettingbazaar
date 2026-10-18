// GOVERNANCE: Read CLAUDE.md before editing this file.
/**
 * The merchant panel's payment vocabulary — money and who the merchant is
 * shown. Every merchant serves INR (USDT buys are paid to the platform). The
 * functions under test decide:
 *   - how much money is displayed and in which unit,
 *   - and whether the merchant is shown the counterparty's name at all, which is
 *     a privacy boundary, not a formatting choice.
 * All pure functions; typed fixtures stand in for the backend payloads.
 */
import { describe, it, expect } from 'vitest';
import {
  PAYMENT_COPY,
  formatMoney, formatMoneyCompact, formatTokens, tokenColumn,
  truncateMiddle, counterpartyOf,
} from './rail';
import type { PaymentOrder } from '../types';

const order = (o: Partial<PaymentOrder> = {}): PaymentOrder => ({
  orderId: 'ORD-1', currency: 'INR', tokenAmount: 0,
  ...o,
} as PaymentOrder);

describe('formatMoney', () => {
  it('renders INR with the rupee sign and Indian grouping', () => {
    expect(formatMoney(1234567)).toBe('₹12,34,567');
    expect(formatMoney(0)).toBe('₹0');
    expect(formatMoney(null)).toBe('₹0');
  });

});

describe('formatMoneyCompact', () => {
  it('uses the Indian scale for INR and keeps the sign', () => {
    expect(formatMoneyCompact(12000000)).toBe('₹1.20Cr');
    expect(formatMoneyCompact(120000)).toBe('₹1.20L');
    expect(formatMoneyCompact(1200)).toBe('₹1.2k');
    expect(formatMoneyCompact(-120000)).toBe('-₹1.20L');
  });

});

describe('formatTokens — a token figure is BB', () => {
  it('renders tokens as BB with Indian grouping, NOT rupees', () => {
    // Tokens are 1:1 with rupees but still tokens, so "₹2,50,000" would
    // mislabel a token count.
    expect(formatTokens(250000)).toBe('2,50,000 BB');
    expect(formatTokens(0)).toBe('0 BB');
    expect(formatTokens(null)).toBe('0 BB');
  });

});

describe('tokenColumn — the second figure beside the amount', () => {
  it('shows the BB credit', () => {
    expect(tokenColumn(order({ tokenAmount: 9000 }))).toEqual({ label: 'Credited as', value: '9,000 BB' });
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
  it('names the account holder on a withdrawal the merchant must pay', () => {
    const wd = order({ userBankDetails: { accountHolderName: '  Asha Rao  ' } as any });
    expect(counterpartyOf(wd)).toEqual({ name: 'Asha Rao', identified: true });
  });

  it('shows only the order reference when no identity was sent', () => {
    // The backend strips the user's identity from everything except a
    // withdrawal. Rendering a placeholder name would imply the panel knows who
    // this is — it does not, by design.
    expect(counterpartyOf(order({ orderId: 'Z9Y8' }))).toEqual({ name: 'Order Z9Y8', identified: false });
  });

  it('never invents a name from an empty holder field', () => {
    const wd = order({ orderId: 'K1', userBankDetails: { accountHolderName: '   ' } as any });
    expect(counterpartyOf(wd)).toEqual({ name: 'Order K1', identified: false });
  });
});

describe('PAYMENT_COPY — every payment string in one place', () => {
  it('words a bank-transfer order', () => {
    expect(PAYMENT_COPY.proofLabel).toBe('UTR');
    expect(PAYMENT_COPY.credentialsLabel).toBe('Bank account');
    for (const [k, v] of Object.entries(PAYMENT_COPY)) expect(v, k).toBeTruthy();
    expect(Object.values(PAYMENT_COPY).join(' ')).not.toMatch(/USDT|wallet|Tx hash/);
  });
});
