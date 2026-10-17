// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The admin directory: one row per player, one per merchant and one per staff
 * account, with the figures an operator sorts by (owner, 2026-10-14). Read
 * only; it owns no value.
 *
 * ── Every figure is read from its owner, never stored here ───────────────────
 * Players:
 *   VIP wallet       `wallets.deposit_paise + winnings_paise` (the VIP pockets)
 *   General wallet   `wallets.promo_paise` (§2 "The GENERAL balance")
 *   Locked           `wallets.locked_paise` (stakes on open rounds)
 *   Deposits/sells   completed BUY / SELL orders, `order_states` in tokens
 *                    (`token_amount_paise`, never `fiat_amount_paise`: trap 15)
 *   Net win/loss     settled board bets (`payout - stake` on WON, `-stake` on
 *                    LOST; phantom bets excluded) plus casino rounds
 *                    (`credited + refunded - debited`). Positive: the player is
 *                    up; negative: the player has lost that much.
 * Merchants:
 *   Processed, orders  the merchant row's own counters, moved by
 *                    `recordCompletedOrder` (`total_processed_volume_paise`,
 *                    `total_orders_completed`)
 *   Pool             the team pool(s) the merchant works from: a merchant
 *                    account's own pool, a supervisor's teams' pools, an
 *                    agent's team's pool (`team_pools`, display only, §9)
 *   Commission       their own shares (`team_commission_shares`), today and
 *                    this month on the IST calendar of the DATABASE clock
 *
 * ── Page numbers, not a keyset ───────────────────────────────────────────────
 * The order is any figure the admin picks, and a keyset over a computed sum is
 * a cursor that moves under you as money moves. An admin pages a sorted table
 * by number; a row shifting between two presses is a re-read, not a lost row.
 *
 * ── Sorting is a whitelist ──────────────────────────────────────────────────
 * The panel names a key; the key maps to a column alias here. Anything else is
 * a 400 the panel can phrase (`UNKNOWN_SORT`), never SQL.
 */
import { pgQuery } from '../client.js';

const toInt = (v) => (v === null || v === undefined ? 0 : Number(v));

/** Sort keys the players table offers → the column each sorts by. */
export const PLAYER_SORTS = Object.freeze({
  joined:      'joined_at',
  deposits:    'deposits_paise',
  withdrawals: 'withdrawals_paise',
  net:         'net_paise',
  vip:         'vip_paise',
  general:     'general_paise',
  locked:      'locked_paise',
  name:        'username',
});

/** Sort keys the merchants table offers → the column each sorts by. */
export const MERCHANT_SORTS = Object.freeze({
  joined:          'created_at',
  processed:       'processed_paise',
  orders:          'completed_orders',
  pool:            'pool_available_paise',
  commissionToday: 'commission_today_paise',
  commissionMonth: 'commission_month_paise',
  commissionTotal: 'commission_total_paise',
  name:            'name',
});

/** Which kind of merchant a row is, derived from the team rows (never stored). */
export const MERCHANT_ROLES = Object.freeze({
  MERCHANT: 'MERCHANT',      // owns a DIRECT team (a merchant account)
  SUPERVISOR: 'SUPERVISOR',  // runs agent teams
  AGENT: 'AGENT',            // a member of an agent team
  UNASSIGNED: 'UNASSIGNED',  // an agent in no team yet
});

function refuse(code, message) {
  return Object.assign(new Error(message), { status: 400, code });
}

