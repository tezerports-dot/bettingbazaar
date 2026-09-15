// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * twoFactorPolicy.js — WHO must hold a second factor.
 *
 * One question, one owner. It lived in `twoFactor.routes.js`, which was fine
 * while only that file asked it. It is now asked by three callers in two
 * directions:
 *
 *   - `auth.middleware.js` refuses an unenrolled staff session (F-011 step 2);
 *   - `routes.js` stamps `mustEnroll2FA` on a login and on `/me`;
 *   - `twoFactor.routes.js` reports it and refuses a disable.
 *
 * The middleware cannot import the routes file — the routes file imports the
 * middleware, and `check:deps` refuses the cycle. Splitting a policy out of a
 * router is the right answer to that rather than duplicating the rule, which
 * §5 names as the thing that drifts silently: two copies of "who is staff"
 * disagreeing is an account the guard treats as ordinary while the rest of the
 * application treats it as an admin.
 */

/**
 * Roles for which 2FA is mandatory rather than optional.
 *
 * Exported because `twoFactor.routes.js` names the same set when it labels an
 * authenticator entry — which account this code belongs to. One list, so the
 * policy and the label cannot describe different sets of people.
 */
export const MANDATORY_2FA_ROLES = new Set(['admin', 'subadmin']);

/**
 * Does this account have to hold a second factor?
 *
 * `isAdmin` / `isSubAdmin` are checked FIRST and are authoritative, because
 * that is what the login handler and route guards actually use to grant
 * privilege. Deriving this from `roles` alone was a real hole: an account with
 * `isAdmin: true` and the default `roles: ['user']` — which is how externally
 * created or older admin documents look — would be reported as non-mandatory
 * and allowed to switch its own 2FA off, while the rest of the application
 * treated it as an admin. The policy has to key on the same field the
 * privilege does, or it is guarding a different account than it thinks.
 */
export function requires2FA(user) {
  if (!user) return false;
  if (user.isAdmin === true || user.isSubAdmin === true) return true;
  const roles = [user.role, ...(user.roles || [])].filter(Boolean);
  return roles.some((r) => MANDATORY_2FA_ROLES.has(String(r).toLowerCase()));
}
