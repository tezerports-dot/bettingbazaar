// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * playerPaymentFailure.service.js — what an unpaid buy order tells us.
 *
 * ── An expiry is NOBODY's fault ─────────────────────────────────────────────
 * A buy order that expires at ASSIGNED or PROCESSING expires because the player
 * did not pay. That is an ordinary thing to do, and the merchant was standing
 * by and did nothing wrong. Neither of them is punished for it, and the first
 * two versions of this module got that wrong in opposite directions: one
 * charged the merchant (three players who changed their minds suspended an
 * honest merchant), the next charged the player.
 *
 * ── It is still a SIGNAL, and it points at two different things ─────────────
 * The same event answers two questions, and they have different answers.
 *
 * THE PLAYER, three in a row: every one of those orders held a merchant's
 * tokens for its full window (F-018) — real inventory, unavailable to anybody
 * else, released only when the order died. A player cycling through them is
 * taking supply out of circulation that other players needed. So they cannot
 * open a new order for an hour. The cool-off lifts ITSELF, and paying for a
 * real order clears it early.
 *
 * THE MERCHANT, three in a row: this is the one nothing else on the platform
 * could see. If three different players were each assigned to the same merchant
 * and none of them could pay, the likeliest explanation is that something about
 * that MERCHANT is broken — a dead QR, a closed UPI handle, a bank refusing.
 * Each failure on its own looks like an ordinary abandoned purchase, so the
 * pattern is invisible one order at a time. They stop being assigned until an
 * admin has spoken to them. Not a suspension: they keep their orders, their
 * balance and their standing, and it is lifted by a person, because a clock
 * cannot tell whether the QR was fixed.
 *
 * ── One owner, and why the player half shares it ───────────────────────────
 * `flagPaymentWarning` already existed with exactly one caller — the merchant's
 * red-flag button, an accusation a person makes. This is the second, and it is
 * the platform noticing by itself. Both land there so one player has ONE count
 * however the failure was noticed; two counters would disagree the first time
 * either was tuned (§5).
 *
 * ── Never throws ────────────────────────────────────────────────────────────
 * It runs inside the expiry sweep, after the order has already been cancelled.
 * An exception would take down the rest of the batch and leave due orders
 * unprocessed — §21, a write that follows a commit must not be able to fail.
 */
import { db } from '#db';
import { getSystemConfig } from '#db/repositories/config.js';
import { sendAlert } from '../../services/alerting.service.js';
import { emitAdminUpdate } from '../notification/realtimeEmitters.js';

/**
 * A buy order expired with nobody having paid. Advance BOTH counts.
 *
 * The player's and the merchant's are separate questions about the same event,
 * so both are asked here — one place, so an expiry cannot be recorded against
 * one party and forgotten against the other.
 *
 * @returns {Promise<{playerStreak:number, locked:boolean, merchantStreak:number, paused:boolean}>}
 */
export async function recordPlayerPaymentFailure({ orderId, userId, merchantId = null, reason = '' }) {
  if (!orderId || !userId) {
    return { playerStreak: 0, locked: false, merchantStreak: 0, paused: false };
  }
  const config = await getSystemConfig();
  const limits = config?.merchantOrderLimits ?? {};

  const player = await countAgainstPlayer(orderId, userId, limits, reason);
  const merchant = await countAgainstMerchant(orderId, merchantId, limits);
  return { ...player, ...merchant };
}

/** Three unpaid orders in a row and the player cannot open another for an hour. */
async function countAgainstPlayer(orderId, userId, limits, reason) {
  try {
    // Advanced and read in ONE statement, so two orders expiring in the same
    // sweep cannot both believe they were the third.
    const streak = await db.users.bumpConsecutivePaymentFailures(userId);
    const cap = limits.maxConsecutivePlayerPaymentFailures ?? 3;   // schema default: 3
    if (streak < cap) return { playerStreak: streak, locked: false };

    const minutes = limits.playerOrderLockMinutes ?? 60;           // schema default: 60
    const until = await db.users.lockOrderCreation(userId, minutes);

    // Flagged as well as locked, through the count the admin screen already
    // reads. `maxWarnings: 0` means "never auto-block from here": the lock is
    // an hour and lifts itself, and closing an account is a person's decision.
    await db.users.flagPaymentWarning(userId, {
      reason: reason || `${streak} buy orders in a row expired without payment.`,
      maxWarnings: 0,
    });

    console.warn(
      `[player-payment] ${userId} locked out of new orders until ${until} after ${streak} `
      + `unpaid buy orders in a row (latest ${orderId}). Each one held a merchant's tokens.`,
    );
    emitAdminUpdate('user_flagged', {
      userId: String(userId),
      orderId: String(orderId),
      reason: 'Consecutive unpaid buy orders',
      consecutivePaymentFailures: streak,
      orderLockUntil: until,
      autoBlocked: false,
      server_ts: Date.now(),
    });
    return { playerStreak: streak, locked: true };
  } catch (error) {
    console.error(`[player-payment] could not record a failure for ${userId}:`, error);
    return { playerStreak: 0, locked: false };
  }
}

/**
 * Three in a row against the SAME merchant and we stop sending players to them.
 *
 * This is the half that finds a broken merchant. Three different players, each
 * assigned to Anil, none of whom could pay: one at a time that is three
 * abandoned purchases, and together it is a merchant nobody can pay.
 */
async function countAgainstMerchant(orderId, merchantId, limits) {
  if (!merchantId) return { merchantStreak: 0, paused: false };
  try {
    const streak = await db.merchants.bumpConsecutiveExpiries(merchantId);
    const cap = limits.maxConsecutiveMerchantExpiries ?? 3;        // schema default: 3
    if (streak < cap) return { merchantStreak: streak, paused: false };

    const reason = `${streak} buy orders in a row expired with no payment. `
                 + 'Check this merchant can actually be paid — QR, UPI handle, bank.';
    await db.merchants.pauseAssignment(merchantId, reason);

    console.error(`[merchant-expiry] ${merchantId} paused from assignment: ${reason} (latest ${orderId})`);
    await sendAlert(
      `merchant-expiries-${merchantId}`,
      `Merchant ${merchantId} paused: ${streak} buy orders in a row expired unpaid.`,
      { merchantId, orderId, streak },
    ).catch(() => {});
    emitAdminUpdate('merchant_assignment_paused', {
      merchantId: String(merchantId),
      consecutiveExpiries: streak,
      reason,
      server_ts: Date.now(),
    });
    return { merchantStreak: streak, paused: true };
  } catch (error) {
    console.error(`[merchant-expiry] could not record an expiry for ${merchantId}:`, error);
    return { merchantStreak: 0, paused: false };
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
