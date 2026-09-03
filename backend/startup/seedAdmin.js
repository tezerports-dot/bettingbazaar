// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * startup/seedAdmin.js — the first admin account, on first boot.
 *
 * Single responsibility: ensure an admin exists. Never crashes the server if it
 * fails — a platform that will not start because it could not seed an account
 * is worse than one an operator has to create an account on.
 */
import { db } from '#db';
// Password hashing authority (argon2id, with a bcrypt verify-fallback).
import { hashPassword, verifyPassword, isArgon2 } from '../domains/identity/password.util.js';

export async function seedAdminAccount() {
  try {
    const adminMobile   = process.env.DEFAULT_ADMIN_MOBILE;
    const adminPassword = process.env.DEFAULT_ADMIN_PASSWORD;

    if (!adminMobile || !adminPassword) {
      console.warn('⚠️  Skipping admin seed — DEFAULT_ADMIN_MOBILE or DEFAULT_ADMIN_PASSWORD not set');
      return;
    }

    const { users: [existingAdmin] } = await db.users.listUsers({ isAdmin: true, limit: 1 });

    if (existingAdmin) {
      // Re-hash only when the credentials actually changed — plus an
      // opportunistic upgrade of a legacy bcrypt admin hash to argon2id.
      //
      // The hash comes from the CREDENTIALS read, which is the only function
      // that returns one. The version this replaced took it off the user object
      // — where it is deliberately absent, so an ordinary read cannot leak a
      // password hash into a response — and compared against `undefined`. Every
      // boot therefore decided the password had changed and re-hashed it.
      const credentials = await db.users.getUserCredentials(existingAdmin.userId);
      const storedHash = credentials?.passwordHash ?? '';
      const { valid: samePassword } = await verifyPassword(storedHash, adminPassword);
      const sameMobile = existingAdmin.mobile === adminMobile;
      const legacyHash = !isArgon2(storedHash);

      if (!samePassword || !sameMobile || legacyHash) {
        // `mobile` is NOT mutable — it is the account's identity, and the
        // repository refuses to write it. Changing which number the admin signs
        // in with means creating an account for that number, deliberately,
        // rather than silently repointing an existing one on a boot.
        if (!sameMobile) {
          console.warn(
            `⚠️  DEFAULT_ADMIN_MOBILE (${adminMobile}) differs from the existing admin `
            + `(${existingAdmin.mobile}). The number is an account's identity and is not `
            + 'reassigned on boot — create the new admin deliberately if that is the intent.',
          );
        }
        await db.users.updateUser(existingAdmin.userId, {
          passwordHash: await hashPassword(adminPassword),
        });
        console.log(legacyHash && samePassword && sameMobile
          ? '✅ Admin password hash upgraded to argon2id'
          : '✅ Admin password updated from env vars');
      } else {
        console.log('✅ Admin credentials unchanged — skipping re-hash');
      }
      return;
    }

    // `createUser` returns the EXISTING account on a mobile conflict rather
    // than throwing, so two instances booting together seed ONE admin — the
    // UNIQUE constraint on `mobile` decides, not a prior existence check that a
    // concurrent boot fits between.
    // `{ user, created }`, not a user: the `created` flag distinguishes "this
    // boot made the admin" from "another instance got there first", which the
    // log below reports honestly rather than claiming a seed either way.
    const { user, created } = await db.users.createUser({
      userId: db.users.newUserId(),
      username: 'Super Admin',
      mobile: adminMobile,
      passwordHash: await hashPassword(adminPassword),
      status: 'ACTIVE',
      kycStatus: 'APPROVED',
      isAdmin: true,
    });
    // `roles` is set through `setRoles`, which DERIVES the authorisation flags
    // from it in the same statement — so the array and the flags every
    // authorisation check reads cannot come apart.
    await db.users.setRoles(user.userId, ['admin']);
    console.log(created
      ? '✅ Admin account seeded successfully'
      : '✅ Admin account already existed — roles reconciled');
  } catch (error) {
    console.warn('⚠️  Admin seed failed (server still running):', error.message);
  }
}
