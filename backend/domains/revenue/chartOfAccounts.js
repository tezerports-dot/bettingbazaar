// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
// Domain: Revenue & Settlement Platform (BBEPS Phase 007 bootstrap, 2026-07-09).
//
// CHART OF ACCOUNTS — the canonical, closed list of ledger accounts.
// Every posting in every AccountingEvent must reference one of these.
// Adding an account is a deliberate act: add it here WITH its normalBalance
// and description, in the same commit as the first event type that posts to
// it. Never post to an ad-hoc string.
//
// Sign convention (standard double-entry, single-currency INR for now):
//   - Every posting carries a SIGNED integer amount in minor units (paise).
//   - Positive = debit, negative = credit.
//   - The postings of one event MUST sum to exactly zero.
//   - An account's raw balance is the sum of its postings; its REPORTED
//     balance flips sign for credit-normal accounts so that "PLATFORM_REVENUE
//     balance: ₹5,000" reads the way a human expects.

export const ACCOUNTS = Object.freeze({
  // Money that has entered/left the platform's fiat boundary (asset-like).
  // Debited when fiat comes in (deposit), credited when fiat goes out
  // (withdrawal payout).
  EXTERNAL_FIAT: { code: 'EXTERNAL_FIAT', normalBalance: 'DEBIT',
    description: 'Fiat received from / paid out to users at the platform boundary' },

  // What the platform owes users — their token balances (liability).
  USER_FUNDS: { code: 'USER_FUNDS', normalBalance: 'CREDIT',
    description: 'Aggregate user token liability (deposit + winnings wallets)' },

  // Reserve allocations carved out of deposits per DepositPolicy (liability).
  PLATFORM_RESERVE: { code: 'PLATFORM_RESERVE', normalBalance: 'CREDIT',
    description: 'Reserve wallet allocations per DepositPolicy (deposit/reserve split)' },

  // Platform earnings: net cycle settlement profit (which since Phase A
  // includes the winnings platform fee — winners are paid net, the retained
  // fee stays inside Cycle.netProfit), historical rate-spread residuals.
  // Merchant bonus funding flows OUT of here — the reported balance of this
  // account IS the distributable platform revenue.
  PLATFORM_REVENUE: { code: 'PLATFORM_REVENUE', normalBalance: 'CREDIT',
    description: 'Platform revenue: cycle net profit (incl. winnings fees), spread residuals' },

  // Future payout fees (no fee exists today — account + event type are
  // defined so the fee, when Business Policy introduces one, has a home;
  // no producer posts here yet).
  PAYOUT_FEES: { code: 'PAYOUT_FEES', normalBalance: 'CREDIT',
    description: 'Payout fees charged on withdrawals (none charged today)' },

  // Platform-funded pool from which Merchant Performance Bonuses are issued.
  // Funded ONLY from PLATFORM_REVENUE (never from users/deposits/withdrawals
  // — hard business rule, enforced in revenueSettlement.service.js).
  MERCHANT_BONUS_POOL: { code: 'MERCHANT_BONUS_POOL', normalBalance: 'CREDIT',
    description: 'Platform-funded pool for Merchant Performance Bonuses' },

  // What the platform owes merchants — issued bonuses land here as a
  // liability, mirrored 1:1 by the merchant-wallet credit executed via
  // merchantWallet.service.js (Merchant Platform, Phase 008).
  MERCHANT_FUNDS: { code: 'MERCHANT_FUNDS', normalBalance: 'CREDIT',
    description: 'Aggregate merchant liability from issued Performance Bonuses' },
});

export const ACCOUNT_CODES = Object.freeze(Object.keys(ACCOUNTS));

// ── Event types ───────────────────────────────────────────────────────────────
// The closed list of accounting event types. One name per logical financial
// occurrence (same discipline as docs/governance/04-GOVERNANCE.md §11 for socket events).
export const EVENT_TYPES = Object.freeze({
  // A completed DEPOSIT PaymentOrder: fiat in; user liability + reserve up;
  // any residual (historical buy-rate spread) is platform revenue.
  DEPOSIT_COMPLETED: 'DEPOSIT_COMPLETED',

  // A completed WITHDRAWAL PaymentOrder: user liability down; fiat out; any
  // residual (historical sell-rate spread) is platform revenue.
  WITHDRAWAL_COMPLETED: 'WITHDRAWAL_COMPLETED',

  // A settled betting cycle: netProfit (realPool − totalPaidOut) moves from
  // user liability to platform revenue (signs flip naturally on a loss cycle).
  // Since Phase A totalPaidOut is NET of the winnings platform fee, so the
  // retained fee arrives here inside netProfit — itemized in the event
  // metadata (totalPlatformFees / winningsFeePercentUsed), not a separate leg.
  BET_CYCLE_SETTLED: 'BET_CYCLE_SETTLED',

  // Future: a payout fee charged on a withdrawal (no producer yet — the fee
  // itself does not exist; Business Policy Platform will define it).
  PAYOUT_FEE_CHARGED: 'PAYOUT_FEE_CHARGED',

  // Moving distributable platform revenue into the merchant bonus pool.
  MERCHANT_BONUS_FUNDED: 'MERCHANT_BONUS_FUNDED',

  // Future: issuing a Merchant Performance Bonus from the pool to a merchant
  // after a completed buy→sell cycle (bonus engine not built yet).
  MERCHANT_BONUS_ISSUED: 'MERCHANT_BONUS_ISSUED',

  // Manual admin correction — always a NEW balancing entry, never an edit of
  // history (append-only ledger; corrections are reversing entries).
  ADJUSTMENT: 'ADJUSTMENT',
});

export const EVENT_TYPE_LIST = Object.freeze(Object.values(EVENT_TYPES));

// ── Money math ────────────────────────────────────────────────────────────────
// All ledger amounts are INTEGER MINOR UNITS (paise). Rupee floats exist only
// at the boundary where legacy documents (PaymentOrder.fiatAmount, Cycle
// netProfit, ...) store rupees as JS numbers.
export function toMinor(rupees) {
  if (typeof rupees !== 'number' || !Number.isFinite(rupees)) {
    throw new Error(`toMinor: expected a finite number, got ${rupees}`);
  }
  return Math.round(rupees * 100);
}

export function toRupees(minor) {
  if (!Number.isInteger(minor)) {
    throw new Error(`toRupees: expected an integer minor-unit amount, got ${minor}`);
  }
  return minor / 100;
}
