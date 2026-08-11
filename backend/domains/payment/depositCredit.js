// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
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
 *   - an order predating the split fields reads 0 through a hydrated Mongoose
 *     document (the schema default applies) but `undefined` through `.lean()`.
 *     So `??` fires or does not fire depending on how the order was READ, which
 *     is not a property any money decision should depend on.
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
