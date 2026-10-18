// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
// Unit tests for the order-currency vocabulary: an order is paid in INR or
// USDT, USDT on one chain, to the platform. Merchants have no rail.
import { describe, it, expect } from 'vitest';
import {
  ORDER_CURRENCY, USDT_CHAINS, USDT_CHAIN_SPEC, isUsdtChain, formatOrderFiat,
} from '../../domains/payment/orderCurrency.js';

describe('ORDER_CURRENCY', () => {
  it('names the two currencies an order is paid in, frozen', () => {
    expect(Object.values(ORDER_CURRENCY)).toEqual(['INR', 'USDT']);
    expect(Object.isFrozen(ORDER_CURRENCY)).toBe(true);
  });
});

describe('the USDT chain', () => {
  it('is BNB Smart Chain alone: USDT buys are paid to the platform there (owner, 2026-10-18)', () => {
    expect(USDT_CHAINS).toEqual(['BEP20']);
    expect(isUsdtChain('BEP20')).toBe(true);
    expect(isUsdtChain('TRC20')).toBe(false);
    expect(USDT_CHAIN_SPEC.BEP20.label).toMatch(/BNB Smart Chain/);
  });
});

describe('formatOrderFiat', () => {
  it('writes the amount in the order’s own currency', () => {
    expect(formatOrderFiat({ currency: 'USDT', fiatAmount: 500 })).toBe('500 USDT');
    expect(formatOrderFiat({ currency: 'INR', fiatAmount: 50000 })).toBe('₹50,000');
  });
});
