// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * postgres/merchantPg.js — the merchant record.
 *
 * A merchant settles real INR and USDT. This module owns the row that says who
 * they are, which currency they settle in, and what credentials money is sent
 * to.
 *
 * ── What is NOT here, and why ───────────────────────────────────────────────
 *
 * A TOKEN BALANCE. A merchant holds none: their team's pool does
 * (`teamPools.js`, PROJECT_STATUS §3.10 2c). Which member an order goes to is
 * `teamRouting.js`.
 *
 * THE ACTIVE ORDER COUNT. The document store kept `activeOrderCount` as an
 * accumulator: incremented on assign, decremented on finish. That counts passes
 * rather than rows, so a crash between the two loses the decrement permanently
 * and the merchant is throttled forever by a number nothing can correct. It is
 * derived from `order_states` where it is used (`teamRouting.js` counts a
 * member's open orders under their row lock), which is the same rule the money
 * counters follow.
 *
 * ── Two things the row enforces that a schema flag could not ────────────────
 * `public_ref` is immutable by TRIGGER, because the document store's
 * `immutable: true` is honoured by a document save and ignored by an update
 * operator. And `merchant_type` is a GENERATED column over
 * `accepted_currencies[1]` rather than an application-layer virtual, so the
 * scalar the panels read cannot drift from the array assignment filters on.
 */
import { USDT_CHAIN_SPEC } from '../../backend/domains/merchant/merchantCurrency.js';
import { nonNegative } from '../numbers.js';
import { pgQuery, getPool, connectGuarded } from '../client.js';
import { randomBytes } from 'node:crypto';
import { rupeesToPaise, paiseToRupees } from '../../backend/shared/money.js';

/** The reference players see. Random, not derived from anything identifying. */
export function generateMerchantPublicRef() {
  return `M${randomBytes(8).toString('hex').toUpperCase()}`;
}

/** A merchant's own id. Random 24-hex, the same shape ids travel in elsewhere. */
export function newMerchantId() {
  return randomBytes(12).toString('hex');
}

const COLUMNS = `merchant_id, user_id, name, public_ref, username, mobile, email,
  two_factor_enabled, two_factor_enrolled_at, status, suspension_reason, is_online,
  accepts_deposits, accepts_withdrawals, accepted_currencies, merchant_type,
  bank_account_holder_name, bank_upi_id, bank_name, bank_account_no, bank_ifsc,
  usdt_address_trc20, usdt_address_bep20,
  min_deposit_paise, max_deposit_paise, min_withdraw_paise, max_withdraw_paise,
  total_processed_volume_paise, earnings_paise, total_deposit_amount_paise,
  total_withdrawal_amount_paise, total_deposits_processed, total_withdrawals_processed,
  rating, last_online_toggle, panel_url,
  merchant_approval_status, merchant_approved_by, merchant_approved_at,
  merchant_rejection_reason,
  monthly_processed_paise, daily_processed_paise, total_orders_processed,
  stats_last_reset_at,
  success_rate, avg_response_minutes, dispute_rate, consecutive_rejections,
  consecutive_expiries, assignment_paused_at, assignment_pause_reason, cash_ready,
  total_orders_completed, total_orders_all, is_supervisor, supervisor_rail,
  created_at, updated_at`;

/**
 * The same columns, qualified. A join against a CTE that also has
 * `merchant_id` makes the bare list ambiguous, and PostgreSQL says so at
 * runtime rather than at load — derived from COLUMNS so the two cannot drift.
 */
const M_COLUMNS = COLUMNS.split(',').map((c) => `m.${c.trim()}`).join(', ');

/** node-postgres returns BIGINT as a STRING. Cast once, here, at the boundary. */
const toInt = (v) => (v === null || v === undefined ? null : Number(v));
const rupees = (v) => paiseToRupees(Number(v ?? 0));

/**
 * The shape the routes and panels already read.
 *
 * Money comes back in RUPEES under the names the callers use (`limits.minDeposit`,
 * `earnings`), because that is what they render and compare against a rupee
 * order amount. Paise is what is STORED and what the constraints check; this is
 * the one wall it crosses.
 */
function toMerchant(row) {
  if (!row) return null;
  return {
    merchantId: row.merchant_id,
    // SECURITY-RELEVANT: merchant_id aliases _id/id for downstream authorization.
    // merchantAuth.js reads merchant._id and assigns it to req.merchantId, which
    // every merchant handler then passes as the SECOND argument of
    // getMerchantOrder(orderId, merchantId) — the ownership test lives in that
    // query's WHERE clause. Do not remove or rename this alias without updating
    // the authorization flow: req.merchantId would become undefined and every
    // lookup would match no row. That fails CLOSED (no data leak) but silently
    // breaks the merchant panel. Covered by the regression test in
    // backend/tests/routes/merchantPanelRoutes.test.js.
    _id: row.merchant_id,
    id: row.merchant_id,
    userId: row.user_id,
    name: row.name,
    publicRef: row.public_ref,
    username: row.username,
    mobile: row.mobile,
    email: row.email,

    twoFactorEnabled: row.two_factor_enabled,
    twoFactorEnrolledAt: row.two_factor_enrolled_at,

    status: row.status,
    suspensionReason: row.suspension_reason,
    isOnline: row.is_online,
    acceptsDeposits: row.accepts_deposits,
    acceptsWithdrawals: row.accepts_withdrawals,
    acceptedCurrencies: row.accepted_currencies,
    merchantType: row.merchant_type,

    bankDetails: {
      accountHolderName: row.bank_account_holder_name,
      upiId: row.bank_upi_id,
      bankName: row.bank_name,
      accountNo: row.bank_account_no,
      ifsc: row.bank_ifsc,
    },
    // One address PER CHAIN. USDT sent to a TRC-20 address from a BEP-20
    // wallet is gone, so which chain an address belongs to is a fact the row
    // states rather than one a reader infers from its shape.
    usdtAddressTrc20: row.usdt_address_trc20,
    usdtAddressBep20: row.usdt_address_bep20,

    limits: {
      minDeposit: rupees(row.min_deposit_paise),
      maxDeposit: rupees(row.max_deposit_paise),
      minWithdraw: rupees(row.min_withdraw_paise),
      maxWithdraw: rupees(row.max_withdraw_paise),
    },
    totalProcessedVolume: rupees(row.total_processed_volume_paise),
    earnings: rupees(row.earnings_paise),
    totalDepositAmount: rupees(row.total_deposit_amount_paise),
    totalWithdrawalAmount: rupees(row.total_withdrawal_amount_paise),
    totalDepositsProcessed: toInt(row.total_deposits_processed),
    totalWithdrawalsProcessed: toInt(row.total_withdrawals_processed),

    rating: Number(row.rating),
    lastOnlineToggle: row.last_online_toggle,
    panelUrl: row.panel_url,

    merchantApprovalStatus: row.merchant_approval_status,
    merchantApprovedBy: row.merchant_approved_by,
    merchantApprovedAt: row.merchant_approved_at,
    merchantRejectionReason: row.merchant_rejection_reason,

    merchantStats: {
      monthlyProcessed: rupees(row.monthly_processed_paise),
      dailyProcessed: rupees(row.daily_processed_paise),
      totalOrdersProcessed: toInt(row.total_orders_processed),
      lastResetDate: row.stats_last_reset_at,
    },

    successRate: Number(row.success_rate),
    avgResponseMinutes: Number(row.avg_response_minutes),
    disputeRate: Number(row.dispute_rate),
    consecutiveRejections: toInt(row.consecutive_rejections),
    consecutiveExpiries: toInt(row.consecutive_expiries),
    assignmentPausedAt: row.assignment_paused_at,
    // A CASH member at the machine, ready for a buy (§3.10). Switched off by
    // the assignment that hands them one.
    cashReady: row.cash_ready === true,
    assignmentPauseReason: row.assignment_pause_reason,
    totalOrdersCompleted: toInt(row.total_orders_completed),
    totalOrdersAll: toInt(row.total_orders_all),
    // A supervisor runs teams and serves no orders; its rail is what every
    // team under it settles on (teams.js).
    isSupervisor: row.is_supervisor === true,
    supervisorRail: row.supervisor_rail ?? null,

    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ── Reads ────────────────────────────────────────────────────────────────────

export async function getMerchant(merchantId) {
  if (!merchantId) return null;
  const { rows } = await pgQuery(
    `SELECT ${COLUMNS} FROM merchants WHERE merchant_id = $1`,
    [String(merchantId)], 'merchant_get',
  );
  return toMerchant(rows[0]);
}

/** Several merchants in one round trip. Missing ids are simply absent. */
export async function getMerchants(merchantIds = []) {
  const ids = [...new Set(merchantIds.filter(Boolean).map(String))];
  if (!ids.length) return [];
  const { rows } = await pgQuery(
    `SELECT ${COLUMNS} FROM merchants WHERE merchant_id = ANY($1::text[])`,
    [ids], 'merchant_get_many',
  );
  return rows.map(toMerchant);
}

export async function getMerchantByUserId(userId) {
  if (!userId) return null;
  const { rows } = await pgQuery(
    `SELECT ${COLUMNS} FROM merchants WHERE user_id = $1`, [String(userId)], 'merchant_get_user',
  );
  return toMerchant(rows[0]);
}

export async function getMerchantByPublicRef(publicRef) {
  if (!publicRef) return null;
  const { rows } = await pgQuery(
    `SELECT ${COLUMNS} FROM merchants WHERE public_ref = $1`, [String(publicRef)], 'merchant_get_ref',
  );
  return toMerchant(rows[0]);
}

/** The login lookup: mobile or username, case-insensitively for the username. */
export async function getMerchantByLogin(identifier) {
  if (!identifier) return null;
  const { rows } = await pgQuery(
    `SELECT ${COLUMNS} FROM merchants
      WHERE mobile = $1 OR lower(username) = lower($1) LIMIT 1`,
    [String(identifier)], 'merchant_get_login',
  );
  return toMerchant(rows[0]);
}

/**
 * The credential columns, for the sign-in path only.
 *
 * Separate from `getMerchant` so a password hash or a 2FA secret cannot reach a
 * response body by accident — a caller has to ask for this by name, and no
 * route that renders a merchant calls it.
 */
export async function getMerchantCredentials(merchantId) {
  if (!merchantId) return null;
  const { rows } = await pgQuery(
    // The password comes from the merchant's LOGIN row — the one owner, and
    // the row a password reset writes. The second factor stays on `merchants`.
    `SELECT m.merchant_id, u.password_hash, m.two_factor_enabled, m.two_factor_secret,
            m.two_factor_pending_secret, m.two_factor_last_counter, m.backup_codes
       FROM merchants m
       LEFT JOIN users u ON u.user_id = m.user_id AND u.account_type = 'MERCHANT'
      WHERE m.merchant_id = $1`,
    [String(merchantId)], 'merchant_get_credentials',
  );
  const r = rows[0];
  return r ? {
    merchantId: r.merchant_id,
    passwordHash: r.password_hash,
    twoFactorEnabled: r.two_factor_enabled,
    twoFactorSecret: r.two_factor_secret,
    twoFactorPendingSecret: r.two_factor_pending_secret,
    twoFactorLastCounter: toInt(r.two_factor_last_counter),
    backupCodes: r.backup_codes ?? [],
  } : null;
}

/**
 * The admin list. Keyset pagination on `(created_at, merchant_id)`.
 *
 * Not OFFSET: a merchant created while an admin pages through the list shifts
 * every later row by one, and the page after it silently skips a merchant.
 */
export async function listMerchants({
  status = null, approvalStatus = null, currency = null, search = null,
  limit = 50, cursor = null,
} = {}) {
  const where = [];
  const params = [];
  // `replaceAll`, not `replace`. A string pattern replaces the FIRST occurrence
  // only, so a clause naming the same value twice —
  //
  //     add('(username ILIKE $? || \'%\' OR mobile LIKE $? || \'%\')', search)
  //
  // — left a literal `$?` in the SQL and PostgreSQL answered 42601, syntax
  // error. That is every admin search for a player, 500ing since the search box
  // was added: `serverError` answers with nothing (§2), so the screen showed an
  // empty list and an admin read it as "no such player".
  //
  // CLAUDE.md trap 13 is this exact mistake, recorded against the mutation
  // harness — "String.replace(string, …) changes the first occurrence only" —
  // and it was made a second time in production SQL. Fixed in all six
  // repositories that carry this helper, not just the one with a live caller
  // (§0.15): the other five are one two-placeholder clause away from the same
  // 500. One value, two references to the same $n, which is what Postgres wants.
  const add = (sql, value) => { params.push(value); where.push(sql.replaceAll('$?', `$${params.length}`)); };

  if (status) add('status = $?', String(status));
  if (approvalStatus) add('merchant_approval_status = $?', String(approvalStatus));
  if (currency) add('merchant_type = $?', String(currency));
  if (search) {
    params.push(`%${String(search)}%`);
    where.push(`(name ILIKE $${params.length} OR username ILIKE $${params.length}
                 OR mobile ILIKE $${params.length} OR public_ref ILIKE $${params.length})`);
  }
  if (cursor?.createdAt && cursor?.merchantId) {
    params.push(cursor.createdAt, String(cursor.merchantId));
    where.push(`(created_at, merchant_id) < ($${params.length - 1}, $${params.length})`);
  }

  const size = Math.min(Math.max(Number(limit) || 50, 1), 500);
  const { rows } = await pgQuery(
    `SELECT ${COLUMNS}, COUNT(*) OVER () AS total_count FROM merchants
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY created_at DESC, merchant_id DESC
      LIMIT ${size + 1}`,
    params, 'merchant_list',
  );

  const hasMore = rows.length > size;
  const page = rows.slice(0, size);
  const last = page[page.length - 1];
  return {
    merchants: page.map(toMerchant),
    total: rows[0] ? Number(rows[0].total_count) : 0,
    nextCursor: hasMore && last
      ? { createdAt: last.created_at, merchantId: last.merchant_id }
      : null,
  };
}

/** Aggregate counts for the admin dashboard, in one pass over the table. */
export async function merchantCounts() {
  const { rows } = await pgQuery(
    `SELECT
       COUNT(*)::int                                                AS total,
       COUNT(*) FILTER (WHERE status = 'ACTIVE')::int                AS active,
       COUNT(*) FILTER (WHERE is_online)::int                        AS online,
       COUNT(*) FILTER (WHERE merchant_approval_status = 'PENDING')::int AS pending_approval,
       COUNT(*) FILTER (WHERE merchant_type = 'INR')::int            AS inr,
       COUNT(*) FILTER (WHERE merchant_type = 'USDT')::int           AS usdt
     FROM merchants`, [], 'merchant_counts',
  );
  const r = rows[0];
  return {
    total: r.total, active: r.active, online: r.online,
    pendingApproval: r.pending_approval, inr: r.inr, usdt: r.usdt,
  };
}

// ── Writes ───────────────────────────────────────────────────────────────────

/**
 * Columns `updateMerchant` may write, and the shape each expects.
 *
 * An allowlist that THROWS on anything else. The document model silently
 * discarded a write to an undeclared path — an approval that recorded no
 * reviewer, a counter that incremented nothing, each reporting success. A typo
 * here throws instead.
 *
 * `public_ref`, `merchant_id`, `merchant_type` and the money counters are
 * absent deliberately: the first two are identity, the third is generated, and
 * the counters move through the arithmetic writers below so two concurrent
 * settlements cannot lose one of them to a read-modify-write.
 */
const UPDATABLE = new Set([
  'user_id', 'name', 'username', 'mobile', 'email',
  'two_factor_enabled', 'two_factor_secret', 'two_factor_pending_secret',
  'two_factor_last_counter', 'two_factor_enrolled_at', 'backup_codes',
  'status', 'suspension_reason', 'is_online', 'accepts_deposits', 'accepts_withdrawals',
  'accepted_currencies',
  'bank_account_holder_name', 'bank_upi_id', 'bank_name', 'bank_account_no', 'bank_ifsc',
  'usdt_address_trc20', 'usdt_address_bep20',
  'min_deposit_paise', 'max_deposit_paise', 'min_withdraw_paise', 'max_withdraw_paise',
  'rating', 'last_online_toggle', 'panel_url',
  'merchant_approval_status', 'merchant_approved_by', 'merchant_approved_at',
  'merchant_rejection_reason',
  'success_rate', 'avg_response_minutes', 'dispute_rate',
]);

/** camelCase → column, derived from the allowlist so the two cannot drift. */
const CAMEL_TO_COLUMN = Object.freeze(Object.fromEntries(
  [...UPDATABLE].map((col) => [col.replace(/_([a-z])/g, (_, c) => c.toUpperCase()), col]),
));

/**
 * Nested names the panels use, mapped to the flat columns behind them.
 *
 * The bank details were an embedded object in the document model and the whole
 * admin panel writes `bankDetails.upiId`. They are columns now, because two
 * merchants sharing a UPI id must be refused by an index and an index cannot
 * reach inside a JSON blob — but the caller keeps its vocabulary.
 */
const NESTED_TO_COLUMN = Object.freeze({
  'bankDetails.accountHolderName': 'bank_account_holder_name',
  'bankDetails.upiId': 'bank_upi_id',
  'bankDetails.bankName': 'bank_name',
  'bankDetails.accountNo': 'bank_account_no',
  'bankDetails.ifsc': 'bank_ifsc',
  'limits.minDeposit': 'min_deposit_paise',
  'limits.maxDeposit': 'max_deposit_paise',
  'limits.minWithdraw': 'min_withdraw_paise',
  'limits.maxWithdraw': 'max_withdraw_paise',
  // `minOrder`/`maxOrder` were here too, and are gone with their columns. The
  // lesson they left is worth keeping: a field must be WRITABLE under the name
  // it is READABLE under. They were readable as `minOrder` and writable only as
  // `minOrderPaise`, so every save 500'd with "refusing to write unknown or
  // protected column(s)" and the panel said "Failed to save limits" on a save
  // that had never once been possible.
});

/** Columns holding money, so a caller passing rupees gets paise stored. */
const MONEY_COLUMNS = new Set([
  'min_deposit_paise', 'max_deposit_paise', 'min_withdraw_paise',
  'max_withdraw_paise',
]);

/** Flatten `{ bankDetails: { upiId } }` into the dotted names above. */
function flatten(patch, prefix = '') {
  const out = {};
  for (const [key, value] of Object.entries(patch)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)
        && !(value instanceof Date) && (path === 'bankDetails' || path === 'limits')) {
      Object.assign(out, flatten(value, path));
    } else {
      out[path] = value;
    }
  }
  return out;
}

function toColumns(patch, fn) {
  const out = {};
  const unknown = [];
  for (const [key, value] of Object.entries(flatten(patch))) {
    if (value === undefined) continue;
    const column = UPDATABLE.has(key) ? key : (CAMEL_TO_COLUMN[key] ?? NESTED_TO_COLUMN[key]);
    if (!column) { unknown.push(key); continue; }
    out[column] = MONEY_COLUMNS.has(column) ? rupeesToPaise(value) : value;
  }
  if (unknown.length) {
    throw new Error(`${fn}: refusing to write unknown or protected column(s): ${unknown.join(', ')}`);
  }
  return out;
}

/**
 * Create a merchant.
 *
 * The rail is normalised to a single-element array here rather than trusted to
 * the caller, because the CHECK will refuse anything else and a 500 at the
 * constraint tells an operator less than a value that was never wrong.
 */
export async function createMerchant({
  merchantId = null, userId = null, name, publicRef = null,
  username = null, mobile = null, email = null,
  currency = 'INR', status = 'PENDING', bankDetails = null,
  usdtAddressTrc20 = null, usdtAddressBep20 = null, panelUrl = '',
  limits = null, client = null,
} = {}) {
  if (!name) throw new Error('createMerchant requires a name');
  const id = String(merchantId || newMerchantId());
  const ref = String(publicRef || generateMerchantPublicRef());

  const run = client
    ? (text, params) => client.query(text, params)
    : (text, params) => pgQuery(text, params, 'merchant_create');

  const l = limits || {};
  const { rows } = await run(
    `INSERT INTO merchants (
       merchant_id, user_id, name, public_ref, username, mobile, email,
       accepted_currencies, status,
       bank_account_holder_name, bank_upi_id, bank_name, bank_account_no, bank_ifsc,
       usdt_address_trc20, usdt_address_bep20, panel_url,
       min_deposit_paise, max_deposit_paise, min_withdraw_paise, max_withdraw_paise)
     VALUES ($1,$2,$3,$4,$5,$6,$7, ARRAY[$8], $9,
             $10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
     RETURNING ${COLUMNS}`,
    [id, userId ? String(userId) : null, String(name), ref,
      username || null, mobile || null, email || null,
      String(currency), String(status),
      bankDetails?.accountHolderName || null, bankDetails?.upiId || null,
      bankDetails?.bankName || null, bankDetails?.accountNo || null, bankDetails?.ifsc || null,
      usdtAddressTrc20 || null, usdtAddressBep20 || null, panelUrl || '',
      rupeesToPaise(l.minDeposit ?? 500), rupeesToPaise(l.maxDeposit ?? 50000),
      rupeesToPaise(l.minWithdraw ?? 500), rupeesToPaise(l.maxWithdraw ?? 50000)],
  );
  return toMerchant(rows[0]);
}

/** Patch a merchant. Unknown or protected columns are REFUSED, not dropped. */
export async function updateMerchant(merchantId, patch = {}) {
  if (!merchantId) throw new Error('updateMerchant requires a merchantId');
  const entries = Object.entries(toColumns(patch, 'updateMerchant'));
  if (!entries.length) return getMerchant(merchantId);

  const sets = entries.map(([col], i) => `${col} = $${i + 2}`);
  const { rows } = await pgQuery(
    `UPDATE merchants SET ${sets.join(', ')}, updated_at = now()
      WHERE merchant_id = $1 RETURNING ${COLUMNS}`,
    [String(merchantId), ...entries.map(([, v]) => v)],
    'merchant_update',
  );
  return toMerchant(rows[0]);
}

/**
 * Flip the online switch, and record WHEN.
 *
 * One statement: the toggle and its timestamp cannot disagree, and two rapid
 * toggles cannot interleave into "online, with the timestamp of going offline".
 */
export async function setOnline(merchantId, isOnline) {
  const { rows } = await pgQuery(
    `UPDATE merchants SET is_online = $2, last_online_toggle = now(), updated_at = now()
      WHERE merchant_id = $1 RETURNING ${COLUMNS}`,
    [String(merchantId), Boolean(isOnline)], 'merchant_set_online',
  );
  return toMerchant(rows[0]);
}

/**
 * Record a completed order against the merchant's lifetime totals.
 *
 * The arithmetic is IN THE STATEMENT. A read-modify-write in the application
 * loses one of two concurrent settlements silently — the money is right and the
 * merchant's history is short by one order, which is the kind of drift nobody
 * notices until an operator asks why the totals do not add up.
 *
 * The rates are recomputed from the counters in the same statement rather than
 * patched separately, so `success_rate` can never describe a different number
 * of orders than `total_orders_all` counts.
 */
export async function recordCompletedOrder(merchantId, {
  direction, amountRupees = 0, earningsRupees = 0, disputed = false, responseMinutes = null,
}) {
  const amountPaise = rupeesToPaise(amountRupees || 0);
  const earnPaise = rupeesToPaise(earningsRupees || 0);
  const isDeposit = direction === 'DEPOSIT';

  const { rows } = await pgQuery(
    `UPDATE merchants SET
       total_orders_all       = total_orders_all + 1,
       total_orders_completed = total_orders_completed + (CASE WHEN $5 THEN 0 ELSE 1 END),
       total_orders_processed = total_orders_processed + 1,
       total_processed_volume_paise = total_processed_volume_paise + $2,
       earnings_paise               = earnings_paise + $3,
       monthly_processed_paise      = monthly_processed_paise + $2,
       daily_processed_paise        = daily_processed_paise + $2,
       total_deposits_processed     = total_deposits_processed + (CASE WHEN $4 THEN 1 ELSE 0 END),
       total_withdrawals_processed  = total_withdrawals_processed + (CASE WHEN $4 THEN 0 ELSE 1 END),
       total_deposit_amount_paise   = total_deposit_amount_paise
                                      + (CASE WHEN $4 THEN $2 ELSE 0 END),
       total_withdrawal_amount_paise = total_withdrawal_amount_paise
                                      + (CASE WHEN $4 THEN 0 ELSE $2 END),
       -- Derived from the counters this same statement just moved, so the rate
       -- and the count it describes are always the same pair.
       success_rate = (total_orders_completed + (CASE WHEN $5 THEN 0 ELSE 1 END))::float8
                      / GREATEST(total_orders_all + 1, 1),
       dispute_rate = LEAST(1.0, GREATEST(0.0,
                        (dispute_rate * total_orders_all + (CASE WHEN $5 THEN 1 ELSE 0 END))
                        / GREATEST(total_orders_all + 1, 1))),
       -- A rolling average, weighted by the orders already in it. NULL leaves
       -- it alone: "we did not measure this one" is not "it took zero minutes".
       avg_response_minutes = CASE WHEN $6::float8 IS NULL THEN avg_response_minutes
         ELSE (avg_response_minutes * total_orders_all + $6::float8)
              / GREATEST(total_orders_all + 1, 1) END,
       updated_at = now()
     WHERE merchant_id = $1
     RETURNING ${COLUMNS}`,
    [String(merchantId), amountPaise, earnPaise, isDeposit, Boolean(disputed),
      responseMinutes === null ? null : Number(responseMinutes)],
    'merchant_record_order',
  );
  return toMerchant(rows[0]);
}

/**
 * Reset the periodic counters.
 *
 * Guarded by the timestamp IN THE STATEMENT: two workers waking at midnight
 * both see a stale `stats_last_reset_at`, and a check-then-write would let both
 * reset — the second one wiping a day that had already started accumulating.
 * Here the second UPDATE matches no row.
 */
export async function resetPeriodicStats(merchantId, { period = 'daily', notResetSince } = {}) {
  const column = period === 'monthly' ? 'monthly_processed_paise' : 'daily_processed_paise';
  const { rows } = await pgQuery(
    `UPDATE merchants
        SET ${column} = 0, stats_last_reset_at = now(), updated_at = now()
      WHERE merchant_id = $1 AND stats_last_reset_at < $2
      RETURNING merchant_id`,
    [String(merchantId), notResetSince ?? new Date(Date.now() - 86_400_000)],
    'merchant_reset_stats',
  );
  return rows.length > 0;
}

/**
 * Suspend a merchant, with the reason the CHECK requires.
 *
 * A suspension without a reason is one nobody can appeal, so the row refuses
 * it. Raised here as a plain argument error rather than a constraint violation,
 * because the caller can fix it and a 500 does not say so.
 */
/**
 * Another buy order for this merchant expired with nobody having paid.
 *
 * Advanced and read in ONE statement, for the same reason the refusal streak
 * is: two orders expiring in the same sweep must not both read 2 and both
 * decide they were the third.
 *
 * This is NOT `consecutive_rejections`. An expiry is not a refusal — the
 * merchant did nothing — so it must never reach the suspension cap. What three
 * in a row means is that something about this merchant may be broken, which is
 * a different question with a different answer.
 */
export async function bumpConsecutiveExpiries(merchantId) {
  const { rows } = await pgQuery(
    `UPDATE merchants SET consecutive_expiries = consecutive_expiries + 1, updated_at = now()
      WHERE merchant_id = $1
      RETURNING consecutive_expiries`,
    [String(merchantId)], 'merchant_bump_expiries',
  );
  return rows.length ? Number(rows[0].consecutive_expiries) : 0;
}

/** A completed order says the merchant is working. The expiry run ends. */
export async function resetConsecutiveExpiries(merchantId) {
  await pgQuery(
    `UPDATE merchants SET consecutive_expiries = 0, updated_at = now()
      WHERE merchant_id = $1 AND consecutive_expiries <> 0`,
    [String(merchantId)], 'merchant_reset_expiries',
  );
}

/**
 * Stop assigning new orders to this merchant until somebody has spoken to them.
 *
 * NOT a suspension. A suspension says the merchant did something wrong; this
 * says the platform cannot tell whether they are working, and will not send
 * another player to find out. They keep every order they already hold — taking
 * those away would strand players who are mid-payment on them — and they keep
 * their account, their balance and their history.
 *
 * It has no timer, by the same decision as a suspension: an admin reads the
 * reason, talks to the merchant, and lifts it. A clock cannot tell whether the
 * QR was fixed.
 */
export async function pauseAssignment(merchantId, reason) {
  if (!String(reason ?? '').trim()) throw new Error('pauseAssignment requires a reason');
  const { rows } = await pgQuery(
    `UPDATE merchants
        SET assignment_paused_at = COALESCE(assignment_paused_at, now()),
            assignment_pause_reason = $2,
            updated_at = now()
      WHERE merchant_id = $1
      RETURNING ${COLUMNS}`,
    [String(merchantId), String(reason).trim().slice(0, 500)], 'merchant_pause_assignment',
  );
  return toMerchant(rows[0]);
}

/**
 * An admin has looked into it. Assignment resumes.
 *
 * The COUNTER goes back to zero in the same statement. Left standing at three,
 * the merchant is assignable again and the very next expiry — however
 * ordinary — pauses them on the spot, so the admin's decision would last one
 * order. The same reasoning as `approveMerchant` and the refusal streak.
 */
export async function resumeAssignment(merchantId) {
  const { rows } = await pgQuery(
    `UPDATE merchants
        SET assignment_paused_at = NULL, assignment_pause_reason = NULL,
            consecutive_expiries = 0, updated_at = now()
      WHERE merchant_id = $1
      RETURNING ${COLUMNS}`,
    [String(merchantId)], 'merchant_resume_assignment',
  );
  return toMerchant(rows[0]);
}

export async function suspendMerchant(merchantId, reason, { actor = null } = {}) {
  if (!String(reason ?? '').trim()) throw new Error('suspendMerchant requires a reason');
  return updateMerchant(merchantId, {
    status: 'SUSPENDED',
    suspension_reason: String(reason).trim(),
    merchant_approval_status: 'SUSPENDED',
    merchant_approved_by: actor ? String(actor) : undefined,
  });
}

/**
 * Approve a merchant for assignment.
 *
 * Clears the suspension reason as part of the same statement — a merchant that
 * is ACTIVE while still carrying "suspended for fraud" is a row that says two
 * things at once, and an operator reading it cannot tell which is current.
 */
export async function approveMerchant(merchantId, { actor = null } = {}) {
  const { rows } = await pgQuery(
    `UPDATE merchants SET
       merchant_approval_status = 'APPROVED', status = 'ACTIVE',
       merchant_approved_by = $2, merchant_approved_at = now(),
       merchant_rejection_reason = NULL, suspension_reason = NULL,
       -- ── The streak goes back to zero with the reinstatement ──────────────
       -- There is no timer on a refusal suspension: an admin reads the reason
       -- and, if it holds up, reinstates the merchant on the spot. That only
       -- works if the count comes back with them. Left standing at the cap,
       -- the merchant is ACTIVE with three strikes already against them and
       -- the very next refusal — however ordinary — suspends them again
       -- instantly, so the admin's decision would last exactly one order.
       --
       -- In the SAME statement as the reinstatement, so there is no instant at
       -- which the merchant is tradeable and the counter still says suspend.
       consecutive_rejections = 0,
       -- …and the expiry pause, for the same reason. An admin who has just
       -- reinstated a merchant has answered a strictly larger question than
       -- "can this merchant be paid", so leaving them unassignable would make
       -- the reinstatement mean nothing.
       consecutive_expiries = 0,
       assignment_paused_at = NULL,
       assignment_pause_reason = NULL,
       updated_at = now()
     WHERE merchant_id = $1 RETURNING ${COLUMNS}`,
    [String(merchantId), actor ? String(actor) : null], 'merchant_approve',
  );
  return toMerchant(rows[0]);
}

export async function rejectMerchant(merchantId, reason, { actor = null } = {}) {
  if (!String(reason ?? '').trim()) throw new Error('rejectMerchant requires a reason');
  const { rows } = await pgQuery(
    `UPDATE merchants SET
       merchant_approval_status = 'REJECTED', status = 'REJECTED',
       merchant_rejection_reason = $2, merchant_approved_by = $3,
       merchant_approved_at = now(), updated_at = now()
     WHERE merchant_id = $1 RETURNING ${COLUMNS}`,
    [String(merchantId), String(reason).trim(), actor ? String(actor) : null],
    'merchant_reject',
  );
  return toMerchant(rows[0]);
}

/**
 * Delete a merchant.
 *
 * Refuses while the merchant is working an order: deleting the counterparty of
 * an in-flight settlement leaves a player's money committed to an account that
 * no longer exists. The check and the delete are in ONE statement so a new
 * assignment landing between them cannot slip through.
 */
export async function deleteMerchant(merchantId) {
  const { rows } = await pgQuery(
    `DELETE FROM merchants m
      WHERE m.merchant_id = $1
        AND NOT EXISTS (
          SELECT 1 FROM order_states o
           WHERE o.merchant_id = m.merchant_id
             AND o.state IN ('ASSIGNED', 'PROCESSING', 'PAID', 'DISPUTED'))
      RETURNING merchant_id`,
    [String(merchantId)], 'merchant_delete',
  );
  if (rows.length) return { ok: true };
  const still = await getMerchant(merchantId);
  return still
    ? { ok: false, reason: 'HAS_OPEN_ORDERS' }
    : { ok: false, reason: 'NOT_FOUND' };
}

/**
 * Create the whole merchant: the login account, the merchant record and the
 * wallet row, in ONE transaction.
 *
 * ── What this replaces ──────────────────────────────────────────────────────
 * Signup wrote the account, then the merchant record, with nothing joining
 * them. A failure on the second left an account flagged `isMerchant` with no
 * merchant record behind it — an applicant who could never log in, whose
 * mobile was now taken, and who could not reapply. The login path had grown a
 * repair for a neighbouring case: find the account, find the merchant by
 * account id, and write the mobile back onto the merchant record if it was
 * missing. Data repair inside an authentication path.
 *
 * All three rows commit together or none of them do, so the half-created
 * merchant is not a state that exists and the login path has nothing to repair.
 *
 * @returns {{ok:true, merchant, userId}}
 *          {{ok:false, reason:'MOBILE_TAKEN'|'CREDENTIALS_TAKEN'}}
 */
export async function createMerchantAccount({
  userId, username, mobile, email = null, passwordHash,
  currency = 'INR', bankDetails = null, usdtAddressTrc20 = null, usdtAddressBep20 = null,
}) {
  if (!mobile) throw new Error('createMerchantAccount requires a mobile');
  if (!passwordHash) throw new Error('createMerchantAccount requires a passwordHash');

  const pool = await getPool();
  if (!pool) throw new Error('Postgres not configured (DATABASE_URL unset)');
  const client = await connectGuarded(pool);
  let failure = null;

  try {
    await client.query('BEGIN');

    // The account. `ON CONFLICT DO NOTHING` on (mobile, account_type), so a
    // second MERCHANT application on a registered number is REFUSED by the
    // index rather than by a prior lookup two applicants can both pass — and a
    // number that already holds a player or staff account is no longer a reason
    // to refuse a merchant one.
    // NO `email` column here. `users.email` was removed with the player email
    // (CLAUDE.md §2: "there are none beyond the mobile"), and this INSERT kept
    // naming it — so EVERY merchant signup threw `column "email" of relation
    // "users" does not exist`, was caught, and answered "Signup failed. Please
    // try again." No merchant could ever self-register, and the message named
    // nothing an applicant or support could act on.
    //
    // The merchant's own email is a different thing and still stored, on
    // `merchants` — §2 says so explicitly, and `createMerchant` below takes it.
    //
    // ── 'MERCHANT', and the conflict target moved with it ─────────────────
    // A mobile is unique PER ACCOUNT TYPE now (2026-09-24), so `ON CONFLICT
    // (mobile)` matches no constraint at all and this INSERT throws — which the
    // catch below turns into "Signup failed. Please try again." for every
    // applicant, exactly the way the `email` column did before it.
    //
    // The type itself is the load-bearing half. Without it this row is written
    // as a PLAYER, and the player login door — which scopes its read by type —
    // would admit a merchant signing in with their merchant password. The three
    // panels are separate accounts by the owner's decision; this is where the
    // merchant one says so.
    const account = await client.query(
      `INSERT INTO users (user_id, username, mobile, password_hash, status,
                          roles, account_type)
       VALUES ($1, $2, $3, $4, 'ACTIVE', ARRAY['merchant'], 'MERCHANT')
       ON CONFLICT (mobile, account_type) DO NOTHING
       RETURNING user_id`,
      [String(userId), username ?? '', String(mobile), passwordHash],
    );
    if (!account.rows.length) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'MOBILE_TAKEN' };
    }
    const uid = account.rows[0].user_id;

    const merchant = await createMerchant({
      merchantId: newMerchantId(), userId: uid, name: username || String(mobile),
      username, mobile, email,
      currency, status: 'PENDING', bankDetails, usdtAddressTrc20, usdtAddressBep20,
      client,
    });

    await client.query('COMMIT');
    return { ok: true, merchant, userId: uid };
  } catch (error) {
    failure = error;
    try { await client.query('ROLLBACK'); } catch { /* already unwound */ }
    // A payment credential already registered to another merchant. Money sent
    // to it would arrive at the wrong account, so it is refused — and named,
    // because "signup failed" tells an applicant nothing they can act on.
    if (error.code === '23505') {
      return { ok: false, reason: 'CREDENTIALS_TAKEN', constraint: error.constraint };
    }
    throw error;
  } finally {
    client.release(failure ?? undefined);
  }
}

