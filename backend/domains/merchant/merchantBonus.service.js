// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
// Domain: Merchant Platform (BBEPS Phase 008).
//
// MERCHANT PERFORMANCE BONUS ENGINE — Cycle Tracker → Bonus Calculator →
// issuance. The long-promised replacement for the retired buy/sell spread
// (2026-07-08 decision).
//
// HARD RULES (2026-07-08/09 decisions, all structurally enforced):
//   - Platform-funded ONLY: issuance draws on MERCHANT_BONUS_POOL via
//     revenueSettlement.issueMerchantBonus(), which caps at the pool balance;
//     the pool itself is fundable only from distributable platform revenue.
//   - NEVER calculated from buyRate/sellRate (retired — they don't exist).
//   - NEVER deducts user balances: no code path here touches User documents
//     or walletAuthority.
//   - Configurable ONLY through Business Policy: the percentage/threshold
//     come from MerchantBonusPolicy (domains/configuration); this engine
//     owns no numbers.
//
// CYCLE TRACKER — what is a "completed buy→sell cycle"?
//   A merchant "buys" when they dispense tokens for a completed user DEPOSIT
//   and "sells" when they take tokens back for a completed user WITHDRAWAL.
//   Matched cycle volume = min(total completed deposit fiat, total completed
//   withdrawal fiat) per merchant — volume that has demonstrably gone BOTH
//   ways. The engine issues on NEWLY matched volume above the last bonused
//   high-water mark, so each rupee of matched volume is bonused exactly once.
//
// HIGH-WATER MARK — derived, not stored: the latest MERCHANT_BONUS_ISSUED
//   accounting event for the merchant carries cumulativeMatchedMinor in its
//   metadata. Single source of truth (the ledger), nothing to drift.
//
// IDEMPOTENCY / CRASH SAFETY — the wallet credit and the ledger event share
//   one deterministic key (acct_bonusissue_<merchantId>_<cumulativeMatchedMinor>).
//   Both operations are idempotent on it, and the engine credits the wallet
//   AFTER the ledger event exists; a crash between the two is healed on the
//   next run because the same key is recomputed and each side no-ops if done.

import { db } from '#db';
import { getActiveBonusPolicy } from '../configuration/merchantBonusPolicy.service.js';
import { issueMerchantBonus, getAccountBalanceMinor } from '../revenue/revenueSettlement.service.js';
import { ACCOUNTS, toMinor, toRupees } from '../revenue/chartOfAccounts.js';
import { creditMerchantBonus } from './merchantWallet.service.js';

/** Pure: bonus for newly matched volume. Exported for tests. */
export function computeBonusMinor({ matchedMinor, lastBonusedMatchedMinor, bonusPercent, minMatchedVolumeMinor }) {
  if (!Number.isInteger(matchedMinor) || !Number.isInteger(lastBonusedMatchedMinor)) {
    throw new Error('computeBonusMinor: volumes must be integer minor units.');
  }
  const newMatchedMinor = matchedMinor - lastBonusedMatchedMinor;
  if (newMatchedMinor < minMatchedVolumeMinor || newMatchedMinor <= 0) {
    return { newMatchedMinor: Math.max(0, newMatchedMinor), bonusMinor: 0 };
  }
  // Integer math: floor the bonus so the pool is never over-drawn by rounding.
  const bonusMinor = Math.floor(newMatchedMinor * bonusPercent / 100);
  return { newMatchedMinor, bonusMinor };
}

/**
 * Cycle Tracker: per-merchant matched buy→sell volume, in minor units.
 *
 * The smaller of what a merchant took in and what they paid out — which is
 * what a completed cycle actually is. One statement, rather than two aggregates
 * merged in a loop that defaulted whichever side it did not find.
 */
export const getMerchantMatchedVolumes = () => db.orders.merchantMatchedVolumes();

