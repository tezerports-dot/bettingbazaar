// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * depositCredit.js — how much of a confirmed deposit lands in each pocket.
 *
 * ONE rule, in one place, because three routes had three different ones and one
 * of them created tokens.
 *
 * ── What went wrong ─────────────────────────────────────────────────────────
 * A confirmed deposit debits the merchant's token inventory and credits the
 * user. The user's credit is SPLIT across two pockets — `depositBalance` (usable
 * for betting) and `reserveBalance` — by the active DepositPolicy, locked onto
 * the order at creation by paymentOrder.model.js's pre-save hook.
 *
 * The split is a question about the USER's side. The merchant's side is not
 * split at all: whatever the user receives in total, the merchant parts with.
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
 * `total` is what the merchant is debited. Callers use it rather than reaching
 * for `order.tokenAmount` themselves, so the two sides cannot drift apart again.
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
 * EXPORTED because `moveDepositMoney` is not the only path that debits a
 * merchant for a deposit. `POST /api/merchant/confirm/:id` — the route the
 * merchant panel actually uses — reimplements the same debit-then-credit
 * sequence inline and has its own `if (!debited)` refusal, so a reporter living
 * only inside `moveDepositMoney` would cover the ADMIN override and miss the
 * common path entirely. That the two paths are separate at all is a §5 problem
 * in its own right and is recorded as F-017; this export makes the reporting
 * correct in the meantime rather than waiting on that decision.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * `{ ok: false, reason: 'merchant_insufficient' }` was returned and nothing in
 * the platform read it. Both call sites answered 400 and did nothing else: no
 * alert, no notification, not one log line.
 *
 * The money was never at risk — the refusal happens BEFORE the order advances,
 * every movement is keyed on the order id, and the order stays PAID and
 * retryable. What was wrong is who found out. `PAID` means the player has
 * ALREADY SENT REAL MONEY and submitted a UTR, and at that moment the merchant
 * was told (they see the 400 and can top up), while the player saw an order
 * that simply stopped and the platform learned nothing at all. `expireOrders`
 * deliberately does not cover PAID — auto-cancelling a paid order would strand
 * the payment — so nothing swept it either, and the only route out was the
 * player noticing and pressing dispute.
 *
 * The argument for fixing it was eight lines below the call site: the sibling
 * branch, for the rarer and less consequential case of a refused transition,
 * carries the comment "It must be loud rather than silent" and logs. Within one
 * function the exotic failure shouted and the ordinary one was quiet.
 *
 * ── How an order reaches a merchant who cannot fund it ───────────────────────
 * Assignment is a check-then-act — `inventoryRefusal()` reads the balance and
 * the caller assigns in a separate statement — but `maxConcurrentDepositOrders`
 * defaults to 1, so that race needs two assignments in the same instant. The
 * ordinary path needs no race at all: the balance falls between assignment and
 * confirmation because the merchant funded a withdrawal, an admin deducted, or
 * a token order settled.
 *
 * ── Three deliberate choices ────────────────────────────────────────────────
 * 1. **Nothing here may throw.** This runs on the money path, immediately
 *    before a refusal the caller must still return. A reporting failure that
 *    became an exception would turn a clean 400 into a 500 and lose the reason
 *    the caller needs — reporting a problem must never create a worse one.
 * 2. **The alert key is per MERCHANT, not global and not per order.**
 *    `sendAlert` holds a 10-minute cooldown per key. A global key would swallow
 *    a second merchant running dry; a per-order key would defeat the cooldown
 *    entirely and page on every retry. One merchant being short IS one
 *    incident, however many orders hit it.
 * 3. **`console.error` as well as the alert**, because `sendAlert` returns
 *    silently when no webhook is configured — by design — and a deployment
 *    without one must still leave the operator a record.
 */