/**
 * Spend a TOTP counter, atomically.
 *
 * ── Why this is a conditional UPDATE and not a save ─────────────────────────
 * A TOTP code stays valid for its 30-second step plus the verifier's drift
 * window, so the same six digits are accepted for up to 90 seconds — exactly
 * the window a shoulder-surfed or phished code needs. The guard against that is
 * remembering the highest counter already spent and refusing anything at or
 * below it.
 *
 * Read the counter, compare it in JavaScript, then write it back, and two
 * submissions of the SAME code inside that window both read the old value, both
 * pass, and both are accepted. The replay guard would fail in precisely the
 * situation it exists for, because a replay IS concurrent. The comparison is in
 * the WHERE clause here, so exactly one of N racing submissions updates a row.
 *
 * @returns {boolean} true when this call is the one that spent the counter.
 */
export async function spendTwoFactorCounter(merchantId, counter) {
  const n = Number(counter);
  if (!Number.isFinite(n)) return false;
  const { rowCount } = await pgQuery(
    `UPDATE merchants SET two_factor_last_counter = $2, updated_at = now()
      WHERE merchant_id = $1
        AND (two_factor_last_counter IS NULL OR two_factor_last_counter < $2)`,
    [String(merchantId), n], 'merchant_2fa_spend_counter',
  );
  return rowCount === 1;
}

