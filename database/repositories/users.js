// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * postgres/userPg.js — the account: identity, roles, status, second factor.
 *
 * ── What this module does NOT own, and must never own ────────────────────────
 *
 * **Balances.** They live in `wallets`, in integer paise, behind a row lock,
 * and `walletPg.js` is their only writer. The document this table replaces
 * carried six balance fields alongside the identity ones, which is how a
 * balance came to have two writers that could disagree — and how an
 * affordability check came to be decided from one number and executed against
 * another. There is no balance column on `users`, not a cached one, not one
 * "just for the admin list". Every balance read goes to `walletPg`.
 *
 * **KYC decisions.** `user_kyc` owns them and `kyc_transitions` is their audit
 * trail. `users.kyc_status` is the denormalised copy the authorisation checks
 * read on every request — cheap, and correct only because `setKycStatus` below
 * is called inside the SAME transaction that writes the decision. Never write
 * one without the other.
 *
 * ── Integers cross the boundary here ─────────────────────────────────────────
 * node-postgres returns BIGINT as a STRING. Left uncast, `'900' >= 1000` is
 * true and every comparison against it is silently wrong. `toInt` is applied to
 * every BIGINT column on the way out, once, at this boundary.
 */
import { randomBytes } from 'node:crypto';
import { pgQuery, getPool, connectGuarded } from '../client.js';

/**
 * A new account id.
 *
 * 24 hex characters — the shape the rest of the codebase still expects, since
 * `ObjectId.isValid` guards survive in modules that have not moved yet, and a
 * value that fails them is silently dropped rather than rejected.
 *
 * RANDOM, not derived from the mobile. Deriving would make signup idempotent
 * for free, and it is tempting for exactly that reason — but account ids travel
 * in URLs and payloads, and an id computable from a phone number lets anyone
 * holding the number address the account. Idempotency comes from the UNIQUE
 * constraint on `mobile` instead, which is where it belongs: `createUser`
 * returns the existing account on conflict rather than making a second one.
 */
export function newUserId() {
  return randomBytes(12).toString('hex');
}

/** pg returns BIGINT as a string. Cast once, here, or compare strings later. */
const toInt = (v) => (v == null ? null : Number(v));

/** Every column, in one place, so a projection cannot drift from the table. */
const COLUMNS = `
  user_id, username, mobile, password_hash,
  joining_number, referral_code, referral_clicks, referred_by,
  status, kyc_status, kyc_submission_count, wallet_address, profile_pic, warning_count,
  payment_flagged, payment_flag_reason, payment_flagged_at, payment_flag_count,
  is_admin, is_sub_admin, is_queue_manager, is_mediator,
  sub_admin_role, sub_admin_permissions, phantom_access,
  two_factor_enabled, two_factor_secret, two_factor_pending_secret,
  two_factor_last_counter, two_factor_enrolled_at,
  is_blocked, block_reason, blocked_at, blocked_by,
  bank_details, last_login, roles, deleted_at, deleted_by, joined_at, updated_at`;

/**
 * The columns a caller may set through `updateUser`.
 *
 * An ALLOWLIST, not a denylist, and that is the point: `req.body` reaches these
 * update paths, and a denylist grants every column somebody adds later. `mobile`
 * is absent deliberately — it is never mutable by anyone (§1) — and so are
 * `user_id`, `joining_number` and every balance-adjacent name that does not
 * exist on this table anyway.
 *
 * Callers may use EITHER the column name or the camelCase name the application
 * speaks (`isBlocked` as well as `is_blocked`). The column names are this
 * module's business; a route that has to know them is a route coupled to the
 * schema, and the coupling is what makes a rename a hundred-file change.
 */
