// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * playerPaymentFailure.service.js — the one owner of "this player did not pay".
 *
 * ── Why this exists at all ──────────────────────────────────────────────────
 * A buy order that expires at ASSIGNED or PROCESSING expires because the player
 * never paid. Until this module, that counted against the MERCHANT: every
 * expired assignment advanced their consecutive-refusal streak, so three
 * players who changed their minds suspended a merchant who had done nothing but
 * wait. The party who failed and the party who was charged for it were
 * different people.
 *
 * It is not a free action, though, and that is the other half. Every one of
 * those orders held a merchant's tokens for the length of its window — real
 * inventory, unavailable to anyone else, released only when the order died. A
 * player who places five and pays for none is denying a merchant their float.
 *
 * ── Flagged, not blocked ────────────────────────────────────────────────────
 * At the cap the player is FLAGGED, which puts them on the admin's flagged-
 * players screen for a person to look at. It does not block them. An abandoned
 * purchase is an ordinary thing to do and the platform's answer to a PATTERN of
 * them is a human, not an automatic door. The auto-block that does exist stays
 * where it was: on the warning count an admin sets deliberately.
 *
 * ── One owner, two callers ──────────────────────────────────────────────────
 * `flagPaymentWarning` already existed and had exactly one caller — the
 * merchant's red-flag button, an accusation a person makes. The expiry sweep is
 * the second, and it is the platform noticing by itself. Both land here so one
 * player has ONE count however the failure was noticed; two counters would
 * disagree the first time either was tuned (§5).
 *
 * ── Never throws ────────────────────────────────────────────────────────────
 * It runs inside the expiry sweep, after the order has already been cancelled.
 * An exception would take down the rest of the batch and leave due orders
 * unprocessed — §21, a write that follows a commit must not be able to fail.
 */
import { db } from '#db';
import { getSystemConfig } from '#db/repositories/config.js';
import { emitAdminUpdate } from '../notification/realtimeEmitters.js';

/**
 * Record that a player let a buy order expire without paying.
 *
 * @returns {Promise<{streak:number, flagged:boolean}>}
 */
export async function recordPlayerPaymentFailure({ orderId, userId, reason = '' }) {
  if (!orderId || !userId) return { streak: 0, flagged: false };

  try {
    // The streak advances and is read in ONE statement, so two orders expiring
    // in the same sweep cannot both believe they were the fifth.
    const streak = await db.users.bumpConsecutivePaymentFailures(userId);

    const config = await getSystemConfig();
    // schema default: 5
    const cap = config?.merchantOrderLimits?.maxConsecutivePlayerPaymentFailures ?? 5;
    if (streak < cap) return { streak, flagged: false };

    // At the cap, through the flag the admin screen already reads. `maxWarnings:
    // 0` means "never auto-block from here" — this control's job is to raise a
    // hand, and the block stays a decision somebody makes.
    await db.users.flagPaymentWarning(userId, {
      reason: reason || `${streak} buy orders in a row expired without payment.`,
      maxWarnings: 0,
    });

    console.warn(
      `[player-payment] ${userId} flagged after ${streak} unpaid buy orders in a row `
      + `(latest ${orderId}). Every one of them held a merchant's tokens for its window.`,
    );
    emitAdminUpdate('user_flagged', {
      userId: String(userId),
      orderId: String(orderId),
      reason: 'Consecutive unpaid buy orders',
      consecutivePaymentFailures: streak,
      autoBlocked: false,
      server_ts: Date.now(),
    });
    return { streak, flagged: true };
  } catch (error) {
    console.error(`[player-payment] could not record a failure for ${userId}:`, error);
    return { streak: 0, flagged: false };
  }
}

/**
 * The player paid. Their streak goes back to zero.
 *
 * Called from the deposit-credit path — the one place both confirm routes agree
 * the money actually arrived. Reaching PAID is only the player SAYING they
 * paid, and resetting on that would let a player clear their record with a
 * false UTR.
 */
export async function clearPlayerPaymentFailures(userId) {
  if (!userId) return;
  try {
    await db.users.resetConsecutivePaymentFailures(userId);
  } catch (error) {
    console.error(`[player-payment] could not clear failures for ${userId}:`, error);
  }
}