/**
 * Consume one recovery code, atomically.
 *
 * Compare-and-swap on the whole array: the update only lands if the stored
 * codes are still exactly the ones the caller verified against. Two requests
 * redeeming the same code both compute the same shorter array, but only the
 * first matches the expected value — the second finds the list already changed
 * and is refused, so a single-use code is single-use under concurrency rather
 * than only in sequence.
 *
 * @returns {boolean} true when this call is the one that consumed it.
 */
export async function consumeTwoFactorBackupCode(merchantId, { expected, remaining }) {
  const { rowCount } = await pgQuery(
    `UPDATE merchants SET backup_codes = $3, updated_at = now()
      WHERE merchant_id = $1 AND COALESCE(backup_codes, ARRAY[]::text[]) = $2`,
    [String(merchantId), expected ?? [], remaining ?? []], 'merchant_2fa_consume_backup',
  );
  return rowCount === 1;
}

/**
 * A merchant refused an order: advance their streak and say where it stands.
 *
 * The increment and the read are ONE statement. A read-then-write would let two
 * concurrent rejects both see 2 and both write 3, so a merchant could pass the
 * cap without it ever being observed — the same shape as every other guard in
 * this repository, and the reason it is expressed as an UPDATE … RETURNING.
 *
 * @returns {Promise<number>} the streak AFTER this refusal.
 */
export async function bumpConsecutiveRejections(merchantId) {
  const { rows } = await pgQuery(
    `UPDATE merchants SET consecutive_rejections = consecutive_rejections + 1, updated_at = now()
      WHERE merchant_id = $1
      RETURNING consecutive_rejections`,
    [String(merchantId)], 'merchant_bump_rejections',
  );
  return rows.length ? Number(rows[0].consecutive_rejections) : 0;
}

/**
 * A merchant completed an order, so the streak is over.
 *
 * Idempotent by construction — setting zero twice is setting zero — so the
 * completion path can call it without first asking whether there was a streak.
 */
export async function resetConsecutiveRejections(merchantId) {
  await pgQuery(
    `UPDATE merchants SET consecutive_rejections = 0, updated_at = now()
      WHERE merchant_id = $1 AND consecutive_rejections <> 0`,
    [String(merchantId)], 'merchant_reset_rejections',
  );
}