const UPDATABLE = Object.freeze(new Set([
  'username', 'password_hash', 'referral_code', 'referral_clicks', 'referred_by',
  'status', 'kyc_status', 'wallet_address', 'profile_pic', 'warning_count',
  'payment_flagged', 'payment_flag_reason', 'payment_flagged_at', 'payment_flag_count',
  'is_admin', 'is_sub_admin', 'is_queue_manager', 'is_mediator',
  'sub_admin_role', 'sub_admin_permissions', 'phantom_access',
  'two_factor_enabled', 'two_factor_secret', 'two_factor_pending_secret',
  'two_factor_last_counter', 'two_factor_enrolled_at',
  'is_blocked', 'block_reason', 'blocked_at', 'blocked_by',
  'bank_details', 'last_login', 'roles',
]));

/** camelCase → column, derived from the allowlist so the two cannot drift. */
const CAMEL_TO_COLUMN = Object.freeze(Object.fromEntries(
  [...UPDATABLE].map((col) => [col.replace(/_([a-z])/g, (_, c) => c.toUpperCase()), col]),
));

/**
 * Normalise a patch to columns, refusing anything the allowlist does not name.
 *
 * `mobile` gets its own message because it is the one people reach for most and
 * the refusal is deliberate rather than an oversight.
 */
function toColumns(patch, fn) {
  const out = {};
  const unknown = [];
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const column = UPDATABLE.has(key) ? key : CAMEL_TO_COLUMN[key];
    if (!column) { unknown.push(key); continue; }
    out[column] = value;
  }
  if (unknown.length) {
    const mobile = unknown.includes('mobile')
      ? ' `mobile` is never mutable — it is the account\'s identity.' : '';
    throw new Error(`${fn}: refusing to write unknown or protected column(s): ${unknown.join(', ')}.${mobile}`);
  }
  return out;
}

/**
 * Row → the shape the application speaks.
 *
 * Secrets are NOT included. `password_hash`, `two_factor_secret`,
 * `two_factor_pending_secret` and `two_factor_last_counter` are returned only
 * by the functions that exist to read them, so an ordinary read cannot leak a
 * credential into a response body by accident. The document model expressed
 * this with `select: false`; here it is the mapper's job, and the mapper is the
 * only way a row becomes a user.
 */
function toUser(row) {
  if (!row) return null;
  return {
    userId: row.user_id,
    username: row.username,
    mobile: row.mobile,
    joiningNumber: toInt(row.joining_number),
    referralCode: row.referral_code,
    referralClicks: toInt(row.referral_clicks),
    referredBy: row.referred_by,
    status: row.status,
    kycStatus: row.kyc_status,
    kycSubmissionCount: row.kyc_submission_count,
    walletAddress: row.wallet_address,
    profilePic: row.profile_pic,
    warningCount: row.warning_count,
    paymentFlagged: row.payment_flagged,
    paymentFlagReason: row.payment_flag_reason,
    paymentFlaggedAt: row.payment_flagged_at,
    paymentFlagCount: row.payment_flag_count,
    isAdmin: row.is_admin,
    isSubAdmin: row.is_sub_admin,
    isQueueManager: row.is_queue_manager,
    isMediator: row.is_mediator,
    subAdminRole: row.sub_admin_role,
    subAdminPermissions: row.sub_admin_permissions ?? {},
    phantomAccess: row.phantom_access,
    twoFactorEnabled: row.two_factor_enabled,
    twoFactorEnrolledAt: row.two_factor_enrolled_at,
    isBlocked: row.is_blocked,
    blockReason: row.block_reason,
    blockedAt: row.blocked_at,
    blockedBy: row.blocked_by,
    bankDetails: row.bank_details ?? null,
    lastLogin: row.last_login,
    roles: row.roles ?? [],
    // Present so an admin reading a deleted account can see who removed it and
    // when. `users_deleted_has_actor` guarantees both are set whenever the
    // status is DELETED, so a caller never has to handle one without the other.
    deletedAt: row.deleted_at ?? null,
    deletedBy: row.deleted_by ?? null,
    joinedAt: row.joined_at,
    updatedAt: row.updated_at,
  };
}

// ── Reads ────────────────────────────────────────────────────────────────────

