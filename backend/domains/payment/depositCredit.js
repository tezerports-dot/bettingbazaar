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
  if (!debited) return { ok: false, reason: 'merchant_insufficient', depositCredit, reserveCredit, total };

  // Both keyed on the ORDER ID, not on a message. A sentence here would make a
  // second key for the same deposit and open the idempotency gate.
  if (depositCredit > 0) await creditDeposit(order.userId, depositCredit, order.orderId);
  if (reserveCredit > 0) await creditReserve(order.userId, reserveCredit, order.orderId);
  await releaseUTR(order.orderId);

  return { ok: true, depositCredit, reserveCredit, total };
}
