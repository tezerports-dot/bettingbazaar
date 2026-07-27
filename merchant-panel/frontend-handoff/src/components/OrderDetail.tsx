// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
//
// Order detail — a right drawer on desktop, a bottom sheet on mobile (design
// handoff "BB Merchant Panel.dc.html"). Everything on the card, plus the full
// payment rows, the user's submitted proof, and the same actions pinned to the
// footer so they stay reachable while reading.
import React from 'react';
import { ArrowDownLeft, ArrowUpRight, Check, ShieldCheck } from 'lucide-react';
import { OrderStatus, type MerchantProfile, type PaymentOrder } from '../types';
import { counterpartyOf, formatMoney, railCopy, railOf, tokenColumn } from '../utils/rail';
import { formatCountdown, secondsLeft, URGENT_SECONDS } from '../hooks/useCountdown';
import { Banner, Button, CopyInline, Panel, StatusPill } from './ui';
import type { OrderActions } from './OrderCard';

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
}> = ({ order, merchant, now, isMobile, onClose, actions }) => {
  if (!order) return null;

  const rail = railOf(merchant);
  const copy = railCopy(rail);
  const isDeposit = order.type === 'DEPOSIT';
  const accent = isDeposit ? 'var(--dep)' : 'var(--wd)';
  const accentBg = isDeposit ? 'var(--dep-bg)' : 'var(--wd-bg)';
  const token = tokenColumn(order, rail);
  const counterparty = counterpartyOf(order);

  const remaining = secondsLeft(order.expiresAt, now);
  const openStatus = [OrderStatus.PENDING_QUEUE, OrderStatus.ASSIGNED, OrderStatus.PROCESSING, OrderStatus.PAID].includes(
    order.status as OrderStatus
  );
  const showTimer = remaining !== null && openStatus;
  const urgent = remaining !== null && remaining < URGENT_SECONDS;

  const canAccept = order.status === OrderStatus.ASSIGNED || order.status === OrderStatus.PENDING_QUEUE;
  const canRelease = order.status === OrderStatus.PAID && isDeposit;
  const canPayout = order.status === OrderStatus.PROCESSING && !isDeposit;

  // Payment rows: the merchant's own receiving credentials on a deposit, the
  // user's payout destination on a withdrawal.
  const paymentRows: Array<{ label: string; value: string }> = [];
  if (isDeposit) {
    if (rail === 'USDT') {
      if (merchant?.usdtWalletAddress) paymentRows.push({ label: 'Your USDT address', value: merchant.usdtWalletAddress });
      paymentRows.push({ label: 'Network', value: 'TRC-20' });
    } else {
      const upi = merchant?.settlementDetails?.upiId || merchant?.bankDetails?.upiId;
      if (upi) paymentRows.push({ label: 'Your UPI ID', value: upi });
      const holder = merchant?.settlementDetails?.accountName || merchant?.bankDetails?.accountHolderName;
      if (holder) paymentRows.push({ label: 'Account holder', value: holder });
    }
  } else if (rail === 'USDT') {
    if (order.userUsdtAddress) paymentRows.push({ label: 'User wallet', value: order.userUsdtAddress });
    paymentRows.push({ label: 'Network', value: 'TRC-20' });
  } else {
    const bank = order.userBankDetails;
    if (bank?.accountHolderName) paymentRows.push({ label: 'Holder', value: bank.accountHolderName });
    if (bank?.accountNumber) paymentRows.push({ label: 'Account no.', value: bank.accountNumber });
    if (bank?.ifscCode) paymentRows.push({ label: 'IFSC', value: bank.ifscCode });
    if (bank?.bankName) paymentRows.push({ label: 'Bank', value: bank.bankName });
    if (order.upiId) paymentRows.push({ label: 'UPI ID', value: order.upiId });
  }

  const paySectionLabel = isDeposit
    ? (rail === 'USDT' ? 'Deposit address — user sends here' : 'Payment — user pays you here')
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

  const footer = canAccept ? (
    <>
      <Button onClick={() => actions.onAccept(order)} style={{ flex: 1, padding: 14, fontSize: 14 }}>Accept order</Button>
      <Button variant="outline" tone="danger" onClick={() => actions.onReject(order)} style={{ padding: '14px 18px', fontSize: 14 }}>
        Reject
      </Button>
    </>
  ) : canRelease ? (
    <>
      <Button tone="ok" onClick={() => actions.onRelease(order)} style={{ flex: 1, padding: 14, fontSize: 14 }}>
        <ShieldCheck size={16} /> Confirm &amp; release
      </Button>
      <Button variant="outline" tone="dispute" onClick={() => actions.onDispute(order)} style={{ padding: '14px 18px', fontSize: 14 }}>
        Dispute
      </Button>
    </>
  ) : canPayout ? (
    <>
      <Button tone="ok" onClick={() => actions.onPayout(order)} style={{ flex: 1, padding: 14, fontSize: 14 }}>
        <Check size={16} /> Mark payout sent
      </Button>
      <Button variant="outline" tone="dispute" onClick={() => actions.onDispute(order)} style={{ padding: '14px 18px', fontSize: 14 }}>
        Dispute
      </Button>
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
            {formatMoney(order.fiatAmount ?? order.amount, rail)}
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

      {(order.utrNumber || order.proofScreenshot) && (
        <div>
          <div style={sectionLabel}>{copy.proofSectionLabel}</div>
          {order.utrNumber && (
            <div style={{ background: 'var(--surface-2)', borderRadius: 12, padding: '0 14px', marginBottom: 9 }}>
              <CopyInline label={copy.proofLabel} value={order.utrNumber} />
            </div>
          )}
          {order.proofScreenshot && rail !== 'USDT' && (
            <a href={order.proofScreenshot} target="_blank" rel="noreferrer" style={{ display: 'block' }}>
              <img
                src={order.proofScreenshot}
                alt="Payment proof submitted by the user"
                style={{ width: '100%', borderRadius: 12, border: '1px solid var(--border)', display: 'block' }}
              />
            </a>
          )}
          {rail === 'USDT' && (
            <Banner tone="dep" icon={<ShieldCheck size={18} style={{ color: 'var(--dep)', flexShrink: 0, marginTop: 1 }} />}>
              On-chain transfer — verify this hash on a Tron explorer before releasing.
            </Banner>
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
          {order.rejectionReason || 'This order was rejected.'}
        </Banner>
      )}
    </Panel>
  );
};

export default OrderDetail;
