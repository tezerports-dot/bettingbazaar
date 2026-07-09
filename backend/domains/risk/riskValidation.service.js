// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
// Domain: Risk Platform (BBEPS Phase 010).
//
// THE SINGLE AUTHORITY for operational rules and transaction validation
// (2026-07-09 directive). Funding order creation, bet placement, and the
// deposit reserve-split all validate HERE — not inline in routes/services.
//
// OWNERSHIP BOUNDARIES:
//   - Configurable NUMBERS (limits, percentages, rule toggles) are owned by
//     the Business Policy Platform (SystemConfig / policy documents) — this
//     platform reads them and enforces; it stores nothing.
//   - This platform never mutates balances or writes financial records.
//
// Validation rules implemented (2026-07-09 directive):
//   - positive values only, numeric values only
//   - multiples of 10 for buy tokens / sell tokens / betting
//   - reserve-ratio rounding (Spec 4.4: floor the reserve, remainder to
//     deposit — the user never loses a token to rounding)
//   - payout fee computation (percentage owned by SystemConfig)
//   - opposite-side betting restriction (config-gated)
//   - funding-order velocity limit (config-gated)
// Declared Risk Platform capabilities NOT yet implemented (no fake
// placeholders — see EXECUTION_QUEUE.md): AML screening, fraud-signal
// scoring, device risk, behaviour analysis, responsible-gaming limits.

import mongoose from 'mongoose';
// Shared trading vocabulary (Phase 011) — canonical sides, no local strings.
import { oppositeSide } from '../trading/tradingModels.js';

function reject(message, code = 'RISK_VALIDATION') {
  return Object.assign(new Error(message), { status: 400, code });
}

// ═════════════════════════════════════════════════════════════════════════════
// Pure validators (exported for tests — no DB)
// ═════════════════════════════════════════════════════════════════════════════

export function assertPositiveNumber(amount, label = 'Amount') {
  if (typeof amount !== 'number' || !Number.isFinite(amount)) {
    throw reject(`${label} must be a number.`);
  }
  if (amount <= 0) throw reject(`${label} must be positive.`);
  return true;
}

export function assertMultipleOf10(amount, label = 'Amount') {
  if (!Number.isInteger(amount) || amount % 10 !== 0) {
    throw reject(`${label} must be a multiple of 10 tokens.`, 'MULTIPLE_OF_10');
  }
  return true;
}

/**
 * validateTokenPurchase / validateTokenSale / validateBetAmount — pure rule
 * cores. Limits come from the caller (read from SystemConfig — Business
 * Policy owns the numbers); enforceMultiples comes from riskRules config.
 */
export function validateTokenPurchase({ amount, min, max, enforceMultiples = true }) {
  assertPositiveNumber(amount, 'Purchase amount');
  if (enforceMultiples) assertMultipleOf10(amount, 'Purchase amount');
  if (amount < min) throw reject(`Minimum purchase is ${min} BB tokens`);
  if (amount > max) throw reject(`Maximum purchase is ${max} BB tokens`);
  return true;
}

export function validateTokenSale({ amount, min, max, enforceMultiples = true }) {
  assertPositiveNumber(amount, 'Withdrawal amount');
  if (enforceMultiples) assertMultipleOf10(amount, 'Withdrawal amount');
  if (amount < min) throw reject(`Minimum withdrawal is ${min} BB tokens`);
  if (amount > max) throw reject(`Maximum withdrawal is ${max} BB tokens`);
  return true;
}

export function validateBetAmount({ amount, min, max, enforceMultiples = true }) {
  assertPositiveNumber(amount, 'Bet amount');
  if (!Number.isInteger(amount)) throw reject('Bet amount must be a whole number.');
  if (enforceMultiples) assertMultipleOf10(amount, 'Bet amount');
  if (amount < min) throw reject(`Minimum bet is ₹${min}`);
  if (amount > max) throw reject(`Maximum bet is ₹${max}`);
  return true;
}

/**
 * computeReserveSplit — Spec 4.4 reserve-ratio rounding, owned here since
 * Phase 010 (previously inline in paymentOrder.model.js's pre-save hook).
 * The reserve share is FLOORED and the remainder goes to the deposit share,
 * so the user never loses a token to rounding and the split always conserves
 * the full amount.
 */