export async function reportUncreditableDeposit(order, total) {
  try {
    console.error(
      `[deposit-credit] ${order.orderId}: merchant ${order.merchantId} cannot cover ${total} tokens.`
      + ' The player has already paid; this order stays PAID and retryable.',
    );

    const { sendAlert } = await import('../../services/alerting.service.js');
    // Not awaited into the money path's latency: fire it and let it settle.
    sendAlert(
      `deposit-uncreditable-${order.merchantId}`,
      'A paid deposit cannot be credited — merchant is out of tokens',
      {
        merchantId: String(order.merchantId),
        orderId: String(order.orderId),
        tokensRequired: total,
        note: 'The player has already sent payment. Top the merchant up or reassign.',
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
 * ── Why this is a function and not two copies ───────────────────────────────
 * Two routes force-complete a deposit — the merchant/admin confirm
 * (`POST /api/payment/deposit/:orderId/confirm`) and the admin queue override
 * (`POST /api/admin/payment-orders/:orderId/action`) — and they did not agree.
 * The override credited `tokenAmount` in one lump, never debited the merchant,
 * and never released the UTR, so an admin approval MINTED tokens: the merchant
 * kept their float and the player got tokens that came from nowhere.
 *
 * It also passed a sentence where `creditDeposit` expects an order id. That
 * argument builds the idempotency key (`dep_complete_<orderId>`), so the two
 * routes wrote DIFFERENT keys for the same deposit and each could credit the
 * player once. The unique-tx_id gate was open for exactly as long as both
 * routes existed.
 *
 * The split above already had one owner. The movement it belongs to did not.
 * Now it does, and a third caller cannot invent a fourth arithmetic.
 *
 * ── Ordering ────────────────────────────────────────────────────────────────
 * The merchant is debited FIRST, because refusing (a merchant confirming more
 * than they hold) is the ordinary case and must refuse before anything else
 * moves. Every movement is keyed on the order, so a failure part-way through
 * leaves a retryable position rather than something to unwind.
 *
 * The caller applies the state transition AFTER this returns ok — money before
 * status, so a crash between them leaves a PAID order whose next confirm
 * replays these movements as no-ops, never a COMPLETED order that paid nobody.
 *
 * @param {object} order  the order record, read from the same rows this writes
 * @returns {Promise<{ok: boolean, reason?: string, depositCredit, reserveCredit, total}>}
 */
export async function moveDepositMoney(order, {
  debitMerchantTokens, creditDeposit, creditReserve, releaseUTR,
}) {
  const { depositCredit, reserveCredit, total } = depositCreditSplit(order);

  const { merchant: debited } = await debitMerchantTokens({
    merchantId: order.merchantId, amount: total,
    reason: `Deposit ${order.orderId} confirmed — tokens dispensed to user`,
    refModel: 'PaymentOrder', refId: order.orderId,
    txId: `mw_dep_deduct_${order.orderId}`,
  });
  if (!debited) {
    await reportUncreditableDeposit(order, total);
    return { ok: false, reason: 'merchant_insufficient', depositCredit, reserveCredit, total };
  }

  // Both keyed on the ORDER ID, not on a message. A sentence here would make a
  // second key for the same deposit and open the idempotency gate.
  if (depositCredit > 0) await creditDeposit(order.userId, depositCredit, order.orderId);
  if (reserveCredit > 0) await creditReserve(order.userId, reserveCredit, order.orderId);
  await releaseUTR(order.orderId);

  // ── The player's unpaid streak is cleared HERE, and only here ─────────────
  // This is the one point on the platform where the money is known to have
  // arrived: both confirm routes reach it, and reaching it means a merchant
  // looked at the payment and released their tokens for it.
  //
  // Deliberately NOT when the order reaches PAID. PAID is the player SAYING
  // they paid — clearing the count there would let anyone wipe their record by
  // submitting a false UTR, which is exactly the behaviour the count exists to
  // notice.
  //
  // Imported where it is used, like `sendAlert` and `notify` below: this module
  // is the deposit SPLIT rule and takes its money movers as arguments, so a
  // static import would give it a dependency its callers cannot substitute.
  const { clearPlayerPaymentFailures } = await import('./playerPaymentFailure.service.js');
  await clearPlayerPaymentFailures(order.userId);

  return { ok: true, depositCredit, reserveCredit, total };
}