/**
 * High-water marks, from the ledger.
 *
 * ── The mark that was always zero ───────────────────────────────────────────
 * This read `$metadata.cumulativeMatchedMinor` off the accounting event. There
 * is no metadata column on an accounting event and nothing stores one, so every
 * mark came back undefined and defaulted to 0 — and the engine would treat a
 * merchant's ENTIRE lifetime matched volume as newly matched on every pass.
 * Enabling the bonus engine would have paid every merchant their whole history
 * again, each run. It ships disabled, which is the only reason this never
 * fired.
 *
 * The mark now comes from the idempotency KEY the engine already writes:
 * `acct_bonusissue_<merchantId>_<cumulativeMatchedMinor>`. That key exists, is
 * UNIQUE, and is the thing that makes the payment idempotent — so the mark and
 * the idempotency cannot disagree, which a separate metadata field could.
 */
export const getBonusHighWaterMarks = () => db.ledger.bonusHighWaterMarks();

/**
 * runBonusEngine — one full pass. Reads the ACTIVE MerchantBonusPolicy;
 * does nothing while disabled (the shipped default). Per-merchant failures
 * are collected, never thrown.
 */
export async function runBonusEngine() {
  const policy = await getActiveBonusPolicy();
  if (!policy || !policy.enabled || !(policy.bonusPercent > 0)) {
    return { ran: false, reason: 'No enabled MerchantBonusPolicy with a non-zero percentage.' };
  }

  const [volumes, marks] = await Promise.all([
    getMerchantMatchedVolumes(),
    getBonusHighWaterMarks(),
  ]);
  const minMatchedVolumeMinor = toMinor(policy.minMatchedVolume || 0);

  const results = [];
  for (const [merchantId, vol] of Object.entries(volumes)) {
    try {
      const lastBonusedMatchedMinor = marks[merchantId] || 0;
      const { newMatchedMinor, bonusMinor } = computeBonusMinor({
        matchedMinor: vol.matchedMinor,
        lastBonusedMatchedMinor,
        bonusPercent: policy.bonusPercent,
        minMatchedVolumeMinor,
      });
      if (bonusMinor <= 0) continue;

      const poolMinor = await getAccountBalanceMinor(ACCOUNTS.MERCHANT_BONUS_POOL.code);
      if (bonusMinor > poolMinor) {
        // Never partial-issue: paying less while recording the full matched
        // high-water would silently under-pay. Skip until an admin funds the
        // pool from distributable revenue.
        results.push({ merchantId, issued: false,
          reason: `Bonus ₹${toRupees(bonusMinor)} exceeds pool ₹${toRupees(poolMinor)} — fund the pool first.` });
        continue;
      }

      const cumulativeMatchedMinor = vol.matchedMinor;
      const key = `acct_bonusissue_${merchantId}_${cumulativeMatchedMinor}`;

      // 1. Ledger first (pool → merchant liability), idempotent on key.
      await issueMerchantBonus({
        merchantId, amountMinor: bonusMinor, idempotencyKey: key,
        description: `Merchant Performance Bonus: ${policy.bonusPercent}% of ₹${toRupees(newMatchedMinor)} newly matched buy→sell volume`,
        metadata: {
          policyVersion: policy.version,
          bonusPercent: policy.bonusPercent,
          newMatchedMinor,
          cumulativeMatchedMinor,
          depositMinor: vol.depositMinor,
          withdrawalMinor: vol.withdrawalMinor,
        },
      });

      // 2. Wallet credit (tokens, 1:1 with rupees), idempotent on the same key.
      await creditMerchantBonus({
        merchantId,
        amount: toRupees(bonusMinor),
        txId: key,
        description: `Merchant Performance Bonus (${policy.bonusPercent}% of newly matched cycle volume)`,
      });

      results.push({ merchantId, issued: true, bonusRupees: toRupees(bonusMinor), newMatchedRupees: toRupees(newMatchedMinor) });
    } catch (e) {
      results.push({ merchantId, issued: false, error: e.message });
    }
  }
  return { ran: true, policyVersion: policy.version, results };
}
