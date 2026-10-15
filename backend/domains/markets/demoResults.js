// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Demo results in the analytics (owner, 2026-10-15).
 *
 * Until a board has a full analytics window of real results, the player app
 * fills the rest of the window with demo results placed BEFORE the oldest real
 * one, so every tab shows a full 1,440. Each real result that arrives pushes
 * the oldest demo result out; once the window is all real, no demo is shown.
 *
 * Demo results are display only: never a cycle, a bet or a payout, never in
 * the Results list, the cycle-history feed or any server figure. The winners
 * are drawn by `redesign/demoResults.ts` in the player app (§11), the same
 * for every player, faded and named nowhere on screen; the admin says so in
 * the board rules (owner, 2026-10-15). `SystemConfig.demoResultsOn` switches
 * them off.
 */

/** The schema default of `SystemConfig.demoResultsOn`. */
export const DEFAULT_DEMO_RESULTS_ON = true;

/** Whether demo results are shown. */
export function demoResultsOnOf(cfg) {
  return typeof cfg?.demoResultsOn === 'boolean' ? cfg.demoResultsOn : DEFAULT_DEMO_RESULTS_ON;
}
