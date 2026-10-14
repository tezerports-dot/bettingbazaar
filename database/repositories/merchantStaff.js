// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The people who work a merchant account (owner, 2026-10-11 — Phase B of the
 * merchants-and-agents plan). The ONE writer of `merchant_staff` and
 * `merchant_staff_accounts`.
 *
 * A sub-member is their own login: a `users` row of account_type MERCHANT,
 * verified in Telegram like every merchant login (§33), that is not itself a
 * merchant. Their roles say what they may do:
 *
 *   DEPOSITS    — work buys paid into the accounts assigned to them for DEPOSIT;
 *   WITHDRAWALS — work sells, paid from the accounts assigned to them for WITHDRAWAL;
 *   AUDIT       — read every order and report; write nothing.
 *
 * The owner (the merchant) has every power and is not a row here.
 *
 * ── A change of power ends the sessions it was given to ──────────────────────
 * Changing a sub-member's roles or removing them moves their login's
 * `sessions_valid_from` in the same transaction, so every session and stream
 * opened under the old roles is refused on its next check (`sessionIsLive`);
 * the route closes their open streams at once as well. Assignments whose duty
 * the new roles no longer carry are dropped in that transaction too.
 *
 * Every write names the owner merchant in its WHERE (trap 16).
 */
import { randomBytes } from 'node:crypto';
import { pgQuery, withTransaction } from '../client.js';

export const STAFF_ROLES = Object.freeze({ DEPOSITS: 'DEPOSITS', WITHDRAWALS: 'WITHDRAWALS', AUDIT: 'AUDIT' });
/**
 * The duty an account is assigned for. DEPOSIT needs the DEPOSITS role and
 * WITHDRAWAL the WITHDRAWALS role, held by the row (`merchant_staff_accounts_shape`).
 */
export const STAFF_DUTIES = Object.freeze({ DEPOSIT: 'DEPOSIT', WITHDRAWAL: 'WITHDRAWAL' });

const newStaffId = () => `mst_${randomBytes(10).toString('hex')}`;
const bad = (message, code = 'INVALID_SUB_MEMBER') => Object.assign(new Error(message), { status: 400, code });

/** The roles as the row holds them: known, distinct, at least one. */
export function cleanRoles(roles) {
  if (!Array.isArray(roles) || !roles.length) {
    throw bad('Give the sub-member at least one role: DEPOSITS, WITHDRAWALS or AUDIT.');
  }
  const unknown = roles.filter((r) => !STAFF_ROLES[r]);
  if (unknown.length) throw bad(`Unknown role(s): ${unknown.join(', ')}. Roles are DEPOSITS, WITHDRAWALS and AUDIT.`);
  return Object.values(STAFF_ROLES).filter((r) => roles.includes(r));
}

function toStaff(r, assignments = []) {
  if (!r) return null;
  return {
    staffId: r.staff_id,
    merchantId: r.merchant_id,
    userId: r.user_id,
    name: r.name,
    mobile: r.mobile ?? null,
    roles: [...(r.roles ?? [])],
    status: r.status,
    createdAt: r.created_at,
    removedAt: r.removed_at ?? null,
    assignments: assignments.map((a) => ({ accountId: a.account_id, duty: a.duty })),
  };
}

/**
 * Add a sub-member: their login and their row, in ONE transaction. The login
 * has no password (owner, 2026-10-14): the sub-member signs in with "Continue
 * with Telegram", and their first contact share of this mobile links it.
 * Returns { ok: true, staff } or { ok: false, reason: 'MOBILE_TAKEN' |
 * 'NAME_IS_A_MOBILE' | 'not_direct' }.
 */