/** One account by id, or null. */
export async function getUser(userId) {
  if (!userId) return null;
  const { rows } = await pgQuery(
    `SELECT ${COLUMNS} FROM users WHERE user_id = $1`, [String(userId)], 'user_get',
  );
  return toUser(rows[0]);
}

/** One account by mobile, or null. The mobile is unique and never mutable. */
export async function getUserByMobile(mobile) {
  if (!mobile) return null;
  const { rows } = await pgQuery(
    `SELECT ${COLUMNS} FROM users WHERE mobile = $1`, [String(mobile)], 'user_get_mobile',
  );
  return toUser(rows[0]);
}

/** One account by referral code, or null — the signup attribution lookup. */
export async function getUserByReferralCode(code) {
  if (!code) return null;
  const { rows } = await pgQuery(
    `SELECT ${COLUMNS} FROM users WHERE referral_code = $1`, [String(code)], 'user_get_refcode',
  );
  return toUser(rows[0]);
}

/** Several accounts by id, in one round trip. Missing ids are simply absent. */
export async function getUsers(userIds = []) {
  const ids = [...new Set(userIds.filter(Boolean).map(String))];
  if (!ids.length) return [];
  const { rows } = await pgQuery(
    `SELECT ${COLUMNS} FROM users WHERE user_id = ANY($1::text[])`, [ids], 'user_get_many',
  );
  return rows.map(toUser);
}

/**
 * The credential columns, for the sign-in path only.
 *
 * Separate from `getUser` so a credential cannot reach a response body by
 * accident: a caller has to ask for this function by name, and no route that
 * renders a user calls it.
 */
export async function getUserCredentials(userId) {
  if (!userId) return null;
  const { rows } = await pgQuery(
    `SELECT user_id, password_hash, two_factor_enabled, two_factor_secret,
            two_factor_pending_secret, two_factor_last_counter
       FROM users WHERE user_id = $1`,
    [String(userId)], 'user_get_credentials',
  );
  const r = rows[0];
  return r ? {
    userId: r.user_id,
    passwordHash: r.password_hash,
    twoFactorEnabled: r.two_factor_enabled,
    twoFactorSecret: r.two_factor_secret,
    twoFactorPendingSecret: r.two_factor_pending_secret,
    twoFactorLastCounter: toInt(r.two_factor_last_counter),
  } : null;
}

// ── Writes ───────────────────────────────────────────────────────────────────

/**
 * Create an account. Returns the created user, or the EXISTING one when the
 * mobile is already registered — a signup racing itself must not produce two
 * accounts, and the unique index is what decides, not a prior existence check.
 */
export async function createUser({
  userId, username, mobile, passwordHash = null, referralCode = null,
  referredBy = null, status = 'ACTIVE', isAdmin = false,
  kycStatus = 'PENDING_SUBMISSION', kycSubmissionCount = 0, client = null,
}) {
  if (!userId) throw new Error('createUser requires a userId');
  if (!mobile) throw new Error('createUser requires a mobile');

  // `client` lets a caller enlist this insert in a transaction it already
  // owns — the signup writes the account, the identity and the KYC row
  // together or not at all.
  const run = client
    ? (text, params) => client.query(text, params)
    : (text, params) => pgQuery(text, params, 'user_create');

  const { rows } = await run(
    `INSERT INTO users (user_id, username, mobile, password_hash, referral_code,
                        referred_by, status, is_admin, kyc_status, kyc_submission_count)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (mobile) DO NOTHING
     RETURNING ${COLUMNS}`,
    [String(userId), username ?? '', String(mobile), passwordHash, referralCode,
     referredBy ? String(referredBy) : null, status, isAdmin,
     kycStatus, kycSubmissionCount],
  );
  if (rows[0]) return { user: toUser(rows[0]), created: true };
  return { user: await getUserByMobile(mobile), created: false };
}

