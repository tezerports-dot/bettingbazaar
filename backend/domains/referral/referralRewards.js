// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * domains/referral/referralRewards.js — what a referral and a first deposit
 * pay into the GENERAL balance, and the one play rule for both, read from the
 * admin's settings (`SystemConfig.referralRewards`, Admin › System Settings ›
 * Referral Rewards; owner, 2026-10-14: "I want those admin editable").
 *
 * A change applies to NEW joiners only. Each earning is stamped with its
 * amount when the joiner verifies (`referral_earnings.amount_paise`), so the
 * people already waiting in the payout queue are paid exactly what they were
 * promised; the turnover a bonus asks is stamped on its grant when it is paid
 * (`promo_grants.required_turnover_paise`).
 */

/**
 * The live numbers, in paise and whole multiples.
 * @param {object|null} cfg  the SystemConfig document (`getSystemConfig()`)
 */
export function referralRewardsFrom(cfg) {
  const r = cfg?.referralRewards ?? {};
  return {
    // What each level earns, level 1 first. schema default: [25, 25]
    // (database/spec/config.spec.js referralRewards.levelRupees)
    levelsPaise: (Array.isArray(r.levelRupees) ? r.levelRupees : [25, 25]).map((v) => Math.round(Number(v) * 100)),
    // schema default: 10 (a bonus is played 10× before it unlocks)
    turnoverMultiplier: Number(r.turnoverMultiplier ?? 10),
  };
}

/**
 * The first deposit bonus, in paise (`SystemConfig.firstDepositBonus`, Admin ›
 * System Settings › First Deposit Bonus; owner, 2026-10-15). 0 = off. Its play
 * requirement is `referralRewardsFrom(cfg).turnoverMultiplier`, the one rule
 * for every General bonus.
 * @param {object|null} cfg  the SystemConfig document (`getSystemConfig()`)
 */
export function firstDepositBonusFrom(cfg) {
  // schema default: 0 (off; database/spec/config.spec.js firstDepositBonus)
  return { amountPaise: Math.round(Number(cfg?.firstDepositBonus?.rupees ?? 0) * 100) };
}
