// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
// Domain: Merchant Platform (BBEPS Phase 008).
//
// MERCHANT COMMISSION ENGINE — Cycle Tracker → per-variety rate → issuance.
// Replaces the flat-rate performance bonus (2026-07-08 decision), which paid one
// percentage for every kind of work a merchant does.
//
// HARD RULES (2026-07-08/09 decisions, all structurally enforced):
//   - Platform-funded ONLY: issuance draws on MERCHANT_BONUS_POOL via
//     revenueSettlement.issueMerchantBonus(), which caps at the pool balance;
//     the pool itself is fundable only from distributable platform revenue.
//   - NEVER calculated from buyRate/sellRate (retired — they don't exist).
//   - NEVER deducts user balances: no code path here touches a player's wallet.
//   - Configurable ONLY through Business Policy: the rates and the threshold
//     come from the ACTIVE merchant_commission_policies version; this engine
//     owns no numbers.
//
// CYCLE TRACKER — what is a "completed buy→sell cycle"?
//   A merchant "buys" when they dispense tokens for a completed user DEPOSIT
//   and "sells" when they take tokens back for a completed user WITHDRAWAL.
//   Matched cycle volume = min(completed deposit volume, completed withdrawal
//   volume) — volume that has demonstrably gone BOTH ways. The engine issues on
//   NEWLY matched volume above the last-paid high-water mark, so each unit of
//   matched volume is paid exactly once.
//
// ── What "per variety" changes, and what it deliberately does not ───────────
// The BASIS is unchanged: matched buy→sell volume, once, above a high-water
// mark. What moved is the RATE, from one number for everybody to a rate looked
// up per (currency, paymentMode, denomination) — and, within that, one
// percentage for each LEG of the matched volume, because a matched rupee came
// in through a deposit and went out through a withdrawal.
//
// Both the matching and the mark are therefore per variety too. Matching across
// varieties would pair a ₹500 cash run to a machine with a UPI payout and pay
// one rate for two different jobs; one mark per merchant would let a payment for
// their cash work advance the mark on their UPI work, and the volume underneath
// it would never be paid at all.
//
// A variety with no rate pays NOTHING and is reported as unpriced. There is no
// default and no nearest-match: a variety an admin has not priced is one they
// have not decided about, and inventing a number for it pays real money on a
// decision nobody made.
//
// IDEMPOTENCY / CRASH SAFETY — the wallet credit and the ledger event share one
//   deterministic key (acct_commission_<merchantId>~<variety>~<cumulative>).
//   Both operations are idempotent on it, and the engine credits the wallet
//   AFTER the ledger event exists; a crash between the two is healed on the next
//   run because the same key is recomputed and each side no-ops if done.
//
//   The separator is `~` and not `_`: a merchant id can contain an underscore,
//   so the mark read back out of this key is a `split_part` rather than a
//   pattern guessing where the id ends.

import { db } from '#db';
import { getActiveCommissionPolicy } from '../configuration/merchantCommissionPolicy.service.js';
import { issueMerchantBonus, getAccountBalanceMinor } from '../revenue/revenueSettlement.service.js';
import { ACCOUNTS, toMinor, toRupees } from '../revenue/chartOfAccounts.js';
import { creditMerchantBonus } from './merchantWallet.service.js';

/**
 * The name of one variety, as it appears in an idempotency key.
 *
 * Built here and nowhere else, because it is half of a money key: two spellings
 * of the same variety would be two high-water marks, and the volume under the
 * abandoned one would be paid a second time.
 */
export function varietyKey({ currency, paymentMode, denominationPaise }) {
  const denomination = denominationPaise === null || denominationPaise === undefined
    ? 'none' : String(denominationPaise);
  return `${currency}:${paymentMode}:${denomination}`;
}

/**
 * The rate for one variety, or null when the policy does not price it.
 *
 * Exact match on all three axes. A "closest match" rule — falling back to the
 * same rail at another denomination, say — would pay a rate an admin never set
 * for work they never priced, and the difference would be invisible in every
 * panel.
 */
export function rateFor(policy, variety) {
  const denomination = variety.denominationPaise === null || variety.denominationPaise === undefined
    ? null : Number(variety.denominationPaise);
  return (policy?.rates ?? []).find((r) => r.currency === variety.currency
    && r.paymentMode === variety.paymentMode
    && (r.denominationPaise === null || r.denominationPaise === undefined
      ? denomination === null
      : Number(r.denominationPaise) === denomination)) ?? null;
}

