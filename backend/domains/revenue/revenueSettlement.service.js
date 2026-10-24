// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
// Domain: Revenue & Settlement Platform (BBEPS Phase 007 bootstrap, 2026-07-09).
//
// THE SINGLE FINANCIAL AUTHORITY. This service is the ONLY writer of
// AccountingEvent documents (CLAUDE.md §1/§2). It owns:
//   completed bets · completed payouts · platform revenue · the settlement
//   ledger · reserve deductions · payout fees · accounting events.
//
// WHAT IT DELIBERATELY DOES NOT DO:
//   - It never mutates wallet balances — walletAuthority.service.js remains
//     the sole wallet writer (§7). This ledger is the ACCOUNTING view.
//   - It owns no configurable percentages or business rules — those belong
//     to the Business Policy Platform (domains/configuration). When a
//     payout-fee policy exists, this service READS it.
//   - It does not orchestrate. The Operations Platform (admin routes, cron)
//     calls in; this service enforces the invariants.
//
// DESIGN (standard fintech ledger practice — see CLAUDE.md
// 2026-07-09 for sources): append-only journal entries with signed integer
// postings (paise) that sum to zero; unique idempotency keys; balances always
// derived from postings; corrections are new reversing entries.
//
// PRODUCER MODEL: the ledger is DERIVED. A reconciliation worker (cronJobs.js,
// 60s) anti-joins completed source records (PaymentOrder COMPLETED, Cycle
// settled) against existing entries and records what's missing. No money
// flow was modified to produce ledger entries — completion code paths stay
// untouched, the ledger self-heals, and history backfills automatically.

import {
  recordEventOnPostgres, trialBalanceOnPostgres,
  accountBalanceOnPostgres, getLedgerOnPostgres,
  findCasinoRoundsUnbooked, findPromoGrantsUnbooked, findCompensationsUnbooked, findCricketPollsUnbooked,
} from '#db/repositories/ledger.js';
import { ACCOUNTS, ACCOUNT_CODES, EVENT_TYPES, toMinor } from './chartOfAccounts.js';
import { INR_TOKEN_RATE } from '../configuration/tokenRates.js';
import { formatOrderFiat } from '../payment/orderCurrency.js';
import { db } from '#db';

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
 * What entered the platform, in the LEDGER's currency.
 *
 * ── The ledger speaks one currency, and an order may not ───────────────────
 * `fiat_amount_paise` is "what the payer sends, in the ORDER's currency". On
 * an INR order that is rupees and can be posted directly. On a USDT order it
 * is USDT: 500, for a purchase of 50,000 tokens.
 *
 * Posting that 500 as rupees does not fail any check. The postings still sum
 * to zero, because the difference lands in the residual — so a USDT deposit
 * used to credit PLATFORM_REVENUE ₹49,500 the platform never earned and debit
 * EXTERNAL_FIAT ₹500 for value of ₹50,000. Balanced, silent, and wrong on
 * every USDT order.
 *
 * The honest figure is the INR-equivalent of what arrived, and the platform
 * already has it: the token amount, at the peg. That is precisely what the
 * merchant is debited and what the player is credited, so the residual is 0
 * for the same reason it is 0 on an INR order — nothing was earned on the
 * conversion, and the USDT never touched the platform's own accounts. The
 * amount the player actually sent stays in `metadata.fiatAmount` alongside
 * `rateUsed`, which is where a currency-denominated figure belongs.
 */
function ledgerFiatMinor(order) {
  return order?.currency === 'USDT'
    ? toMinor(Number(order.tokenAmount || 0) * INR_TOKEN_RATE)
    : toMinor(order?.fiatAmount || 0);
}

/**
 * Postings for a completed DEPOSIT order.
 * fiat in (debit EXTERNAL_FIAT); user liability + reserve up (credits); any
 * residual — e.g. the historical buy-rate spread on pre-1:1 orders — is
 * platform revenue. At today's fixed 1:1 the residual is always 0.
 */
