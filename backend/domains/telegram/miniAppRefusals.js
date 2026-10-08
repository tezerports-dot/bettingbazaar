// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * domains/telegram/miniAppRefusals.js — what a person is told when Telegram's
 * proof is not enough.
 *
 * One table for every route that takes a Mini App proof (the Mini App's own
 * routes and "Login with Telegram"), so the same refusal reads the same
 * wherever it is met (§5). Each sentence says what the reader can do next
 * (§32 S14); the `code` is what a panel branches on (CLAUDE.md §33, the Step 3
 * contract in docs/PROJECT_STATUS.md).
 */
import { INIT_DATA_REFUSAL } from './miniAppAuth.js';

const TABLE = {
  INIT_DATA_INVALID: [400, 'Telegram could not confirm this request. Close the app and open it again from Telegram.'],
  INIT_DATA_STALE: [401, 'This screen has been open too long. Close the app and open it again from Telegram.'],
  INIT_DATA_REPLAYED: [409, 'This request was already used. Close the app and open it again from Telegram.'],
  CONTACT_INVALID: [400, 'Telegram could not confirm the shared contact. Tap "Share contact" again.'],
  CONTACT_REQUIRED: [400, 'Share your contact to continue: Telegram confirms your mobile number with it.'],
  CONTACT_NOT_OWN: [403, 'Share your OWN contact — the one of the Telegram account you are using.'],
  CONTACT_MISMATCH: [403, 'Your Telegram account\'s number is not the mobile number of this account. Use the Telegram account on that number.'],
  TELEGRAM_ALREADY_LINKED: [409, 'This Telegram account already verifies another account on this panel. Use the Telegram account on this account\'s mobile number.'],
  TELEGRAM_NOT_LINKED: [403, 'This account is not linked to a Telegram account yet.'],
  NO_ACCOUNT: [404, 'There is no account with this mobile number on this panel. Sign up first.'],
  NO_LINKED_ACCOUNT: [404, 'No account on this panel is linked to this Telegram account. Sign in with your mobile number and password instead.'],
  ACCOUNT_BLOCKED: [403, 'This account is blocked. Contact support.'],
  ACCOUNT_CLOSED: [403, 'This account has been closed. Contact support.'],
  CHALLENGE_EXPIRED: [410, 'This request has expired. Go back to the website or app and start again.'],
  CHALLENGE_ANSWERED: [409, 'This request was already answered. Go back to the website or app.'],
  MOBILE_TAKEN: [409, 'An account already exists for this mobile number. Sign in on the website or app instead.'],
  DUPLICATE: [409, 'An account already exists for those details. Sign in on the website or app instead.'],
  START_PARAM_INVALID: [400, 'This link is not one the app recognises. Open it again from the website or app.'],
};

/** Repository codes that mean the same thing as a table entry. */
const ALIAS = { NO_CHALLENGE: 'CHALLENGE_EXPIRED' };

/**
 * A refusal for a verifier reason (`INIT_DATA_REFUSAL`) or a repository code.
 *
 * @param {string} reasonOrCode
 * @param {{contact?: boolean}} [o]  the string refused was the shared contact
 * @returns {{status: number, code: string, message: string}}
 */
export function miniAppRefusal(reasonOrCode, { contact = false } = {}) {
  let code = ALIAS[reasonOrCode] || reasonOrCode;
  if (Object.values(INIT_DATA_REFUSAL).includes(reasonOrCode)) {
    if (reasonOrCode === INIT_DATA_REFUSAL.STALE) code = 'INIT_DATA_STALE';
    else code = contact ? 'CONTACT_INVALID' : 'INIT_DATA_INVALID';
  }
  const [status, message] = TABLE[code] || [400, 'That request could not be accepted.'];
  return { status, code, message };
}
