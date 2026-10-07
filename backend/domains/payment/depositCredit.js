// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * depositCredit.js — the money for a confirmed buy, and what happens when it
 * cannot move.
 *
 * ── One owner, every route ──────────────────────────────────────────────────
 * Three routes complete a buy (the member's confirm, the admin queue's
 * APPROVE, a dispute released to the player) and all three come here, because
 * three routes once had three rules and one of them created tokens.
 *
 * ── What moves, and where ───────────────────────────────────────────────────
 * The team pool's held tokens, the player's credit and TEAM_FLOAT → USER_FLOAT
 * are ONE transaction, `teamPools.spendForBuy` (owner, 2026-10-07): the
 * database refuses to commit a wallet change without its USER_FLOAT leg, or a
 * pool change without its TEAM_FLOAT leg. How the credit divides between
 * `depositBalance` and `reserveBalance` is `wallets.buyCreditSplit`, read from
 * the order row that transaction has locked. The player receives exactly the
 * order's token amount, which the pool parts with — a partial or corrupt split
 * falls back to all-deposit, which neither creates nor destroys a token.
 */

/**
 * A deposit that cannot be credited is REPORTED — F-015.
 *
 * EXPORTED so the reporting has one owner whichever route met the refusal.
 *
 * ── When it happens ─────────────────────────────────────────────────────────
 * Every buy HOLDS its tokens in the team's pool at assignment (§3.10, 2c), and
 * a DISPUTED buy keeps its hold, so a paid buy finding nothing to spend means
 * the hold is missing — an anomaly, not the ordinary case. The order stays
 * PAID and retryable: the refusal happens BEFORE the order advances, and every
 * movement is keyed on the order id. What matters is who finds out: the player
 * has ALREADY SENT REAL MONEY, so they are told it is in hand, and the
 * operator is alerted to top the team up or resolve it.
 *
 * ── Three deliberate choices ────────────────────────────────────────────────
 * 1. **Nothing here may throw.** This runs on the money path, immediately
 *    before a refusal the caller must still return. A reporting failure that
 *    became an exception would turn a clean 400 into a 500 and lose the reason
 *    the caller needs — reporting a problem must never create a worse one.
 * 2. **The alert key is per TEAM, not global and not per order.**
 *    `sendAlert` holds a 10-minute cooldown per key. A global key would swallow
 *    a second team running dry; a per-order key would defeat the cooldown
 *    entirely and page on every retry. One team's pool being short IS one
 *    incident, however many orders hit it.
 * 3. **`console.error` as well as the alert**, because `sendAlert` returns
 *    silently when no webhook is configured — by design — and a deployment
 *    without one must still leave the operator a record.
 */
export async function reportUncreditableDeposit(order, total) {
  try {
    console.error(
      `[deposit-credit] ${order.orderId}: team ${order.teamId} cannot cover ${total} tokens `
      + `(member ${order.merchantId}). The player has already paid; this order stays PAID and retryable.`,
    );

    const { sendAlert } = await import('../../services/alerting.service.js');
    // Not awaited into the money path's latency: fire it and let it settle.
    sendAlert(
      `deposit-uncreditable-${order.teamId}`,
      'A paid deposit cannot be credited — the team pool cannot cover it',
      {
        teamId: String(order.teamId),
        merchantId: String(order.merchantId),
        orderId: String(order.orderId),
        tokensRequired: total,
        note: 'The player has already sent payment. Fund the team pool, or resolve the order.',
      },
    ).catch(() => { /* alerting is best-effort by design */ });

    // Through the one owner (§2). Never write a notification row directly.
    const { notify } = await import('../communication/communication.service.js');
    await notify({
      userId: order.userId,
      type: 'WARNING',
      title: 'Your deposit is taking longer than usual',
      // Says what is true and what happens next, and names neither the merchant
      // nor the reason: who the player paid is not theirs to have (§24), and
      // "the merchant is out of tokens" invites them to think their money is
      // gone. It is not — the order is retryable and the payment is claimed.
      message: 'We have your payment and your order is being completed. '
        + 'This can take a little longer than usual. If it has not cleared shortly, '
        + 'raise a dispute from the order and our team will settle it.',
      relatedId: String(order.orderId),
      relatedType: 'PaymentOrder',
    });
  } catch (e) {
    // Reached only if the reporting itself breaks. Logged, never rethrown — see
    // choice 1 above.
    console.error(`[deposit-credit] reporting failed for ${order?.orderId}:`, e?.message || e);
  }
}

