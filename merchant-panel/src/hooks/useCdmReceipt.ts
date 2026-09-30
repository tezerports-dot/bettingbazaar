// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The CDM receipt, from the merchant's side: what is owed, and how one is sent.
 *
 * Two things reach the same dialog and so they live in one hook rather than two
 * copies of this state:
 *
 *   • the prompt straight after a cash payout is confirmed — the merchant is
 *     standing at the machine with the slip in their hand, which is the moment
 *     it is easiest to send; and
 *   • the outstanding list, for every time that moment was missed. The confirm
 *     COMPLETES the order, so a failed upload or an app closed at the machine
 *     otherwise leaves the payout gone from every screen they have, with an
 *     admin queue filling up that only they can clear.
 *
 * `submitted` is the server's echo of what it accepted and it is deliberately
 * kept here rather than discarded on success: a stored receipt cannot be read
 * back by the merchant who stored it, so that echo is the only record they get.
 */
import { useCallback, useState } from 'react';
import toast from 'react-hot-toast';
import { getOutstandingCdmReceipts, submitCdmReceipt } from '../services/api';
import type { OutstandingCdmReceipt } from '../types';

export interface CdmReceiptTarget {
  orderId: string;
  /** In RUPEES, or null when the caller does not have the figure to hand. */
  amount: number | null;
}

export function useCdmReceipt() {
  const [target, setTarget] = useState<CdmReceiptTarget | null>(null);
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState<{ transactionId: string; submittedAt: string } | null>(null);
  const [outstanding, setOutstanding] = useState<OutstandingCdmReceipt[]>([]);

  const reloadOutstanding = useCallback(async () => {
    try {
      setOutstanding(await getOutstandingCdmReceipts());
    } catch {
      // A failed read leaves the previous list on screen. It is a reminder, not
      // a gate: nothing the merchant does depends on it having loaded.
    }
  }, []);

  const open = useCallback((orderId: string, amount: number | null = null) => {
    setSubmitted(null);
    setTarget({ orderId, amount });
  }, []);

  const dismiss = useCallback(() => {
    setTarget(null);
    setSubmitted(null);
  }, []);

  /**
   * Send it.
   *
   * On failure the dialog stays OPEN with the transaction id and the photo
   * still in it. The server refuses a short id, a file it cannot verify against
   * this merchant and this order, and a payout on the wrong rail — each is
   * something the merchant can fix standing where they are, and closing the
   * dialog would make them start again without being told which half was wrong.
   */
  const submit = useCallback(async (transactionId: string, receipt: File) => {
    if (!target) return;
    setBusy(true);
    try {
      const echo = await submitCdmReceipt(target.orderId, transactionId, receipt);
      setSubmitted(echo);
      // The row leaving this list is the merchant's only other confirmation.
      await reloadOutstanding();
    } catch (error: any) {
      toast.error(error?.message || 'The receipt did not go through — try again');
    } finally {
      setBusy(false);
    }
  }, [reloadOutstanding, target]);

  return { target, busy, submitted, outstanding, open, dismiss, submit, reloadOutstanding };
}
