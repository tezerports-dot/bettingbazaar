// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file.
/**
 * domains/referral/referralRewards.js — the programme's fixed numbers.
 *
 * A constant, not a configuration value: the reward is what the programme
 * PROMISED the people already in the queue, and a queue whose reward can be
 * edited while people wait in it is not a queue they can rely on. Changing it
 * is a new programme, with its own budget and its own announcement.
 */

/** ₹25, in paise. Integer, because money is integer paise everywhere. */
export const REFERRAL_REWARD_PAISE = 2500;

/** Levels paid, in the order they settle within one signup. */
export const REFERRAL_LEVELS = Object.freeze([1, 2]);
