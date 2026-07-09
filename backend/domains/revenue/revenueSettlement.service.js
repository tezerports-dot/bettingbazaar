// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
// Domain: Revenue & Settlement Platform (BBEPS Phase 007 bootstrap, 2026-07-09).
//
// THE SINGLE FINANCIAL AUTHORITY. This service is the ONLY writer of
// AccountingEvent documents (04-GOVERNANCE.md §1/§2). It owns:
//   completed bets · completed payouts · platform revenue · the settlement
//   ledger · reserve deductions · payout fees · accounting events · merchant
//   bonus funding.
//
// WHAT IT DELIBERATELY DOES NOT DO:
//   - It never mutates wallet balances — walletAuthority.service.js remains
//     the sole wallet writer (§7). This ledger is the ACCOUNTING view.
//   - It owns no configurable percentages or business rules — those belong
//     to the Business Policy Platform (domains/configuration). When a
//     MerchantBonusPolicy / payout-fee policy exists, this service READS it.
//   - It does not orchestrate. The Operations Platform (admin routes, cron)
//     calls in; this service enforces the invariants.
//
// DESIGN (standard fintech ledger practice — see ENTERPRISE_DECISIONS.md
// 2026-07-09 for sources): append-only journal entries with signed integer
// postings (paise) that sum to zero; unique idempotency keys; balances always
// derived from postings; corrections are new reversing entries.
//
// PRODUCER MODEL: the ledger is DERIVED. A reconciliation worker (cronJobs.js,
// 60s) anti-joins completed source records (PaymentOrder COMPLETED, Cycle
// settled) against existing entries and records what's missing. No money
// flow was modified to produce ledger entries — completion code paths stay
// untouched, the ledger self-heals, and history backfills automatically.

import mongoose from 'mongoose';
import { AccountingEvent } from './accountingEvent.model.js';
import { ACCOUNTS, ACCOUNT_CODES, EVENT_TYPES, toMinor } from './chartOfAccounts.js';

// ═════════════════════════════════════════════════════════════════════════════
// Pure validation + posting builders (exported for tests — no DB required)
// ═════════════════════════════════════════════════════════════════════════════

export function validatePostings(postings) {
  if (!Array.isArray(postings) || postings.length < 2) {
    throw new Error('An accounting event needs at least two postings (double-entry).');
  }
  let sum = 0;
  for (const p of postings) {
    if (!ACCOUNT_CODES.includes(p.account)) {
      throw new Error(`Unknown ledger account '${p.account}'. Add it to chartOfAccounts.js first.`);
    }
    if (!Number.isInteger(p.amountMinor)) {
      throw new Error(`Posting to ${p.account} is not an integer minor-unit amount: ${p.amountMinor}`);
    }
    sum += p.amountMinor;
  }
  if (sum !== 0) {
    throw new Error(`Postings must sum to zero — got ${sum} minor units.`);
  }
  return true;
}

/**
 * Postings for a completed DEPOSIT order.
 * fiat in (debit EXTERNAL_FIAT); user liability + reserve up (credits); any
 * residual — e.g. the historical buy-rate spread on pre-1:1 orders — is
 * platform revenue. At today's fixed 1:1 the residual is always 0.
 */
export function buildDepositPostings(order) {
  const fiatMinor = toMinor(order.fiatAmount || 0);
  let depMinor    = toMinor(order.depositAllocation || 0);
  const resMinor  = toMinor(order.reserveAllocation || 0);
  // Orders that predate the DepositPolicy allocation fields carry 0/0 —
  // their full token amount was user liability.
  if (depMinor === 0 && resMinor === 0) depMinor = toMinor(order.tokenAmount || 0);

  const residual = fiatMinor - depMinor - resMinor; // historical spread, 0 at 1:1
  const postings = [
    { account: ACCOUNTS.EXTERNAL_FIAT.code,    amountMinor: fiatMinor },
    { account: ACCOUNTS.USER_FUNDS.code,       amountMinor: -depMinor },
    { account: ACCOUNTS.PLATFORM_RESERVE.code, amountMinor: -resMinor },
  ];
  if (residual !== 0) {
    postings.push({ account: ACCOUNTS.PLATFORM_REVENUE.code, amountMinor: -residual });
  }
  return postings;
}

