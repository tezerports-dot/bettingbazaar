// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * What a cash buy's payment link may be (`domains/payment/cashLink.js`).
 *
 * The link is scanned by a member and handed to a PLAYER as a button that opens
 * their banking app, so each refusal below is a link somebody else would have
 * paid. The opposite case is pinned too: a real ATM link, in the spellings a
 * scanner actually produces, goes through unchanged.
 */
import { describe, it, expect } from 'vitest';
import { checkCashLink, CASH_LINK_MAX_LENGTH } from '../../domains/payment/cashLink.js';

const ATM = 'upi://pay?pa=atm.cash%40icici&pn=ICICI%20ATM&am=1000.00&cu=INR&tr=ATM8812345&mc=6011';

const refusedWith = (raw, amount, pattern) => {
  let err;
  try { checkCashLink(raw, amount); } catch (e) { err = e; }
  expect(err, `accepted: ${raw}`).toBeDefined();
  expect(err).toMatchObject({ status: 400, code: 'INVALID_CASH_LINK' });
  if (pattern) expect(err.message).toMatch(pattern);
};

describe('a cash link', () => {
  it('accepts a real ATM link for the order amount, unchanged', () => {
    expect(checkCashLink(ATM, 1000)).toBe(ATM);
  });

  it('accepts the amount written without decimals, and an upper-case scheme', () => {
    const link = 'UPI://PAY?pa=atm@sbi&am=500&cu=INR';
    expect(checkCashLink(link, 500)).toBe('upi://pay?pa=atm@sbi&am=500&cu=INR');
  });

  it('accepts a link that does not name the currency', () => {
    expect(checkCashLink('upi://pay?pa=atm@hdfc&am=5000.00', 5000)).toBe('upi://pay?pa=atm@hdfc&am=5000.00');
  });

  it('refuses a link for a different amount, and names both', () => {
    refusedWith(ATM, 5000, /₹1,000.*₹5,000/);
  });

  it('refuses a link with no amount', () => {
    refusedWith('upi://pay?pa=atm@sbi&cu=INR', 500, /no amount/);
  });

  it.each([
    ['a web page', 'https://example.com/pay?pa=atm@sbi&am=500'],
    ['a script', 'javascript:alert(1)//upi://pay?pa=a@b&am=500'],
    ['another scheme', 'upi://mandate?pa=atm@sbi&am=500'],
    // The same length as `upi://pay?`, with a valid payee and amount after it:
    // refused for its scheme, not rewritten into one.
    ['another app\'s scheme', 'tez://upi?pa=atm@sbi&am=500'],
    ['a collect request', 'upi://col?pa=atm@sbi&am=500'],
  ])('refuses %s, by its scheme', (_, raw) => {
    refusedWith(raw, 500, /not a UPI payment link/);
  });

  it.each([
    ['nothing', ''],
    ['a number', 12345],
  ])('refuses %s', (_, raw) => {
    refusedWith(raw, 500, /no link was received/);
  });

  it('refuses a QR that pays a mobile number: a person, whose number the player would see', () => {
    for (const handle of ['9876543210@ybl', '919876543210@paytm', 'pay.09876543210@okaxis', '9876543210-2@axl', '00919876543210@ibl']) {
      refusedWith(`upi://pay?pa=${handle}&am=500`, 500, /mobile number/);
    }
  });

  it('refuses a mobile number in the name or note the player\'s UPI app shows, however it is written', () => {
    for (const extra of ['pn=Ravi%209876543210', 'pn=Ravi+98765+43210', 'tn=call%20%2B91-98765-43210', 'tn=0091.98765.43210', 'pn=R%2009876543210']) {
      refusedWith(`upi://pay?pa=atm.1234@sbi&am=500&${extra}`, 500, /mobile number in its name or note/);
    }
  });

  it('takes a machine\'s name and note with short numbers in them', () => {
    for (const extra of ['pn=SBI%20ATM%20123456', 'tn=Cash%20withdrawal%20T-4471', 'pn=ICCW+5000123412']) {
      const link = `upi://pay?pa=atm.1234@sbi&am=500&${extra}`;
      expect(checkCashLink(link, 500)).toBe(link);
    }
  });

  it('takes a machine handle with a terminal number in it', () => {
    // Digits in a handle are not a phone number unless they are one.
    for (const handle of ['atm.12345678@sbi', 'iccw123456789012@icici', 'atm5876543@hdfc']) {
      expect(checkCashLink(`upi://pay?pa=${handle}&am=500`, 500)).toBe(`upi://pay?pa=${handle}&am=500`);
    }
  });

  it('refuses markup, spaces and control characters', () => {
    refusedWith('upi://pay?pa=atm@sbi&am=500&pn=<b>x</b>', 500, /characters/);
    refusedWith('upi://pay?pa=atm@sbi&am=500&pn=A B', 500, /characters/);
    refusedWith('upi://pay?pa=atm@sbi&am=500\n&cu=INR', 500, /characters/);
  });

  it('refuses a parameter named twice, so the amount read is the amount paid', () => {
    refusedWith('upi://pay?pa=atm@sbi&am=500&am=50000', 500, /"am" twice/);
    refusedWith('upi://pay?pa=atm@sbi&pa=thief@ybl&am=500', 500, /"pa" twice/);
  });

  it('refuses a payee that is not a UPI address', () => {
    refusedWith('upi://pay?am=500', 500, /payee/);
    refusedWith('upi://pay?pa=notanaddress&am=500', 500, /payee/);
  });

  it('refuses a currency other than rupees', () => {
    refusedWith('upi://pay?pa=atm@sbi&am=500&cu=USD', 500, /rupees/);
  });

  it('refuses an over-long link', () => {
    refusedWith(`upi://pay?pa=atm@sbi&am=500&tn=${'x'.repeat(CASH_LINK_MAX_LENGTH)}`, 500, /too long/);
  });
});
