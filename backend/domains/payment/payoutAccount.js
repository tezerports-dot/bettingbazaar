// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * A bank account whose number is somebody's mobile is refused (§24, Step 2d).
 *
 * The rule itself is the database's (`bb_account_number_is_a_mobile` and the
 * two CHECKs in `database/schema.sql`), so it holds for every writer. This
 * module only turns the refusal into a sentence the person saving the account
 * can act on, the same sentence on every path that saves one: a player's bank
 * details, a member's profile, and a member's signup.
 *
 * Why: the member's account is shown to the player on a bank-transfer buy and
 * the player's to the member on a sell, and the owner's rule (2026-10-03) is
 * that nobody is shown anyone's mobile number. Payments banks use the mobile
 * as the account number.
 */

/** The CHECKs that refuse such an account, by table. */
export const ACCOUNT_IS_A_MOBILE_CONSTRAINTS = Object.freeze([
  'merchants_bank_account_not_a_mobile',
  'users_bank_account_not_a_mobile',
  // A merchant account's payment accounts (owner, 2026-10-11), the UPI
  // handle's name part and payee name included.
  'merchant_payment_accounts_not_a_mobile',
]);

export const ACCOUNT_IS_A_MOBILE_MESSAGE =
  'Those bank details contain a mobile number: an account number that is a mobile (payments banks such as '
  + 'Paytm, Airtel and Jio use your mobile as the account number), or a number in the name. The other side '
  + 'of an order sees these details, so they cannot be used. Use an account at a regular bank, and the name '
  + 'as the bank has it.';

/** Whether a database error is that refusal. */
export function isAccountMobileRefusal(error) {
  return error?.code === '23514' && ACCOUNT_IS_A_MOBILE_CONSTRAINTS.includes(error.constraint);
}

/**
 * A player's UPI ID (owner, 2026-10-21): the member paying a sell is shown a
 * link built from it, so its name part may not be a mobile. The rule is the
 * row's (`users_upi_id_shape`, schema.sql); this is the same pattern, asked
 * first so a mistyped ID is told apart from a mobile one.
 */
export const UPI_ID_PATTERN = /^[A-Za-z0-9._-]{2,255}@[A-Za-z][A-Za-z0-9.-]{1,64}$/;

export const UPI_ID_INVALID_MESSAGE =
  'That is not a UPI ID. It looks like name@bank, for example rahul.k@okaxis.';

export const UPI_ID_IS_A_MOBILE_MESSAGE =
  'That UPI ID is your mobile number. The merchant paying your sell sees your UPI ID, and nobody is shown '
  + 'anyone\'s mobile number, so it cannot be used. Make a UPI ID that is not your mobile number in your '
  + 'UPI app (most apps let you choose one), and save that.';

export const MEMBER_UPI_ID_IS_A_MOBILE_MESSAGE =
  'That UPI ID is your mobile number. Players paying you by UPI are given a link with your UPI ID in it, and '
  + 'nobody is shown anyone\'s mobile number, so it cannot be used. Make a UPI ID that is not your mobile '
  + 'number in your UPI app, and save that.';

/**
 * The refusals of a save of a player's payout details, phrased for the player:
 * a mobile in the account or the UPI ID, and the lock (schema.sql "PAYOUT
 * DETAILS LOCK"): 48 hours after a save, and while an order is open. Null when
 * the error is none of them.
 */
export function payoutDetailsRefusal(error, lockedUntil = null) {
  if (error?.code !== '23514') return null;
  if (ACCOUNT_IS_A_MOBILE_CONSTRAINTS.includes(error.constraint)) {
    return { status: 400, code: 'ACCOUNT_IS_A_MOBILE', message: ACCOUNT_IS_A_MOBILE_MESSAGE };
  }
  if (error.constraint === 'users_upi_id_shape') {
    return { status: 400, code: 'UPI_ID_IS_A_MOBILE', message: UPI_ID_IS_A_MOBILE_MESSAGE };
  }
  if (error.constraint === 'users_payout_details_locked') {
    return {
      status: 409, code: 'PAYOUT_DETAILS_LOCKED', lockedUntil,
      message: 'Your bank details and UPI ID were saved less than 48 hours ago, so they cannot be changed yet. '
             + 'You can change them after the time shown.',
    };
  }
  if (error.constraint === 'users_payout_details_in_use') {
    return {
      status: 409, code: 'PAYOUT_DETAILS_IN_USE',
      message: 'You have an order in progress, and it uses these details. You can change them once it is finished.',
    };
  }
  return null;
}