/**
 * Postings for a completed WITHDRAWAL order (a completed payout).
 * User liability down (debit USER_FUNDS); fiat out (credit EXTERNAL_FIAT).
 * Residual (tokens − fiat) splits into:
 *   - the order's recorded payoutFee (Phase 010, Risk-computed) → PAYOUT_FEES
 *   - anything else (historical sell-rate spread) → PLATFORM_REVENUE
 */
export function buildWithdrawalPostings(order) {
  const tokenMinor = toMinor(order.tokenAmount || 0);
  const fiatMinor  = toMinor(order.fiatAmount || 0);
  const feeMinor   = toMinor(order.payoutFee || 0);
  const residual   = tokenMinor - fiatMinor; // 0 at 1:1 with no fee
  const spreadMinor = residual - feeMinor;   // historical spread portion
  const postings = [
    { account: ACCOUNTS.USER_FUNDS.code,    amountMinor: tokenMinor },
    { account: ACCOUNTS.EXTERNAL_FIAT.code, amountMinor: -fiatMinor },
  ];
  if (feeMinor !== 0) {
    postings.push({ account: ACCOUNTS.PAYOUT_FEES.code, amountMinor: -feeMinor });
  }
  if (spreadMinor !== 0) {
    postings.push({ account: ACCOUNTS.PLATFORM_REVENUE.code, amountMinor: -spreadMinor });
  }
  return postings;
}

/**
 * Postings for a settled betting cycle.
 * netProfit = realPool − totalPaidOut (gameEngine.js). Positive: user
 * liability shrinks, platform revenue grows. Negative (loss cycle): signs
 * flip naturally. Zero-net cycles still get an entry (zero legs) so the
 * reconciler's anti-join sees them as done.
 */
export function buildCyclePostings(cycle) {
  const netMinor = toMinor(cycle.netProfit || 0);
  return [
    { account: ACCOUNTS.USER_FUNDS.code,       amountMinor: netMinor },
    { account: ACCOUNTS.PLATFORM_REVENUE.code, amountMinor: -netMinor },
  ];
}

/** Postings for funding the merchant bonus pool from distributable revenue. */
export function buildBonusFundingPostings(amountMinor) {
  if (!Number.isInteger(amountMinor) || amountMinor <= 0) {
    throw new Error('Bonus pool funding amount must be a positive integer minor-unit amount.');
  }
  return [
    { account: ACCOUNTS.PLATFORM_REVENUE.code,    amountMinor: amountMinor },
    { account: ACCOUNTS.MERCHANT_BONUS_POOL.code, amountMinor: -amountMinor },
  ];
}

/** Postings for issuing a Merchant Performance Bonus from the pool. */
export function buildBonusIssuePostings(amountMinor) {
  if (!Number.isInteger(amountMinor) || amountMinor <= 0) {
    throw new Error('Bonus issue amount must be a positive integer minor-unit amount.');
  }
  return [
    { account: ACCOUNTS.MERCHANT_BONUS_POOL.code, amountMinor: amountMinor },
    { account: ACCOUNTS.MERCHANT_FUNDS.code,      amountMinor: -amountMinor },
  ];
}

// ═════════════════════════════════════════════════════════════════════════════
// The write path
// ═════════════════════════════════════════════════════════════════════════════

/**
 * recordAccountingEvent — the ONLY way an entry enters the ledger.
 * Idempotent: if idempotencyKey already exists, returns the existing entry
 * with { idempotent: true } and writes nothing.
 */
