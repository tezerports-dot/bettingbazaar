// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
//
// Order card — design handoff "BB Merchant Panel.dc.html".
// One card per order in the merchant's queue: what it is, how much, who it is
// with, where the money goes, and the actions available in the current status.
//
// Everything currency-shaped comes from utils/rail.ts, so an INR merchant sees
// ₹ / UPI / UTR and a USDT merchant sees USDT / TRC-20 / Tx ID from the same
// component — the merchant's rail is fixed by the backend, never chosen here.
import React from 'react';
import { ArrowDownLeft, ArrowUpRight, Check, Clock, Copy, ChevronRight, ShieldCheck } from 'lucide-react';
import { OrderStatus, type MerchantProfile, type PaymentOrder } from '../types';
import { counterpartyOf, formatMoney, railCopy, railOf, tokenColumn, truncateMiddle, type MerchantRail } from '../utils/rail';
import { formatCountdown, secondsLeft, URGENT_SECONDS } from '../hooks/useCountdown';
import { Banner, Button, CopyRow, StatusPill, cardStyle, copyText } from './ui';

export interface OrderActions {
  onAccept: (order: PaymentOrder) => void;
  onReject: (order: PaymentOrder) => void;
  /** Deposit: confirm the user's payment arrived and release tokens. */
  onRelease: (order: PaymentOrder) => void;
  /** Withdrawal: record that the payout has been sent. */
  onPayout: (order: PaymentOrder) => void;
  onDispute: (order: PaymentOrder) => void;
  onOpen: (order: PaymentOrder) => void;
}

/** Where this order's money is going, in the merchant's own terms. */
export function paymentDestination(
  order: PaymentOrder,
  merchant: MerchantProfile | null,
  rail: MerchantRail
): { label: string; value: string; sub?: string } | null {
  const copy = railCopy(rail);
  const isDeposit = order.type === 'DEPOSIT';

  if (isDeposit) {
    // Money coming in — the merchant's own credentials, which the user pays to.
    if (rail === 'USDT') {
      const address = merchant?.usdtWalletAddress || '';
      return address ? { label: 'Your USDT address — user sends here', value: address, sub: copy.networkNote } : null;
    }
    const upi = merchant?.settlementDetails?.upiId || merchant?.bankDetails?.upiId || '';
    return upi ? { label: 'Your UPI — user pays here', value: upi } : null;
  }

  // Money going out — the user's payout destination, carried on the order.
  if (rail === 'USDT') {
    const address = order.userUsdtAddress || '';
    return address ? { label: copy.payoutDestinationLabel, value: address, sub: copy.networkNote } : null;
  }
  const bank = order.userBankDetails;
  if (bank?.accountNumber) {
    return {
      label: copy.payoutDestinationLabel,
      value: bank.accountNumber,
      sub: [bank.bankName, bank.ifscCode].filter(Boolean).join(' · '),
    };
  }
  return order.upiId ? { label: 'Send to user UPI', value: order.upiId } : null;
}

const OPEN_STATUSES: string[] = [OrderStatus.PENDING_QUEUE, OrderStatus.ASSIGNED, OrderStatus.PROCESSING];

