// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Contact and payout details reach full admins only (owner, 2026-10-21;
 * CLAUDE.md §24): what the shield takes out, what it leaves, and that each
 * door (JSON answers, workbooks, the staff stream) asks it.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  shieldContact, shieldWorkbook, seesContact, shieldContactForStaff,
} from '../../domains/identity/staffContactShield.js';
import { sendXlsx } from '../../domains/reporting/xlsx.util.js';

const order = {
  orderId: 'ORD1', tokenAmount: 50_000,
  userId: { userId: 'u1', username: 'player', mobile: '9876543210' },
  merchantId: { merchantId: 'm1', name: 'Shop', mobile: '9123456780' },
  userMobile: '9876543210',
  userBankDetails: { accountHolderName: 'A Player', accountNumber: '123456789012', ifscCode: 'HDFC0001234', bankName: 'HDFC', upiId: 'a@okaxis' },
  payoutUpiLink: 'upi://pay?pa=a@okaxis',
  disputeReason: 'call me on 98765 43210 please',
  messages: [{ message: 'my number +91 9876543210', sender: 'USER' }],
  supportLinks: { phone: '9000000000', email: 'help@site' },
};

describe('the staff contact shield', () => {
  it('takes out every contact and payout detail, at any depth', () => {
    const out = shieldContact(order);
    const text = JSON.stringify(out);
    expect(text).not.toMatch(/9876543210|9123456780|123456789012|HDFC0001234|a@okaxis/);
    expect(out.userId).toEqual({ userId: 'u1', username: 'player' });
    expect(out.userBankDetails).toEqual({ accountHolderName: 'A Player', bankName: 'HDFC' });
    expect(out.payoutUpiLink).toBeUndefined();
  });

  it('hides a mobile written into free text, and keeps the rest of it', () => {
    const out = shieldContact(order);
    expect(out.disputeReason).toBe('call me on [number hidden] please');
    expect(out.messages[0]).toEqual({ message: 'my number [number hidden]', sender: 'USER' });
  });

  it('leaves the order\'s own figures and the platform\'s published support contact', () => {
    const out = shieldContact(order);
    expect(out).toMatchObject({ orderId: 'ORD1', tokenAmount: 50_000 });
    expect(out.supportLinks).toEqual({ phone: '9000000000', email: 'help@site' });
  });

  it('only a full admin sees contact', () => {
    expect(seesContact({ isAdmin: true })).toBe(true);
    for (const v of [{ isSubAdmin: true }, { isMediator: true }, { isAdmin: 'true' }, null]) expect(seesContact(v)).toBe(false);
  });

  it('the staff router shields a sub-admin\'s answer and not a full admin\'s', () => {
    for (const [user, mobile] of [[{ isSubAdmin: true }, undefined], [{ isAdmin: true }, '9876543210']]) {
      const sent = [];
      const res = { json: (b) => sent.push(b) };
      const next = vi.fn();
      shieldContactForStaff({ user }, res, next);
      expect(next).toHaveBeenCalled();
      res.json({ user: { mobile: '9876543210' } });
      expect(sent[0].user.mobile).toBe(mobile);
    }
  });

  it('a workbook loses its contact columns for a sub-admin, and keeps them for a full admin', () => {
    const workbook = { sheets: [{ name: 'P', tables: [{ columns: [{ key: 'username' }, { key: 'mobile' }], rows: [{ username: 'p', mobile: '9876543210' }] }] }] };
    expect(shieldWorkbook(workbook).sheets[0].tables[0]).toEqual({ columns: [{ key: 'username' }], rows: [{ username: 'p' }] });
    const send = (user) => {
      const res = { req: { user }, headers: {}, setHeader(k, v) { this.headers[k] = v; }, send: vi.fn() };
      sendXlsx(res, 'p.xlsx', workbook);
      return res.send.mock.calls[0][0].toString('latin1');
    };
    // The sheet XML is deflated; compare sizes instead of text: the shielded one lacks the column.
    expect(send({ accountType: 'STAFF', isSubAdmin: true }).length).toBeLessThan(send({ accountType: 'STAFF', isAdmin: true }).length);
  });
});