export function buildDepositPostings(order) {
  const fiatMinor = ledgerFiatMinor(order);
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
  // Same rule as the deposit leg: a figure in the order's currency is not a
  // figure this ledger can post. No withdrawal is denominated in USDT today —
  // the rail is buy-only — and this makes that stay true rather than silently
  // booking a spread if one ever is.
  const fiatMinor  = ledgerFiatMinor(order);
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

// ═════════════════════════════════════════════════════════════════════════════
// The write path
// ═════════════════════════════════════════════════════════════════════════════

/**
 * recordAccountingEvent — the ONLY way an entry enters the ledger.
 * Idempotent: if idempotencyKey already exists, returns the existing entry
 * with { idempotent: true } and writes nothing.
 *
 * A caller's `metadata` and `recordedBy` are NOT stored: `accounting_events`
 * has no column for either, so they are not read here.
 */
export async function recordAccountingEvent({
  eventType, idempotencyKey, postings, refModel, refId,
  occurredAt, description,
}) {
  if (!Object.values(EVENT_TYPES).includes(eventType)) {
    throw new Error(`Unknown accounting event type '${eventType}'. Add it to chartOfAccounts.js first.`);
  }
  if (!idempotencyKey || typeof idempotencyKey !== 'string') {
    throw new Error('idempotencyKey is required for every accounting event.');
  }
  validatePostings(postings);

  // Validation runs FIRST: a malformed event is refused before anything is
  // written, so a bad posting cannot reach the books and then need unwinding.
  //
  // The idempotency gate is the UNIQUE constraint inside the INSERT, not a
  // read-then-write. A pre-read followed by an insert lets two deliveries both
  // see "not there" and both write — which on a ledger means the same money
  // recorded twice, in the one place a duplicate can never be netted out.
  const recorded = await recordEventOnPostgres({
    eventType, idempotencyKey, postings, refModel, refId, occurredAt, description,
  });
  return { idempotent: recorded.idempotent, event: recorded.event };
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
  // Derived from the postings, in one statement. A trial balance computed
  // anywhere other than where the entries live is a report about a store that
  // is not the source of truth — and it would read CLEAN the whole time it was
  // wrong, which is the only kind of accounting error that matters.
  return trialBalanceOnPostgres();
}

/** Reported balance (minor units) of one account. */
export async function getAccountBalanceMinor(accountCode) {
  if (!ACCOUNT_CODES.includes(accountCode)) {
    throw new Error(`Unknown ledger account '${accountCode}'.`);
  }
  return (await accountBalanceOnPostgres(accountCode)).reportedMinor;
}

/**
 * Distributable platform revenue = the reported PLATFORM_REVENUE balance.
 * Bonuses and team commission are booked against this account as costs, so
 * what was paid out is already excluded. Floored at 0 for consumers.
 */
export async function getDistributableRevenueMinor() {
  const bal = await getAccountBalanceMinor(ACCOUNTS.PLATFORM_REVENUE.code);
  return Math.max(0, bal);
}

/** Paginated ledger read (newest first), optional eventType filter. */
export async function getLedger({ page = 1, limit = 50, eventType } = {}) {
  return getLedgerOnPostgres({ page, limit, eventType: eventType ?? null });
}

// ═════════════════════════════════════════════════════════════════════════════
// Reconciliation — derive the ledger from completed source records
// ═════════════════════════════════════════════════════════════════════════════

// Anti-join note: each pass scans completed sources lacking a ledger entry
// via $lookup. Correct-by-construction and self-healing (a failed insert is
// simply retried next pass; history backfills automatically on first runs).
// If source volume makes the scan expensive, add a checkpoint optimization —
// flagged in CLAUDE.md.

/**
 * The two reconciliation reads live in the repository now.
 *
 * `unrecordedSources` was one generic aggregation parameterised by a model, a
 * match stage and a join — and it was called with two models that had already
 * been deleted, so BOTH reconciliation passes threw a ReferenceError.
 * Silently: they are called from a cron whose per-item failures are collected
 * rather than raised, so a revenue reconciliation that had never run once
 * still reported a clean, empty result.
 *
 * A LEFT JOIN with a NULL test answers the same question in one pass, and each
 * source gets a named query rather than a generic one that has to be told what
 * a source is.
 */

/**
 * reconcileCompletedOrders — record DEPOSIT_COMPLETED / WITHDRAWAL_COMPLETED
 * events for COMPLETED PaymentOrders that have no ledger entry yet.
 * Per-item failures are collected, never thrown.
 */
export async function reconcileCompletedOrders(limit = 200) {
  const due = await db.orders.findCompletedOrdersMissingEvents({ limit });

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
        // Named in the order's OWN currency: "₹500" for a payment of 500 USDT
        // is the same lie as posting it, in the line a human reads first.
        // Through the one formatter, so this cannot drift from what the
        // merchant's card and the player's message say.
        description: `${order.type} ${order.orderId} completed — ${order.tokenAmount} tokens / ${formatOrderFiat(order)}`,
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
  const due = await db.markets.findSettledCyclesMissingEvents({ limit });

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
          // Phase A itemization: winners are paid NET, so the retained
          // winnings fee is already inside netProfit (and therefore inside
          // the PLATFORM_REVENUE leg) — recorded here for audit/reporting.
          totalPlatformFees: cycle.totalPlatformFees ?? 0,
          winningsFeePercentUsed: cycle.winningsFeePercentUsed ?? 0,
        },
      });
      results.push({ refId: String(cycle.cycleId), recorded: !res.idempotent });
    } catch (e) {
      results.push({ refId: String(cycle.cycleId), recorded: false, error: e.message });
    }
  }
  return results;
}

/**
 * reconcileCasinoRounds — book each casino round's net to the house as it
 * moves: the difference between (bets − wins − refunds) and what is already
 * booked, keyed by the round's figures (each only grows), so a replay is a
 * no-op and a late win books its reversal. Per-item failures are collected.
 */
