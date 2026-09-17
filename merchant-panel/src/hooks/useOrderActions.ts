// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
//
// The four things a merchant can do to an order, in one place so the card, the
// detail drawer and the dashboard all behave identically.
//
// Backend contract (backend/domains/merchant/merchant.routes.js):
//   accept   POST /accept/:id            ASSIGNED|PENDING_QUEUE → PROCESSING
//   reject   POST /reject/:id  {reason}  → REJECTED, requires a reason
//   confirm  POST /confirm/:id {utrNumber?}
//              The reference sits on OPPOSITE sides of the two order types,
//              because opposite parties make the payment.
//              DEPOSIT (PAID → COMPLETED) — takes NO body. The PLAYER paid, so
//              the reference is theirs: submitted at mark-paid and claimed
//              against this order in `utr_registry` (CLAUDE.md §27). The route
//              reads it off the row and refuses if it is not there. It does not
//              accept one from the merchant. There is no payment-proof
//              requirement — proof collection was removed platform-wide.
//              WITHDRAWAL (PROCESSING → PAID/COMPLETED) — the MERCHANT paid, so
//              `utrNumber` is theirs to give and required on the UPI rail. At a
//              cash machine it is not asked for: that payout is evidenced by the
//              CDM slip, which has its own route and its own claim.
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

/** The shortest string the backend will accept as a bank UTR. */
const MIN_UTR_LENGTH = 12;

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
      input: { label: 'Reason for rejection (required)', multiline: true },
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
          : 'Confirm you have transferred the amount to the user, and enter the reference your bank gave the transfer.',
        confirmLabel: "I've sent the money",
        tone: 'ok',
        // ── The reference on a SELL is the MERCHANT's ──────────────────────
        // A buy and a sell put the reference on opposite sides. On a buy the
        // PLAYER pays and submits their UTR; on a sell the MERCHANT pays, so
        // the reference for that transfer is theirs to give and there is
        // nobody else who could.
        //
        // Not asked at a cash machine: that payout's evidence is the CDM slip,
        // collected separately below, and a bank UTR does not exist for it.
        ...(atMachine ? {} : {
          input: {
            label: `UTR for this transfer (min ${MIN_UTR_LENGTH} characters)`,
            validate: (v: string) => (v.length >= MIN_UTR_LENGTH
              ? null
              : `A UTR is at least ${MIN_UTR_LENGTH} characters. It is on your transfer receipt.`),
          },
        }),
        onConfirm: async (utr: string) => {
          const settled = await run(
            () => api.confirmPayment(orderRef(order), atMachine ? undefined : utr),
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
      input: { label: 'What is wrong with it?', multiline: true },
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
