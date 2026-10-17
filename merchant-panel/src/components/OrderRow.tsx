// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
//
// Order row — one line per order (owner, 2026-10-17: "single line with UTR,
// amount, approve, reject"). What it is, how much, the reference, the time
// left, and the one or two actions the order's state allows; everything else
// (where the money goes, the account holder, the flag) is in the detail drawer
// a tap on the row opens.
//
// There is no Accept: routing starts an order as it hands it out. ✓ approves
// (a buy's payment arrived, or a sell's payout was sent); ✗ says no (a buy's
// payment never arrived, or a started order is declined back to the queue).
//
// Everything currency-shaped comes from utils/rail.ts, so an INR merchant sees
// ₹ / UTR and a USDT merchant sees USDT / Tx ID from the same component.
import React from 'react';
import { ArrowDownLeft, ArrowUpRight, Check, Clock, QrCode, X } from 'lucide-react';
import { OrderStatus, type MerchantProfile, type PaymentAccount, type PaymentOrder } from '../types';
import { actorOf, mayWorkOrder } from '../utils/actor';
import { formatMoney, railCopy, railOf, truncateMiddle } from '../utils/rail';
import { formatCountdown, secondsLeft, URGENT_SECONDS } from '../hooks/useCountdown';
import { StatusPill, cardStyle } from './ui';

export interface OrderActions {
  /** Hand a started order back to the queue (only when `order.canDecline`). */
  onDecline: (order: PaymentOrder) => void;
  /** The player claims they paid and the money never arrived — see the dialog. */
  onPaymentNotReceived: (order: PaymentOrder) => void;
  /** Deposit: confirm the user's payment arrived and release tokens. */
  onRelease: (order: PaymentOrder) => void;
  /** Withdrawal: record that the payout has been sent. */
  onPayout: (order: PaymentOrder) => void;
  onRedFlag: (order: PaymentOrder) => void;
  /** Cash buy: scan the cash machine's QR the player will pay (Step 2d). */
  onScanCashLink: (order: PaymentOrder) => void;
  onOpen: (order: PaymentOrder) => void;
}

/** The merchant account's own payment account an order names, if the list has it. */
export function accountNamed(accounts: PaymentAccount[] | undefined, accountId: string | null | undefined): PaymentAccount | null {
  if (!accountId) return null;
  return accounts?.find((a) => a.accountId === String(accountId)) ?? null;
}

/**
 * Why a sub-member is shown an order without its controls (owner,
 * 2026-10-11): the server would refuse them (merchantActor.js `workRefusal`).
 */
export function viewOnlyReason(merchant: MerchantProfile | null, order: PaymentOrder): string {
  const actor = actorOf(merchant);
  if (actor.isOwner) return '';
  const isDeposit = order.type === 'DEPOSIT';
  const role = isDeposit ? 'DEPOSITS' : 'WITHDRAWALS';
  if (!actor.roles.includes(role)) {
    return actor.roles.includes('AUDIT') && actor.roles.length === 1
      ? 'View only: auditors read orders and change nothing.'
      : `View only: your role does not include ${isDeposit ? 'deposits' : 'withdrawals'}.`;
  }
  return isDeposit
    ? 'View only: this deposit is paid into an account not assigned to you.'
    : 'View only: no account assigned to you can pay this withdrawal.';
}

const OPEN_STATUSES: string[] = [OrderStatus.PENDING_QUEUE, OrderStatus.PROCESSING, OrderStatus.PAID];

/** A square icon button with its action named for screen readers and on hover. */
const IconAction: React.FC<{
  label: string; tone: string; bg: string; onClick: () => void; children: React.ReactNode;
}> = ({ label, tone, bg, onClick, children }) => (
  <button
    type="button"
    aria-label={label}
    title={label}
    onClick={(e) => { e.stopPropagation(); onClick(); }}
    style={{
      width: 34, height: 34, flexShrink: 0, borderRadius: 10, cursor: 'pointer',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      border: `1.5px solid ${tone}`, background: bg, color: tone,
    }}
  >
    {children}
  </button>
);