export async function reconcileCasinoRounds(limit = 200) {
  const due = await findCasinoRoundsUnbooked({ limit });
  const results = [];
  for (const r of due) {
    try {
      const res = await recordAccountingEvent({
        eventType: EVENT_TYPES.CASINO_ROUND_NET,
        idempotencyKey: `acct_casino_${r.id}_${r.debitedPaise}_${r.creditedPaise}_${r.refundedPaise}`,
        postings: [
          { account: ACCOUNTS.USER_FUNDS.code,       amountMinor: r.deltaPaise },
          { account: ACCOUNTS.PLATFORM_REVENUE.code, amountMinor: -r.deltaPaise },
        ],
        refModel: 'CasinoRound',
        refId: r.id,
        occurredAt: r.updatedAt ? new Date(r.updatedAt) : new Date(),
        description: `Casino round ${r.providerKey}/${r.roundId}: net to the house ₹${(r.deltaPaise / 100).toFixed(2)} booked`,
      });
      results.push({ refId: r.id, recorded: !res.idempotent });
    } catch (e) {
      results.push({ refId: r.id, recorded: false, error: e.message });
    }
  }
  return results;
}

/**
 * reconcileCricketPolls — book each ended cricket poll's net to the house
 * (stakes kept less wins and claims paid), once per poll.
 */
export async function reconcileCricketPolls(limit = 200) {
  const due = await findCricketPollsUnbooked({ limit });
  const results = [];
  for (const p of due) {
    try {
      const res = await recordAccountingEvent({
        eventType: EVENT_TYPES.CRICKET_POLL_NET,
        idempotencyKey: `acct_cricket_${p.pollId}`,
        postings: [
          { account: ACCOUNTS.USER_FUNDS.code,       amountMinor: p.netPaise },
          { account: ACCOUNTS.PLATFORM_REVENUE.code, amountMinor: -p.netPaise },
        ],
        refModel: 'CricketPoll',
        refId: p.pollId,
        occurredAt: p.settledAt ? new Date(p.settledAt) : new Date(),
        description: `Cricket poll ${p.title}: net to the house ₹${(p.netPaise / 100).toFixed(2)}`,
      });
      results.push({ refId: p.pollId, recorded: !res.idempotent });
    } catch (e) {
      results.push({ refId: p.pollId, recorded: false, error: e.message });
    }
  }
  return results;
}

/**
 * reconcilePromoGrants — book each General bonus (referral, first deposit) as
 * a cost: platform revenue down, what is owed to players up. Once per grant.
 */
export async function reconcilePromoGrants(limit = 200) {
  const due = await findPromoGrantsUnbooked({ limit });
  const results = [];
  for (const g of due) {
    try {
      const res = await recordAccountingEvent({
        eventType: EVENT_TYPES.PROMO_BONUS_PAID,
        idempotencyKey: `acct_promo_${g.grantId}`,
        postings: [
          { account: ACCOUNTS.PLATFORM_REVENUE.code, amountMinor: g.amountPaise },
          { account: ACCOUNTS.USER_FUNDS.code,       amountMinor: -g.amountPaise },
        ],
        refModel: 'PromoGrant',
        refId: g.grantId,
        occurredAt: g.createdAt ? new Date(g.createdAt) : new Date(),
        description: `${g.source === 'FIRST_DEPOSIT' ? 'First-deposit' : 'Referral'} bonus ₹${(g.amountPaise / 100).toFixed(2)} paid`,
      });
      results.push({ refId: g.grantId, recorded: !res.idempotent });
    } catch (e) {
      results.push({ refId: g.grantId, recorded: false, error: e.message });
    }
  }
  return results;
}

/**
 * Book each dispute compensation (`dispute_compensations`) not yet in the
 * ledger: EXTERNAL_FIAT +amount, USER_FUNDS -amount, as a buy is booked, so
 * USER_FUNDS keeps describing the wallets. Keyed by the order, once.
 */
export async function reconcileCompensations(limit = 200) {
  const due = await findCompensationsUnbooked({ limit });
  const results = [];
  for (const c of due) {
    try {
      const res = await recordAccountingEvent({
        eventType: EVENT_TYPES.DISPUTE_COMPENSATION,
        idempotencyKey: `acct_dispute_comp_${c.orderId}`,
        postings: [
          { account: ACCOUNTS.EXTERNAL_FIAT.code, amountMinor: c.amountPaise },
          { account: ACCOUNTS.USER_FUNDS.code,    amountMinor: -c.amountPaise },
        ],
        refModel: 'DisputeCompensation',
        refId: c.orderId,
        occurredAt: c.createdAt ? new Date(c.createdAt) : new Date(),
        description: `${c.percent}% dispute compensation ₹${(c.amountPaise / 100).toFixed(2)} paid from the team's pool`,
      });
      results.push({ refId: c.orderId, recorded: !res.idempotent });
    } catch (e) {
      results.push({ refId: c.orderId, recorded: false, error: e.message });
    }
  }
  return results;
}
