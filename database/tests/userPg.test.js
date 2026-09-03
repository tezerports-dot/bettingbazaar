// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * The accounts table, against a REAL PostgreSQL (skipped when DATABASE_URL is
 * unset).
 *
 * The properties worth proving here are the database's, not the module's: the
 * mobile is unique so a racing signup cannot make two accounts, a joining
 * number cannot be handed out twice, a block cannot be recorded without its
 * reason, and BIGINT columns come back as NUMBERS rather than the strings the
 * driver actually returns. None of those can be asserted against a fake.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { pgConfigured, pgQuery, applySchema, closePg } from '../client.js';
import {
  createUser, getUser, getUserByMobile, getUserByReferralCode, getUsers,
  getUserCredentials, updateUser, bumpReferralClicks, claimJoiningNumber,
  setKycStatus, setBlocked, listUsers, countUsers, withUserTransaction,
  setRoles, softDeleteUser,
} from '../repositories/users.js';

const describePg = pgConfigured() ? describe : describe.skip;

const mk = (over = {}) => ({
  userId: 'u-1', username: 'alice', mobile: '9990000001', ...over,
});

describePg('accounts (PostgreSQL)', () => {
  beforeAll(async () => { await applySchema(); });
  afterAll(async () => { await closePg(); });
  beforeEach(async () => {
    await pgQuery('TRUNCATE users RESTART IDENTITY CASCADE');
    // The joining number comes from a SEQUENCE, which is global and does not
    // reset when the table is emptied — correctly, since it hands out an ORDER
    // rather than a count. Restarting it here lets these tests assert concrete
    // values instead of "some distinct integers", which is easier to read and
    // still exercises the same code path.
    await pgQuery('ALTER SEQUENCE joining_number_seq RESTART WITH 1');
  });

  describe('creation', () => {
    it('creates an account and reads it back', async () => {
      const { user, created } = await createUser(mk());
      expect(created).toBe(true);
      expect(user).toMatchObject({
        userId: 'u-1', username: 'alice', mobile: '9990000001',
        status: 'ACTIVE', kycStatus: 'PENDING_SUBMISSION', isAdmin: false,
      });
      expect(await getUser('u-1')).toMatchObject({ mobile: '9990000001' });
    });

    it('a second signup on the same mobile returns the FIRST account, not a second one', async () => {
      // The unique index decides this, not a prior existence check — a check
      // and an insert are two statements and a racing signup fits between them.
      await createUser(mk());
      const { user, created } = await createUser(mk({ userId: 'u-2', username: 'mallory' }));
      expect(created).toBe(false);
      expect(user.userId).toBe('u-1');
      expect(user.username).toBe('alice');
      expect(await countUsers()).toBe(1);
    });

    it('20 concurrent signups on one mobile produce exactly one account', async () => {
      const attempts = Array.from({ length: 20 }, (_, i) =>
        createUser(mk({ userId: `race-${i}` })));
      const results = await Promise.all(attempts);
      expect(results.filter((r) => r.created)).toHaveLength(1);
      expect(await countUsers()).toBe(1);
      // Every loser still gets the winning account back rather than a null.
      for (const r of results) expect(r.user).not.toBeNull();
    });
  });

  describe('lookups', () => {
    it('finds by mobile and by referral code, and returns null for neither', async () => {
      await createUser(mk({ referralCode: 'ALICE1' }));
      expect((await getUserByMobile('9990000001')).userId).toBe('u-1');
      expect((await getUserByReferralCode('ALICE1')).userId).toBe('u-1');
      expect(await getUserByMobile('0000000000')).toBeNull();
      expect(await getUserByReferralCode('NOPE')).toBeNull();
      expect(await getUser(null)).toBeNull();
    });

    it('fetches many in one round trip, skipping ids that do not exist', async () => {
      await createUser(mk());
      await createUser(mk({ userId: 'u-2', mobile: '9990000002' }));
      const users = await getUsers(['u-1', 'u-2', 'u-absent', null]);
      expect(users.map((u) => u.userId).sort()).toEqual(['u-1', 'u-2']);
      expect(await getUsers([])).toEqual([]);
    });
  });

  describe('secrets do not leak through an ordinary read', () => {
    it('omits the password hash and the 2FA secret from getUser', async () => {
      await createUser(mk({ passwordHash: 'argon2-hash' }));
      await updateUser('u-1', { two_factor_secret: 'TOTPSECRET', two_factor_enabled: true });

      const user = await getUser('u-1');
      expect(user.twoFactorEnabled).toBe(true);     // the FACT is public
      expect(user).not.toHaveProperty('passwordHash');
      expect(user).not.toHaveProperty('twoFactorSecret');
      expect(JSON.stringify(user)).not.toContain('TOTPSECRET');
      expect(JSON.stringify(user)).not.toContain('argon2-hash');
    });

    it('returns them only through the function that exists to read them', async () => {
      await createUser(mk({ passwordHash: 'argon2-hash' }));
      await updateUser('u-1', { two_factor_secret: 'TOTPSECRET', two_factor_last_counter: 42 });
      expect(await getUserCredentials('u-1')).toMatchObject({
        passwordHash: 'argon2-hash', twoFactorSecret: 'TOTPSECRET', twoFactorLastCounter: 42,
      });
    });
  });

  describe('updates', () => {
    it('patches only what it is given', async () => {
      await createUser(mk());
      const after = await updateUser('u-1', { username: 'alice-renamed' });
      expect(after.username).toBe('alice-renamed');
      expect(after.mobile).toBe('9990000001');
    });

    it('REFUSES an unknown column instead of silently discarding it', async () => {
      // The failure this replaces: the document model dropped a write to an
      // undeclared path without erroring, so approvals recorded no reviewer and
      // counters incremented nothing — each reporting success.
      await createUser(mk());
      await expect(updateUser('u-1', { notAColumn: 1 }))
        .rejects.toThrow(/unknown or protected column/);
    });

    it('REFUSES to change the mobile, which is never mutable by anyone', async () => {
      await createUser(mk());
      await expect(updateUser('u-1', { mobile: '9999999999' }))
        .rejects.toThrow(/unknown or protected column/);
      expect((await getUser('u-1')).mobile).toBe('9990000001');
    });

    it('refuses a status the table does not recognise', async () => {
      await createUser(mk());
      await expect(updateUser('u-1', { status: 'BANANA' }))
        .rejects.toThrow(/users_status_check/);
    });
  });

  describe('the referral click counter', () => {
    it('increments in SQL, so concurrent clicks all count', async () => {
      await createUser(mk());
      await Promise.all(Array.from({ length: 50 }, () => bumpReferralClicks('u-1')));
      // A read-modify-write in the application loses some of these and reports
      // success for every one of them.
      expect((await getUser('u-1')).referralClicks).toBe(50);
    });

    it('comes back as a NUMBER, not the string the driver returns', async () => {
      await createUser(mk());
      await bumpReferralClicks('u-1', 900);
      const { referralClicks } = await getUser('u-1');
      expect(typeof referralClicks).toBe('number');
      // The exact shape of the bug this guards: uncast, '900' >= 1000 is true.
      expect(referralClicks >= 1000).toBe(false);
    });
  });

  describe('joining numbers', () => {
    it('hands out 1, 2, 3 in order', async () => {
      // Gaps would be fine — this is an order, not a count — but with the
      // sequence restarted above the numbering is contiguous and readable.
      for (let i = 1; i <= 3; i += 1) {
        await createUser(mk({ userId: `u-${i}`, mobile: `999000000${i}` }));
        expect(await claimJoiningNumber(`u-${i}`)).toBe(i);
      }
    });

    it('is idempotent — completing onboarding twice does not consume two', async () => {
      await createUser(mk());
      expect(await claimJoiningNumber('u-1')).toBe(1);
      expect(await claimJoiningNumber('u-1')).toBe(1);
    });

    it('never hands the same number to two accounts under concurrency', async () => {
      const ids = Array.from({ length: 15 }, (_, i) => `u-${i}`);
      for (const [i, id] of ids.entries()) {
        await createUser(mk({ userId: id, mobile: `98800000${String(i).padStart(2, '0')}` }));
      }
      // EVERY claim succeeds. This used to be `allSettled`, with a comment
      // calling the collisions acceptable and "retried by the caller" — but the
      // collision happens at the very end of onboarding, and what the player
      // sees is a 500. The number now comes from a sequence, so there is
      // nothing to collide over and nothing to retry.
      const claimed = await Promise.all(ids.map((id) => claimJoiningNumber(id)));
      expect(claimed.every((n) => Number.isInteger(n) && n > 0)).toBe(true);
      expect(new Set(claimed).size).toBe(ids.length);

      const { rows } = await pgQuery(
        `SELECT joining_number, count(*)::int AS n FROM users
          WHERE joining_number IS NOT NULL GROUP BY 1 HAVING count(*) > 1`);
      expect(rows).toEqual([]);
    });
  });

  describe('the patch vocabulary', () => {
    it('accepts camelCase as well as column names', async () => {
      await createUser(mk());
      const updated = await updateUser('u-1', {
        profilePic: '/x.png', walletAddress: '0xabc',
        warning_count: 2,            // the column name still works
      });
      expect(updated).toMatchObject({ profilePic: '/x.png', walletAddress: '0xabc', warningCount: 2 });
    });

    it('still cannot half-block an account through the patch path', async () => {
      // Blocking sets a flag, a reason, a time and an actor, and the row
      // refuses any subset — which is why `setBlocked` exists and why a patch
      // is not a way around it.
      await createUser(mk());
      await expect(updateUser('u-1', { isBlocked: true, blockReason: 'no time set' }))
        .rejects.toThrow(/users_blocked_has_reason/);
    });

    it('refuses mobile with a message that says why', async () => {
      await createUser(mk());
      await expect(updateUser('u-1', { mobile: '9000000000' }))
        .rejects.toThrow(/`mobile` is never mutable/);
    });
  });

  describe('blocking', () => {
    it('records the reason, the time and the actor', async () => {
      await createUser(mk());
      const blocked = await setBlocked('u-1', { blocked: true, reason: 'fraud review', actor: 'admin-1' });
      expect(blocked).toMatchObject({ isBlocked: true, blockReason: 'fraud review', blockedBy: 'admin-1' });
      expect(blocked.blockedAt).toBeInstanceOf(Date);
    });

    it('clears all three on unblock', async () => {
      await createUser(mk());
      await setBlocked('u-1', { blocked: true, reason: 'fraud review', actor: 'admin-1' });
      expect(await setBlocked('u-1', { blocked: false })).toMatchObject({
        isBlocked: false, blockReason: null, blockedAt: null, blockedBy: null,
      });
    });

    it('REFUSES a block with no reason — in the code and in the table', async () => {
      await createUser(mk());
      await expect(setBlocked('u-1', { blocked: true })).rejects.toThrow(/requires a reason/);
      // And the table refuses it too, so a future path that forgets the guard
      // cannot write "blocked, reason unknown" — which is a support ticket
      // nobody can answer and an appeal nobody can review.
      await expect(pgQuery(
        `UPDATE users SET is_blocked = true WHERE user_id = $1`, ['u-1'],
      )).rejects.toThrow(/users_blocked_has_reason/);
    });
  });

  describe('the denormalised KYC status', () => {
    it('is written in the SAME transaction as the decision it copies', async () => {
      await createUser(mk());
      await withUserTransaction(async (client) => {
        await client.query(
          `INSERT INTO user_kyc (user_id, kyc_status) VALUES ($1, $2)
           ON CONFLICT (user_id) DO UPDATE SET kyc_status = EXCLUDED.kyc_status`,
          ['u-1', 'APPROVED'],
        );
        await setKycStatus(client, 'u-1', 'APPROVED');
      });
      expect((await getUser('u-1')).kycStatus).toBe('APPROVED');
    });

    it('rolls back with the decision, so the two cannot diverge', async () => {
      await createUser(mk());
      await expect(withUserTransaction(async (client) => {
        await setKycStatus(client, 'u-1', 'APPROVED');
        throw new Error('the decision failed after the copy was written');
      })).rejects.toThrow(/decision failed/);
      // The copy authorisation reads must not survive a decision that did not.
      expect((await getUser('u-1')).kycStatus).toBe('PENDING_SUBMISSION');
    });

    it('REFUSES to be written outside a transaction', async () => {
      await createUser(mk());
      await expect(setKycStatus(null, 'u-1', 'APPROVED'))
        .rejects.toThrow(/inside the transaction/);
    });
  });

  describe('listing', () => {
    beforeEach(async () => {
      for (let i = 1; i <= 5; i += 1) {
        await createUser(mk({ userId: `u-${i}`, username: `user${i}`, mobile: `977000000${i}` }));
        // Distinct timestamps so the keyset order is deterministic.
        await pgQuery(`UPDATE users SET joined_at = now() - ($2 || ' minutes')::interval
                        WHERE user_id = $1`, [`u-${i}`, String(i)]);
      }
    });

    it('pages by keyset without skipping a row when one is inserted mid-pagination', async () => {
      const page1 = await listUsers({ limit: 2 });
      expect(page1.users.map((u) => u.userId)).toEqual(['u-1', 'u-2']);
      expect(page1.nextCursor).not.toBeNull();

      // A signup arrives between pages. Under OFFSET this shifts every later
      // page by one and a row is silently skipped; under keyset it cannot.
      await createUser(mk({ userId: 'u-new', mobile: '9770000099' }));

      const page2 = await listUsers({ limit: 2, cursor: page1.nextCursor });
      expect(page2.users.map((u) => u.userId)).toEqual(['u-3', 'u-4']);
    });

    it('returns no cursor on a partial page', async () => {
      expect((await listUsers({ limit: 100 })).nextCursor).toBeNull();
    });

    it('filters by status and by flag', async () => {
      await updateUser('u-3', { status: 'SUSPENDED' });
      await updateUser('u-4', { payment_flagged: true, payment_flagged_at: new Date() });
      expect((await listUsers({ status: 'SUSPENDED' })).users.map((u) => u.userId)).toEqual(['u-3']);
      expect((await listUsers({ flagged: true })).users.map((u) => u.userId)).toEqual(['u-4']);
    });

    it('caps the page size, so a caller cannot ask for the whole table', async () => {
      const { users } = await listUsers({ limit: 100_000 });
      expect(users.length).toBeLessThanOrEqual(200);
    });

    it('counts from rows rather than an accumulator', async () => {
      expect(await countUsers()).toBe(5);
      // Through softDeleteUser, not a bare status write: users_deleted_has_actor
      // refuses a DELETED row with nobody accountable for it, which is the
      // point — an account that vanished with no record of who removed it is
      // the one a dispute cannot be answered from.
      await softDeleteUser('u-2', { actor: 'admin-1' });
      expect(await countUsers({ status: 'ACTIVE' })).toBe(4);
    });

    it('records who deleted an account, and refuses a second deletion', async () => {
      const deleted = await softDeleteUser('u-3', { actor: 'admin-7' });
      expect(deleted.status).toBe('DELETED');
      expect(deleted.deletedBy).toBe('admin-7');
      expect(deleted.deletedAt).toBeInstanceOf(Date);
      // Already deleted: null, so the route answers 404 rather than reporting a
      // second successful deletion of the same account.
      expect(await softDeleteUser('u-3', { actor: 'admin-7' })).toBeNull();
    });

    it('derives the authorisation flags from the roles it is given', async () => {
      const admin = await setRoles('u-4', ['admin', 'queue_manager']);
      expect(admin.roles.sort()).toEqual(['admin', 'queue_manager']);
      expect(admin.isAdmin).toBe(true);
      expect(admin.isQueueManager).toBe(true);
      expect(admin.isSubAdmin).toBe(false);

      // Removing the role removes the flag in the same statement. The four
      // separate assignments this replaced could leave `roles` saying one thing
      // and `is_admin` — which every authorisation check reads — saying another.
      const stripped = await setRoles('u-4', []);
      expect(stripped.roles).toEqual([]);
      expect(stripped.isAdmin).toBe(false);
      expect(stripped.isQueueManager).toBe(false);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The KYC reapply cap. It is the only thing stopping "submit a number, be told
// whether it is registered" from being a repeatable enumeration oracle.
// ─────────────────────────────────────────────────────────────────────────────
import { claimKycSubmission, releaseKycSubmission, newUserId } from '../repositories/users.js';

describePg('the KYC submission cap', () => {
  beforeAll(async () => { await applySchema(); });
  afterAll(async () => { await closePg(); });
  beforeEach(async () => {
    await pgQuery('TRUNCATE users RESTART IDENTITY CASCADE');
    await createUser(mk());
  });

  it('hands out attempts up to the cap and then refuses', async () => {
    expect(await claimKycSubmission('u-1', 3)).toBe(1);
    expect(await claimKycSubmission('u-1', 3)).toBe(2);
    expect(await claimKycSubmission('u-1', 3)).toBe(3);
    expect(await claimKycSubmission('u-1', 3)).toBeNull();
  });

  it('20 concurrent reapplies consume exactly the cap, never more', async () => {
    // The hole this closes: the previous implementation READ the count near the
    // top of the flow and incremented at the very bottom, with the whole
    // submission in between. Requests arriving together all read the same count
    // and all passed, so the cap was exceeded by the number in flight — which
    // is exactly the oracle it exists to prevent.
    const results = await Promise.all(
      Array.from({ length: 20 }, () => claimKycSubmission('u-1', 3)));
    expect(results.filter((r) => r !== null)).toHaveLength(3);

    const { rows } = await pgQuery(
      'SELECT kyc_submission_count AS n FROM users WHERE user_id = $1', ['u-1']);
    expect(Number(rows[0].n)).toBe(3);
  });

  it('gives an attempt back when the submission never entered the queue', async () => {
    await claimKycSubmission('u-1', 3);
    expect(await releaseKycSubmission('u-1')).toBe(0);
    // …and the freed attempt is genuinely usable again.
    expect(await claimKycSubmission('u-1', 3)).toBe(1);
  });

  it('a release that runs twice does not hand out a free attempt', async () => {
    await claimKycSubmission('u-1', 3);
    await releaseKycSubmission('u-1');
    await releaseKycSubmission('u-1');   // a retry, or a crash between paths
    const { rows } = await pgQuery(
      'SELECT kyc_submission_count AS n FROM users WHERE user_id = $1', ['u-1']);
    expect(Number(rows[0].n)).toBe(0);   // floored, never negative
  });

  it('the count SURVIVES the verification row being deleted', async () => {
    // This is why the counter lives on `users` and not on `kyc_verifications`:
    // releaseFailedSubmission DELETES that row to free the unique Aadhaar hash,
    // and a counter living there would be deleted with it — resetting the cap
    // and making it unlimited by construction.
    await claimKycSubmission('u-1', 3);
    await claimKycSubmission('u-1', 3);
    await pgQuery(
      `INSERT INTO kyc_verifications (user_id, aadhaar_hash, aadhaar_encrypted, aadhaar_last4, phone, status)
       VALUES ($1,'h','c','1234','999','FAILED')`, ['u-1']);
    await pgQuery(`DELETE FROM kyc_verifications WHERE user_id = $1`, ['u-1']);

    expect(await claimKycSubmission('u-1', 3)).toBe(3);
    expect(await claimKycSubmission('u-1', 3)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The admin seed — the account that can do everything, created on first boot.
// ─────────────────────────────────────────────────────────────────────────────
describePg('seeding the first admin', () => {
  let seedAdminAccount;

  beforeAll(async () => {
    await applySchema();
    ({ seedAdminAccount } = await import('../../backend/startup/seedAdmin.js'));
  });
  afterAll(async () => { await closePg(); });
  beforeEach(async () => {
    await pgQuery('TRUNCATE users RESTART IDENTITY CASCADE');
    process.env.DEFAULT_ADMIN_MOBILE = '9999000001';
    process.env.DEFAULT_ADMIN_PASSWORD = 'seed-test-password';
  });

  it('creates one admin with the flags derived from its roles', async () => {
    await seedAdminAccount();

    const { users } = await listUsers({ isAdmin: true });
    expect(users).toHaveLength(1);
    // The flags come from `setRoles`, in the same statement as the array, so
    // the roles and the flags every authorisation check reads cannot diverge.
    expect(users[0].isAdmin).toBe(true);
    expect(users[0].roles).toEqual(['admin']);
    expect(users[0].mobile).toBe('9999000001');
  });

  it('hashes the password with argon2id and never stores it in the clear', async () => {
    await seedAdminAccount();
    const { users: [admin] } = await listUsers({ isAdmin: true });

    const credentials = await getUserCredentials(admin.userId);
    expect(credentials.passwordHash).toMatch(/^\$argon2id\$/);
    expect(credentials.passwordHash).not.toContain('seed-test-password');
    // And an ordinary read cannot carry it: the projection that builds a user
    // does not select the hash at all.
    expect(admin).not.toHaveProperty('passwordHash');
  });

  it('does not re-hash on a second boot with the same credentials', async () => {
    await seedAdminAccount();
    const { users: [first] } = await listUsers({ isAdmin: true });
    const before = (await getUserCredentials(first.userId)).passwordHash;

    await seedAdminAccount();

    const { users } = await listUsers({ isAdmin: true });
    expect(users).toHaveLength(1);
    // argon2 salts every hash, so an unnecessary re-hash is visible as a changed
    // digest. The check that prevents it reads the stored hash through
    // `getUserCredentials`; taking it off the user object — where it is
    // deliberately absent — compared against undefined and re-hashed on EVERY
    // boot.
    expect((await getUserCredentials(users[0].userId)).passwordHash).toBe(before);
  });

  it('updates the password when the environment changes', async () => {
    await seedAdminAccount();
    const { users: [admin] } = await listUsers({ isAdmin: true });
    const before = (await getUserCredentials(admin.userId)).passwordHash;

    process.env.DEFAULT_ADMIN_PASSWORD = 'a-different-password';
    await seedAdminAccount();

    expect((await getUserCredentials(admin.userId)).passwordHash).not.toBe(before);
  });

  it('seeds ONE admin when two instances boot together', async () => {
    // The UNIQUE constraint on `mobile` decides, not a prior existence check a
    // concurrent boot fits between.
    await Promise.all([seedAdminAccount(), seedAdminAccount(), seedAdminAccount()]);
    expect((await listUsers({ isAdmin: true })).users).toHaveLength(1);
  });

  it('does nothing at all without the environment variables', async () => {
    delete process.env.DEFAULT_ADMIN_MOBILE;
    delete process.env.DEFAULT_ADMIN_PASSWORD;
    await seedAdminAccount();
    expect((await listUsers({ isAdmin: true })).users).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The second-factor writes, under concurrency.
//
// The unit test asserts the module's LOGIC against a stub. What it cannot
// assert is that two requests racing the same code produce one success — a
// race needs a real database, and this is the only place it can be run.
// ─────────────────────────────────────────────────────────────────────────────
import { spendTwoFactorCounter, consumeTwoFactorBackupCode } from '../repositories/users.js';

describePg('the second-factor anti-replay writes', () => {
  const U = 'u-2fa';

  beforeAll(async () => { await applySchema(); });
  afterAll(async () => { await closePg(); });
  beforeEach(async () => {
    await pgQuery('TRUNCATE users RESTART IDENTITY CASCADE');
    await createUser({ userId: U, username: 'twofa', mobile: '9995550001' });
  });

  it('spends a counter once, and refuses the same one again', async () => {
    expect(await spendTwoFactorCounter(U, 100)).toBe(true);
    // The replayed code verifies cryptographically for up to 90 seconds. This
    // is what stops it being accepted twice.
    expect(await spendTwoFactorCounter(U, 100)).toBe(false);
  });

  it('refuses a counter BELOW the one already spent', async () => {
    await spendTwoFactorCounter(U, 100);
    expect(await spendTwoFactorCounter(U, 99)).toBe(false);
    expect(await spendTwoFactorCounter(U, 101)).toBe(true);
  });

  it('lets exactly ONE of many simultaneous replays through', async () => {
    // The real shape of the attack: the same six digits submitted at once. A
    // read-then-write guard passes every one of these, because they all read
    // the old counter before any of them writes.
    const results = await Promise.all(
      Array.from({ length: 12 }, () => spendTwoFactorCounter(U, 500)),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('consumes a recovery code once, even when redeemed concurrently', async () => {
    const codes = ['h1', 'h2', 'h3'];
    await updateUser(U, { backupCodes: codes });

    // Both callers verified against the same list and computed the same
    // shorter one. Compare-and-swap means only the first lands.
    const results = await Promise.all([
      consumeTwoFactorBackupCode(U, { expected: codes, remaining: ['h1', 'h3'] }),
      consumeTwoFactorBackupCode(U, { expected: codes, remaining: ['h1', 'h3'] }),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await getUserCredentials(U)).backupCodes).toEqual(['h1', 'h3']);
  });

  it('refuses a consume whose expected list is already stale', async () => {
    await updateUser(U, { backupCodes: ['h1', 'h2'] });
    await consumeTwoFactorBackupCode(U, { expected: ['h1', 'h2'], remaining: ['h1'] });
    // A second request holding the pre-consume list must not resurrect 'h2'.
    expect(await consumeTwoFactorBackupCode(U, { expected: ['h1', 'h2'], remaining: ['h2'] })).toBe(false);
    expect((await getUserCredentials(U)).backupCodes).toEqual(['h1']);
  });

  it('returns the recovery codes with the credentials, not with the account', async () => {
    await updateUser(U, { backupCodes: ['h1'] });
    // They were missing from getUserCredentials entirely, so the second-factor
    // check could never reach a recovery code — locking out precisely the
    // person whose authenticator is gone, which is what they exist for.
    expect((await getUserCredentials(U)).backupCodes).toEqual(['h1']);
    expect(JSON.stringify(await getUser(U))).not.toContain('h1');
  });
});
