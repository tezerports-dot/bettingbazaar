// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
//
// The things a merchant can do to an order, in one place so the row, the
// detail drawer and the dashboard all behave identically.
//
// Backend contract (backend/domains/merchant/merchant.routes.js). There is no
// accept: routing starts an order as it hands it out (owner, 2026-10-17).
//   decline  POST /reject/:id  {reason}  PROCESSING → back to the queue, only
//              while nobody can have paid (`canDecline` on the order);
//              requires a reason
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
//              `utrNumber` is theirs to give, and required on EVERY rail: a sell
//              is paid by bank transfer whichever team serves it (Step 2d).
//   redFlag  POST /orders/:id/red-flag {reason} → flagged + DISPUTED for review
//   cashLink POST /orders/:id/cash-link {link}  a CASH buy, PROCESSING:
//              the cash machine's QR the member scanned, which the player pays
//              (Step 2d). Replaceable until the player taps "I've paid".
//   payment-not-received
//            POST /orders/:id/reject {reason}
//              a PAID buy → REJECTED, the team's tokens held while the player
//              may dispute. Different from `decline` above. This one says the
//              payment the player claimed never arrived: it warns and flags
//              their account, so the route REQUIRES a reason of 10+ characters
//              (no proof image: owner, 2026-10-17). Before the Paid tap there
//              is no claim to deny: the row does not offer it, and the route
//              answers 400 NOT_PAID_YET (owner, 2026-10-07).
import { useCallback, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { api } from '../services/api';
import { PAYMENT_COPY } from '../utils/rail';
import type { PaymentOrder } from '../types';
import type { ConfirmRequest } from '../components/ui';
import type { OrderActions } from '../components/OrderRow';

/** The shortest string the backend will accept as a bank UTR. */
export const MIN_UTR_LENGTH = 12;

const orderRef = (order: PaymentOrder): string => String(order._id || order.id || order.orderId);

export function useOrderActions(
  onChanged: () => Promise<void> | void,
) {
  const [confirmRequest, setConfirmRequest] = useState<ConfirmRequest | null>(null);
  const [closeDetail, setCloseDetail] = useState(false);
  const [rejectTarget, setRejectTarget] = useState<PaymentOrder | null>(null);
  const [rejectBusy, setRejectBusy] = useState(false);
  const [scanTarget, setScanTarget] = useState<PaymentOrder | null>(null);
  const [scanBusy, setScanBusy] = useState(false);
  // A sell a merchant account serves: paid FROM one of its accounts, chosen
  // with the UTR in its own dialog (owner, 2026-10-11).
  const [payoutTarget, setPayoutTarget] = useState<PaymentOrder | null>(null);

  /**
   * Run one action and say whether it WORKED.
   *
   * The boolean is not decoration. This helper swallows the error into a toast,
   * so a caller that chains anything after it would otherwise run identically
   * whether the action completed or threw.
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
    onPaymentNotReceived: (order) => setRejectTarget(order),

    onScanCashLink: (order) => setScanTarget(order),

    onDecline: (order) => setConfirmRequest({
      title: 'Decline this order?',
      body: 'It goes to another member. It counts as a refusal, and this cannot be undone.',
      confirmLabel: 'Decline order',
      tone: 'danger',
      input: { label: 'Why are you declining it? (required)', multiline: true },
      onConfirm: (reason) => run(() => api.rejectOrder(orderRef(order), reason), 'Order declined'),
    }),

    onRelease: (order) => {
      // The reference is the PLAYER's, already stored and already claimed in
      // `utr_registry`. This checks it is THERE before opening the dialog, so a
      // merchant is not walked through a confirmation the server will refuse —
      // it does not re-send it, because the route reads the row.
      const utr = (order.utrNumber || '').trim();
      if (!utr) {
        toast.error(`The user has not submitted their ${PAYMENT_COPY.proofLabel} yet.`);
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
        body: `Confirm the full amount reached your account. Tokens credit to the user immediately and this cannot be reversed.`,
        confirmLabel: 'Confirm & release',
        tone: 'ok',
        onConfirm: () => run(
          () => api.confirmPayment(orderRef(order)),
          'Payment confirmed — tokens released'
        ),
      });
    },

    onPayout: (order) => (order.inrRouting === 'MERCHANTS' ? setPayoutTarget(order) : setConfirmRequest({
      title: 'Mark payout as sent?',
      body: 'Confirm you have sent the amount by bank transfer to the player\u2019s account, and enter the reference your bank gave the transfer.',
      confirmLabel: "I've sent the money",
      tone: 'ok',
      // ── The reference on a SELL is the MERCHANT's ──────────────────────
      // A buy and a sell put the reference on opposite sides. On a buy the
      // PLAYER pays and submits their UTR; on a sell the MERCHANT pays, so
      // the reference for that transfer is theirs to give and there is
      // nobody else who could. Asked on every rail: a cash team's payout is
      // a bank transfer too (owner, 2026-10-03).
      input: {
        label: `UTR for this transfer (min ${MIN_UTR_LENGTH} characters)`,
        validate: (v: string) => (v.length >= MIN_UTR_LENGTH
          ? null
          : `A UTR is at least ${MIN_UTR_LENGTH} characters. It is on your transfer receipt.`),
      },
      onConfirm: (utr: string) => run(
        () => api.confirmPayment(orderRef(order), utr),
        'Payout confirmed'
      ),
    })),

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
  }), [run]);

  /**
   * Send the rejection.
   *
   * The dialog stays OPEN on failure, with what the merchant typed still in
   * it, so a refusal does not make them start again.
   */
  const submitPaymentNotReceived = useCallback(async (reason: string) => {
    if (!rejectTarget) return;
    setRejectBusy(true);
    try {
      await api.rejectPaidOrder(orderRef(rejectTarget), reason);
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

  /**
   * Send the scanned QR. The scanner stays OPEN on a refusal, so the member
   * can scan again at the machine they are standing at; the server's message
   * says what was wrong (another amount, not a UPI payment QR).
   */
  const sendCashLink = useCallback(async (order: PaymentOrder, link: string): Promise<boolean> => {
    setScanBusy(true);
    try {
      await api.attachCashLink(orderRef(order), link);
      toast.success('QR sent. The player can pay it now.');
      await onChanged();
      return true;
    } catch (error: any) {
      toast.error(error?.message || 'That did not go through — scan again');
      return false;
    } finally {
      setScanBusy(false);
    }
  }, [onChanged]);

  /**
   * Mark a merchant account's sell paid, from the account chosen. Throws the
   * server's refusal (PAID_FROM_ACCOUNT_REQUIRED, a claimed UTR, a role) so
   * the dialog stays open and says it; resolves once it went through.
   */
  const submitPayoutFrom = useCallback(async (utr: string, paidFromAccountId: string) => {
    if (!payoutTarget) return;
    await api.confirmPayment(orderRef(payoutTarget), utr, paidFromAccountId);
    toast.success('Payout confirmed');
    setPayoutTarget(null);
    setCloseDetail(true);
    await onChanged();
  }, [onChanged, payoutTarget]);

  return {
    actions,
    confirmRequest,
    /** A merchant account's sell being marked paid, with its paid-from account. */
    payoutTarget,
    dismissPayout: () => setPayoutTarget(null),
    submitPayoutFrom,
    /** The cash buy whose machine QR is being scanned, if any. */
    scanTarget,
    scanBusy,
    dismissScan: () => setScanTarget(null),
    sendCashLink,
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