/**
 * Pure: what one variety earns on its newly matched volume. Exported for tests.
 *
 * The two percentages are ADDED because they describe the two legs of the same
 * matched volume: the merchant took it in and paid it out, and both are work.
 * Multiplying, or taking the larger, would each describe something that did not
 * happen.
 */
export function computeCommissionMinor({
  matchedMinor, lastPaidMatchedMinor, buyPercent, sellPercent, minMatchedVolumeMinor,
}) {
  if (!Number.isInteger(matchedMinor) || !Number.isInteger(lastPaidMatchedMinor)) {
    throw new Error('computeCommissionMinor: volumes must be integer minor units.');
  }
  const newMatchedMinor = matchedMinor - lastPaidMatchedMinor;
  if (newMatchedMinor < minMatchedVolumeMinor || newMatchedMinor <= 0) {
    return { newMatchedMinor: Math.max(0, newMatchedMinor), commissionMinor: 0 };
  }
  const percent = Number(buyPercent || 0) + Number(sellPercent || 0);
  // Integer math: floor the commission so the pool is never over-drawn by
  // rounding. A merchant is short by at most one paise per issuance; the pool
  // going negative would be a hole in the platform's own books.
  const commissionMinor = Math.floor((newMatchedMinor * percent) / 100);
  return { newMatchedMinor, commissionMinor };
}

/**
 * Cycle Tracker: matched buy→sell volume per merchant AND variety, in minor
 * units — the smaller of what a merchant took in and what they paid out within
 * that variety, which is what a completed cycle actually is.
 */
export const getMerchantMatchedVolumes = () => db.orders.merchantMatchedVolumesByVariety();

/**
 * High-water marks, from the ledger, per merchant and variety.
 *
 * ── The mark that was always zero ───────────────────────────────────────────
 * The engine this replaces read `$metadata.cumulativeMatchedMinor` off the
 * accounting event. There is no metadata column on an accounting event and
 * nothing stores one, so every mark came back undefined and defaulted to 0 —
 * and the engine would treat a merchant's ENTIRE lifetime matched volume as
 * newly matched on every pass. Enabling it would have paid every merchant their
 * whole history again, each run. It shipped disabled, which is the only reason
 * that never fired.
 *
 * The mark comes from the idempotency KEY the engine already writes. That key
 * exists, is UNIQUE, and is the thing that makes the payment idempotent — so
 * the mark and the idempotency cannot disagree, which a separate metadata field
 * could.
 */
export const getCommissionHighWaterMarks = () => db.ledger.commissionHighWaterMarks();

/**
 * runCommissionEngine — one full pass. Reads the ACTIVE policy; does nothing
 * while disabled (the shipped default). Per-variety failures are collected,
 * never thrown: one merchant's problem must not stop everybody else's payment.
 */