/**
 * Patch an account.
 *
 * Only columns in UPDATABLE are written; anything else is REFUSED loudly rather
 * than dropped. That refusal is the point. The document model silently
 * discarded a write to an undeclared path, which cost this codebase six bugs —
 * approvals that recorded no reviewer, counters that incremented nothing — each
 * of which reported success. A typo here throws instead.
 */
export async function updateUser(userId, patch = {}) {
  if (!userId) throw new Error('updateUser requires a userId');
  const entries = Object.entries(toColumns(patch, 'updateUser'));
  if (!entries.length) return getUser(userId);

  const sets = entries.map(([col], i) => `${col} = $${i + 2}`);
  const { rows } = await pgQuery(
    `UPDATE users SET ${sets.join(', ')}, updated_at = now()
      WHERE user_id = $1
      RETURNING ${COLUMNS}`,
    [String(userId), ...entries.map(([, v]) => v)],
    'user_update',
  );
  return toUser(rows[0]);
}

/**
 * Increment the referral click counter.
 *
 * An UPDATE with the arithmetic in SQL, never a read-modify-write in the
 * application: two clicks arriving together must both count, and a
 * read-then-write loses one of them without reporting anything.
 */
export async function bumpReferralClicks(userId, by = 1) {
  const { rows } = await pgQuery(
    `UPDATE users SET referral_clicks = referral_clicks + $2, updated_at = now()
      WHERE user_id = $1 RETURNING referral_clicks`,
    [String(userId), by], 'user_bump_clicks',
  );
  return toInt(rows[0]?.referral_clicks);
}

/**
 * Record a payment warning against a player, and auto-block at the threshold.
 *
 * ── One statement, because the threshold decision is the block ──────────────
 * This was two writes: increment the counters and set the flag, then read the
 * new count, compare it to the threshold, and issue a SECOND update to block.
 * A failure between them leaves a player one warning past the limit and not
 * blocked — and nothing ever re-checks, because the count only moves when a
 * new warning arrives.
 *
 * Here the increment, the flag and the block are the same UPDATE. The threshold
 * is evaluated against the incremented value in the statement that increments
 * it, so there is no instant at which the count says "block" and the account
 * says otherwise.
 *
 * `maxWarnings = 0` means never auto-block, which is a real setting and not the
 * same as a threshold of zero.
 */
export async function flagPaymentWarning(userId, { reason, maxWarnings = 0 }) {
  const { rows } = await pgQuery(
    `UPDATE users SET
       warning_count       = warning_count + 1,
       payment_flag_count  = payment_flag_count + 1,
       payment_flagged     = TRUE,
       payment_flag_reason = $2,
       payment_flagged_at  = now(),
       -- The block, decided from the count this statement is producing.
       is_blocked  = is_blocked OR ($3::int > 0 AND warning_count + 1 >= $3::int),
       block_reason = CASE
         WHEN NOT is_blocked AND $3::int > 0 AND warning_count + 1 >= $3::int
           THEN 'Automatic block: ' || $3::text || ' payment warnings.'
         ELSE block_reason END,
       blocked_at = CASE
         WHEN NOT is_blocked AND $3::int > 0 AND warning_count + 1 >= $3::int
           THEN now() ELSE blocked_at END,
       updated_at = now()
     WHERE user_id = $1
     RETURNING ${COLUMNS}`,
    [String(userId), String(reason), Number(maxWarnings) || 0],
    'user_flag_payment_warning',
  );
  const user = toUser(rows[0]);
  return user ? {
    user,
    warningCount: user.warningCount,
    autoBlocked: Boolean(maxWarnings) && user.warningCount >= maxWarnings,
  } : null;
}

