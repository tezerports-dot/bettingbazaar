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
