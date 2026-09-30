// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * domains/identity/audiences.js — what each audience is CALLED.
 *
 * `ACCOUNT_TYPES` (database/repositories/users.js) owns the VALUES; this owns
 * the words a person reads. Two different values, so two owners — and keeping
 * them apart is the point: the database's vocabulary must not drift because
 * somebody renamed a label on a screen, and a label must not be spelt three
 * ways because three routes each wrote their own.
 *
 * It exists because of one sentence. The channel-replacement route answered
 * "Every player will be asked to join the new channel" whatever panel the
 * operator had just flipped — which on the merchant screen is the sentence that
 * makes somebody believe they flipped the wrong one and flip it back. §32 S14:
 * a message a person cannot act on, on a screen where the action is expensive.
 */
export { ACCOUNT_TYPES } from '#db/repositories/users.js';

/** The panel, named as the admin panel's own navigation names it. */
export const PANEL_NAME = {
  PLAYER: 'user',
  MERCHANT: 'merchant',
  STAFF: 'admin',
};

/** The people on it, singular, for "every ___ will be asked to…". */
export const PANEL_NOUN = {
  PLAYER: 'player',
  MERCHANT: 'merchant',
  STAFF: 'staff member',
};
