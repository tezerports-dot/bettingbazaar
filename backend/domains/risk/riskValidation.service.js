// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
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
// placeholders — see CLAUDE.md): AML screening, fraud-signal
// scoring, device risk, behaviour analysis, responsible-gaming limits.

import { db } from '#db';
// Shared trading vocabulary (Phase 011) — canonical sides, no local strings.
import { oppositeSide } from '../trading/tradingModels.js';
import { getSystemConfig } from '#db/repositories/config.js';
import { MERCHANT_CURRENCY } from '../merchant/merchantCurrency.js';
import {
  offeredSizes, railForSize, usdtBuyBounds, isUsdtBuyAmount, USDT_BUY_STEP,
} from '../merchant/denominations.js';
// The bet-funding rule's arithmetic: one copy, which a casino BET applies too.
import { reserveBasisPoints, splitStakeMinor, maxStakeMinor } from './stakeFunding.js';

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
 * validateBetAmount — a pure rule core. Limits come from the caller (read from
 * SystemConfig — Business Policy owns the numbers); enforceMultiples comes from
 * riskRules config. Buys and sells have no min/max any more: an INR order is
 * one of the sizes on offer and a USDT buy is a step of USDT (Step 2d), both
 * judged by `assessFundingOrder` below.
 */
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

/**
 * computeBetFundingPlan — THE bet-funding rule (Phase A, 2026-07-10).
 * Splits a bet stake into reserve/deposit/winnings deductions at paise
 * precision. Replaces the hardcoded Math.round(amount*0.97)/(amount*0.03)
 * pair in bet.routes.js, which (a) wasn't admin-editable, (b) rounded the
 * intended 9.7/0.3 of a ₹10 bet to 10/0, and (c) could over-deduct — a ₹50
 * bet rounded to 49 + 2 = ₹51 taken for a ₹50 stake.
 *
 * Rules implemented (owner specification §6):
 *   - reservePercent of the stake comes from reserveBalance; the remainder
 *     ("main") from depositBalance first, then winningsBalance as overflow.
 *   - Fallbacks: reserve short → shortfall shifts to main (Spec 5.2C);
 *     deposit short → overflow to winnings.
 *   - Percent is owned by SystemConfig.betReservePercent (Business Policy);
 *     this function is only the arithmetic rule.
 *
 * Precision (decided 2026-07-10, see CLAUDE.md): PAISE.
 * All arithmetic is integer paise with the percent in integer basis points,
 * so the three parts ALWAYS conserve the exact stake (reserve is floored,
 * remainder to main — same discipline as computeReserveSplit). Wallet
 * balances already hold 2-decimal values (walletAuthority round2s every
 * mutation; F1 commissions credit fractions), so fractional deductions are
 * consistent with the existing wallet convention.
 *
 * Drain safety: when a bucket is emptied, the returned deduction is the
 * caller-supplied available value ITSELF (bit-identical float), so the
 * atomic `$gte` guard in bet.routes.js can never spuriously fail against a
 * stored balance that carries float representation error.
 *
 * Throws INSUFFICIENT_BALANCE if the three buckets can't cover the stake.
 */
export function computeBetFundingPlan({ amount, reservePercent, availableDeposit, availableWinnings, availableReserve }) {
  assertPositiveNumber(amount, 'Bet amount');
  if (typeof reservePercent !== 'number' || !Number.isFinite(reservePercent) ||
      reservePercent < 0 || reservePercent > 100) {
    throw reject('betReservePercent must be between 0 and 100.');
  }
  const availDep = Math.max(0, availableDeposit  || 0);
  const availWin = Math.max(0, availableWinnings || 0);
  const availRes = Math.max(0, availableReserve  || 0);

  const amountMinor = Math.round(amount * 100);
  const reserveBp   = reserveBasisPoints(reservePercent);

  const availDepMinor = Math.round(availDep * 100);
  const availWinMinor = Math.round(availWin * 100);
  const availResMinor = Math.round(availRes * 100);

  if (availDepMinor + availWinMinor + availResMinor < amountMinor) {
    throw reject(
      `Insufficient balance. Available: ₹${((availDepMinor + availWinMinor + availResMinor) / 100)}`,
      'INSUFFICIENT_BALANCE'
    );
  }

  // The split itself is `splitStakeMinor` (stakeFunding.js): the reserve share
  // floored, its shortfall shifted to main (Spec 5.2C); main from deposit
  // first, winnings as overflow. A casino BET applies the same function.
  const split = splitStakeMinor({
    amountMinor, reserveBp,
    depositMinor: availDepMinor, winningsMinor: availWinMinor, reserveMinor: availResMinor,
  });
  if (!split) {
    // The reserve can fund only its share, so the total above can pass while
    // deposit + winnings still fall short of the main part.
    throw reject('Insufficient balance for this bet.', 'INSUFFICIENT_BALANCE');
  }
  const { fromReserveMinor, fromDepositMinor, fromWinningsMinor } = split;

  // Drained bucket → return the caller's float verbatim (see doc comment).
  const fromReserve  = fromReserveMinor  === availResMinor ? availRes : fromReserveMinor  / 100;
  const fromDeposit  = fromDepositMinor  === availDepMinor ? availDep : fromDepositMinor  / 100;
  const fromWinnings = fromWinningsMinor === availWinMinor ? availWin : fromWinningsMinor / 100;

  return {
    fromDeposit, fromWinnings, fromReserve,
    fromDepositMinor, fromWinningsMinor, fromReserveMinor,
    reservePercentApplied: reserveBp / 100,
  };
}