export async function addStaff(merchantId, { userId, mobile, name, roles, createdBy }) {
  if (!mobile) throw bad('Enter the sub-member\'s mobile number.');
  const cleanName = String(name ?? '').trim();
  if (!cleanName || cleanName.length > 60) throw bad('Enter the sub-member\'s name (1 to 60 characters).');
  const clean = cleanRoles(roles);
  try {
    return await withTransaction(async (client) => {
      // A MERCHANT login, refused by the (mobile, account_type) index rather
      // than by a prior read two requests could both pass.
      const account = await client.query(
        `INSERT INTO users (user_id, username, mobile, status, roles, account_type)
         VALUES ($1, $2, $3, 'ACTIVE', ARRAY['merchant'], 'MERCHANT')
         ON CONFLICT (mobile, account_type) DO NOTHING
         RETURNING user_id`,
        [String(userId), cleanName, String(mobile)]);
      if (!account.rows.length) return { ok: false, reason: 'MOBILE_TAKEN' };
      const { rows } = await client.query(
        `INSERT INTO merchant_staff (staff_id, merchant_id, user_id, name, roles, created_by)
         SELECT $1, $2, $3, $4, $5, $6
          WHERE EXISTS (SELECT 1 FROM teams WHERE owner_merchant_id = $2)
         RETURNING *`,
        [newStaffId(), String(merchantId), account.rows[0].user_id, cleanName, clean, String(createdBy)]);
      if (!rows[0]) throw Object.assign(new Error('not_direct'), { notDirect: true });
      return { ok: true, staff: toStaff({ ...rows[0], mobile }) };
    });
  } catch (e) {
    if (e.notDirect) return { ok: false, reason: 'not_direct' };
    if (e.code === '23514' && e.constraint === 'merchant_staff_name_not_a_mobile') return { ok: false, reason: 'NAME_IS_A_MOBILE' };
    throw e;
  }
}

/** Evict a login's sessions inside the caller's transaction (§33: the cutoff every path checks). */
async function evictWithin(client, userId) {
  await client.query(
    `UPDATE users SET sessions_valid_from = clock_timestamp(), updated_at = now()
      WHERE user_id = $1 AND account_type = 'MERCHANT'`,
    [String(userId)]);
}

/**
 * New roles for a sub-member. Assignments whose duty the new roles do not carry
 * are dropped, and their sessions evicted, in one transaction.
 * Returns { ok: true, staff } or { ok: false, reason: 'not_found' }.
 */
export async function setRoles(merchantId, staffId, roles) {
  const clean = cleanRoles(roles);
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `UPDATE merchant_staff SET roles = $3, updated_at = now()
        WHERE staff_id = $1 AND merchant_id = $2 AND status = 'ACTIVE'
        RETURNING *`,
      [String(staffId), String(merchantId), clean]);
    if (!rows[0]) return { ok: false, reason: 'not_found' };
    await client.query(
      `DELETE FROM merchant_staff_accounts
        WHERE staff_id = $1
          AND NOT ((CASE duty WHEN 'DEPOSIT' THEN 'DEPOSITS' ELSE 'WITHDRAWALS' END) = ANY ($2::text[]))`,
      [String(staffId), clean]);
    await evictWithin(client, rows[0].user_id);
    return { ok: true, staff: toStaff(rows[0]) };
  });
}

/** Remove a sub-member, for good: their assignments go and their sessions end. */
export async function removeStaff(merchantId, staffId) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `UPDATE merchant_staff SET status = 'REMOVED', removed_at = now(), updated_at = now()
        WHERE staff_id = $1 AND merchant_id = $2 AND status = 'ACTIVE'
        RETURNING *`,
      [String(staffId), String(merchantId)]);
    if (!rows[0]) return { ok: false, reason: 'not_found' };
    await client.query('DELETE FROM merchant_staff_accounts WHERE staff_id = $1', [String(staffId)]);
    await evictWithin(client, rows[0].user_id);
    return { ok: true, staff: toStaff(rows[0]) };
  });
}

/**
 * Assign one of the merchant's accounts to a sub-member for a duty. The row's
 * trigger refuses an account of another merchant, a removed one, or a duty the
 * sub-member's roles do not carry (`merchant_staff_accounts_shape`); answered
 * here by name. Idempotent.
 */
