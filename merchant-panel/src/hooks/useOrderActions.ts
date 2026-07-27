// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
//
// The four things a merchant can do to an order, in one place so the card, the
// detail drawer and the dashboard all behave identically.
//
// Backend contract (backend/domains/merchant/merchant.routes.js):
//   accept   POST /accept/:id            ASSIGNED|PENDING_QUEUE → PROCESSING
//   reject   POST /reject/:id  {reason}  → REJECTED, requires a reason
//   confirm  POST /confirm/:id {proof, utrNumber}
//              DEPOSIT (PAID → COMPLETED) — the route REQUIRES the reference the
//              user submitted (utrNumber, min 12 chars) plus their proof, so the
//              stored values are sent back with the confirmation. Confirming an
//              order the user has not evidenced is refused before the request.
//              WITHDRAWAL (PROCESSING → COMPLETED) — no reference required.
//   dispute  POST /order/:id/dispute {reason} → DISPUTED
import { useCallback, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { api } from '../services/api';
import { railCopy, type MerchantRail } from '../utils/rail';
import type { PaymentOrder } from '../types';
import type { ConfirmRequest } from '../components/ui';
import type { OrderActions } from '../components/OrderCard';

/** Minimum UTR length the backend accepts on a deposit confirm. */
const MIN_UTR_LENGTH = 12;

const orderRef = (order: PaymentOrder): string => String(order._id || order.id || order.orderId);

export function useOrderActions(rail: MerchantRail, onChanged: () => Promise<void> | void) {
  const [confirmRequest, setConfirmRequest] = useState<ConfirmRequest | null>(null);
  const [closeDetail, setCloseDetail] = useState(false);
  const copy = railCopy(rail);

  const run = useCallback(
    async (work: () => Promise<unknown>, success: string) => {
      try {
        await work();
        toast.success(success);
        setCloseDetail(true);
        await onChanged();
      } catch (error: any) {
        toast.error(error?.message || 'That did not go through — try again');
      }
    },
    [onChanged]
  );

  const actions: OrderActions = useMemo(() => ({
    onAccept: (order) => {
      void run(() => api.acceptOrder(orderRef(order)), 'Order accepted — now processing');
    },

    onReject: (order) => setConfirmRequest({
      title: 'Reject this order?',
      body: 'It returns to the queue for reassignment. This cannot be undone.',
      confirmLabel: 'Reject order',
      tone: 'danger',
      reasonLabel: 'Reason for rejection (required)',
      onConfirm: (reason) => run(() => api.rejectOrder(orderRef(order), reason), 'Order rejected'),
    }),

    onRelease: (order) => {
      const utr = (order.utrNumber || '').trim();
      if (utr.length < MIN_UTR_LENGTH) {
        toast.error(`The user has not submitted a valid ${copy.proofLabel} yet — it must be at least ${MIN_UTR_LENGTH} characters.`);
        return;
      }
      if (!order.proofScreenshot) {
        toast.error('The user has not uploaded payment proof yet.');
        return;
      }
      setConfirmRequest({
        title: 'Release tokens to the user?',
        body: `Confirm the full amount reached your ${rail === 'USDT' ? 'wallet' : 'account'}. Tokens credit to the user immediately and this cannot be reversed.`,
        confirmLabel: 'Confirm & release',
        tone: 'ok',
        onConfirm: () => run(
          () => api.confirmPayment(orderRef(order), order.proofScreenshot, utr),
          'Payment confirmed — tokens released'
        ),
      });
    },

    onPayout: (order) => setConfirmRequest({
      title: 'Mark payout as sent?',
      body: 'Confirm you have transferred the amount to the user. The order completes automatically.',
      confirmLabel: "I've sent the money",
      tone: 'ok',
      onConfirm: () => run(
        () => api.confirmPayment(orderRef(order), undefined, order.utrNumber),
        'Payout confirmed — order completed'
      ),
    }),

    onDispute: (order) => setConfirmRequest({
      title: 'Raise a dispute?',
      body: 'An admin will review this order. Only raise a dispute if something is genuinely wrong.',
      confirmLabel: 'Raise dispute',
      tone: 'dispute',
      reasonLabel: 'What went wrong?',
      onConfirm: (reason) => run(() => api.raiseDispute(orderRef(order), reason), 'Dispute raised — an admin will review'),
    }),

    // Replaced by the screen that owns the detail drawer.
    onOpen: () => undefined,
  }), [copy.proofLabel, rail, run]);

  return {
    actions,
    confirmRequest,
    dismissConfirm: () => setConfirmRequest(null),
    /** True once an action succeeded, so the screen can close its drawer. */
    shouldCloseDetail: closeDetail,
    acknowledgeCloseDetail: () => setCloseDetail(false),
  };
}
