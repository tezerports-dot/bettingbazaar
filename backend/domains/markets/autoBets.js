// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * autoBets.js — the rules of a player's auto bets (owner, 2026-10-22).
 *
 * A plan is one board, one profile (VIP or GENERAL: each has its own) and one
 * side, and a progression: a first bet, multiplied after each loss, for 1 to
 * `AUTO_LADDER_STEPS_MAX` steps. One bet per round, placed by the cycle
 * generator (`runPlayerAutoBets`) through the same checks as a bet the player
 * taps (`playerBet.service.js`). A win starts the ladder again from the first
 * step; losing the last step also starts it again (the ladder "ran out").
 *
 * The plan stops on its own, before a bet, when
 *   • its net reaches the take-profit             TAKE_PROFIT
 *   • its net falls to minus the stop-loss         STOP_LOSS
 *   • the next stake is more than the budget has left (budget + net)  BUDGET_USED
 * and when a bet the player could not have placed either is refused (balance,
 * board switched off, profile switched, rules not accepted). The player can
 * stop it at any time.
 *
 * Its step and its net are counted from its bets on every read, never kept
 * (trap 6). The stakes are worked out once, when the plan starts, and stored
 * with it, so a later change of config cannot change a running plan.
 *
 * Everything here is pure; the one writer is
 * database/repositories/playerAutoBets.js. The player app mirrors
 * `ladderStakes` and `stopBefore` for its backtest (redesign/analytics.ts).
 */

/** Steps a ladder may have; more only multiplies the loss. Mirrored as LADDER_MAX_STEPS (analytics.ts). */
export const AUTO_LADDER_STEPS_MAX = 12;
/** The multiplier after a loss, in hundredths: 1.00× to 10.00×. */
export const AUTO_FACTOR_MIN_X100 = 100;
export const AUTO_FACTOR_MAX_X100 = 1000;
/** The most a plan's budget, stop-loss or take-profit may be, in rupees. */
export const AUTO_MONEY_MAX_RUPEES = 10_000_000;

/** Why a plan stopped. PLAYER: the player pressed Stop. */
export const AUTO_STOP_REASONS = Object.freeze([
  'PLAYER', 'TAKE_PROFIT', 'STOP_LOSS', 'BUDGET_USED',
  'BALANCE_SHORT', 'STAKE_OUT_OF_RANGE', 'BOARD_OFF', 'PROFILE_SWITCHED', 'RULES_NOT_ACCEPTED',
]);

/** What the player is told for each reason (the app shows it as sent). */
export const AUTO_STOP_TEXT = Object.freeze({
  PLAYER: 'You stopped it.',
  TAKE_PROFIT: 'Take-profit reached.',
  STOP_LOSS: 'Stop-loss reached.',
  BUDGET_USED: 'The budget left could not cover the next bet.',
  BALANCE_SHORT: 'Your balance could not cover the next bet.',
  STAKE_OUT_OF_RANGE: "The next bet was outside this board's bet limits.",
  BOARD_OFF: 'This board was switched off.',
  PROFILE_SWITCHED: 'You switched profile, so this plan stopped.',
  RULES_NOT_ACCEPTED: 'The board rules changed. Accept them, then start again.',
});

const bad = (message) => Object.assign(new Error(message), { status: 400, code: 'AUTO_BETS_INVALID' });

/**
 * The ladder's stakes in rupees: `start`, then each `factorX100`/100 times the
 * last, rounded to a whole `unit` (the bet step, betStep.js) and never below
 * one unit. Computed from the first stake, not the last rounded one, so the
 * rounding does not compound.
 */
export function ladderStakes(startRupees, factorX100, steps, unit) {
  const f = factorX100 / 100;
  const out = [];
  for (let k = 0; k < steps; k++) out.push(Math.max(unit, Math.round((startRupees * f ** k) / unit) * unit));
  return out;
}

/** The step to bet next, from the losses in a row since the plan's last win. */
export const stepOf = (lossesInARow, steps) => lossesInARow % steps;

/**
 * Whether the plan stops before staking `stakePaise` with `netPaise` won or
 * lost so far. A stop-loss or take-profit of 0 is not set.
 */