export const OrderCard: React.FC<{
  order: PaymentOrder;
  merchant: MerchantProfile | null;
  now: number;
  actions: OrderActions;
}> = ({ order, merchant, now, actions }) => {
  const rail = railOf(merchant);
  const copy = railCopy(rail);
  const isDeposit = order.type === 'DEPOSIT';
  const accent = isDeposit ? 'var(--dep)' : 'var(--wd)';
  const accentBg = isDeposit ? 'var(--dep-bg)' : 'var(--wd-bg)';

  const remaining = secondsLeft(order.expiresAt, now);
  const showTimer = remaining !== null && OPEN_STATUSES.includes(order.status) || (remaining !== null && order.status === OrderStatus.PAID);
  const urgent = showTimer && remaining !== null && remaining < URGENT_SECONDS;

  const canAccept = order.status === OrderStatus.ASSIGNED || order.status === OrderStatus.PENDING_QUEUE;
  const canRelease = order.status === OrderStatus.PAID && isDeposit;
  const canPayout = order.status === OrderStatus.PROCESSING && !isDeposit;
  const awaitingUser = order.status === OrderStatus.PROCESSING && isDeposit;

  const destination = OPEN_STATUSES.includes(order.status) ? paymentDestination(order, merchant, rail) : null;
  const token = tokenColumn(order, rail);
  const reference = String(order.orderId || order.shortId || order._id || '');
  const counterparty = counterpartyOf(order);

  return (
    <div style={{ ...cardStyle, overflow: 'hidden', position: 'relative' }}>
      <div style={{ position: 'absolute', top: 0, left: 0, bottom: 0, width: 4, background: accent }} />
      <div style={{ padding: '16px 16px 16px 19px' }}>
        {/* Header: type, id, status, countdown */}
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10, marginBottom: 14 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
            <span style={{
              width: 38, height: 38, borderRadius: 11, background: accentBg, color: accent,
              display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
            }}>
              {isDeposit ? <ArrowDownLeft size={19} /> : <ArrowUpRight size={19} />}
            </span>
            <div style={{ minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                <span style={{ fontSize: 13.5, fontWeight: 800, color: 'var(--text)' }}>
                  {isDeposit ? 'Deposit' : 'Withdrawal'}
                </span>
                <span style={{
                  fontSize: 9.5, fontWeight: 800, padding: '2px 6px', borderRadius: 6, letterSpacing: '.03em',
                  color: rail === 'USDT' ? 'var(--dep)' : 'var(--brand)',
                  background: rail === 'USDT' ? 'var(--dep-bg)' : 'var(--brand-bg)',
                }}>
                  {copy.unit}
                </span>
              </div>
              <button
                onClick={() => copyText(reference, 'Order ID')}
                className="bb-mono"
                style={{
                  fontSize: 11, fontWeight: 600, color: 'var(--muted)', background: 'none', border: 0,
                  cursor: 'pointer', padding: 0, display: 'flex', alignItems: 'center', gap: 4, maxWidth: '100%',
                }}
              >
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{reference}</span>
                <Copy size={11} style={{ flexShrink: 0 }} />
              </button>
            </div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6, flexShrink: 0 }}>
            <StatusPill status={order.status} />
            {showTimer && remaining !== null && (
              <span
                className="bb-mono"
                style={{
                  display: 'flex', alignItems: 'center', gap: 4, fontSize: 11.5, fontWeight: 700,
                  color: urgent ? 'var(--danger)' : 'var(--text-2)',
                  animation: urgent ? 'bb-pulse 1.4s ease infinite' : 'none',
                }}
              >
                <Clock size={11} />
                {remaining === 0 ? 'Expired' : formatCountdown(remaining)}
              </span>
            )}
          </div>
        </div>

        {/* Amount */}
        <div style={{
          display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 10,
          padding: '13px 15px', background: 'var(--surface-2)', borderRadius: 13, marginBottom: 13,
        }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.05em' }}>
              {isDeposit ? 'User pays you' : 'You send'}
            </div>
            <div className="bb-mono" style={{ fontSize: 23, fontWeight: 700, color: 'var(--text)', letterSpacing: '-1px', lineHeight: 1.1 }}>
              {formatMoney(order.fiatAmount ?? order.amount, rail)}
            </div>
          </div>
          <div style={{ textAlign: 'right', flexShrink: 0 }}>
            <div style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--muted)' }}>{token.label}</div>
            <div className="bb-mono" style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-2)' }}>{token.value}</div>
          </div>
        </div>

        {/* Counterparty — only when a name exists. Merchants are not sent the
            user's identity (see counterpartyOf); on a deposit there is nothing
            to show here that the header does not already say. */}
        {counterparty.identified && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
            <span style={{
              width: 26, height: 26, borderRadius: '50%', background: 'var(--surface-2)', color: 'var(--text-2)',
              display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700, flexShrink: 0,
            }}>
              {counterparty.name.charAt(0).toUpperCase()}
            </span>
            <span style={{
              fontSize: 12.5, fontWeight: 700, color: 'var(--text)', minWidth: 0,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>
              {counterparty.name}
            </span>
            <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)', flexShrink: 0 }}>· account holder</span>
          </div>
        )}

        {/* Where the money goes */}
        {destination && (
          <div style={{ marginBottom: 13 }}>
            <CopyRow
              label={destination.label}
              value={destination.value}
              sub={destination.sub}
              tone={accent}
              background={accentBg}
            />
          </div>
        )}

        {/* Status narration */}
        {awaitingUser && (
          <Banner tone="warn" style={{ marginBottom: 13 }} icon={<Clock size={16} style={{ color: 'var(--warn)', flexShrink: 0, marginTop: 1 }} />}>
            Waiting for the user to pay {formatMoney(order.fiatAmount ?? order.amount, rail)}.
          </Banner>
        )}
        {canRelease && (
          <div style={{ padding: '11px 13px', background: 'var(--dep-bg)', borderRadius: 12, marginBottom: 13 }}>
            <div style={{ fontSize: 12, fontWeight: 800, color: 'var(--dep)', marginBottom: 3 }}>
              User marked as paid — verify the {copy.proofLabel}
            </div>
            {order.utrNumber ? (
              <button
                onClick={() => copyText(order.utrNumber || '', copy.proofLabel)}
                className="bb-mono"
                style={{
                  fontSize: 12, fontWeight: 700, color: 'var(--text)', background: 'none', border: 0,
                  cursor: 'pointer', padding: 0, display: 'flex', alignItems: 'center', gap: 5,
                }}
              >
                {copy.proofLabel} {truncateMiddle(order.utrNumber, 16, 8)}
                <Copy size={11} style={{ color: 'var(--dep)' }} />
              </button>
            ) : (
              <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-2)' }}>
                No {copy.proofLabel} submitted yet — open the order to review the proof.
              </div>
            )}
          </div>
        )}
        {order.status === OrderStatus.DISPUTED && (
          <Banner tone="dispute" title="Under admin review" style={{ marginBottom: 13 }}>
            {order.disputeReason || 'An admin is reviewing this order.'}
          </Banner>
        )}
        {order.status === OrderStatus.COMPLETED && (
          <Banner
            tone="ok"
            style={{ marginBottom: 13 }}
            icon={<Check size={15} style={{ color: 'var(--ok)', flexShrink: 0, marginTop: 1 }} />}
          >
            Completed.
          </Banner>
        )}
        {order.status === OrderStatus.REJECTED && (
          <Banner tone="danger" title="Rejected" style={{ marginBottom: 13 }}>
            {order.rejectionReason || order.disputeReason || 'This order was rejected.'}
          </Banner>
        )}

        {/* Actions */}
        {canAccept && (
          <div style={{ display: 'flex', gap: 9 }}>
            <Button onClick={() => actions.onAccept(order)} style={{ flex: 1 }}>
              <Check size={16} /> Accept order
            </Button>
            <Button variant="outline" tone="danger" onClick={() => actions.onReject(order)}>Reject</Button>
          </div>
        )}
        {canRelease && (
          <div style={{ display: 'flex', gap: 9 }}>
            <Button tone="ok" onClick={() => actions.onRelease(order)} style={{ flex: 1 }}>
              <ShieldCheck size={16} /> Confirm &amp; release
            </Button>
            <Button variant="outline" tone="dispute" title="Payment not received" onClick={() => actions.onDispute(order)}>
              Dispute
            </Button>
          </div>
        )}
        {canPayout && (
          <div style={{ display: 'flex', gap: 9 }}>
            <Button tone="ok" onClick={() => actions.onPayout(order)} style={{ flex: 1 }}>
              <ArrowUpRight size={16} /> Mark payout sent
            </Button>
            <Button variant="outline" tone="dispute" title="Cannot process" onClick={() => actions.onDispute(order)}>
              Dispute
            </Button>
          </div>
        )}

        <button
          onClick={() => actions.onOpen(order)}
          style={{
            width: '100%', marginTop: 10, padding: 8, border: 0, background: 'none', color: 'var(--muted)',
            fontSize: 12, fontWeight: 700, cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4,
          }}
        >
          View full details <ChevronRight size={13} />
        </button>
      </div>
    </div>
  );
};

export default OrderCard;