/**
 * computeMaxStake — the largest bet these balances can actually fund.
 *
 * ── The bug this exists for ─────────────────────────────────────────────────
 * The wallet showed a single total and `bet.routes.js` pre-checked against
 * `deposit + winnings + reserve`. Both are wrong, because the reserve is NOT
 * freely spendable: only `reservePercent` of a stake may come from it, and the
 * REST must come from deposit+winnings. Reserve shortfall shifts to main
 * (Spec 5.2C); main shortfall has nowhere to go.
 *
 * So a player holding ₹100 deposit, ₹100 winnings and ₹800 reserve was shown
 * "₹1,000 available", tried to bet ₹500, passed the total pre-check, and was
 * then refused by `computeBetFundingPlan` with the message
 * "Insufficient balance. Available: ₹1000" — telling them they had the money
 * while refusing to take it. At 3% their true maximum is ₹206.18.
 *
 * ── Why a search rather than algebra ────────────────────────────────────────
 * `A − floor(A·bp/10000)` is monotonic but not invertible in closed form once
 * the floor and the `min(reserveTarget, availRes)` clamp are both in play, and
 * the regimes cross over at `availRes·10000/bp`. A closed form would need three
 * cases and would be the kind of arithmetic that is subtly wrong at the
 * boundary — which is exactly where it matters, because the boundary is the
 * number shown to the player. Monotonicity makes a binary search exact in ~40
 * integer steps, and it reuses the same expression the funding plan applies.
 *
 * @returns {{maxStakeMinor: number, maxStake: number, reservePercentApplied: number}}
 */
export function computeMaxStake({ reservePercent, availableDeposit, availableWinnings, availableReserve }) {
  if (typeof reservePercent !== 'number' || !Number.isFinite(reservePercent) ||
      reservePercent < 0 || reservePercent > 100) {
    throw reject('betReservePercent must be between 0 and 100.');
  }
  const availDepMinor = Math.round(Math.max(0, availableDeposit  || 0) * 100);
  const availWinMinor = Math.round(Math.max(0, availableWinnings || 0) * 100);
  const availResMinor = Math.round(Math.max(0, availableReserve  || 0) * 100);

  const reserveBp = reserveBasisPoints(reservePercent);
  // `maxStakeMinor` (stakeFunding.js) searches with the same expression the
  // split applies; a casino provider is told the same ceiling.
  const ceilingMinor = maxStakeMinor({
    reserveBp, depositMinor: availDepMinor, winningsMinor: availWinMinor, reserveMinor: availResMinor,
  });

  return {
    maxStakeMinor: ceilingMinor,
    maxStake: ceilingMinor / 100,
    reservePercentApplied: reserveBp / 100,
  };
}

/**
 * computeWinningsPayout — THE settlement payout rule (Phase A, 2026-07-10).
 * Winning bets pay gross = stake × multiplier (2x), minus the platform fee
 * on winnings (owner spec §6: bet 100 → win 200 → ~2 fee → 198 net).
 * The PERCENT is owned by SystemConfig.winningsFeePercent (Business Policy);
 * this is only the arithmetic rule, used by markets/gameEngine.js.
 *
 * Paise-exact: integer paise + integer basis points; the fee is FLOORED so
 * the platform never rounds up against the user; net + fee always equals
 * gross exactly. The fee itself never touches a wallet — winners are
 * credited net, so the retained fee lands in Cycle.netProfit and flows to
 * PLATFORM_REVENUE through the existing BET_CYCLE_SETTLED ledger posting.
 */