export const OrderRow: React.FC<{
  order: PaymentOrder;
  merchant: MerchantProfile | null;
  now: number;
  actions: OrderActions;
}> = ({ order, merchant, now, actions }) => {
  const rail = railOf(merchant);
  const copy = railCopy(rail);
  const isDeposit = order.type === 'DEPOSIT';
  const accent = isDeposit ? 'var(--dep)' : 'var(--wd)';
  const reference = String(order.orderId || order._id || '');

  const remaining = secondsLeft(order.expiresAt, now);
  const showTimer = remaining !== null && OPEN_STATUSES.includes(order.status);
  const urgent = showTimer && remaining !== null && remaining < URGENT_SECONDS;

  // A merchant account's sub-member is offered only what their role and their
  // assigned accounts let them do; AUDIT is offered nothing (owner,
  // 2026-10-11). The server refuses the rest whatever is shown.
  const workable = mayWorkOrder(merchant, order);
  const cashBuy = isDeposit && order.paymentMode === 'CASH_ATM';
  const utr = (order.utrNumber || '').trim();
  // A PAID buy is confirmed only once its reference is there (§27); on cash
  // the player taps Paid at the machine and the reference follows.
  const canRelease = workable && isDeposit && order.status === OrderStatus.PAID && Boolean(utr);
  const canReport = workable && isDeposit && order.status === OrderStatus.PAID;
  const canPayout = workable && !isDeposit && order.status === OrderStatus.PROCESSING;
  const canScan = workable && cashBuy && order.status === OrderStatus.PROCESSING;
  const canDecline = workable && order.canDecline === true;
  const viewOnly = !workable && OPEN_STATUSES.includes(order.status) ? viewOnlyReason(merchant, order) : '';

  // What the reference column says when there is no reference yet.
  const waiting = order.status === OrderStatus.PROCESSING && isDeposit
    ? (cashBuy && !order.cashLink ? 'Scan the machine QR' : 'Waiting for payment')
    : order.status === OrderStatus.PAID && isDeposit && !utr ? `Waiting for ${copy.proofLabel}` : '—';

  return (
    <div
      data-testid="order-row"
      style={{
        ...cardStyle, borderRadius: 12, display: 'flex', alignItems: 'center', gap: 10,
        padding: '8px 10px', borderLeft: `4px solid ${accent}`, minWidth: 0,
      }}
    >
      <button
        type="button"
        onClick={() => actions.onOpen(order)}
        aria-label={`Open ${isDeposit ? 'deposit' : 'withdrawal'} ${reference}`}
        title={viewOnly || reference}
        style={{
          flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 10,
          background: 'none', border: 0, padding: 0, cursor: 'pointer', color: 'inherit', textAlign: 'left',
        }}
      >
        <span style={{ color: accent, display: 'flex', flexShrink: 0 }} aria-hidden>
          {isDeposit ? <ArrowDownLeft size={17} /> : <ArrowUpRight size={17} />}
        </span>
        <span className="bb-mono" style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)', flexShrink: 0 }}>
          {formatMoney(order.fiatAmount ?? order.amount, rail)}
        </span>
        <span
          className="bb-mono"
          style={{
            flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            fontSize: 12, fontWeight: 600, color: utr ? 'var(--text-2)' : 'var(--muted)',
          }}
        >
          {utr ? `${copy.proofLabel} ${truncateMiddle(utr, 14, 6)}` : waiting}
        </span>
        {showTimer && remaining !== null && (
          <span
            className="bb-mono"
            style={{
              display: 'flex', alignItems: 'center', gap: 3, fontSize: 11, fontWeight: 700, flexShrink: 0,
              color: urgent ? 'var(--danger)' : 'var(--text-2)',
            }}
          >
            <Clock size={11} aria-hidden />
            {remaining === 0 ? 'Expired' : formatCountdown(remaining)}
          </span>
        )}
      </button>

      {canScan && (
        <IconAction label={order.cashLink ? 'Scan the machine QR again' : 'Scan the machine QR'}
          tone="var(--warn)" bg="var(--warn-bg)" onClick={() => actions.onScanCashLink(order)}>
          <QrCode size={16} />
        </IconAction>
      )}
      {canRelease && (
        <IconAction label="Payment arrived: confirm and release" tone="var(--ok)" bg="var(--ok-bg)" onClick={() => actions.onRelease(order)}>
          <Check size={17} />
        </IconAction>
      )}
      {canPayout && (
        <IconAction label="Payout sent: mark paid" tone="var(--ok)" bg="var(--ok-bg)" onClick={() => actions.onPayout(order)}>
          <Check size={17} />
        </IconAction>
      )}
      {canReport && (
        <IconAction label="Payment not received: reject" tone="var(--danger)" bg="var(--danger-bg)" onClick={() => actions.onPaymentNotReceived(order)}>
          <X size={17} />
        </IconAction>
      )}
      {canDecline && (
        <IconAction label="Decline this order" tone="var(--danger)" bg="var(--danger-bg)" onClick={() => actions.onDecline(order)}>
          <X size={17} />
        </IconAction>
      )}
      {!canRelease && !canReport && !canPayout && !canScan && !canDecline && (
        <StatusPill status={order.status} style={{ flexShrink: 0 }} />
      )}
    </div>
  );
};

export default OrderRow;
