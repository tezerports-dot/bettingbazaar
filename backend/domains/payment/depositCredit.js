// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * depositCredit.js — how much of a confirmed deposit lands in each pocket.
 *
 * ONE rule, in one place, because three routes had three different ones and one
 * of them created tokens.
 *
 * ── What went wrong ─────────────────────────────────────────────────────────
 * A confirmed deposit spends the team pool's held tokens and credits the
 * user. The user's credit is SPLIT across two pockets — `depositBalance` (usable
 * for betting) and `reserveBalance` — by the active DepositPolicy, locked onto
 * the order at creation by paymentOrder.model.js's pre-save hook.
 *
 * The split is a question about the USER's side. The team's side is not
 * split at all: whatever the user receives in total, the pool parts with.
 * Two of the three routes had that right and debited `order.tokenAmount`. The
 * third debited `order.depositAllocation` and then credited
 * `depositAllocation + reserveAllocation`, so on every deposit with a non-zero
 * reserve share it credited more than it debited — 100 tokens per ₹1000 deposit
 * under the default 90/10 policy, appearing from nowhere. All three also used
 * the same canonical idempotency key for the debit while asking for different
 * amounts.
 *
 * ── And why the fallbacks disagreed ─────────────────────────────────────────
 * The three readers were `?? tokenAmount`, `|| tokenAmount`, and no fallback.
 * They differ on 0, and `depositAllocation` is legitimately 0 twice over:
 *
 *   - a policy of `reserveAllocationPercent: 100` is legal (the service
 *     validates only that the two percentages sum to 100), and it makes the
 *     deposit share exactly zero. `||` treats that as absent and substitutes
 *     the whole token amount, so the user is credited the full amount to
 *     deposit AND the full amount to reserve.
 *   - an order predating the split fields reads 0 where the column defaults
 *     and `undefined` where it does not, so `??` fired or did not fire
 *     depending on how the order was READ — not a property any money decision
 *     should depend on.
 *
 * ── The rule ────────────────────────────────────────────────────────────────
 * The user receives exactly `tokenAmount`. It is split by the recorded
 * allocation when that allocation is present and adds up; otherwise the whole
 * amount goes to `depositBalance`, which is where it went before the split
 * existed and is the only answer that neither creates nor destroys tokens.
 *
 * `total` is what the pool parts with. Callers use it rather than reaching for
 * `order.tokenAmount` themselves, so the two sides cannot drift apart again.
 */

/**
 * @param {{tokenAmount:number, depositAllocation?:number, reserveAllocation?:number}} order
 * @returns {{depositCredit:number, reserveCredit:number, total:number, split:boolean}}
 *   `depositCredit + reserveCredit === total` always. `split` says whether the
 *   order's recorded allocation was used, so a caller can log the fallback.
 */
export function depositCreditSplit(order) {
  const total = Number(order?.tokenAmount) || 0;

  const deposit = Number(order?.depositAllocation);
  const reserve = Number(order?.reserveAllocation);

  // Both must be real numbers AND account for the whole amount. A partial split
  // is not a split to fall back from — it is a corrupt order, and quietly
  // crediting part of it would leave the difference unaccounted for on a path
  // whose whole job is that the books close.
  const usable = Number.isFinite(deposit) && Number.isFinite(reserve)
    && deposit >= 0 && reserve >= 0
    && Math.abs((deposit + reserve) - total) < 1e-9;

  if (!usable) return { depositCredit: total, reserveCredit: 0, total, split: false };
  return { depositCredit: deposit, reserveCredit: reserve, total, split: true };
}

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
 * ── The team's side is taken ONCE, from the HOLD ────────────────────────────
 * Every buy HOLDS its tokens in the team's pool from the moment it becomes a
 * member's (`teamRouting.assignToTeam`). `spendForBuy` spends that hold
 * (held −a), posts the treasury movement TEAM_FLOAT → USER_FLOAT with it, and
 * writes the pool's ledger line, all in one transaction keyed on the order — a
 * retry or a double-tap finds `alreadyTaken` and moves nothing. Only an order
 * that somehow holds nothing is taken from `available`, and only if it covers
 * it.
 *
 * ── Ordering ────────────────────────────────────────────────────────────────
 * The team's side comes FIRST, because refusing must happen before anything
 * else moves. Every movement is keyed on the order, so a failure part-way
 * through leaves a retryable position rather than something to unwind.
 *
 * The caller applies the state transition AFTER this returns ok — money before
 * status, so a crash between them leaves a PAID order whose next confirm
 * replays these movements as no-ops, never a COMPLETED order that paid nobody.
 *
 * @param {object} order  the order record, read from the same rows this writes
 * @returns {Promise<{ok: boolean, reason?: string, depositCredit, reserveCredit, total}>}
 */
export async function moveDepositMoney(order, {
  creditDeposit, creditReserve, releaseUTR,
  /**
   * Spends the order's hold. Injected like the movers above so a caller can
   * substitute it; defaults to the real one, so no caller can forget it.
   */
  spendPool = null,
}) {
  const { depositCredit, reserveCredit, total } = depositCreditSplit(order);

  const spend = spendPool ?? (await import('#db')).db.teamPools.spendForBuy;
  const taken = await spend(order.orderId, { actor: 'deposit-credit' });
  if (!taken.ok) {
    // `pool_short` / `no_team`: nothing held and nothing spendable. The player
    // has paid, so it is reported, and the order stays PAID to retry.
    await reportUncreditableDeposit(order, total);
    return { ok: false, reason: taken.reason, depositCredit, reserveCredit, total };
  }

  // Both keyed on the ORDER ID, not on a message. A sentence here would make a
  // second key for the same deposit and open the idempotency gate.
  if (depositCredit > 0) await creditDeposit(order.userId, depositCredit, order.orderId);
  if (reserveCredit > 0) await creditReserve(order.userId, reserveCredit, order.orderId);
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

  return { ok: true, depositCredit, reserveCredit, total };
}