export function stopBefore({ netPaise, stakePaise, stopLossPaise, takeProfitPaise, budgetPaise }) {
  if (takeProfitPaise > 0 && netPaise >= takeProfitPaise) return 'TAKE_PROFIT';
  if (stopLossPaise > 0 && netPaise <= -stopLossPaise) return 'STOP_LOSS';
  if (stakePaise > budgetPaise + netPaise) return 'BUDGET_USED';
  return null;
}

/**
 * What a refused bet means for the plan: the reason it stops, or null to try
 * again next round (betting closed under it, or the player bet the other side
 * of this round themselves).
 */
export function stopForRefusal(code) {
  switch (code) {
    case 'STAKE_EXCEEDS_FUNDABLE': case 'INSUFFICIENT_BALANCE': return 'BALANCE_SHORT';
    case 'BOARD_SWITCHED_OFF': return 'BOARD_OFF';
    case 'WRONG_PROFILE_FOR_CYCLE': return 'PROFILE_SWITCHED';
    case 'BOARD_RULES_NOT_ACCEPTED': return 'RULES_NOT_ACCEPTED';
    // assessBet's (riskValidation.service.js): the stake against the board's bounds and step.
    case 'RISK_VALIDATION': case 'MULTIPLE_OF_10': return 'STAKE_OUT_OF_RANGE';
    // BETTING_CLOSED, OPPOSITE_SIDE_BLOCKED, CYCLE_NOT_FOUND and anything
    // unforeseen: this round is skipped and the next one tried.
    default: return null;
  }
}

const wholeRupees = (v, label, { min = 0, required = false } = {}) => {
  if (v === undefined || v === null || v === '') {
    if (required) throw bad(`Enter ${label}.`);
    return 0;
  }
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > AUTO_MONEY_MAX_RUPEES) {
    throw bad(`${label[0].toUpperCase()}${label.slice(1)} must be a whole number of rupees from ${min} to ${AUTO_MONEY_MAX_RUPEES.toLocaleString('en-IN')}.`);
  }
  return n;
};

/**
 * A plan as the player typed it, checked whole against the board it is for
 * and the bet step. Throws a 400 naming the first thing wrong; answers the
 * plan in paise with its stakes worked out.
 */
export function normalisePlan(body, board, unit) {
  const side = body?.side;
  if (side !== 'DELHI' && side !== 'BOMBAY') throw bad('Pick Delhi or Bombay.');
  const steps = Number(body?.steps);
  if (!Number.isInteger(steps) || steps < 1 || steps > AUTO_LADDER_STEPS_MAX) throw bad(`Steps must be from 1 to ${AUTO_LADDER_STEPS_MAX}.`);
  const factorX100 = Math.round(Number(body?.factor) * 100);
  if (!Number.isFinite(factorX100) || factorX100 < AUTO_FACTOR_MIN_X100 || factorX100 > AUTO_FACTOR_MAX_X100) {
    throw bad('The multiplier must be from 1 to 10.');
  }
  const start = Number(body?.start);
  if (!Number.isInteger(start) || start % unit !== 0) throw bad(`The first bet must be a whole multiple of ₹${unit}.`);
  if (start < board.minBet) throw bad(`The first bet must be at least this board's smallest bet, ₹${board.minBet}.`);
  const stakes = ladderStakes(start, factorX100, steps, unit);
  const over = stakes.findIndex((s) => s > board.maxBet);
  if (over !== -1) {
    throw bad(`Step ${over + 1} would be ₹${stakes[over].toLocaleString('en-IN')}, above this board's largest bet of ₹${board.maxBet.toLocaleString('en-IN')}. Use fewer steps or a smaller multiplier.`);
  }
  const budget = wholeRupees(body?.budget, 'a budget', { min: 1, required: true });
  if (budget < stakes[0]) throw bad('The budget must cover at least the first bet.');
  const stopLoss = wholeRupees(body?.stopLoss, 'the stop-loss');
  const takeProfit = wholeRupees(body?.takeProfit, 'the take-profit');
  return {
    side, steps, factorX100,
    startPaise: start * 100,
    stakesPaise: stakes.map((s) => s * 100),
    budgetPaise: budget * 100,
    stopLossPaise: stopLoss * 100,
    takeProfitPaise: takeProfit * 100,
  };
}

/** The idempotency key of a plan's bet on one round: a plan bets a round once. */
export const autoBetId = (planId, cycleId) => `auto_${planId}_${cycleId}`;
