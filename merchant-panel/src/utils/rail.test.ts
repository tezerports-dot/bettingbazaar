// GOVERNANCE: Read CLAUDE.md before editing this file.
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
  isUsdtAddress, receivingAddressFor, truncateMiddle, counterpartyOf,
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

describe('isUsdtAddress — gates where a player is told to send', () => {
  const TRON = 'TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE';
  const BNB  = '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb0';

  it('accepts a well-formed address on its own chain', () => {
    // Same rules the backend enforces; mirrored only for immediate feedback.
    expect(isUsdtAddress('TRC20', TRON)).toBe(true);
    expect(isUsdtAddress('TRC20', `  ${TRON}  `)).toBe(true); // trimmed
    expect(isUsdtAddress('BEP20', BNB)).toBe(true);
    // EIP-55 mixed case is a checksum, not part of the address — refusing a
    // lower-case one would reject the form most wallets copy.
    expect(isUsdtAddress('BEP20', BNB.toLowerCase())).toBe(true);
  });

  it('REFUSES the other chain’s address — the mistake that loses the money', () => {
    expect(isUsdtAddress('TRC20', BNB)).toBe(false);
    expect(isUsdtAddress('BEP20', TRON)).toBe(false);
  });

  it('rejects a malformed one', () => {
    expect(isUsdtAddress('TRC20', '')).toBe(false);
    expect(isUsdtAddress('TRC20', TRON.slice(0, -1))).toBe(false);          // one short
    expect(isUsdtAddress('TRC20', `B${TRON.slice(1)}`)).toBe(false);        // wrong prefix
    expect(isUsdtAddress('TRC20', `TO${TRON.slice(2)}`)).toBe(false);       // base58-ambiguous O
    expect(isUsdtAddress('BEP20', BNB.slice(2))).toBe(false);               // no 0x
    expect(isUsdtAddress('BEP20', `${BNB}ff`)).toBe(false);                 // too long
  });
});

describe('receivingAddressFor — which of the merchant’s addresses this order uses', () => {
  const merchant = {
    usdtAddressTrc20: 'TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE',
    usdtAddressBep20: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb0',
  };

  it('picks the address for the ORDER’s chain, not "the USDT address"', () => {
    // A merchant may hold both. Showing the wrong one tells a player to send on
    // a network where that address does not exist, and the tokens are gone.
    expect(receivingAddressFor(merchant, 'TRC20')?.address).toBe(merchant.usdtAddressTrc20);
    expect(receivingAddressFor(merchant, 'BEP20')?.address).toBe(merchant.usdtAddressBep20);
  });

  it('names the NETWORK alongside it, always', () => {
    expect(receivingAddressFor(merchant, 'TRC20')?.label).toMatch(/Tron/);
    expect(receivingAddressFor(merchant, 'BEP20')?.label).toMatch(/BNB/);
  });

  it('returns nothing when the merchant holds no address on that chain', () => {
    // Rendering a blank as a destination is how somebody sends to an empty
    // string. Absent means absent.
    expect(receivingAddressFor({ usdtAddressTrc20: merchant.usdtAddressTrc20 }, 'BEP20')).toBeNull();
    expect(receivingAddressFor(merchant, null)).toBeNull();
    expect(receivingAddressFor(merchant, 'SOLANA')).toBeNull();
    expect(receivingAddressFor(null, 'TRC20')).toBeNull();
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
    expect(usdt.proofLabel).toBe('Tx ID');
    expect(inr.credentialsLabel).toBe('UPI & bank');
    expect(usdt.credentialsLabel).toBe('TRC-20 wallet');
    // No field is left blank except the INR network note (there is no network).
    for (const [k, v] of Object.entries(usdt)) expect(v, `USDT.${k}`).toBeTruthy();
  });
});
