// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
//
// Order detail — a right drawer on desktop, a bottom sheet on mobile (design
// handoff "BB Merchant Panel.dc.html"). Everything on the one-line row, plus
// the full payment rows, the account holder, and the same actions (and Flag)
// pinned to the footer so they stay reachable while reading.
import React from 'react';
import { ArrowDownLeft, ArrowUpRight, Check, QrCode, ShieldCheck, X } from 'lucide-react';
import { OrderStatus, type MerchantProfile, type PaymentAccount, type PaymentOrder } from '../types';
import { mayWorkOrder } from '../utils/actor';
import { counterpartyOf, formatMoney, tokenColumn, PAYMENT_COPY } from '../utils/rail';
import { formatCountdown, secondsLeft, URGENT_SECONDS } from '../hooks/useCountdown';
import { Banner, Button, CopyInline, Panel, StatusPill } from './ui';
import { accountNamed, viewOnlyReason, type OrderActions } from './OrderRow';

const sectionLabel: React.CSSProperties = {
  fontSize: 11, fontWeight: 800, color: 'var(--muted)',
  textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 8,
};

export const OrderDetail: React.FC<{
  order: PaymentOrder | null;
  merchant: MerchantProfile | null;
  now: number;
  isMobile: boolean;
  onClose: () => void;
  actions: OrderActions;
  /** A merchant account's payment accounts, to name the one an order is paid into or from. */
  paymentAccounts?: PaymentAccount[];
}> = ({ order, merchant, now, isMobile, onClose, actions, paymentAccounts }) => {
  if (!order) return null;

  const copy = PAYMENT_COPY;
  const isDeposit = order.type === 'DEPOSIT';
  const accent = isDeposit ? 'var(--dep)' : 'var(--wd)';
  const accentBg = isDeposit ? 'var(--dep-bg)' : 'var(--wd-bg)';
  const token = tokenColumn(order);
  const counterparty = counterpartyOf(order);

  const remaining = secondsLeft(order.expiresAt, now);
  const openStatus = [OrderStatus.PENDING_QUEUE, OrderStatus.PROCESSING, OrderStatus.PAID].includes(
    order.status as OrderStatus
  );
  const showTimer = remaining !== null && openStatus;
  const urgent = remaining !== null && remaining < URGENT_SECONDS;

  // What this person may do to it (a merchant account's sub-member by role and
  // assigned accounts; owner, 2026-10-11). Controls they cannot use are not offered.
  const workable = mayWorkOrder(merchant, order);
  // No accept: routing starts an order as it hands it out (owner, 2026-10-17).
  // A started order may be declined only while nobody can have paid on it.
  const canDecline = workable && order.canDecline === true;
  const canScan = workable && isDeposit && order.paymentMode === 'CASH_ATM' && order.status === OrderStatus.PROCESSING;
  /**
   * PAID, but not yet evidenced.
   *
   * On the CASH rail the player taps "I've paid" the moment the machine gives
   * them the notes — that is what lets this merchant carry on at an ATM whose
   * session is timing out — and the reference follows a minute later. The
   * server refuses Confirm until it lands (§27: a completed deposit the
   * registry never saw leaves a later dispute nothing to match against).
   *
   * So the button is not offered while it would only be refused. A control
   * that fails when pressed reads as a broken panel, and the merchant's next
   * move is to call support about a working guard.
   */
  const awaitingReference = order.status === OrderStatus.PAID && isDeposit && !order.utrNumber;
  const canRelease = workable && order.status === OrderStatus.PAID && isDeposit && !awaitingReference;
  const canPayout = workable && order.status === OrderStatus.PROCESSING && !isDeposit;
  const payAccount = accountNamed(paymentAccounts, order.payAccountId);
  const paidFrom = accountNamed(paymentAccounts, order.paidFromAccountId);

  // Payment rows: the merchant's own receiving credentials on a deposit, the
  // user's payout destination on a withdrawal.
  const paymentRows: Array<{ label: string; value: string }> = [];
  if (isDeposit && order.payAccountId) {
    // A merchant account's buy: paid into the account routing chose (owner, 2026-10-11).
    paymentRows.push({ label: 'Your account', value: payAccount?.label ?? String(order.payAccountId) });
    if (payAccount?.kind === 'UPI_QR' && payAccount.upiId) paymentRows.push({ label: 'UPI ID', value: payAccount.upiId });
    if (payAccount) {
      paymentRows.push({ label: 'Account no.', value: payAccount.accountNo });
      paymentRows.push({ label: 'IFSC', value: payAccount.ifsc });
    }
  } else if (isDeposit) {
    if (order.paymentMode === 'CASH_ATM') {
      // Paid to the cash machine this member scans (Step 2d), never to them.
      paymentRows.push({ label: 'Cash machine QR', value: order.cashLink ? 'Scanned — the player can pay it' : 'Not scanned yet' });
    } else {
      // Paid by bank transfer into the member's own account, the details the
      // player is shown (owner, 2026-10-03).
      const holder = merchant?.bankDetails?.accountHolderName || merchant?.settlementDetails?.accountName;
      const accountNo = merchant?.bankDetails?.accountNo || merchant?.settlementDetails?.accountNumber;
      const ifsc = merchant?.bankDetails?.ifsc || merchant?.settlementDetails?.ifsc;
      const bankName = merchant?.bankDetails?.bankName || merchant?.settlementDetails?.bankName;
      if (holder) paymentRows.push({ label: 'Account holder', value: holder });
      if (accountNo) paymentRows.push({ label: 'Account no.', value: accountNo });
      if (ifsc) paymentRows.push({ label: 'IFSC', value: ifsc });
      if (bankName) paymentRows.push({ label: 'Bank', value: bankName });
    }
  } else {
    const bank = order.userBankDetails;
    if (bank?.accountHolderName) paymentRows.push({ label: 'Holder', value: bank.accountHolderName });
    if (bank?.accountNumber) paymentRows.push({ label: 'Account no.', value: bank.accountNumber });
    if (bank?.ifscCode) paymentRows.push({ label: 'IFSC', value: bank.ifscCode });
    if (bank?.bankName) paymentRows.push({ label: 'Bank', value: bank.bankName });
  }

  const paySectionLabel = isDeposit
    ? (order.paymentMode === 'CASH_ATM' ? 'Payment — user pays the cash machine'
      : 'Payment — user transfers to your account')
    : copy.payoutDestinationLabel;

  const header = (
    <>
      <span style={{
        width: 36, height: 36, borderRadius: 10, background: accentBg, color: accent,
        display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
      }}>
        {isDeposit ? <ArrowDownLeft size={18} /> : <ArrowUpRight size={18} />}
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          <span style={{ fontSize: 15, fontWeight: 800, color: 'var(--text)' }}>
            {isDeposit ? 'Deposit' : 'Withdrawal'}
          </span>
          <StatusPill status={order.status} />
        </div>
        <div className="bb-mono" style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {order.orderId || order._id}
        </div>
      </div>
    </>
  );

  const viewOnly = !workable && openStatus ? viewOnlyReason(merchant, order) : '';
  const footer = viewOnly ? (
    <div role="status" style={{ flex: 1, fontSize: 12.5, fontWeight: 700, color: 'var(--text-2)', textAlign: 'center', padding: 8 }}>
      {viewOnly}
    </div>
  ) : awaitingReference ? (
    <div style={{
      flex: 1, padding: 13, borderRadius: 12, textAlign: 'center',
      background: 'var(--warn-bg)', border: '1px solid var(--warn)',
      color: 'var(--text)', fontSize: 12.5, fontWeight: 700,
    }}>
      The player has reported paying. Waiting for their payment reference —
      you can release as soon as it arrives.
    </div>
  ) : canRelease ? (
    <>
      <Button tone="ok" onClick={() => actions.onRelease(order)} style={{ flex: 1, padding: 14, fontSize: 14 }}>
        <ShieldCheck size={16} /> Confirm &amp; release
      </Button>
      <Button variant="outline" tone="danger" onClick={() => actions.onPaymentNotReceived(order)} style={{ padding: '14px 14px', fontSize: 14 }}>
        <X size={16} /> Not received
      </Button>
      <Button variant="outline" tone="dispute" onClick={() => actions.onRedFlag(order)} style={{ padding: '14px 14px', fontSize: 14 }}>
        Flag
      </Button>
    </>
  ) : canPayout ? (
    <>
      <Button tone="ok" onClick={() => actions.onPayout(order)} style={{ flex: 1, padding: 14, fontSize: 14 }}>
        <Check size={16} /> Mark payout sent
      </Button>
      {canDecline && (
        <Button variant="outline" tone="danger" onClick={() => actions.onDecline(order)} style={{ padding: '14px 14px', fontSize: 14 }}>
          <X size={16} /> Decline
        </Button>
      )}
      <Button variant="outline" tone="dispute" onClick={() => actions.onRedFlag(order)} style={{ padding: '14px 14px', fontSize: 14 }}>
        Flag
      </Button>
    </>
  ) : canScan ? (
    <>
      <Button onClick={() => actions.onScanCashLink(order)} style={{ flex: 1, padding: 14, fontSize: 14 }}>
        <QrCode size={16} /> {order.cashLink ? 'Scan again' : 'Scan the machine\'s QR'}
      </Button>
      {canDecline && (
        <Button variant="outline" tone="danger" onClick={() => actions.onDecline(order)} style={{ padding: '14px 14px', fontSize: 14 }}>
          <X size={16} /> Decline
        </Button>
      )}
    </>
  ) : undefined;

  return (
    <Panel open onClose={onClose} isMobile={isMobile} header={header} footer={footer}>
      {showTimer && remaining !== null && (
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '12px 15px', borderRadius: 13,
          color: urgent ? 'var(--danger)' : 'var(--warn)',
          background: urgent ? 'var(--danger-bg)' : 'var(--warn-bg)',
        }}>
          <span style={{ fontSize: 12, fontWeight: 700 }}>Time remaining</span>
          <span className="bb-mono" style={{ fontSize: 17, fontWeight: 700 }}>
            {remaining === 0 ? 'Expired' : formatCountdown(remaining)}
          </span>
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 11 }}>
        <div style={{ background: 'var(--surface-2)', borderRadius: 13, padding: 14 }}>
          <div style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase' }}>
            {isDeposit ? 'User pays you' : 'You send'}
          </div>
          <div className="bb-mono" style={{ fontSize: 22, fontWeight: 700, color: 'var(--text)', letterSpacing: '-1px' }}>
            {formatMoney(order.fiatAmount ?? order.amount)}
          </div>
        </div>
        <div style={{ background: 'var(--surface-2)', borderRadius: 13, padding: 14 }}>
          <div style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase' }}>{token.label}</div>
          <div className="bb-mono" style={{ fontSize: 22, fontWeight: 700, color: 'var(--text)', letterSpacing: '-1px' }}>
            {token.value}
          </div>
        </div>
      </div>

      <div>
        <div style={sectionLabel}>Counterparty</div>
        <div style={{ background: 'var(--surface-2)', borderRadius: 13, padding: '4px 14px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, padding: '9px 0', borderBottom: '1px solid var(--border)' }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)', flexShrink: 0 }}>
              {counterparty.identified ? 'Account holder' : 'Reference'}
            </span>
            <span
              className={counterparty.identified ? undefined : 'bb-mono'}
              style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
            >
              {counterparty.name}
            </span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '9px 0' }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)' }}>Raised</span>
            <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>
              {new Date(order.createdAt).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
            </span>
          </div>
        </div>
        <p style={{ margin: '8px 2px 0', fontSize: 11, fontWeight: 600, color: 'var(--muted)', lineHeight: 1.5 }}>
          Personal details of the user are not shared with merchants.
        </p>
      </div>

      {paymentRows.length > 0 && (
        <div>
          <div style={sectionLabel}>{paySectionLabel}</div>
          <div style={{ background: accentBg, border: `1px solid ${accent}`, borderRadius: 13, padding: '4px 14px' }}>
            {paymentRows.map((row) => (
              <CopyInline key={row.label} label={row.label} value={row.value} tone={accent} />
            ))}
          </div>
        </div>
      )}

      {!isDeposit && order.paidFromAccountId && (
        <div>
          <div style={sectionLabel}>Paid from</div>
          <div style={{ background: 'var(--surface-2)', borderRadius: 12, padding: '0 14px' }}>
            <CopyInline label="Your account" value={paidFrom?.label ?? String(order.paidFromAccountId)} />
          </div>
        </div>
      )}

      {(order.utrNumber || order.proofScreenshot) && (
        <div>
          <div style={sectionLabel}>{copy.proofSectionLabel}</div>
          {order.utrNumber && (
            <div style={{ background: 'var(--surface-2)', borderRadius: 12, padding: '0 14px', marginBottom: 9 }}>
              <CopyInline label={copy.proofLabel} value={order.utrNumber} />
            </div>
          )}
          {order.proofScreenshot && (
            <a href={order.proofScreenshot} target="_blank" rel="noreferrer" style={{ display: 'block' }}>
              <img
                src={order.proofScreenshot}
                alt="Payment proof submitted by the user"
                style={{ width: '100%', borderRadius: 12, border: '1px solid var(--border)', display: 'block' }}
              />
            </a>
          )}
        </div>
      )}

      {order.status === OrderStatus.DISPUTED && (
        <Banner tone="dispute" title="Under admin review">
          {order.disputeReason || 'An admin is reviewing this order.'}
        </Banner>
      )}
      {order.status === OrderStatus.REJECTED && (
        <Banner tone="danger" title="Rejected">
          {order.rejectedReason || 'This order was rejected.'}
          {order.disputeWindowUntil && new Date(order.disputeWindowUntil).getTime() > Date.now() && (
              <> The pool's tokens stay held until {new Date(order.disputeWindowUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} in case the player disputes. If they do not, the tokens return to the pool.</>
            )}
        </Banner>
      )}
    </Panel>
  );
};

export default OrderDetail;
