// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The tag a curated winners entry carries on the player's Winners page (owner,
 * 2026-10-22: "make the name editable for demo from admin panel"). It is
 * `SystemConfig.winnersDemoLabel`, admin-editable but never blank, held to
 * WINNERS_DEMO_LABEL_LIMITS on save, and sent with the feed
 * (`GET /api/v1/winners`, `demoLabel`) so the app keeps no copy.
 */

/** The default tag, and the schema default of `SystemConfig.winnersDemoLabel`. */
export const DEFAULT_WINNERS_DEMO_LABEL = 'Demo';

export const WINNERS_DEMO_LABEL_LIMITS = { minLength: 2, maxLength: 16 };

/** The tag as players are shown it: the saved one, or the default. Never blank. */
export function winnersDemoLabelOf(cfg) {
  const saved = typeof cfg?.winnersDemoLabel === 'string' ? cfg.winnersDemoLabel.trim() : '';
  return saved.length >= WINNERS_DEMO_LABEL_LIMITS.minLength ? saved : DEFAULT_WINNERS_DEMO_LABEL;
}
