// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * betStep.js — what every bet must be a whole multiple of: 10 while
 * `SystemConfig.riskRules.enforceMultiplesOf10` is on (the schema default), else 1.
 * The rule `validateBetAmount` enforces (riskValidation.service.js), said as a
 * number so the player app's ladders and the auto bets' stakes
 * (markets/autoBets.js) round to what a bet may be. Sent as `betMultipleOf`
 * (systemConfigPayload.js).
 */
export function betMultipleOf(cfg) {
  // schema default: true (config.spec.js riskRules.enforceMultiplesOf10)
  return (cfg?.riskRules?.enforceMultiplesOf10 ?? true) ? 10 : 1;
}