/** The ORDER BY for a whitelisted key, with a stable tiebreak. */
function orderBy(sorts, sort, dir, fallback, idColumn) {
  const key = sort || fallback;
  const column = sorts[key];
  if (!column) throw refuse('UNKNOWN_SORT', `Unknown sort "${key}". Sort by: ${Object.keys(sorts).join(', ')}.`);
  const direction = String(dir || 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  return `ORDER BY ${column} ${direction} NULLS LAST, ${idColumn} ${direction}`;
}

/** How many rows one CSV export of a directory table may carry. */
export const DIRECTORY_EXPORT_MAX = 200_000;

/** A page of at most 200 rows, or with `exportAll` every row up to DIRECTORY_EXPORT_MAX (the CSV). */
function page(limit, pageNo, exportAll = false) {
  if (exportAll) return { size: DIRECTORY_EXPORT_MAX, offset: 0 };
  const size = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const offset = (Math.max(Number(pageNo) || 1, 1) - 1) * size;
  return { size, offset };
}

const PLAYER_SQL = `
  SELECT u.user_id, u.username, u.mobile, u.status, u.joined_at, u.last_login,
         u.play_profile, u.phantom_access, u.lost_disputes, u.high_risk_at,
         u.payment_flagged, u.is_blocked, u.block_reason,
         COALESCE(w.deposit_paise, 0) + COALESCE(w.winnings_paise, 0) AS vip_paise,
         COALESCE(w.deposit_paise, 0)  AS deposit_paise,
         COALESCE(w.winnings_paise, 0) AS winnings_paise,
         COALESCE(w.promo_paise, 0)    AS general_paise,
         COALESCE(w.locked_paise, 0)   AS locked_paise,
         COALESCE(o.deposits_paise, 0)    AS deposits_paise,
         COALESCE(o.withdrawals_paise, 0) AS withdrawals_paise,
         COALESCE(o.deposit_count, 0)     AS deposit_count,
         COALESCE(b.net_paise, 0) + COALESCE(c.net_paise, 0) AS net_paise
    FROM users u
    LEFT JOIN wallets w ON w.user_id = u.user_id
    LEFT JOIN LATERAL (
      SELECT SUM(token_amount_paise) FILTER (WHERE order_type = 'DEPOSIT')    AS deposits_paise,
             SUM(token_amount_paise) FILTER (WHERE order_type = 'WITHDRAWAL') AS withdrawals_paise,
             COUNT(*) FILTER (WHERE order_type = 'DEPOSIT')                   AS deposit_count
        FROM order_states
       WHERE user_id = u.user_id AND state = 'COMPLETED'
    ) o ON TRUE
    LEFT JOIN LATERAL (
      SELECT SUM(CASE WHEN status = 'WON' THEN payout_paise - stake_paise ELSE -stake_paise END) AS net_paise
        FROM bets
       WHERE user_id = u.user_id AND status IN ('WON', 'LOST') AND NOT is_phantom
    ) b ON TRUE
    LEFT JOIN LATERAL (
      SELECT SUM(credited_paise + refunded_paise - debited_paise) AS net_paise
        FROM casino_rounds
       WHERE user_id = u.user_id
    ) c ON TRUE`;

function toPlayerRow(r) {
  return {
    userId: r.user_id,
    username: r.username,
    mobile: r.mobile,
    status: r.status,
    joinedAt: r.joined_at,
    lastLogin: r.last_login,
    playProfile: r.play_profile,
    phantomAccess: r.phantom_access,
    lostDisputes: toInt(r.lost_disputes),
    highRiskAt: r.high_risk_at ?? null,
    paymentFlagged: Boolean(r.payment_flagged),
    blockReason: r.block_reason ?? null,
    // Paise, as integers. The panel formats; nothing here is rounded.
    wallet: {
      vipPaise: toInt(r.vip_paise),
      depositPaise: toInt(r.deposit_paise),
      winningsPaise: toInt(r.winnings_paise),
      generalPaise: toInt(r.general_paise),
      lockedPaise: toInt(r.locked_paise),
    },
    totals: {
      depositsPaise: toInt(r.deposits_paise),
      withdrawalsPaise: toInt(r.withdrawals_paise),
      depositCount: toInt(r.deposit_count),
      netPaise: toInt(r.net_paise),
    },
  };
}

/**
 * Players, one row each, sortable by any `PLAYER_SORTS` key.
 * Players only (`account_type = 'PLAYER'`, §32 S30): staff and merchant logins
 * have their own tables.
 */
export async function listPlayers({
  search = null, status = null, sort = 'joined', dir = 'desc', limit = 50, page: pageNo = 1, exportAll = false,
} = {}) {
  const order = orderBy(PLAYER_SORTS, sort, dir, 'joined', 'user_id');
  const where = ["u.account_type = 'PLAYER'"];
  const params = [];
  if (status) { params.push(String(status)); where.push(`u.status = $${params.length}`); }
  else where.push("u.status <> 'DELETED'");
  if (search) {
    // Anchored prefix, as `listUsers`: the index serves it.
    params.push(String(search));
    where.push(`(u.username ILIKE $${params.length} || '%' OR u.mobile LIKE $${params.length} || '%'
                 OR u.user_id = $${params.length})`);
  }
  const { size, offset } = page(limit, pageNo, exportAll);
  params.push(size, offset);
  const { rows } = await pgQuery(
    `SELECT d.*, COUNT(*) OVER () AS total_count FROM (${PLAYER_SQL}
      WHERE ${where.join(' AND ')}) d
      ${order}
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params, 'admin_directory_players',
  );
  return { rows: rows.map(toPlayerRow), total: rows[0] ? Number(rows[0].total_count) : 0 };
}

/** One player's directory row (the profile page's header), or null. */
export async function playerRow(userId) {
  const { rows } = await pgQuery(
    `${PLAYER_SQL} WHERE u.user_id = $1 AND u.account_type = 'PLAYER'`,
    [String(userId)], 'admin_directory_player',
  );
  return rows[0] ? toPlayerRow(rows[0]) : null;
}

const MERCHANT_SQL = `
  SELECT m.merchant_id, m.user_id, m.name, m.username, m.mobile, m.status,
         m.merchant_approval_status, m.is_online, m.is_supervisor, m.supervisor_rail,
         m.merchant_type, m.accepts_deposits, m.accepts_withdrawals, m.routing_priority,
         m.lost_disputes, m.high_risk_at, m.assignment_paused_at, m.created_at,
         m.total_processed_volume_paise AS processed_paise,
         m.total_orders_completed       AS completed_orders,
         CASE WHEN dt.team_id IS NOT NULL THEN 'MERCHANT'
              WHEN m.is_supervisor        THEN 'SUPERVISOR'
              WHEN tm.team_id IS NOT NULL THEN 'AGENT'
              ELSE 'UNASSIGNED' END AS role,
         COALESCE(dt.team_id, mt.team_id) AS team_id,
         COALESCE(dt.name, mt.name)       AS team_name,
         tm.status                        AS member_status,
         COALESCE(p.available_paise, 0) AS pool_available_paise,
         COALESCE(p.held_paise, 0)      AS pool_held_paise,
         COALESCE(p.teams, 0)           AS pool_teams,
         COALESCE(c.today_paise, 0) AS commission_today_paise,
         COALESCE(c.month_paise, 0) AS commission_month_paise,
         COALESCE(c.total_paise, 0) AS commission_total_paise
    FROM merchants m
    LEFT JOIN teams dt ON dt.kind = 'DIRECT' AND dt.owner_merchant_id = m.merchant_id
    LEFT JOIN team_members tm ON tm.merchant_id = m.merchant_id
    LEFT JOIN teams mt ON mt.team_id = tm.team_id
    LEFT JOIN LATERAL (
      SELECT SUM(tp.available_paise) AS available_paise, SUM(tp.held_paise) AS held_paise,
             COUNT(*) AS teams
        FROM team_pools tp JOIN teams t ON t.team_id = tp.team_id
       WHERE t.team_id = dt.team_id OR t.team_id = tm.team_id
          OR (t.kind = 'AGENT' AND t.supervisor_id = m.merchant_id)
    ) p ON TRUE
    LEFT JOIN LATERAL (
      SELECT SUM(share_paise) FILTER (
               WHERE (created_at AT TIME ZONE 'Asia/Kolkata')::date
                   = (now() AT TIME ZONE 'Asia/Kolkata')::date) AS today_paise,
             SUM(share_paise) FILTER (
               WHERE date_trunc('month', created_at AT TIME ZONE 'Asia/Kolkata')
                   = date_trunc('month', now() AT TIME ZONE 'Asia/Kolkata')) AS month_paise,
             SUM(share_paise) AS total_paise
        FROM team_commission_shares
       WHERE merchant_id = m.merchant_id
    ) c ON TRUE`;

function toMerchantRow(r) {
  return {
    merchantId: r.merchant_id,
    userId: r.user_id,
    name: r.username || r.name || '',
    mobile: r.mobile || '',
    status: r.status,
    merchantApprovalStatus: r.merchant_approval_status,
    isOnline: Boolean(r.is_online),
    role: r.role,
    rail: r.is_supervisor ? (r.supervisor_rail ?? null) : r.merchant_type,
    acceptsDeposits: Boolean(r.accepts_deposits),
    acceptsWithdrawals: Boolean(r.accepts_withdrawals),
    routingPriority: Number(r.routing_priority),
    lostDisputes: toInt(r.lost_disputes),
    highRiskAt: r.high_risk_at ?? null,
    assignmentPausedAt: r.assignment_paused_at ?? null,
    createdAt: r.created_at,
    team: r.team_id ? { teamId: r.team_id, name: r.team_name, memberStatus: r.member_status ?? null } : null,
    processedPaise: toInt(r.processed_paise),
    completedOrders: toInt(r.completed_orders),
    pool: {
      availablePaise: toInt(r.pool_available_paise),
      heldPaise: toInt(r.pool_held_paise),
      teams: toInt(r.pool_teams),
    },
    commission: {
      todayPaise: toInt(r.commission_today_paise),
      monthPaise: toInt(r.commission_month_paise),
      totalPaise: toInt(r.commission_total_paise),
    },
  };
}

/**
 * Merchants (agents, supervisors, merchant accounts), one row each, sortable by
 * any `MERCHANT_SORTS` key and narrowed by `role` (a `MERCHANT_ROLES` key) and
 * `approval` (the approval status).
 */
export async function listMerchants({
  search = null, role = null, approval = null, status = null,
  sort = 'joined', dir = 'desc', limit = 50, page: pageNo = 1, exportAll = false,
} = {}) {
  const order = orderBy(MERCHANT_SORTS, sort, dir, 'joined', 'merchant_id');
  if (role && !MERCHANT_ROLES[role]) {
    throw refuse('UNKNOWN_ROLE', `Unknown role "${role}". One of: ${Object.keys(MERCHANT_ROLES).join(', ')}.`);
  }
  const where = [];
  const params = [];
  if (role) { params.push(String(role)); where.push(`role = $${params.length}`); }
  if (approval) { params.push(String(approval)); where.push(`merchant_approval_status = $${params.length}`); }
  if (status) { params.push(String(status)); where.push(`status = $${params.length}`); }
  if (search) {
    params.push(`%${String(search)}%`);
    where.push(`(name ILIKE $${params.length} OR username ILIKE $${params.length}
                 OR mobile ILIKE $${params.length} OR merchant_id = $${params.length + 1})`);
    params.push(String(search));
  }
  const { size, offset } = page(limit, pageNo, exportAll);
  params.push(size, offset);
  const { rows } = await pgQuery(
    `SELECT d.*, COUNT(*) OVER () AS total_count FROM (${MERCHANT_SQL}) d
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ${order}
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params, 'admin_directory_merchants',
  );
  return { rows: rows.map(toMerchantRow), total: rows[0] ? Number(rows[0].total_count) : 0 };
}

/** One merchant's directory row (the profile page's header), or null. */
export async function merchantRow(merchantId) {
  const { rows } = await pgQuery(
    `${MERCHANT_SQL} WHERE m.merchant_id = $1`,
    [String(merchantId)], 'admin_directory_merchant',
  );
  return rows[0] ? toMerchantRow(rows[0]) : null;
}

// ── Staff ─────────────────────────────────────────────────────────────────────
// Every STAFF account (admin, sub-admin, queue manager, mediator) as one row.
// The roles are the account's own flags on `users`; the areas are the keys its
// grant holds true (`sub_admin_permissions`, validated by staffPermissions.js);
// whether it has an authenticator is a yes/no from `staff_totp`, never the
// secret. Nothing here is stored.

/** Sort keys the staff table offers → the column each sorts by. */
export const STAFF_SORTS = Object.freeze({
  joined:    'joined_at',
  lastLogin: 'last_login',
  areas:     'area_count',
  name:      'username',
});

/** A staff role → the flag on `users` that makes an account one. */
export const STAFF_ROLES = Object.freeze({
  ADMIN: 'is_admin',
  SUB_ADMIN: 'is_sub_admin',
  QUEUE_MANAGER: 'is_queue_manager',
  MEDIATOR: 'is_mediator',
});

const STAFF_SQL = `
  SELECT u.user_id, u.username, u.mobile, u.status, u.joined_at, u.last_login,
         u.is_admin, u.is_sub_admin, u.is_queue_manager, u.is_mediator, u.is_blocked,
         u.sub_admin_permissions,
         (SELECT COUNT(*) FROM jsonb_each(u.sub_admin_permissions) e WHERE e.value = 'true'::jsonb) AS area_count,
         (t.user_id IS NOT NULL) AS authenticator_enrolled
    FROM users u
    LEFT JOIN staff_totp t ON t.user_id = u.user_id AND t.enrolled_at IS NOT NULL`;

function toStaffRow(r) {
  const grant = r.sub_admin_permissions || {};
  return {
    userId: r.user_id,
    username: r.username,
    mobile: r.mobile,
    status: r.status,
    isBlocked: Boolean(r.is_blocked),
    joinedAt: r.joined_at,
    lastLogin: r.last_login,
    roles: Object.keys(STAFF_ROLES).filter((role) => r[STAFF_ROLES[role]]),
    // The areas this account holds, by key; labels are the catalogue's
    // (`GET /staff-permissions`), so the panel keeps no list of its own.
    areas: Object.keys(grant).filter((k) => grant[k] === true),
    authenticatorEnrolled: Boolean(r.authenticator_enrolled),
  };
}

/**
 * The staff table, sorted by a whitelisted key and paged by number.
 * `role` narrows to one STAFF_ROLES key; an unknown one is a 400.
 */
export async function listStaff({
  search = null, role = null, sort = 'joined', dir = 'desc', limit = 50, page: pageNo = 1, exportAll = false,
} = {}) {
  const order = orderBy(STAFF_SORTS, sort, dir, 'joined', 'user_id');
  const where = ["u.account_type = 'STAFF'", "u.status <> 'DELETED'"];
  const params = [];
  if (role) {
    const flag = STAFF_ROLES[String(role)];
    if (!flag) throw refuse('UNKNOWN_ROLE', `Unknown role "${role}". Roles: ${Object.keys(STAFF_ROLES).join(', ')}.`);
    where.push(`u.${flag}`);
  }
  if (search) {
    params.push(String(search));
    where.push(`(u.username ILIKE $${params.length} || '%' OR u.mobile LIKE $${params.length} || '%'
                 OR u.user_id = $${params.length})`);
  }
  const { size, offset } = page(limit, pageNo, exportAll);
  params.push(size, offset);
  const { rows } = await pgQuery(
    `SELECT d.*, COUNT(*) OVER () AS total_count FROM (${STAFF_SQL}
      WHERE ${where.join(' AND ')}) d
      ${order}
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params, 'admin_directory_staff',
  );
  return { rows: rows.map(toStaffRow), total: rows[0] ? Number(rows[0].total_count) : 0 };
}

/** One staff account's row (the profile page), or null for any other account. */
export async function staffRow(userId) {
  const { rows } = await pgQuery(
    `${STAFF_SQL} WHERE u.user_id = $1 AND u.account_type = 'STAFF'`,
    [String(userId)], 'admin_directory_staff_one',
  );
  return rows[0] ? toStaffRow(rows[0]) : null;
}
