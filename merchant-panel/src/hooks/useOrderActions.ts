// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
//
// The four things a merchant can do to an order, in one place so the card, the
// detail drawer and the dashboard all behave identically.
//
// Backend contract (backend/domains/merchant/merchant.routes.js):
//   accept   POST /accept/:id            ASSIGNED|PENDING_QUEUE → PROCESSING
//   reject   POST /reject/:id  {reason}  → REJECTED, requires a reason
//   confirm  POST /confirm/:id {}
//              DEPOSIT (PAID → COMPLETED) — takes NO body. The route reads the
//              player's reference off the order row and refuses if it is not
//              there; it does not accept one from the merchant, because the
//              reference is the player's and is claimed against this order in
//              `utr_registry` (CLAUDE.md §27). There is no payment-proof
//              requirement — proof collection was removed platform-wide.
//              WITHDRAWAL (PROCESSING → COMPLETED) — no reference required.
//   redFlag  POST /orders/:id/red-flag {reason} → flagged + DISPUTED for review
//   payment-not-received
//            POST /orders/:id/reject {reason, proofFileKey, proofCdnUrl}
//              PAID|PROCESSING → CANCELLED. Different from `reject` above,
//              which declines an order before payment. This one accuses the
//              player of not paying: it warns their account and can auto-block
//              them, so the route REQUIRES a reason of 10+ characters and a
//              verified proof image, and refuses without either.
import { useCallback, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { api } from '../services/api';
import { railCopy, type MerchantRail } from '../utils/rail';
import type { PaymentOrder } from '../types';
import type { ConfirmRequest } from '../components/ui';
import type { OrderActions } from '../components/OrderCard';

const orderRef = (order: PaymentOrder): string => String(order._id || order.id || order.orderId);

/**
 * @param onCashPayoutSettled called after a CASH_ATM withdrawal completes, so
 *   the screen can ask for the CDM slip while the merchant is still at the
 *   machine holding it. Branching on the ORDER's rail, never the live policy:
 *   an admin can switch at any moment and both rails then run side by side
 *   until the last pre-flip order settles, so an order held across a switch
 *   still settles the way it was created.
 */
export function useOrderActions(
  rail: MerchantRail,
  onChanged: () => Promise<void> | void,
  onCashPayoutSettled?: (order: PaymentOrder) => void,
) {
  const [confirmRequest, setConfirmRequest] = useState<ConfirmRequest | null>(null);
  const [closeDetail, setCloseDetail] = useState(false);
  const [rejectTarget, setRejectTarget] = useState<PaymentOrder | null>(null);
  const [rejectBusy, setRejectBusy] = useState(false);
  const copy = railCopy(rail);

  /**
   * Run one action and say whether it WORKED.
   *
   * The boolean is not decoration. This helper swallows the error into a toast,
   * so a caller that chains anything after it — the CDM slip prompt below —
   * would otherwise run identically whether the payout completed or threw, and
   * the merchant would be asked to evidence a payout that never happened.
   */
  const run = useCallback(
    async (work: () => Promise<unknown>, success: string): Promise<boolean> => {
      try {
        await work();
        toast.success(success);
        setCloseDetail(true);
        await onChanged();
        return true;
      } catch (error: any) {
        toast.error(error?.message || 'That did not go through — try again');
        return false;
      }
    },
    [onChanged]
  );

  const actions: OrderActions = useMemo(() => ({
    onAccept: (order) => {
      void run(() => api.acceptOrder(orderRef(order)), 'Order accepted — now processing');
    },

    onPaymentNotReceived: (order) => setRejectTarget(order),

    onReject: (order) => setConfirmRequest({
      title: 'Reject this order?',
      body: 'It returns to the queue for reassignment. This cannot be undone.',
      confirmLabel: 'Reject order',
      tone: 'danger',
      reasonLabel: 'Reason for rejection (required)',
      onConfirm: (reason) => run(() => api.rejectOrder(orderRef(order), reason), 'Order rejected'),
    }),

    onRelease: (order) => {
      // The reference is the PLAYER's, already stored and already claimed in
      // `utr_registry`. This checks it is THERE before opening the dialog, so a
      // merchant is not walked through a confirmation the server will refuse —
      // it does not re-send it, because the route reads the row.
      const utr = (order.utrNumber || '').trim();
      if (!utr) {
        toast.error(`The user has not submitted their ${copy.proofLabel} yet.`);
        return;
      }
      // There is NO payment-screenshot check here, deliberately.
      //
      // This used to refuse on `!order.proofScreenshot` with "The user has not
      // uploaded payment proof yet." Proof collection was removed platform-wide
      // — no player screen has an upload and the presign route is gone — so
      // that field is NULL on every order and the toast fired on EVERY deposit,
      // blaming the player for not supplying something nothing ever asks them
      // for. The merchant's release button did not work, at all, for anyone.
      setConfirmRequest({
        title: 'Release tokens to the user?',
        body: `Confirm the full amount reached your ${rail === 'USDT' ? 'wallet' : 'account'}. Tokens credit to the user immediately and this cannot be reversed.`,
        confirmLabel: 'Confirm & release',
        tone: 'ok',
        onConfirm: () => run(
          () => api.confirmPayment(orderRef(order)),
          'Payment confirmed — tokens released'
        ),
      });
    },

    onPayout: (order) => {
      const atMachine = order.paymentMode === 'CASH_ATM';
      setConfirmRequest({
        title: 'Mark payout as sent?',
        body: atMachine
          ? 'Confirm the cash is in the player\u2019s account. The order completes immediately and you will be asked for the CDM slip next \u2014 keep it to hand.'
          : 'Confirm you have transferred the amount to the user. The order completes automatically.',
        confirmLabel: "I've sent the money",
        tone: 'ok',
        onConfirm: async () => {
          const settled = await run(
            () => api.confirmPayment(orderRef(order)),
            'Payout confirmed — order completed'
          );
          // AFTER the confirm, and only if it SUCCEEDED. The receipt is chased
          // and does not gate the payout — a player is not held up waiting for
          // paperwork, and a merchant who dismisses this still finds the order
          // in the list of slips they owe. But the submit route checks the rail
          // and the order type, not the state, so a slip offered against a
          // payout that threw would be stored against an unsettled order.
          if (settled && atMachine) onCashPayoutSettled?.(order);
        },
      });
    },

    // A merchant reports that an order is wrong; they do not DISPUTE it. The
    // dispute is the instrument of the party who is owed, which on this
    // platform is always the player.
    onRedFlag: (order) => setConfirmRequest({
      title: 'Send this order to an admin?',
      body: 'Use this when an order looks fraudulent or cannot be processed. An admin will review it.',
      confirmLabel: 'Flag for review',
      tone: 'dispute',
      reasonLabel: 'What is wrong with it?',
      onConfirm: (reason) => run(() => api.redFlagOrder(orderRef(order), reason), 'Flagged — an admin will review'),
    }),

    // Replaced by the screen that owns the detail drawer.
    onOpen: () => undefined,
  }), [copy.proofLabel, onCashPayoutSettled, rail, run]);

  /**
   * Send the rejection.
   *
   * The dialog stays OPEN on failure, with what the merchant typed and the file
   * they picked still in it: the backend refuses a short reason or an
   * unverifiable proof, and closing the dialog would make them start again
   * without saying which half was wrong.
   */
  const submitPaymentNotReceived = useCallback(async (reason: string, proof: File) => {
    if (!rejectTarget) return;
    setRejectBusy(true);
    try {
      await api.rejectPaidOrder(orderRef(rejectTarget), reason, proof);
      toast.success('Order rejected — the player has been warned');
      setRejectTarget(null);
      setCloseDetail(true);
      await onChanged();
    } catch (error: any) {
      toast.error(error?.message || 'That did not go through — try again');
    } finally {
      setRejectBusy(false);
    }
  }, [onChanged, rejectTarget]);

  return {
    actions,
    confirmRequest,
    dismissConfirm: () => setConfirmRequest(null),
    /** The order awaiting a "payment never arrived" rejection, if any. */
    rejectTarget,
    rejectBusy,
    dismissReject: () => setRejectTarget(null),
    submitPaymentNotReceived,
    /** True once an action succeeded, so the screen can close its drawer. */
    shouldCloseDetail: closeDetail,
    acknowledgeCloseDetail: () => setCloseDetail(false),
  };
}
