// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * The per-order UPI intent, built on the server.
 *
 * ── What is asserted, and why it is the CONTENTS ────────────────────────────
 * A test that only checked "a link was returned" would pass on a link with no
 * amount in it. A mistyped or mis-rounded amount is the most common cause of a
 * deposit a merchant cannot match against their statement, and the whole point
 * of a pre-filled link is that there is nothing left to get wrong — so every
 * field is checked, by name.
 *
 * The panel used to build this itself, from the merchant's handle and name off
 * the order, which is WHY it had to be given the handle. Moving it here is what
 * makes `playerOrderView.js` achievable rather than aspirational.
 */
import { describe, it, expect } from 'vitest';
import { upiPaymentLink } from '../../domains/payment/paymentLink.js';

const parse = (link) => new URL(link.replace('upi://', 'https://'));

describe('the per-order payment link', () => {
  const ok = () => upiPaymentLink({
    payeeUpiId: 'ravi@okhdfcbank',
    payeeName: 'Merchant #7731',
    amountRupees: 1500.5,
    orderId: 'ORD-77',
  });

  it('carries the payee, the exact amount, the currency and the order reference', () => {
    const q = parse(ok()).searchParams;
    expect(q.get('pa')).toBe('ravi@okhdfcbank');
    expect(q.get('pn')).toBe('Merchant #7731');
    // Two decimals, always: a UPI app rejects more, and `1500.5` is not a
    // rupee amount a bank statement will show.
    expect(q.get('am')).toBe('1500.50');
    expect(q.get('cu')).toBe('INR');
    expect(q.get('tr')).toBe('ORD-77');
    expect(q.get('tn')).toBe('BettingBazaar-ORD-77');
  });

  it('rounds to paise rather than emitting a long float', () => {
    const q = parse(upiPaymentLink({
      payeeUpiId: 'a@b', amountRupees: 0.1 + 0.2, orderId: 'X',
    })).searchParams;
    expect(q.get('am')).toBe('0.30');
  });

  it('escapes a handle and a name so the query cannot be split', () => {
    // `pn` is a display string on somebody else's screen. A name carrying `&`
    // or `=` unescaped would inject query parameters into the intent — a
    // different `pa=` among them.
    const link = upiPaymentLink({
      payeeUpiId: 'x@y', payeeName: 'A & B = C', amountRupees: 10, orderId: 'O1',
    });
    expect(link).not.toContain('A & B = C');
    expect(parse(link).searchParams.get('pn')).toBe('A & B = C');
    expect(parse(link).searchParams.get('pa')).toBe('x@y');
  });

  // ── The states that must not look alike ──────────────────────────────────
  //
  // `upi://pay?pa=` opens a UPI app with no payee. On the screen it is a live
  // button, and tapping it is a payment that goes nowhere recoverable — the
  // empty-state-as-success failure this codebase has shipped repeatedly. Null
  // is a state the screen can render as "waiting for merchant details".
  it.each([
    ['no payee',        { payeeUpiId: '',       amountRupees: 100 }],
    ['a blank payee',   { payeeUpiId: '   ',    amountRupees: 100 }],
    ['a null payee',    { payeeUpiId: null,     amountRupees: 100 }],
    ['no amount',       { payeeUpiId: 'a@b',    amountRupees: undefined }],
    ['a zero amount',   { payeeUpiId: 'a@b',    amountRupees: 0 }],
    ['a negative amount', { payeeUpiId: 'a@b',  amountRupees: -50 }],
    ['a non-numeric amount', { payeeUpiId: 'a@b', amountRupees: 'lots' }],
  ])('returns null, not a broken link, for %s', (_label, args) => {
    expect(upiPaymentLink({ orderId: 'ORD-1', ...args })).toBeNull();
  });

  it('names the merchant by an opaque reference and never by a person', () => {
    // `pn` is the ONE merchant-derived string a player sees on this platform,
    // and it is `Merchant #<publicRef>` — a label that identifies nobody. The
    // field it replaced was `name || username`, which in this data is the
    // merchant's own mobile number.
    const q = parse(ok()).searchParams;
    expect(q.get('pn')).toMatch(/^Merchant #\d+$/);
  });

  it('falls back to a generic payee name rather than emitting undefined', () => {
    const q = parse(upiPaymentLink({
      payeeUpiId: 'a@b', amountRupees: 5, orderId: 'O',
    })).searchParams;
    expect(q.get('pn')).toBe('Merchant');
  });
});