/**
 * Claim the next joining number, atomically.
 *
 * The payout queue is ordered by this, so it must be unique.
 *
 * ── It comes from a real SEQUENCE now ───────────────────────────────────────
 * This used to take `MAX(joining_number) + 1` inside the UPDATE, and the
 * comment above it claimed that was "a sequence over the existing maximum". It
 * was not. Each transaction reads the maximum IT can see, so two concurrent
 * signups both read the same value and one of them collides on the unique
 * index — a 500 at the very end of onboarding. The concurrency test documented
 * those collisions as acceptable and asserted only that no two accounts shared
 * a number; it now asserts that every claim succeeds.
 *
 * Gaps in the numbering are fine: this is an ORDER, not a count. A gap costs
 * nothing; a collision costs a player their signup.
 *
 * Idempotent: an account that already holds a number keeps it — `COALESCE`
 * only calls `nextval` when the column is null. Onboarding can complete twice
 * (a retried webhook, a resumed flow) and must not consume two.
 */
export async function claimJoiningNumber(userId) {
  const { rows } = await pgQuery(
    `UPDATE users
        SET joining_number = COALESCE(joining_number, nextval('joining_number_seq')),
            updated_at = now()
      WHERE user_id = $1
      RETURNING joining_number`,
    [String(userId)], 'user_claim_joining_number',
  );
  return toInt(rows[0]?.joining_number);
}

/**
 * Claim one KYC submission, refusing past the cap.
 *
 * The comparison and the increment are ONE statement, so two submissions
 * arriving together cannot both read the same count and both pass. A
 * read-then-write would let the cap be exceeded by exactly the number of
 * requests in flight — and the cap is what stops "submit a number, learn
 * whether it is registered" from being a repeatable enumeration oracle.
 *
 * @returns {Promise<number|null>} the new count, or null when the cap refused.
 */
export async function claimKycSubmission(userId, cap) {
  const { rows } = await pgQuery(
    `UPDATE users SET kyc_submission_count = kyc_submission_count + 1, updated_at = now()
      WHERE user_id = $1 AND kyc_submission_count < $2
      RETURNING kyc_submission_count`,
    [String(userId), cap], 'user_claim_kyc_submission',
  );
  return rows[0] ? Number(rows[0].kyc_submission_count) : null;
}

/**
 * Give a claimed submission back, because it never entered the queue.
 *
 * Floored at zero: a release that ran twice — a retry, a crash between the two
 * failure paths — must not hand out a free attempt.
 */
export async function releaseKycSubmission(userId) {
  const { rows } = await pgQuery(
    `UPDATE users SET kyc_submission_count = GREATEST(kyc_submission_count - 1, 0),
                      updated_at = now()
      WHERE user_id = $1
      RETURNING kyc_submission_count`,
    [String(userId)], 'user_release_kyc_submission',
  );
  return rows[0] ? Number(rows[0].kyc_submission_count) : null;
}

/**
 * Set the denormalised KYC status.
 *
 * `client` is REQUIRED and is not a convenience: this column is a copy of a
 * decision `user_kyc` owns, and the only thing that makes a copy safe is that
 * it is written in the same transaction as the original. Called without one,
 * the two can diverge — and the one that authorisation reads is this one.
 */
export async function setKycStatus(client, userId, kycStatus) {
  if (!client) throw new Error('setKycStatus must run inside the transaction that records the decision');
  const { rows } = await client.query(
    `UPDATE users SET kyc_status = $2, updated_at = now()
      WHERE user_id = $1 RETURNING kyc_status`,
    [String(userId), kycStatus],
  );
  return rows[0]?.kyc_status ?? null;
}

/**
 * Block or unblock an account.
 *
 * A block must carry its reason and its timestamp — the table refuses one
 * without them (`users_blocked_has_reason`). "Blocked, reason unknown" is a
 * support ticket nobody can answer and an appeal nobody can review.
 */
export async function setBlocked(userId, { blocked, reason = null, actor = null }) {
  if (blocked && !reason) throw new Error('setBlocked: a block requires a reason');
  const { rows } = await pgQuery(
    `UPDATE users
        SET is_blocked = $2,
            block_reason = CASE WHEN $2 THEN $3 ELSE NULL END,
            blocked_at   = CASE WHEN $2 THEN now() ELSE NULL END,
            blocked_by   = CASE WHEN $2 THEN $4 ELSE NULL END,
            updated_at   = now()
      WHERE user_id = $1
      RETURNING ${COLUMNS}`,
    [String(userId), Boolean(blocked), reason, actor ? String(actor) : null],
    'user_set_blocked',
  );
  return toUser(rows[0]);
}