export function computeReserveSplit(tokenAmount, reservePercent) {
  assertPositiveNumber(tokenAmount, 'Token amount');
  if (typeof reservePercent !== 'number' || reservePercent < 0 || reservePercent > 100) {
    throw reject('reservePercent must be between 0 and 100.');
  }
  const reserveAllocation = Math.floor(tokenAmount * (reservePercent / 100));
  const depositAllocation = tokenAmount - reserveAllocation;
  return { depositAllocation, reserveAllocation };
}

/**
 * computePayoutFeeMinor — payout fee on a withdrawal, in integer paise,
 * floored (the platform never rounds a fee up against the user). The
 * PERCENTAGE is owned by SystemConfig.payoutFeePercent (Business Policy);
 * this is only the arithmetic rule.
 */
export function computePayoutFeeMinor(tokenAmount, payoutFeePercent) {
  if (typeof payoutFeePercent !== 'number' || payoutFeePercent < 0 || payoutFeePercent > 100) {
    throw reject('payoutFeePercent must be between 0 and 100.');
  }
  const tokenMinor = Math.round(tokenAmount * 100);
  return Math.floor(tokenMinor * payoutFeePercent / 100);
}

// ═════════════════════════════════════════════════════════════════════════════
// Config-driven gates (read SystemConfig.riskRules — Business Policy owns it)
// ═════════════════════════════════════════════════════════════════════════════

async function getRiskRules() {
  const SystemConfig = mongoose.model('SystemConfig');
  const cfg = await SystemConfig.findOne({ key: 'main' }).select('riskRules payoutFeePercent').lean();
  return {
    // schema default: true (2026-07-09 owner directive — multiples of 10)
    enforceMultiplesOf10: cfg?.riskRules?.enforceMultiplesOf10 ?? true,
    // schema default: false (preserves pre-Phase-010 behavior until enabled)
    blockOppositeSideBetting: cfg?.riskRules?.blockOppositeSideBetting ?? false,
    // schema default: 0 = off
    maxFundingOrdersPerHour: cfg?.riskRules?.maxFundingOrdersPerHour ?? 0,
    // schema default: 0 = no fee
    payoutFeePercent: cfg?.payoutFeePercent ?? 0,
  };
}

export { getRiskRules };

/**
 * assessFundingOrder — full Risk gate for a deposit/withdrawal intent.
 * Called by paymentProcessing (behind the Funding Platform facade).
 */
export async function assessFundingOrder({ userId, tokenAmount, type, min, max }) {
  const rules = await getRiskRules();

  if (type === 'DEPOSIT') {
    validateTokenPurchase({ amount: tokenAmount, min, max, enforceMultiples: rules.enforceMultiplesOf10 });
  } else {
    validateTokenSale({ amount: tokenAmount, min, max, enforceMultiples: rules.enforceMultiplesOf10 });
  }

  // Velocity limit: orders created in the trailing hour (any status —
  // cancellation churn counts as velocity).
  if (rules.maxFundingOrdersPerHour > 0) {
    const PaymentOrder = mongoose.model('PaymentOrder');
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const recent = await PaymentOrder.countDocuments({ userId, createdAt: { $gte: oneHourAgo } });
    if (recent >= rules.maxFundingOrdersPerHour) {
      throw Object.assign(
        new Error(`Too many funding requests — limit is ${rules.maxFundingOrdersPerHour} per hour. Please try later.`),
        { status: 429, code: 'VELOCITY_LIMIT' }
      );
    }
  }
  return true;
}

/**
 * assessBet — full Risk gate for a bet placement.
 * Opposite-side restriction: when enabled, a user with a PENDING bet on one
 * side of a cycle cannot bet the other side of the same cycle (wash-bet /
 * guaranteed-arbitrage prevention).
 */
export async function assessBet({ userId, cycleId, side, amount, min, max }) {
  const rules = await getRiskRules();
  validateBetAmount({ amount, min, max, enforceMultiples: rules.enforceMultiplesOf10 });

  if (rules.blockOppositeSideBetting) {
    const Bet = mongoose.model('Bet');
    const existing = await Bet.findOne({
      userId, cycleId, side: oppositeSide(side), status: 'PENDING', isPhantom: false,
    }).select('_id').lean();
    if (existing) {
      throw Object.assign(
        new Error('You already have a bet on the other side of this cycle — opposite-side betting is not allowed.'),
        { status: 400, code: 'OPPOSITE_SIDE_BLOCKED' }
      );
    }
  }
  return true;
}
