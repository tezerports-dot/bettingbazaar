// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * merchantScoring.service.js — Merchant auto-assignment scoring algorithm.
 *
 * GOVERNANCE §1: This service is the sole authority for merchant selection.
 * It is a pure read + score function — no wallet mutations here.
 * All wallet mutations remain exclusively in walletAuthority.service.js.
 *
 * Scoring formula (max 100):
 *   40 pts  — successRate (0–1)
 *   25 pts  — responseScore: 25 - (avgResponseMinutes * 2), min 0
 *   20 pts  — disputeScore:  20 - (disputeRate * 100), min 0
 *   10 pts  — onlineConsistency: based on lastSeenAt/lastOnlineToggle recency
 *    5 pts  — loadScore: 5 - (activeOrderCount / maxConcurrentOrders * 5)
 */

import mongoose from 'mongoose';

/**
 * Score a single merchant document for a given order context.
 * Returns a numeric score 0–100.
 *
 * @param {object} merchant  — Merchant Mongoose document (lean or full)
 * @returns {number}
 */
function scoreMerchant(merchant) {
  // 40 pts: success rate
  const successScore = (merchant.successRate ?? 1.0) * 40;

  // 25 pts: response speed — lower avgResponseMinutes is better
  // schema default: avgResponseMinutes = 2 → score = 21
  const responseScore = Math.max(0, 25 - ((merchant.avgResponseMinutes ?? 2) * 2));

  // 20 pts: dispute rate — lower is better
  // schema default: disputeRate = 0 → score = 20
  const disputeScore = Math.max(0, 20 - ((merchant.disputeRate ?? 0) * 100));

  // 10 pts: online consistency — penalise merchants not seen recently
  // Use lastOnlineToggle as proxy. Within 5 minutes = full 10, decays to 0 over 60 min
  let onlineConsistency = 5; // schema default: no lastOnlineToggle → mid-score
  if (merchant.lastOnlineToggle) {
    const minutesAgo = (Date.now() - new Date(merchant.lastOnlineToggle).getTime()) / 60000;
    onlineConsistency = Math.max(0, 10 - (minutesAgo / 6)); // 0→5 min = 10pts, decays to 0 at 60 min
  }

  // 5 pts: load score — fewer active orders = better
  // schema default: activeOrderCount = 0, maxConcurrentOrders = 3 → score = 5
  const maxOrders = merchant.maxConcurrentOrders ?? 3; // schema default: 3
  const loadScore = Math.max(0, 5 - ((merchant.activeOrderCount ?? 0) / Math.max(maxOrders, 1)) * 5);

  return successScore + responseScore + disputeScore + onlineConsistency + loadScore;
}

/**
 * selectBestMerchant — find and return the highest-scoring eligible merchant.
 *
 * Eligibility criteria (all must pass):
 *   - merchant.isOnline === true
 *   - merchant.merchantApprovalStatus === 'APPROVED'
 *   - For DEPOSIT: merchant.acceptsDeposits === true AND merchant.tokenBalance >= tokenAmount
 *   - For WITHDRAWAL: merchant.acceptsWithdrawals === true
 *   - merchant.activeOrderCount < merchant.maxConcurrentOrders
 *
 * @param {'DEPOSIT'|'WITHDRAWAL'} orderType
 * @param {number}                 tokenAmount
 * @returns {Promise<object|null>} — Merchant document or null if none eligible
 */
export async function selectBestMerchant(orderType, tokenAmount, currency = 'INR') {
  const Merchant = mongoose.model('Merchant');

  const baseQuery = {
    isOnline:               true,
    merchantApprovalStatus: 'APPROVED',
    status:                 'ACTIVE',
    // Only merchants that accept this order's currency (INR/USDT) — the
    // consumer that makes acceptedCurrencies a real capability, not a label.
    acceptedCurrencies:     currency,
    // activeOrderCount < maxConcurrentOrders
    // CONFIRMED BUG (2026-07-02): a bare $expr comparing two field paths treats a
    // genuinely missing field as BSON null, which sorts below every number — so
    // merchants missing maxConcurrentOrders (e.g. documents created before this
    // field existed in the schema) NEVER matched, regardless of activeOrderCount.
    // Verified empirically against production: 100% of merchants were missing this
    // field, meaning automatic assignment had never successfully matched anyone.
    // $ifNull substitutes the schema default (3) when the field is absent, mirroring
    // the same `?? 3` fallback scoreMerchant() already uses for scoring (see above).
    // See backend/migrations/003-backfill-merchant-defaults.js for the accompanying
    // one-time data fix — this query fix is defense-in-depth so the same class of
    // bug can't silently reoccur if another defaulted field gets added later.
    $expr: {
      $lt: [
        { $ifNull: ['$activeOrderCount', 0] },
        { $ifNull: ['$maxConcurrentOrders', 3] },
      ],
    },
  };

  if (orderType === 'DEPOSIT') {
    baseQuery.acceptsDeposits = true;
    baseQuery.tokenBalance    = { $gte: tokenAmount };
  } else {
    baseQuery.acceptsWithdrawals = true;
  }

  const candidates = await Merchant.find(baseQuery).lean();

  if (candidates.length === 0) return null;

  // Score all candidates
  const scored = candidates.map(m => ({ merchant: m, score: scoreMerchant(m) }));

  // Sort: highest score first; on tie, fewest active orders wins
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return (a.merchant.activeOrderCount ?? 0) - (b.merchant.activeOrderCount ?? 0);
  });

  const bestId = scored[0].merchant._id;

  // Return a live (non-lean) document so callers can mutate and save
  return Merchant.findById(bestId);
}