/**
 * Set an account's roles and the flags derived from them, in one statement.
 *
 * ── isAdmin is DERIVED from roles, not stored beside it ────────────────────
 * The handler this replaced assigned `roles`, then `isAdmin`, `isSubAdmin` and
 * `isQueueManager` as four separate properties on a document and saved it. Any
 * failure between them left an account whose roles array and whose flags
 * disagreed — and the flags are what every authorisation check reads, so the
 * roles column would have said "not an admin" while the platform treated the
 * account as one. Derived in the statement, they cannot come apart.
 *
 * `merchant` is deliberately absent from the flags. It is a role only in the
 * sense that it keeps an account out of the player list; merchant panel access
 * comes from the merchant record and its own login.
 */
export async function setRoles(userId, roles = []) {
  const list = [...new Set(roles.map(String))];
  const { rows } = await pgQuery(
    `UPDATE users SET
       roles = $2::text[],
       is_admin         = 'admin'         = ANY($2::text[]),
       is_sub_admin     = 'subadmin'      = ANY($2::text[]),
       is_queue_manager = 'queue_manager' = ANY($2::text[]),
       updated_at = now()
      WHERE user_id = $1
      RETURNING ${COLUMNS}`,
    [String(userId), list], 'user_set_roles',
  );
  return toUser(rows[0]);
}

/**
 * Soft-delete an account.
 *
 * `users_deleted_has_actor` requires the actor and the timestamp alongside the
 * status, so this cannot write a deletion nobody is accountable for. Nothing is
 * erased: the bets, orders and ledger rows stay exactly where they are, because
 * a deleted account's money still has to reconcile.
 *
 * Returns null for an account that was already deleted, so the route can say so
 * rather than reporting a second successful deletion.
 */
export async function softDeleteUser(userId, { actor }) {
  if (!actor) throw new Error('softDeleteUser requires an actor');
  const { rows } = await pgQuery(
    `UPDATE users SET status = 'DELETED', deleted_at = now(), deleted_by = $2,
            updated_at = now()
      WHERE user_id = $1 AND status <> 'DELETED'
      RETURNING ${COLUMNS}`,
    [String(userId), String(actor)], 'user_soft_delete',
  );
  return toUser(rows[0]);
}

/**
 * A page of accounts for the admin list.
 *
 * KEYSET pagination on (joined_at, user_id), not OFFSET: an offset scan re-reads
 * every skipped row on each page, and — worse for a list somebody is working
 * through — a signup arriving mid-pagination shifts every subsequent page by
 * one, so a row is silently skipped. The tiebreak on user_id is what makes the
 * cursor total when two accounts share a timestamp.
 */
