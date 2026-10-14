// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Break-glass: give a STAFF account back to its owner when nobody can sign in
 * as it — the only admin lost their phone AND their recovery codes, or forgot
 * their password (owner, 2026-10-13: staff sign in with mobile, password and
 * an authenticator app; there is no Telegram reset for staff).
 *
 *   node scripts/reset-staff-access.mjs --mobile 9876543210
 *   NEW_STAFF_PASSWORD='…' node scripts/reset-staff-access.mjs --mobile 9876543210
 *
 * What it does, in ONE transaction (`db.totp.reset`): forgets the account's
 * authenticator and its recovery codes, ends every session it holds, and —
 * when NEW_STAFF_PASSWORD is set — replaces its password. The next sign-in
 * enrols a new authenticator. Recorded in the audit trail as
 * STAFF_ACCESS_RESET_CLI.
 *
 * The new password comes from the ENVIRONMENT, never an argument: argv is
 * readable by every user on the host (/proc) and lands in shell history. It is
 * checked against the staff password policy BEFORE anything changes.
 *
 * Whoever can run this holds the server and its DATABASE_URL, which is already
 * every account; it is a recovery tool, not a new door.
 */
import { pathToFileURL } from 'node:url';
import { db } from '#db';
import { closePg } from '#db/client.js';
import { hashPassword } from '../backend/domains/identity/password.util.js';
import { assertStaffPassword } from '../backend/domains/identity/passwordPolicy.js';
import { normalisePhone } from '../backend/domains/identity/signupFields.js';

/**
 * @param {object} o
 * @param {string} o.mobile
 * @param {string|null} [o.newPassword]
 * @returns {Promise<{ok: true, userId: string, hadAuthenticator: boolean, passwordChanged: boolean}
 *                 | {ok: false, reason: string}>}
 */
export async function resetStaffAccess({ mobile, newPassword = null }) {
  const number = normalisePhone(mobile) || String(mobile || '').trim();
  if (!number) return { ok: false, reason: 'Give the staff account\'s mobile: --mobile <number>' };
  const user = await db.users.getUserByMobile(number, 'STAFF');
  if (!user) return { ok: false, reason: `No staff account has the mobile ${number}.` };

  let passwordHash = null;
  if (newPassword) {
    try {
      assertStaffPassword(newPassword, { mobile: user.mobile, username: user.username }, 'staff');
    } catch (e) {
      return { ok: false, reason: `NEW_STAFF_PASSWORD refused: ${e.message} Nothing was changed.` };
    }
    passwordHash = await hashPassword(newPassword);
  }

  const reset = await db.totp.reset(user.userId, { passwordHash });
  if (!reset.ok) return { ok: false, reason: `No staff account has the mobile ${number}.` };
  await db.audit.recordDetailed({
    performedBy: null, performedByName: 'reset-staff-access.mjs', performedByRole: 'cli',
    action: 'STAFF_ACCESS_RESET_CLI', category: 'SECURITY',
    targetType: 'User', targetId: user.userId, targetName: user.username || null,
    details: { hadAuthenticator: reset.hadAuthenticator, passwordChanged: Boolean(passwordHash) },
  });
  return {
    ok: true, userId: user.userId,
    hadAuthenticator: reset.hadAuthenticator, passwordChanged: Boolean(passwordHash),
  };
}

function argValue(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const mobile = argValue(process.argv.slice(2), '--mobile');
  let code = 0;
  try {
    const result = await resetStaffAccess({ mobile, newPassword: process.env.NEW_STAFF_PASSWORD || null });
    if (!result.ok) {
      console.error(`[reset-staff-access] ${result.reason}`);
      code = 1;
    } else {
      console.log(`[reset-staff-access] done for ${result.userId}: authenticator `
        + `${result.hadAuthenticator ? 'removed' : 'was not set up'}, every session ended`
        + `${result.passwordChanged ? ', password replaced' : ''}. `
        + 'The next sign-in sets up a new authenticator app.');
    }
  } catch (e) {
    console.error('[reset-staff-access] failed:', e.message);
    code = 1;
  }
  await closePg();
  process.exit(code);
}