/**
 * Move the money for a confirmed deposit. THE one place it happens.
 *
 * Every route that completes a buy — the member's confirm, the admin queue
 * override, a dispute released to the player — comes here, so no route can
 * invent its own arithmetic (§2: one owner of "the money for a completed buy").
 *
 * ── Both sides, ONCE, from the HOLD ─────────────────────────────────────────
 * Every buy HOLDS its tokens in the team's pool from the moment it becomes a
 * member's (`teamRouting.assignToTeam`). `walletAuthority.completeBuy` →
 * `teamPools.spendForBuy` spends that hold, credits the player and posts
 * TEAM_FLOAT → USER_FLOAT in one transaction keyed on the order — a retry or a
 * double-tap finds `alreadyTaken` and moves nothing, and a refusal moves
 * nothing at all. Only an order that somehow holds nothing is taken from
 * `available`, and only if it covers it.
 *
 * ── Ordering ────────────────────────────────────────────────────────────────
 * The caller applies the state transition AFTER this returns ok — money before
 * status, so a crash between them leaves a PAID order whose next confirm
 * replays the movement as a no-op, never a COMPLETED order that paid nobody.
 *
 * @param {object} order  the order record, read from the same rows this writes
 * @returns {Promise<{ok: boolean, reason?: string, total: number}>}
 */
export async function moveDepositMoney(order, {
  releaseUTR,
  /**
   * Completes the buy. Injectable so a unit test can substitute it; defaults
   * to the one owner, so no caller can forget it.
   */
  completeBuy = null,
  /**
   * The state the caller read the order in and will complete it from. Asked
   * under the order's row lock: an order that moved since is refused
   * (`order_state`) with nothing moved. Required — a caller that forgot it
   * would pay out a buy that was rejected or cancelled meanwhile.
   */
  requireState,
}) {
  if (!requireState) throw new Error('moveDepositMoney requires requireState: the state the order is completed from');
  const total = Number(order.tokenAmount) || 0;

  const complete = completeBuy ?? (await import('../wallet/walletAuthority.service.js')).completeBuy;
  const taken = await complete(order.orderId, { actor: 'deposit-credit', requireState });
  if (!taken.ok && taken.reason === 'order_state') {
    // Not a funding problem: the order moved since the caller read it. Nothing
    // moved, and there is nothing for the operator to fund.
    return { ok: false, reason: 'order_state', total };
  }
  if (!taken.ok && (taken.reason === 'pool_short' || taken.reason === 'no_team')) {
    // Nothing held and nothing spendable. The player has paid, so it is
    // reported, and the order stays PAID to retry.
    await reportUncreditableDeposit(order, total);
    return { ok: false, reason: taken.reason, total };
  }
  if (!taken.ok) {
    // A refusal no funding cures (a credit already made with no spend beside
    // it, a treasury refusal): nothing moved, and a person has to look.
    console.error(`[deposit-credit] ${order.orderId}: the buy could not complete: ${taken.reason}`);
    return { ok: false, reason: taken.reason, total };
  }
  await releaseUTR(order.orderId);

  // ── The player's unpaid streak is cleared HERE, and only here ─────────────
  // This is the one point on the platform where the money is known to have
  // arrived: every completion reaches it, and reaching it means a member looked
  // at the payment and released the team's tokens for it.
  //
  // Deliberately NOT when the order reaches PAID. PAID is the player SAYING
  // they paid — clearing the count there would let anyone wipe their record by
  // submitting a false UTR, which is exactly the behaviour the count exists to
  // notice.
  const { clearPlayerPaymentFailures } = await import('./playerPaymentFailure.service.js');
  await clearPlayerPaymentFailures(order.userId);

  return { ok: true, total };
}