export async function runCommissionEngine() {
  const policy = await getActiveCommissionPolicy();
  if (!policy || !policy.enabled || !(policy.rates?.length > 0)) {
    return { ran: false, reason: 'No enabled merchant commission policy with any variety priced.' };
  }

  const [volumes, marks, legacyMerchants] = await Promise.all([
    getMerchantMatchedVolumes(),
    getCommissionHighWaterMarks(),
    // A merchant paid by the RETIRED flat-rate engine carries a mark this one
    // cannot read, because that key had no variety in it. Treating them as
    // unpaid would re-pay their whole history on the first pass. They are
    // refused by name instead, so the operator reconciles rather than the
    // engine guessing.
    db.ledger.legacyBonusIssuedMerchants(),
  ]);
  const legacy = new Set(legacyMerchants);
  const minMatchedVolumeMinor = toMinor(policy.minMatchedVolume || 0);

  const results = [];
  for (const vol of volumes) {
    const key = varietyKey(vol);
    try {
      if (legacy.has(vol.merchantId)) {
        results.push({ merchantId: vol.merchantId, variety: key, issued: false,
          reason: 'This merchant was paid by the retired flat-rate bonus engine, whose high-water mark cannot be '
                + 'split across varieties. Reconcile what they were already paid before the commission engine pays them again.' });
        continue;
      }

      const rate = rateFor(policy, vol);
      // Unpriced is not zero-rated: it is reported, so an admin can see which
      // varieties their merchants are actually working and price them. A silent
      // skip is how a merchant works for months and is paid nothing.
      if (!rate) {
        if (vol.matchedMinor > 0) {
          results.push({ merchantId: vol.merchantId, variety: key, issued: false,
            reason: 'No rate is set for this variety — it earns nothing until one is.' });
        }
        continue;
      }

      const lastPaidMatchedMinor = marks[vol.merchantId]?.[key] || 0;
      const { newMatchedMinor, commissionMinor } = computeCommissionMinor({
        matchedMinor: vol.matchedMinor,
        lastPaidMatchedMinor,
        buyPercent: rate.buyPercent,
        sellPercent: rate.sellPercent,
        minMatchedVolumeMinor,
      });
      if (commissionMinor <= 0) continue;

      const poolMinor = await getAccountBalanceMinor(ACCOUNTS.MERCHANT_BONUS_POOL.code);
      if (commissionMinor > poolMinor) {
        // Never partial-issue: paying less while recording the full matched
        // high-water would silently under-pay, permanently. Skip until an admin
        // funds the pool from distributable revenue.
        results.push({ merchantId: vol.merchantId, variety: key, issued: false,
          reason: `Commission ₹${toRupees(commissionMinor)} exceeds pool ₹${toRupees(poolMinor)} — fund the pool first.` });
        continue;
      }

      const cumulativeMatchedMinor = vol.matchedMinor;
      const idempotencyKey = `acct_commission_${vol.merchantId}~${key}~${cumulativeMatchedMinor}`;

      // ── The wallet must be able to receive BEFORE the ledger says it did ──
      //
      // `creditMerchantTokens` returns `{ merchant: null }` for a merchant id
      // with no row — it does not throw. The ledger event is written FIRST, so
      // without this check the sequence is: the pool is debited, the platform
      // records that it owes this merchant, the wallet credit silently does
      // nothing, and the high-water mark — which is derived from that very
      // ledger event — advances past the volume. The money is owed, undelivered
      // and never retried, and the engine reports `issued: true`.
      //
      // `order_states.merchant_id` carries no foreign key to `merchants`, so an
      // id with orders and no merchant row is reachable, not hypothetical.
      // Checking first means the ledger event is never written for a payment
      // that cannot land, which keeps the crash-recovery property honest: after
      // this point the credit either succeeds or throws, and a run that dies in
      // between heals on the next pass because both sides share the key.
      const merchant = await db.merchants.getMerchant(vol.merchantId);
      if (!merchant) {
        results.push({ merchantId: vol.merchantId, variety: key, issued: false,
          reason: 'No merchant record for this id, so a commission credited to it would be owed and never delivered. '
                + 'Nothing was posted. Reconcile the orders naming this merchant.' });
        continue;
      }

      // 1. Ledger first (pool → merchant liability), idempotent on the key.
      await issueMerchantBonus({
        merchantId: vol.merchantId, amountMinor: commissionMinor, idempotencyKey,
        description: `Merchant commission: ${rate.buyPercent}%+${rate.sellPercent}% of ₹${toRupees(newMatchedMinor)} newly matched ${key} volume`,
        metadata: {
          policyVersion: policy.version,
          variety: key,
          buyPercent: rate.buyPercent,
          sellPercent: rate.sellPercent,
          newMatchedMinor,
          cumulativeMatchedMinor,
          depositMinor: vol.depositMinor,
          withdrawalMinor: vol.withdrawalMinor,
        },
      });

      // 2. Wallet credit (tokens, 1:1 with rupees), idempotent on the same key.
      await creditMerchantBonus({
        merchantId: vol.merchantId,
        amount: toRupees(commissionMinor),
        txId: idempotencyKey,
        description: `Merchant commission (${key})`,
      });

      results.push({ merchantId: vol.merchantId, variety: key, issued: true,
        commissionRupees: toRupees(commissionMinor), newMatchedRupees: toRupees(newMatchedMinor) });
    } catch (e) {
      results.push({ merchantId: vol.merchantId, variety: key, issued: false, error: e.message });
    }
  }
  return { ran: true, policyVersion: policy.version, results };
}