export async function assignAccount(merchantId, staffId, accountId, duty) {
  if (!STAFF_DUTIES[duty]) throw bad('The duty is DEPOSIT or WITHDRAWAL.');
  try {
    const { rows } = await pgQuery(
      `INSERT INTO merchant_staff_accounts (staff_id, account_id, duty)
       SELECT st.staff_id, $3, $4 FROM merchant_staff st
        WHERE st.staff_id = $1 AND st.merchant_id = $2 AND st.status = 'ACTIVE'
       ON CONFLICT DO NOTHING
       RETURNING staff_id`,
      [String(staffId), String(merchantId), String(accountId), duty], 'merchant_staff_assign');
    if (rows[0]) return { ok: true };
    const staff = await getStaff(merchantId, staffId);
    if (!staff || staff.status !== 'ACTIVE') return { ok: false, reason: 'not_found' };
    return { ok: true, already: true };
  } catch (e) {
    if (e.code === '23514' && e.constraint === 'merchant_staff_accounts_shape') return { ok: false, reason: 'cannot_assign' };
    if (e.code === '23503') return { ok: false, reason: 'cannot_assign' };
    throw e;
  }
}

export async function unassignAccount(merchantId, staffId, accountId, duty) {
  const { rowCount } = await pgQuery(
    `DELETE FROM merchant_staff_accounts sa USING merchant_staff st
      WHERE sa.staff_id = st.staff_id AND st.merchant_id = $2
        AND sa.staff_id = $1 AND sa.account_id = $3 AND sa.duty = $4`,
    [String(staffId), String(merchantId), String(accountId), String(duty)], 'merchant_staff_unassign');
  return rowCount ? { ok: true } : { ok: false, reason: 'not_found' };
}

const STAFF_SELECT = `
  SELECT st.*, u.mobile FROM merchant_staff st JOIN users u ON u.user_id = st.user_id`;

async function assignmentsOf(staffIds) {
  if (!staffIds.length) return new Map();
  const { rows } = await pgQuery(
    `SELECT staff_id, account_id, duty FROM merchant_staff_accounts
      WHERE staff_id = ANY($1::text[]) ORDER BY created_at`,
    [staffIds], 'merchant_staff_assignments');
  const by = new Map(staffIds.map((id) => [id, []]));
  for (const r of rows) by.get(r.staff_id).push(r);
  return by;
}

export async function getStaff(merchantId, staffId) {
  const { rows } = await pgQuery(`${STAFF_SELECT} WHERE st.staff_id = $1 AND st.merchant_id = $2`,
    [String(staffId), String(merchantId)], 'merchant_staff_get');
  if (!rows[0]) return null;
  const by = await assignmentsOf([rows[0].staff_id]);
  return toStaff(rows[0], by.get(rows[0].staff_id));
}

/** A merchant's sub-members with their assignments; removed ones only when asked for. */
export async function listStaff(merchantId, { includeRemoved = false } = {}) {
  const { rows } = await pgQuery(
    `${STAFF_SELECT} WHERE st.merchant_id = $1 AND ($2 OR st.status = 'ACTIVE') ORDER BY st.created_at`,
    [String(merchantId), Boolean(includeRemoved)], 'merchant_staff_list');
  const by = await assignmentsOf(rows.map((r) => r.staff_id));
  return rows.map((r) => toStaff(r, by.get(r.staff_id)));
}

/** The ACTIVE sub-member a login belongs to, or null — what the login door asks. */
export async function activeStaffByUser(userId) {
  if (!userId) return null;
  const { rows } = await pgQuery(`${STAFF_SELECT} WHERE st.user_id = $1 AND st.status = 'ACTIVE'`,
    [String(userId)], 'merchant_staff_by_user');
  if (!rows[0]) return null;
  const by = await assignmentsOf([rows[0].staff_id]);
  return toStaff(rows[0], by.get(rows[0].staff_id));
}