export function computeWinningsPayout({ amount, feePercent, multiplier = 2 }) {
  assertPositiveNumber(amount, 'Bet amount');
  if (typeof feePercent !== 'number' || !Number.isFinite(feePercent) ||
      feePercent < 0 || feePercent > 100) {
    throw reject('winningsFeePercent must be between 0 and 100.');
  }
  if (!Number.isInteger(multiplier) || multiplier <= 0) {
    throw reject('Payout multiplier must be a positive integer.');
  }
  const amountMinor = Math.round(amount * 100);
  const grossMinor  = amountMinor * multiplier;
  const feeBp       = Math.round(feePercent * 100); // percent → integer basis points
  const feeMinor    = Math.floor(grossMinor * feeBp / 10000);
  const netMinor    = grossMinor - feeMinor;
  return {
    gross: grossMinor / 100, fee: feeMinor / 100, net: netMinor / 100,
    grossMinor, feeMinor, netMinor,
    feePercentApplied: feeBp / 100,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// Config-driven gates (read SystemConfig.riskRules — Business Policy owns it)
// ═════════════════════════════════════════════════════════════════════════════

async function getRiskRules() {
  const cfg = await getSystemConfig();
  return {
    // schema default: true (2026-07-09 owner directive — multiples of 10)
    enforceMultiplesOf10: cfg?.riskRules?.enforceMultiplesOf10 ?? true,
    // schema default: false (preserves pre-Phase-010 behavior until enabled)
    blockOppositeSideBetting: cfg?.riskRules?.blockOppositeSideBetting ?? false,
    // schema default: 0 = off
    maxFundingOrdersPerHour: cfg?.riskRules?.maxFundingOrdersPerHour ?? 0,
    // schema default: 3 — mark a flagged player for review at N payment
    // warnings (0 = never). This used to auto-block on a merchant rejection;
    // the block is an admin decision now and this is the review threshold.
    maxWarnings: cfg?.riskRules?.maxWarnings ?? 3,
    // schema default: 0 = no fee
    payoutFeePercent: cfg?.payoutFeePercent ?? 0,
    // schema default: 1 (Phase A owner spec — 1% platform fee on winnings)
    winningsFeePercent: cfg?.winningsFeePercent ?? 1,
    // schema default: 1 — % of each bet stake drawn from reserveBalance
    betReservePercent: cfg?.betReservePercent ?? 1,
    // schema default: 2 (2x payout; Business Config Audit 2026-07-11)
    payoutMultiplier: cfg?.payoutMultiplier ?? 2,
  };
}

export { getRiskRules };

/**
 * assessFundingOrder — full Risk gate for a deposit/withdrawal intent.
 * Called by paymentProcessing (behind the Funding Platform facade).
 *
 * ── What a player may order, enforced on the SERVER ────────────────────────
 * The player app ships as an Android build, and a Capacitor APK contains the
 * whole JavaScript bundle: anyone who unzips it can send whatever body they
 * like. A rule that lives only in a picker is a suggestion, so the sizes are
 * judged here, from the same module and the same config row the picker is
 * built from (`systemConfigPayload`).
 *
 * ── The rules (owner, 2026-10-02; Step 2d) ─────────────────────────────────
 * 1. **An INR order, buy or sell, is one of the sizes on offer.** Seven fixed
 *    sizes exist (`denominations.js`); the admin chooses which are offered
 *    (`SystemConfig.orderSizes`). The size decides the rail: 500 to 10,000 is
 *    paid in cash at a machine, 50,000 and up by bank transfer. One size per order,
 *    no splitting, so an amount between sizes is unservable by construction.
 * 2. **A USDT buy is a whole number of 100 USDT** between the admin's minimum
 *    and maximum (`SystemConfig.usdtBuy`). There is no USDT sell.
 * 3. **One open buy per currency at a time.** Two at once would let one player
 *    occupy several members' capacity during a shortage.
 *
 * Every refusal is a 400 (or 409) that names what the player CAN choose (§25):
 * a player told only "invalid amount" tries again and again.
 */
function sizesLabel(sizes) {
  return sizes.map((t) => t.toLocaleString('en-IN')).join(', ');
}

function assertSizeIsOffered({ tokenAmount, type, cfg }) {
  const offered = offeredSizes(cfg);
  const verb = type === 'DEPOSIT' ? 'buy' : 'sell';
  // The first thing checked because it is the first thing used, and a caller's
  // mistake: a missing or non-numeric amount is a 400 that names the sizes,
  // never a TypeError answered as a 500 (S35).
  if (typeof tokenAmount !== 'number' || !Number.isFinite(tokenAmount) || tokenAmount <= 0) {
    throw Object.assign(new Error(`Choose an amount to ${verb}: ${sizesLabel(offered)} tokens.`),
      { status: 400, code: 'AMOUNT_REQUIRED' });
  }
  if (!offered.includes(tokenAmount)) {
    // A size that exists but is switched off is told apart from a number that
    // is not a size at all, so the sentence is true either way.
    const why = railForSize(tokenAmount)
      ? `${tokenAmount.toLocaleString('en-IN')} tokens is not on offer right now.`
      : `${tokenAmount.toLocaleString('en-IN')} tokens is not an order size.`;
    throw Object.assign(new Error(`${why} Choose one of ${sizesLabel(offered)} tokens.`),
      { status: 400, code: 'NOT_AN_ORDER_SIZE', sizes: offered });
  }
}

async function assertBuyIsLegal({ userId, tokenAmount, usdtAmount, currency, cfg }) {
  if (currency === MERCHANT_CURRENCY.USDT) {
    // ── The USDT rail: whole steps of USDT, inside the admin's bounds ─────
    // Priced in what the player SENDS; the tokens they receive follow from the
    // admin's rate (`tokensForUsdt`).
    const bounds = usdtBuyBounds(cfg);
    if (!isUsdtBuyAmount(usdtAmount, bounds)) {
      throw Object.assign(
        new Error(`A USDT purchase is ${bounds.min.toLocaleString('en-IN')} to ${bounds.max.toLocaleString('en-IN')} USDT, `
          + `in steps of ${USDT_BUY_STEP}.`),
        { status: 400, code: 'NOT_A_USDT_AMOUNT', usdt: { min: bounds.min, max: bounds.max, step: USDT_BUY_STEP } },
      );
    }
  } else {
    assertSizeIsOffered({ tokenAmount, type: 'DEPOSIT', cfg });
  }

  const open = await db.orders.countOpenDeposits(userId, { currency });
  if (open > 0) {
    throw Object.assign(
      new Error(currency === MERCHANT_CURRENCY.USDT
        ? 'You already have a USDT purchase in progress. Finish or cancel it before starting another.'
        : 'You already have a purchase in progress. Finish or cancel it before starting another.'),
      { status: 409, code: 'BUY_ALREADY_OPEN' },
    );
  }
}

export async function assessFundingOrder({
  userId, tokenAmount, type,
  // What the order settles in, and on USDT the USDT it is priced in. Gated
  // HERE rather than in the handler: this is the single validation authority.
  currency = 'INR', usdtAmount = null,
}) {
  const cfg = await getSystemConfig();
  const rules = await getRiskRules();

  if (type === 'DEPOSIT') {
    await assertBuyIsLegal({ userId, tokenAmount, usdtAmount, currency, cfg });
  } else {
    assertSizeIsOffered({ tokenAmount, type: 'WITHDRAWAL', cfg });
  }

  // Velocity limit: orders created in the trailing hour (any status —
  // cancellation churn counts as velocity).
  if (rules.maxFundingOrdersPerHour > 0) {
    // The window is the DATABASE's hour, not this instance's. Several app
    // servers each subtracting an hour from their own clock disagree by however
    // far those clocks have drifted, and this decides whether a player is
    // refused.
    const recent = await db.orders.countRecentOrders(userId, { withinMinutes: 60 });
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
    // `side <> $3` in the query rather than `oppositeSide(side)` here: with two
    // sides they agree, and the query keeps agreeing if a third is ever added,
    // where a helper returning one "opposite" would quietly stop guarding.
    if (await db.bets.hasOppositeSideBet({ userId, cycleId, side })) {
      throw Object.assign(
        new Error('You already have a bet on the other side of this cycle — opposite-side betting is not allowed.'),
        { status: 400, code: 'OPPOSITE_SIDE_BLOCKED' }
      );
    }
  }
  return true;
}
