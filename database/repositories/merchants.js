// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * postgres/merchantPg.js — the merchant record.
 *
 * A merchant settles real INR and USDT. This module owns the row that says who
 * they are, which rail they settle on, what credentials money is sent to, and
 * the scoring inputs that decide which merchant an order is routed to.
 *
 * ── What is NOT here, and why ───────────────────────────────────────────────
 *
 * THE TOKEN BALANCE. It lives in `merchant_wallets`, behind the row lock its
 * movements take (`merchantWalletPg.js`). A copy on this row would be a second
 * writer waiting to disagree with the first — which is exactly the defect found
 * in `merchantScoring.service.js`, where assignment filtered candidates by a
 * stored `tokenBalance` while the debit moved the wallet. Read balances through
 * `getAvailablePaiseFor`, never from a merchant record.
 *
 * THE ACTIVE ORDER COUNT. The document store kept `activeOrderCount` as an
 * accumulator: incremented on assign, decremented on finish. That counts passes
 * rather than rows, so a crash between the two loses the decrement permanently
 * and the merchant is throttled forever by a number nothing can correct. It is
 * derived from `order_states` here (`getActiveOrderCounts`), which is the same
 * rule the money counters follow.
 *
 * ── Two things the row enforces that a schema flag could not ────────────────
 * `public_ref` is immutable by TRIGGER, because the document store's
 * `immutable: true` is honoured by a document save and ignored by an update
 * operator. And `merchant_type` is a GENERATED column over
 * `accepted_currencies[1]` rather than an application-layer virtual, so the
 * scalar the panels read cannot drift from the array assignment filters on.
 */
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
  usdt_wallet_address, qr_code_url,
  min_deposit_paise, max_deposit_paise, min_withdraw_paise, max_withdraw_paise,
  min_order_paise, max_order_paise,
  total_processed_volume_paise, earnings_paise, total_deposit_amount_paise,
  total_withdrawal_amount_paise, total_deposits_processed, total_withdrawals_processed,
  rating, last_online_toggle, panel_url,
  merchant_approval_status, merchant_approved_by, merchant_approved_at,
  merchant_rejection_reason,
  monthly_processed_paise, daily_processed_paise, total_orders_processed,
  stats_last_reset_at,
  success_rate, avg_response_minutes, dispute_rate, max_concurrent_orders,
  max_concurrent_deposit_orders, max_concurrent_withdrawal_orders,
  total_orders_completed, total_orders_all, created_at, updated_at`;

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
    usdtWalletAddress: row.usdt_wallet_address,
    qrCodeUrl: row.qr_code_url,

    limits: {
      minDeposit: rupees(row.min_deposit_paise),
      maxDeposit: rupees(row.max_deposit_paise),
      minWithdraw: rupees(row.min_withdraw_paise),
      maxWithdraw: rupees(row.max_withdraw_paise),
    },
    minOrder: rupees(row.min_order_paise),
    maxOrder: rupees(row.max_order_paise),

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
    maxConcurrentOrders: toInt(row.max_concurrent_orders),
    maxConcurrentDepositOrders: toInt(row.max_concurrent_deposit_orders),
    maxConcurrentWithdrawalOrders: toInt(row.max_concurrent_withdrawal_orders),
    totalOrdersCompleted: toInt(row.total_orders_completed),
    totalOrdersAll: toInt(row.total_orders_all),

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
    `SELECT merchant_id, password_hash, two_factor_enabled, two_factor_secret,
            two_factor_pending_secret, two_factor_last_counter, backup_codes
       FROM merchants WHERE merchant_id = $1`,
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
 * How many orders each merchant is currently working.
 *
 * DERIVED from `order_states`, never accumulated. The document store's
 * `activeOrderCount` was incremented on assign and decremented on finish, so a
 * crash between the two throttled that merchant permanently — and no repair was
 * possible, because nothing else knew the true number. Here the rows ARE the
 * number.
 *
 * Returns a Map so a caller scoring N candidates makes one query, not N.
 */
export async function getActiveOrderCounts(merchantIds = []) {
  const ids = [...new Set(merchantIds.filter(Boolean).map(String))];
  const counts = new Map(ids.map((id) => [id, { total: 0, deposit: 0, withdrawal: 0 }]));
  if (!ids.length) return counts;

  const { rows } = await pgQuery(
    `SELECT merchant_id, order_type, COUNT(*)::int AS n
       FROM order_states
      WHERE merchant_id = ANY($1::text[])
        AND state IN ('ASSIGNED', 'PROCESSING', 'PAID')
      GROUP BY merchant_id, order_type`,
    [ids], 'merchant_active_orders',
  );
  for (const r of rows) {
    const c = counts.get(r.merchant_id);
    if (!c) continue;
    c.total += r.n;
    if (r.order_type === 'DEPOSIT') c.deposit += r.n;
    else if (r.order_type === 'WITHDRAWAL') c.withdrawal += r.n;
  }
  return counts;
}

/**
 * Candidates for assignment, filtered by the things the ROW can decide.
 *
 * Deliberately does NOT filter on token balance. A merchant's spendable tokens
 * live in `merchant_wallets` and the caller must read them there — a balance
 * predicate written into this query would be the same defect as the stored
 * `tokenBalance` filter it replaces, one layer down. `merchantScoring` fetches
 * the balances for these candidates and excludes on them afterwards.
 */
export async function listAssignableMerchants({
  currency = 'INR', direction = 'DEPOSIT', limit = 200,
} = {}) {
  const acceptsColumn = direction === 'WITHDRAWAL' ? 'accepts_withdrawals' : 'accepts_deposits';
  const { rows } = await pgQuery(
    `SELECT ${COLUMNS} FROM merchants
      WHERE status = 'ACTIVE'
        AND merchant_approval_status = 'APPROVED'
        AND is_online
        AND ${acceptsColumn}
        AND merchant_type = $1
      ORDER BY created_at ASC
      LIMIT $2`,
    [String(currency), Math.min(Math.max(Number(limit) || 200, 1), 1000)],
    'merchant_list_assignable',
  );
  return rows.map(toMerchant);
}

/**
 * The curated queue-manager pool, by id, in the order given.
 *
 * `IN (…)` returns rows in whatever order the planner likes, and the settings
 * screen shows the pool as an ordered list an admin arranged. `ORDER BY
 * array_position` preserves it.
 *
 * A missing id comes back as nothing rather than as an error, and the caller
 * compares lengths — a merchant deleted after being pooled should be reported
 * as gone, not crash the settings page.
 */
export async function getPoolMerchants(merchantIds = []) {
  const ids = [...new Set((merchantIds || []).filter(Boolean).map(String))];
  if (!ids.length) return [];
  const { rows } = await pgQuery(
    `SELECT ${COLUMNS} FROM merchants
      WHERE merchant_id = ANY($1::text[])
      ORDER BY array_position($1::text[], merchant_id)`,
    [ids], 'merchant_pool_get',
  );
  return rows.map(toMerchant);
}

/**
 * Pool members a queue manager may actually assign to, right now.
 *
 * The eligibility the ROW can decide — approved, active, online, and accepting
 * this direction — is in the WHERE clause. What it deliberately does NOT decide
 * is the token balance: that lives in `merchant_wallets` and the caller reads it
 * there. A balance predicate written into this query would be the same defect as
 * the stored `tokenBalance` filter it replaced, one layer down.
 */
export async function getAssignablePoolMerchants(merchantIds = [], { direction = null } = {}) {
  const ids = [...new Set((merchantIds || []).filter(Boolean).map(String))];
  if (!ids.length) return [];
  const clauses = [
    'merchant_id = ANY($1::text[])',
    "status = 'ACTIVE'",
    "merchant_approval_status = 'APPROVED'",
    'is_online',
  ];
  if (direction === 'DEPOSIT') clauses.push('accepts_deposits');
  if (direction === 'WITHDRAWAL') clauses.push('accepts_withdrawals');
  const { rows } = await pgQuery(
    `SELECT ${COLUMNS} FROM merchants WHERE ${clauses.join(' AND ')}
      ORDER BY array_position($1::text[], merchant_id)`,
    [ids], 'merchant_pool_assignable',
  );
  return rows.map(toMerchant);
}

/**
 * Every merchant eligible to BE pooled — the list an admin picks the pool from.
 *
 * Distinct from `getAssignablePoolMerchants`: an offline merchant is a valid
 * pool member (they come back online), but not a valid assignment target right
 * now. Conflating the two either shrinks the pool every night or hands orders
 * to merchants who cannot take them.
 */
export async function listPoolCandidates({ limit = 500 } = {}) {
  const { rows } = await pgQuery(
    `SELECT ${COLUMNS} FROM merchants
      WHERE status = 'ACTIVE' AND merchant_approval_status = 'APPROVED'
      ORDER BY name
      LIMIT ${Math.min(Math.max(Number(limit) || 500, 1), 2000)}`,
    [], 'merchant_pool_candidates',
  );
  return rows.map(toMerchant);
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
  const add = (sql, value) => { params.push(value); where.push(sql.replace('$?', `$${params.length}`)); };

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
  'user_id', 'name', 'username', 'mobile', 'email', 'password_hash',
  'two_factor_enabled', 'two_factor_secret', 'two_factor_pending_secret',
  'two_factor_last_counter', 'two_factor_enrolled_at', 'backup_codes',
  'status', 'suspension_reason', 'is_online', 'accepts_deposits', 'accepts_withdrawals',
  'accepted_currencies',
  'bank_account_holder_name', 'bank_upi_id', 'bank_name', 'bank_account_no', 'bank_ifsc',
  'usdt_wallet_address', 'qr_code_url',
  'min_deposit_paise', 'max_deposit_paise', 'min_withdraw_paise', 'max_withdraw_paise',
  'min_order_paise', 'max_order_paise',
  'rating', 'last_online_toggle', 'panel_url',
  'merchant_approval_status', 'merchant_approved_by', 'merchant_approved_at',
  'merchant_rejection_reason',
  'success_rate', 'avg_response_minutes', 'dispute_rate',
  'max_concurrent_orders', 'max_concurrent_deposit_orders', 'max_concurrent_withdrawal_orders',
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
});

/** Columns holding money, so a caller passing rupees gets paise stored. */
const MONEY_COLUMNS = new Set([
  'min_deposit_paise', 'max_deposit_paise', 'min_withdraw_paise',
  'max_withdraw_paise', 'min_order_paise', 'max_order_paise',
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
  username = null, mobile = null, email = null, passwordHash = null,
  currency = 'INR', status = 'PENDING', bankDetails = null,
  usdtWalletAddress = null, qrCodeUrl = null, panelUrl = '',
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
       merchant_id, user_id, name, public_ref, username, mobile, email, password_hash,
       accepted_currencies, status,
       bank_account_holder_name, bank_upi_id, bank_name, bank_account_no, bank_ifsc,
       usdt_wallet_address, qr_code_url, panel_url,
       min_deposit_paise, max_deposit_paise, min_withdraw_paise, max_withdraw_paise)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8, ARRAY[$9], $10,
             $11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
     RETURNING ${COLUMNS}`,
    [id, userId ? String(userId) : null, String(name), ref,
      username || null, mobile || null, email || null, passwordHash,
      String(currency), String(status),
      bankDetails?.accountHolderName || null, bankDetails?.upiId || null,
      bankDetails?.bankName || null, bankDetails?.accountNo || null, bankDetails?.ifsc || null,
      usdtWalletAddress || null, qrCodeUrl || null, panelUrl || '',
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
  currency = 'INR', bankDetails = null, usdtWalletAddress = null,
}) {
  if (!mobile) throw new Error('createMerchantAccount requires a mobile');
  if (!passwordHash) throw new Error('createMerchantAccount requires a passwordHash');

  const pool = await getPool();
  if (!pool) throw new Error('Postgres not configured (DATABASE_URL unset)');
  const client = await connectGuarded(pool);
  let failure = null;

  try {
    await client.query('BEGIN');

    // The account. `ON CONFLICT DO NOTHING` on the mobile, so a second
    // application on a registered number is REFUSED by the index rather than
    // by a prior lookup two applicants can both pass.
    const account = await client.query(
      `INSERT INTO users (user_id, username, mobile, password_hash, email, status, kyc_status, roles)
       VALUES ($1, $2, $3, $4, $5, 'ACTIVE', 'PENDING_SUBMISSION', ARRAY['merchant'])
       ON CONFLICT (mobile) DO NOTHING
       RETURNING user_id`,
      [String(userId), username ?? '', String(mobile), passwordHash, email],
    );
    if (!account.rows.length) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'MOBILE_TAKEN' };
    }
    const uid = account.rows[0].user_id;

    const merchant = await createMerchant({
      merchantId: newMerchantId(), userId: uid, name: username || String(mobile),
      username, mobile, email, passwordHash,
      currency, status: 'PENDING', bankDetails, usdtWalletAddress,
      client,
    });

    // A merchant with no wallet row is EXCLUDED from assignment, so it belongs
    // in the same transaction as the merchant itself.
    await client.query(
      `INSERT INTO merchant_wallets (merchant_id) VALUES ($1)
       ON CONFLICT (merchant_id) DO NOTHING`, [merchant.merchantId],
    );

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
 * Create a merchant and its wallet row together, or neither.
 *
 * A merchant with no wallet row is EXCLUDED from assignment (that is
 * merchantScoring's rule — a merchant whose spendable balance is unknown must
 * not be routed an order), so a half-created merchant is not a merchant. One
 * transaction.
 */
export async function createMerchantWithWallet(spec) {
  const pool = await getPool();
  if (!pool) throw new Error('Postgres not configured (DATABASE_URL unset)');
  const client = await connectGuarded(pool);
  let failure = null;
  try {
    await client.query('BEGIN');
    const merchant = await createMerchant({ ...spec, client });
    await client.query(
      `INSERT INTO merchant_wallets (merchant_id) VALUES ($1)
       ON CONFLICT (merchant_id) DO NOTHING`,
      [merchant.merchantId],
    );
    await client.query('COMMIT');
    return merchant;
  } catch (error) {
    failure = error;
    try { await client.query('ROLLBACK'); } catch { /* already unwound */ }
    throw error;
  } finally {
    // Pass the error so a dead socket is DESTROYED rather than returned to the
    // pool for the next caller to inherit. See pgClient.connectGuarded.
    client.release(failure ?? undefined);
  }
}