export async function recordAccountingEvent({
  eventType, idempotencyKey, postings, refModel, refId,
  occurredAt, description, metadata, recordedBy = 'reconciler',
}) {
  if (!Object.values(EVENT_TYPES).includes(eventType)) {
    throw new Error(`Unknown accounting event type '${eventType}'. Add it to chartOfAccounts.js first.`);
  }
  if (!idempotencyKey || typeof idempotencyKey !== 'string') {
    throw new Error('idempotencyKey is required for every accounting event.');
  }
  validatePostings(postings);

  const existing = await AccountingEvent.findOne({ idempotencyKey }).lean();
  if (existing) return { idempotent: true, event: existing };

  try {
    const event = await AccountingEvent.create({
      eventType, idempotencyKey, postings, refModel, refId: String(refId),
      occurredAt: occurredAt || new Date(), description, metadata, recordedBy,
    });
    return { idempotent: false, event };
  } catch (err) {
    // Duplicate-key race between the findOne above and create — resolve to
    // the winner's entry (same semantics as the idempotent early return).
    if (err.code === 11000) {
      const winner = await AccountingEvent.findOne({ idempotencyKey }).lean();
      if (winner) return { idempotent: true, event: winner };
    }
    throw err;
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// Balances — always derived from postings, never stored
// ═════════════════════════════════════════════════════════════════════════════

/**
 * getTrialBalance — every account's derived balance in minor units, with the
 * reported balance sign-adjusted by the account's normal balance so
 * credit-normal accounts (revenue, liabilities) read as positive numbers.
 * Also returns integrityOk: whether ALL postings across the ledger sum to 0.
 */
export async function getTrialBalance() {
  const rows = await AccountingEvent.aggregate([
    { $unwind: '$postings' },
    { $group: { _id: '$postings.account', rawMinor: { $sum: '$postings.amountMinor' }, postings: { $sum: 1 } } },
  ]);
  const byAccount = {};
  let grandTotal = 0;
  for (const code of ACCOUNT_CODES) {
    const row = rows.find(r => r._id === code);
    const raw = row ? row.rawMinor : 0;
    grandTotal += raw;
    byAccount[code] = {
      account: code,
      normalBalance: ACCOUNTS[code].normalBalance,
      description: ACCOUNTS[code].description,
      rawMinor: raw,
      reportedMinor: ACCOUNTS[code].normalBalance === 'CREDIT' ? -raw : raw,
      postings: row ? row.postings : 0,
    };
  }
  return { accounts: byAccount, integrityOk: grandTotal === 0, grandTotalMinor: grandTotal };
}

/** Reported balance (minor units) of one account. */
export async function getAccountBalanceMinor(accountCode) {
  if (!ACCOUNT_CODES.includes(accountCode)) {
    throw new Error(`Unknown ledger account '${accountCode}'.`);
  }
  const [row] = await AccountingEvent.aggregate([
    { $unwind: '$postings' },
    { $match: { 'postings.account': accountCode } },
    { $group: { _id: null, rawMinor: { $sum: '$postings.amountMinor' } } },
  ]);
  const raw = row ? row.rawMinor : 0;
  return ACCOUNTS[accountCode].normalBalance === 'CREDIT' ? -raw : raw;
}

/**
 * Distributable platform revenue = the reported PLATFORM_REVENUE balance.
 * Bonus funding debits this account, so already-funded amounts are naturally
 * excluded — no separate bookkeeping to drift. Floored at 0 for consumers.
 */
export async function getDistributableRevenueMinor() {
  const bal = await getAccountBalanceMinor(ACCOUNTS.PLATFORM_REVENUE.code);
  return Math.max(0, bal);
}

/** Paginated ledger read (newest first), optional eventType filter. */
export async function getLedger({ page = 1, limit = 50, eventType } = {}) {
  const filter = {};
  if (eventType) filter.eventType = eventType;
  const [entries, total] = await Promise.all([
    AccountingEvent.find(filter).sort({ createdAt: -1 })
      .skip((page - 1) * limit).limit(limit).lean(),
    AccountingEvent.countDocuments(filter),
  ]);
  return { entries, total, page, pages: Math.ceil(total / limit) || 1 };
}

// ═════════════════════════════════════════════════════════════════════════════
// Merchant bonus funding
// ═════════════════════════════════════════════════════════════════════════════

/**
 * fundMerchantBonusPool — move distributable platform revenue into the
 * merchant bonus pool.
 *
 * HARD BUSINESS RULES (2026-07-08 decision, enforced here):
 *   - Funded ONLY from PLATFORM_REVENUE. There is no code path from
 *     USER_FUNDS / PLATFORM_RESERVE / deposits / withdrawals to the pool.
 *   - Never derived from buyRate/sellRate (which no longer exist).
 *   - The amount cannot exceed current distributable revenue.
 *
 * The percentage/cadence that AUTOMATES funding belongs to the Business
 * Policy Platform (future MerchantBonusPolicy) — this function takes an
 * explicit amount so no configurable rule lives here.
 *
 * NOTE: the distributable check is read-then-write without a cross-document
 * transaction — concurrent fundings could jointly exceed distributable.
 * Acceptable for a rare, manual, admin-only action; flagged in
 * EXECUTION_QUEUE.md for when funding becomes automated.
 */
export async function fundMerchantBonusPool({ amountMinor, actor, justification, idempotencyKey }) {
  if (!justification || !justification.trim()) {
    throw new Error('businessJustification is required to fund the merchant bonus pool.');
  }
  if (!actor?.userId) {
    throw new Error('An acting admin is required to fund the merchant bonus pool.');
  }
  const postings = buildBonusFundingPostings(amountMinor); // validates amount

  const distributable = await getDistributableRevenueMinor();
  if (amountMinor > distributable) {
    throw new Error(
      `Cannot fund ₹${(amountMinor / 100).toFixed(2)} — distributable platform revenue is ₹${(distributable / 100).toFixed(2)}. ` +
      'Merchant bonuses are platform-funded only; the pool can never draw beyond earned revenue.'
    );
  }

  return recordAccountingEvent({
    eventType: EVENT_TYPES.MERCHANT_BONUS_FUNDED,
    idempotencyKey: idempotencyKey || `acct_bonusfund_${new mongoose.Types.ObjectId().toString()}`,
    postings,
    refModel: 'Manual',
    refId: String(actor.userId),
    occurredAt: new Date(),
    description: `Merchant bonus pool funded from distributable platform revenue: ${justification.trim()}`,
    metadata: { amountMinor, justification: justification.trim() },
    recordedBy: String(actor.userId),
  });
}

/**
 * issueMerchantBonus — record the accounting side of a Merchant Performance
 * Bonus: MERCHANT_BONUS_POOL → MERCHANT_FUNDS. Called by the Merchant
 * Platform's bonus engine (which computes WHO earns WHAT from completed
 * buy→sell cycles); this function owns the accounting rules:
 *   - the pool is the ONLY source — structurally, bonuses can never touch
 *     USER_FUNDS / PLATFORM_RESERVE / deposits / withdrawals;
 *   - an issue cannot exceed the pool's current balance (the pool itself is
 *     fundable only from distributable platform revenue);
 *   - idempotent via the caller's deterministic key.
 * The matching merchant-wallet credit is executed by the Merchant Platform
 * (merchantWallet.service.js) with the SAME idempotency key.
 */
export async function issueMerchantBonus({ merchantId, amountMinor, idempotencyKey, description, metadata }) {
  const postings = buildBonusIssuePostings(amountMinor); // validates amount
  if (!merchantId) throw new Error('merchantId is required to issue a merchant bonus.');
  if (!idempotencyKey) throw new Error('A deterministic idempotencyKey is required to issue a merchant bonus.');

  const poolMinor = await getAccountBalanceMinor(ACCOUNTS.MERCHANT_BONUS_POOL.code);
  if (amountMinor > poolMinor) {
    throw new Error(
      `Cannot issue ₹${(amountMinor / 100).toFixed(2)} — merchant bonus pool holds ₹${(poolMinor / 100).toFixed(2)}. ` +
      'Fund the pool from distributable platform revenue first (POST /api/admin/revenue/bonus-pool/fund).'
    );
  }

  return recordAccountingEvent({
    eventType: EVENT_TYPES.MERCHANT_BONUS_ISSUED,
    idempotencyKey,
    postings,
    refModel: 'Merchant',
    refId: String(merchantId),
    occurredAt: new Date(),
    description: description || `Merchant Performance Bonus issued to merchant ${merchantId}`,
    metadata,
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// Reconciliation — derive the ledger from completed source records
// ═════════════════════════════════════════════════════════════════════════════

// Anti-join note: each pass scans completed sources lacking a ledger entry
// via $lookup. Correct-by-construction and self-healing (a failed insert is
// simply retried next pass; history backfills automatically on first runs).
// If source volume makes the scan expensive, add a checkpoint optimization —
// flagged in EXECUTION_QUEUE.md.

async function unrecordedSources(Model, matchStage, refModel, localRefExpr, limit) {
  return Model.aggregate([
    { $match: matchStage },
    { $sort: { _id: 1 } },
    { $lookup: {
        from: 'accountingevents',
        let: { rid: localRefExpr },
        pipeline: [
          { $match: { $expr: { $and: [
            { $eq: ['$refModel', refModel] },
            { $eq: ['$refId', '$$rid'] },
          ] } } },
          { $limit: 1 },
          { $project: { _id: 1 } },
        ],
        as: 'ledger',
    } },
    { $match: { ledger: { $size: 0 } } },
    { $limit: limit },
  ]);
}

/**
 * reconcileCompletedOrders — record DEPOSIT_COMPLETED / WITHDRAWAL_COMPLETED
 * events for COMPLETED PaymentOrders that have no ledger entry yet.
 * Per-item failures are collected, never thrown.
 */
export async function reconcileCompletedOrders(limit = 200) {
  const PaymentOrder = mongoose.model('PaymentOrder');
  const due = await unrecordedSources(
    PaymentOrder,
    { status: 'COMPLETED', type: { $in: ['DEPOSIT', 'WITHDRAWAL'] } },
    'PaymentOrder',
    { $toString: '$_id' },
    limit
  );

  const results = [];
  for (const order of due) {
    try {
      const isDeposit = order.type === 'DEPOSIT';
      const res = await recordAccountingEvent({
        eventType: isDeposit ? EVENT_TYPES.DEPOSIT_COMPLETED : EVENT_TYPES.WITHDRAWAL_COMPLETED,
        idempotencyKey: `acct_${isDeposit ? 'dep' : 'wd'}_${order._id}`,
        postings: isDeposit ? buildDepositPostings(order) : buildWithdrawalPostings(order),
        refModel: 'PaymentOrder',
        refId: String(order._id),
        occurredAt: order.completedAt || order.updatedAt || order.createdAt,
        description: `${order.type} ${order.orderId} completed — ${order.tokenAmount} tokens / ₹${order.fiatAmount}`,
        metadata: {
          orderId: order.orderId,
          tokenAmount: order.tokenAmount,
          fiatAmount: order.fiatAmount,
          rateUsed: order.rateUsed,
          depositAllocation: order.depositAllocation,
          reserveAllocation: order.reserveAllocation,
          depositPolicySnapshot: order.depositPolicySnapshot,
        },
      });
      results.push({ refId: String(order._id), recorded: !res.idempotent });
    } catch (e) {
      results.push({ refId: String(order._id), recorded: false, error: e.message });
    }
  }
  return results;
}

/**
 * reconcileSettledCycles — record BET_CYCLE_SETTLED events for settled
 * cycles (isSettled: 'COMPLETED') that have no ledger entry yet.
 */
export async function reconcileSettledCycles(limit = 200) {
  const Cycle = mongoose.model('Cycle');
  const due = await unrecordedSources(
    Cycle,
    { isSettled: 'COMPLETED' },
    'Cycle',
    '$cycleId',
    limit
  );

  const results = [];
  for (const cycle of due) {
    try {
      const res = await recordAccountingEvent({
        eventType: EVENT_TYPES.BET_CYCLE_SETTLED,
        idempotencyKey: `acct_cycle_${cycle.cycleId}`,
        postings: buildCyclePostings(cycle),
        refModel: 'Cycle',
        refId: String(cycle.cycleId),
        occurredAt: cycle.settledAt ? new Date(cycle.settledAt) : new Date(),
        description: `Cycle ${cycle.cycleId} settled — winner ${cycle.winner}, net ₹${cycle.netProfit ?? 0}`,
        metadata: {
          winner: cycle.winner,
          realPool: (cycle.realDelhi || 0) + (cycle.realBombay || 0),
          totalPaidOut: cycle.totalPaidOut,
          netProfit: cycle.netProfit,
        },
      });
      results.push({ refId: String(cycle.cycleId), recorded: !res.idempotent });
    } catch (e) {
      results.push({ refId: String(cycle.cycleId), recorded: false, error: e.message });
    }
  }
  return results;
}
