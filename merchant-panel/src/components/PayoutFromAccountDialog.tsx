// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Mark a merchant account's sell paid: which of its accounts paid it, and the
 * UTR (owner, 2026-10-11 — Phase B).
 *
 * The account is required: the server refuses a sell a merchant account serves
 * without one (400 PAID_FROM_ACCOUNT_REQUIRED), asked BEFORE the UTR is
 * claimed, and stamps it on the order inside the Paid transition. The choices
 * are the merchant's ACTIVE accounts that pay withdrawals and, for a
 * sub-member, the ones assigned to them (`payFromChoices`, a mirror of
 * `mayPayFrom`). Nothing is pre-chosen: the person who paid says which
 * account they paid from.
 *
 * The dialog stays open on a refusal, with what was typed, and says the
 * server's sentence (§32 S44).
 */
import React, { useEffect, useState } from 'react';
import { ArrowUpRight } from 'lucide-react';
import { Banner, Button, Field, inputStyle, useDismissable } from './ui';
import { payFromChoices } from '../utils/actor';
import { formatMoney } from '../utils/rail';
import { MIN_UTR_LENGTH } from '../hooks/useOrderActions';
import type { MerchantProfile, PaymentAccount, PaymentOrder } from '../types';

export const PayoutFromAccountDialog: React.FC<{
  order: PaymentOrder | null;
  merchant: MerchantProfile | null;
  accounts: PaymentAccount[];
  onCancel: () => void;
  /** Rejects with the server's refusal; resolves once the payout is recorded. */
  onSubmit: (utr: string, paidFromAccountId: string) => Promise<void>;
}> = ({ order, merchant, accounts, onCancel, onSubmit }) => {
  const [accountId, setAccountId] = useState('');
  const [utr, setUtr] = useState('');
  const [problem, setProblem] = useState('');
  const [busy, setBusy] = useState(false);
  const open = order !== null;
  useDismissable(open, onCancel);
  useEffect(() => { setAccountId(''); setUtr(''); setProblem(''); setBusy(false); }, [order?.orderId]);
  if (!order) return null;

  const choices = payFromChoices(merchant, accounts, Number(order.tokenAmount ?? order.amount));

  const submit = async () => {
    if (!accountId) { setProblem('Choose the account you paid this withdrawal from.'); return; }
    const reference = utr.trim();
    if (reference.length < MIN_UTR_LENGTH) {
      setProblem(`A UTR is at least ${MIN_UTR_LENGTH} characters. It is on your transfer receipt.`);
      return;
    }
    setProblem(''); setBusy(true);
    try {
      await onSubmit(reference, accountId);
    } catch (err: any) {
      setProblem(err?.message || 'That did not go through. Try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'var(--overlay)', zIndex: 60,
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 22,
    }}>
      <div role="dialog" aria-modal="true" aria-labelledby="payout-from-title" style={{
        width: '100%', maxWidth: 400, background: 'var(--surface)', borderRadius: 18,
        boxShadow: 'var(--shadow-lg)', padding: 22, display: 'flex', flexDirection: 'column', gap: 12,
      }}>
        <div id="payout-from-title" style={{ fontSize: 17, fontWeight: 800, color: 'var(--text)', display: 'flex', alignItems: 'center', gap: 8 }}>
          <ArrowUpRight size={18} /> Mark payout as sent
        </div>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-2)', lineHeight: 1.5 }}>
          Confirm you sent {formatMoney(order.fiatAmount ?? order.amount)} by bank transfer to the player&apos;s
          account. Choose the account you paid from and enter the UTR your bank gave the transfer.
        </div>
        {choices.length === 0 ? (
          <Banner tone="warn">
            No account can pay this: none of your accounts is active and paying withdrawals of this size
            {merchant?.actor && !merchant.actor.isOwner ? ' and assigned to you' : ''}. Ask the account owner.
          </Banner>
        ) : (
          <Field label="Paid from account" htmlFor="payout-from-account">
            <select id="payout-from-account" value={accountId} onChange={(e) => setAccountId(e.target.value)} style={inputStyle}>
              <option value="">Choose an account…</option>
              {choices.map((a) => (
                <option key={a.accountId} value={a.accountId}>
                  {a.label} · {a.bankName} ·{a.accountNo.slice(-4)}
                </option>
              ))}
            </select>
          </Field>
        )}
        <Field label={`UTR (min ${MIN_UTR_LENGTH} characters)`} htmlFor="payout-from-utr">
          <input id="payout-from-utr" value={utr} onChange={(e) => setUtr(e.target.value)} style={inputStyle} autoComplete="off" />
        </Field>
        {problem && <div role="alert"><Banner tone="danger">{problem}</Banner></div>}
        <div style={{ display: 'flex', gap: 9 }}>
          <Button variant="outline" tone="neutral" onClick={onCancel} style={{ flex: 1, borderColor: 'var(--border)', color: 'var(--text)' }}>
            Cancel
          </Button>
          <Button tone="ok" onClick={() => void submit()} busy={busy} disabled={choices.length === 0} style={{ flex: 1 }}>
            I&apos;ve sent the money
          </Button>
        </div>
      </div>
    </div>
  );
};

export default PayoutFromAccountDialog;
