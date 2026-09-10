// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * merchantRefusal.service.js — the one owner of "a merchant did not serve this
 * order", and of what that costs them.
 *
 * ── Why this is a module and not two blocks of code ─────────────────────────
 * A merchant can fail to serve an order in two ways, and to the player waiting
 * they are the same event:
 *
 *   DECLINED  they pressed reject
 *   EXPIRED   they did nothing and the assignment window closed
 *
 * The second was the hole in the first version of this control. The cap counted
 * only rejections, so a merchant who never pressed the button and simply let
 * every order lapse refused without limit — the streak never moved, and they
 * were handed the next order and the next. Counting only the polite refusal
 * penalises the merchant who tells you.
 *
 * Both now land here, and §5 is why it is one function rather than the same
 * five steps written twice: the same payload assembled in two places drifts,
 * and it drifts silently.
 *
 * ── What a refusal costs ────────────────────────────────────────────────────
 * 1. The pair is recorded. That merchant never sees this ORDER again, and never
 *    sees another order from this PLAYER. Without it the reject route requeues
 *    and immediately reassigns, and can hand the order straight back.
 * 2. The consecutive streak advances. At the cap the merchant is SUSPENDED —
 *    which is a refusal to assign, not a deletion: they keep every order they
 *    already hold, because taking those away would strand players who are
 *    mid-payment on them.
 *
 * Any COMPLETED order resets the streak (`updateMerchantStatsOnComplete`), so
 * the cap is three IN A ROW and not three ever. A lifetime allowance catches
 * every honest merchant eventually, which is the failure mode that gets a
 * control switched off.
 */
import { db } from '#db';
import { getSystemConfig } from '#db/repositories/config.js';
import { sendAlert } from '../../services/alerting.service.js';

/** How a merchant failed to serve an order. Both count the same. */
export const REFUSAL = Object.freeze({
  DECLINED: 'DECLINED',
  EXPIRED:  'EXPIRED',
});

/**
 * Record a refusal and apply its consequences.
 *
 * Never throws. It runs after the order has already moved — on the reject route
 * the requeue has committed, and in the expiry cron the cancellation has — so
 * an exception here would turn a completed action into a 500, or take down a
 * sweep mid-batch and leave the rest of the due orders unprocessed. §21: a
 * write that follows a commit must not be able to fail.
 *
 * @returns {Promise<{streak:number, suspended:boolean}>}
 */
export async function recordMerchantRefusal({
  orderId, merchantId, userId, reason = '', kind = REFUSAL.DECLINED,
}) {
  if (!orderId || !merchantId || !userId) return { streak: 0, suspended: false };

  try {
    // The pair first, so a reassignment happening immediately after already
    // sees it. On the reject route that reassignment is the very next thing.
    await db.orders.recordOrderRejection({
      orderId, merchantId, userId,
      reason: kind === REFUSAL.EXPIRED
        ? `Assignment window expired without action${reason ? `: ${reason}` : ''}`
        : reason,
    });

    // Advanced and read in ONE statement. A read-then-write would let two
    // concurrent refusals both see 2 and both write 3, so a merchant could pass
    // the cap without it ever being observed.
    const streak = await db.merchants.bumpConsecutiveRejections(merchantId);

    const cfg = await getSystemConfig();
    const cap = cfg?.merchantOrderLimits?.maxConsecutiveRejections ?? 3; // schema default: 3
    if (streak < cap) return { streak, suspended: false };

    await db.merchants.suspendMerchant(
      merchantId,
      `Suspended automatically after ${streak} consecutive refusals (${kind.toLowerCase()}).`,
      { actor: 'rejection-cap' },
    );
    // Not awaited into the caller's latency, and never allowed to reject: the
    // suspension has already happened and alerting is best-effort by design.
    sendAlert(
      `merchant-rejection-cap-${merchantId}`,
      'A merchant was suspended for consecutive refusals',
      { merchantId: String(merchantId), streak, cap, lastRefusal: kind },
    ).catch(() => {});
    return { streak, suspended: true };
  } catch (err) {
    console.error(`[merchant-refusal] ${merchantId} on ${orderId} (${kind}):`, err?.message || err);
    return { streak: 0, suspended: false };
  }
}