export async function listUsers({
  status = null, isAdmin = null, isSubAdmin = null, isQueueManager = null,
  kycStatus = null, blocked = null, flagged = null, search = null,
  excludeRole = null, limit = 50, cursor = null, page = null,
} = {}) {
  const where = [];
  const params = [];
  const add = (sql, value) => { params.push(value); where.push(sql.replace('$?', `$${params.length}`)); };

  if (status) add('status = $?', status);
  if (isAdmin !== null) add('is_admin = $?', Boolean(isAdmin));
  if (isSubAdmin !== null) add('is_sub_admin = $?', Boolean(isSubAdmin));
  if (isQueueManager !== null) add('is_queue_manager = $?', Boolean(isQueueManager));
  if (kycStatus) add('kyc_status = $?', String(kycStatus));
  if (blocked !== null) add('is_blocked = $?', Boolean(blocked));
  if (flagged !== null) add('payment_flagged = $?', Boolean(flagged));
  // Merchants are a separate entity with their own record and login; the
  // player list excludes them by the role they were created with.
  if (excludeRole) add('NOT ($? = ANY(roles))', String(excludeRole));
  // Anchored prefix match, so the index is usable and the pattern cannot be
  // turned into a leading-wildcard scan of every account by the search box.
  if (search) add('(username ILIKE $? || \'%\' OR mobile LIKE $? || \'%\')', String(search));
  if (cursor?.joinedAt && cursor?.userId) {
    params.push(cursor.joinedAt, cursor.userId);
    where.push(`(joined_at, user_id) < ($${params.length - 1}, $${params.length})`);
  }

  const capped = Math.min(Math.max(Number(limit) || 50, 1), 200);
  params.push(capped);

  // An OFFSET path for the admin panel, which asks for page numbers. It is the
  // WORSE option and stays available only because the panel draws page links:
  // a signup arriving mid-pagination shifts every later row by one, so page two
  // silently skips an account. `cursor` wins whenever the caller supplies one,
  // and the response hands back the next cursor so a caller can switch.
  let offsetClause = '';
  if (!cursor && page && Number(page) > 1) {
    params.push((Math.max(Number(page), 1) - 1) * capped);
    offsetClause = ` OFFSET $${params.length}`;
  }

  const { rows } = await pgQuery(
    // COUNT(*) OVER () rather than a second query: two statements outside a
    // transaction can disagree, and a total that contradicts the page it labels
    // is how a paginator grows a phantom last page.
    `SELECT ${COLUMNS}, COUNT(*) OVER () AS total_count FROM users
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY joined_at DESC, user_id DESC
      LIMIT $${params.length - (offsetClause ? 1 : 0)}${offsetClause}`,
    params, 'user_list',
  );
  const users = rows.map(toUser);
  const last = users[users.length - 1];
  return {
    users,
    total: rows[0] ? Number(rows[0].total_count) : 0,
    // Absent when the page was not full: there is nothing after it, and handing
    // back a cursor anyway makes a caller do one more round trip to learn that.
    nextCursor: users.length === capped && last
      ? { joinedAt: last.joinedAt, userId: last.userId }
      : null,
  };
}

/**
 * Accounts holding a phantom-betting grant.
 *
 * `NOT phantom_access = 'NONE'` rather than `$ne`, and the mapper drops every
 * credential column on the way out — so the `.select('-passwordHash …')` the
 * route carried, a denylist that grants any credential column added later, is
 * neither needed nor forgettable.
 */
export async function listPhantomAgents() {
  const { rows } = await pgQuery(
    `SELECT ${COLUMNS} FROM users
      WHERE phantom_access <> 'NONE' AND status <> 'DELETED'
      ORDER BY username`, [], 'user_list_phantom_agents',
  );
  return rows.map(toUser);
}

/** Accounts with the queue-manager flag. */
export async function listQueueManagers() {
  const { rows } = await pgQuery(
    `SELECT ${COLUMNS} FROM users
      WHERE is_queue_manager AND status <> 'DELETED'
      ORDER BY username`, [], 'user_list_queue_managers',
  );
  return rows.map(toUser);
}

/** How many accounts match a status. Counted from rows, never accumulated. */
export async function countUsers({ status = null } = {}) {
  const { rows } = await pgQuery(
    `SELECT count(*)::bigint AS n FROM users ${status ? 'WHERE status = $1' : ''}`,
    status ? [status] : [], 'user_count',
  );
  return toInt(rows[0]?.n) ?? 0;
}

/**
 * Run `fn` inside a transaction, so a caller can write a user and something
 * else atomically — a KYC decision and the status copy it implies, an account
 * and its wallet row.
 */
export async function withUserTransaction(fn) {
  const pool = await getPool();
  const client = await connectGuarded(pool);
  try {
    await client.query('BEGIN');
    const value = await fn(client);
    await client.query('COMMIT');
    return value;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
