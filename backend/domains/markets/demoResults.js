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
 * for every player. Wherever one is shown the line below is shown with it:
 * `SystemConfig.demoResultsLabel`, admin-editable but never blank (held to
 * DEMO_RESULTS_LABEL_LIMITS on save); `SystemConfig.demoResultsOn` switches
 * them off.
 */

/** The schema default of `SystemConfig.demoResultsOn`. */
export const DEFAULT_DEMO_RESULTS_ON = true;

/** The default line, and the schema default of `SystemConfig.demoResultsLabel`. */
export const DEFAULT_DEMO_RESULTS_LABEL = 'Includes demo results shown before the first real results. Each new real result replaces the oldest demo one.';

export const DEMO_RESULTS_LABEL_LIMITS = { minLength: 10, maxLength: 160 };

/** The line as players are shown it: the saved one, or the default. Never blank. */
export function demoResultsLabelOf(cfg) {
  const saved = typeof cfg?.demoResultsLabel === 'string' ? cfg.demoResultsLabel.trim() : '';
  return saved.length >= DEMO_RESULTS_LABEL_LIMITS.minLength ? saved : DEFAULT_DEMO_RESULTS_LABEL;
}

/** Whether demo results are shown. */
export function demoResultsOnOf(cfg) {
  return typeof cfg?.demoResultsOn === 'boolean' ? cfg.demoResultsOn : DEFAULT_DEMO_RESULTS_ON;
}
