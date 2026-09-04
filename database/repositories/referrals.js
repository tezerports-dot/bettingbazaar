// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file.
/**
 * repositories/referrals.js — referral earnings, and the batches that pay them.
 *
 * A referral earning is MONEY OWED. Everything here follows the money rules:
 * integer paise in BIGINT, a queue position that is unique and claimed
 * atomically, a budget that is a ceiling in the row rather than a check in the
 * application, and a PAID row that must name the ledger entry which moved it.
 *
 * ── Why the payout is a queue ───────────────────────────────────────────────
 * The programme has a budget. Paying earnings in arrival order, from a pool
 * that can run out, means the order has to be decided ONCE and be stable —
 * otherwise two runs of the disburser pay different people. `queue_position` is
 * that decision, unique so two earnings cannot claim one slot.
 */
import { pgQuery, getPool, connectGuarded } from '../client.js';
import { randomBytes } from 'node:crypto';
import { rupeesToPaise, paiseToRupees } from '../../backend/shared/money.js';

const newId = () => randomBytes(12).toString('hex');

const toEarning = (r) => (r ? {
  id: Number(r.id), earningId: r.earning_id,
  earnerId: r.earner_id, sourceUserId: r.source_user_id, level: r.level,
  amountPaise: Number(r.amount_paise), amount: paiseToRupees(Number(r.amount_paise)),
  queuePosition: r.queue_position === null ? null : Number(r.queue_position),
  status: r.status, blockedReason: r.blocked_reason,
  disbursalBatchId: r.disbursal_batch_id, disbursedAt: r.disbursed_at,
  walletTxId: r.wallet_tx_id, createdAt: r.created_at,
} : null);

/**
 * Record an earning and give it its place in the queue.
 *
 * The position comes from a SEQUENCE. `MAX(queue_position) + 1` — even computed
 * inside the INSERT — is not enough: each transaction reads the maximum it can
 * see, so two concurrent signups both read the same value and both try to claim
 * it, and the unique index then fails one of them for a reason the caller
 * cannot act on. That failure was reproduced by the test below before this was
 * a sequence. A sequence hands out distinct values to concurrent callers by
 * construction. Gaps are fine — this is an ORDER, not a count.
 */
export async function recordEarning({
  earningId = null, earnerId, sourceUserId, level = 1, amountRupees,
}) {
  if (!earnerId || !sourceUserId) throw new Error('recordEarning requires earnerId and sourceUserId');
  if (String(earnerId) === String(sourceUserId)) {
    // The row refuses this too; raising here says which caller did it.
    throw new Error('recordEarning: nobody earns from their own signup');
  }
  const { rows } = await pgQuery(
    `INSERT INTO referral_earnings
       (earning_id, earner_id, source_user_id, level, amount_paise, queue_position)
     VALUES ($1, $2, $3, $4, $5, nextval('referral_queue_position_seq'))
     ON CONFLICT (earning_id) DO NOTHING
     RETURNING *`,
    [String(earningId || newId()), String(earnerId), String(sourceUserId),
      Number(level) || 1, rupeesToPaise(amountRupees)], 'referral_record',
  );
  return rows[0] ? { ok: true, earning: toEarning(rows[0]) } : { ok: true, idempotent: true };
}

export async function getEarning(earningId) {
  const { rows } = await pgQuery(
    'SELECT * FROM referral_earnings WHERE earning_id = $1', [String(earningId)], 'referral_get',
  );
  return toEarning(rows[0]);
}

export async function listEarnings({ earnerId = null, status = null, limit = 100 } = {}) {
  const where = []; const params = [];
  if (earnerId) { params.push(String(earnerId)); where.push(`earner_id = $${params.length}`); }
  if (status) { params.push(String(status)); where.push(`status = $${params.length}`); }
  const { rows } = await pgQuery(
    `SELECT * FROM referral_earnings ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY created_at DESC LIMIT ${Math.min(Math.max(Number(limit) || 100, 1), 500)}`,
    params, 'referral_list',
  );
  return rows.map(toEarning);
}

/** What a referrer has earned, and what is still owed. */
export async function earningsSummary(earnerId) {
  const { rows } = await pgQuery(
    `SELECT
       COALESCE(SUM(amount_paise) FILTER (WHERE status = 'PAID'), 0)    AS paid,
       COALESCE(SUM(amount_paise) FILTER (WHERE status = 'QUEUED'), 0)  AS queued,
       COALESCE(SUM(amount_paise) FILTER (WHERE status = 'BLOCKED'), 0) AS blocked,
       COUNT(*)::int AS total
     FROM referral_earnings WHERE earner_id = $1`,
    [String(earnerId)], 'referral_summary',
  );
  const r = rows[0];
  return {
    paid: paiseToRupees(Number(r.paid)),
    queued: paiseToRupees(Number(r.queued)),
    blocked: paiseToRupees(Number(r.blocked)),
    total: r.total,
  };
}

/**
 * The next payable earnings, in the order the programme promised.
 *
 * A READ, and named `claimPayable` for its callers rather than because it
 * claims: `FOR UPDATE SKIP LOCKED` was here and did nothing, because `pgQuery`
 * runs each statement in its own implicit transaction and the lock releases as
 * the SELECT returns. Two disbursal runs read the same rows either way.
 *
 * What actually stops one earning being paid twice is `markPaid`, whose
 * `status = 'QUEUED'` guard is in the UPDATE's WHERE clause — the loser gets
 * NOT_QUEUED and moves on. Leaving a no-op lock in this query would suggest the
 * coordination lives here, and the next reader would trust it.
 *
 * `level` breaks ties within one joiner, so level 1 is always settled before
 * level 2 for the same signup.
 */
export async function claimPayable({ limit = 100 } = {}) {
  const { rows } = await pgQuery(
    `SELECT * FROM referral_earnings
      WHERE status = 'QUEUED'
      ORDER BY queue_position ASC, level ASC
      LIMIT $1`,
    [Math.min(Math.max(Number(limit) || 100, 1), 1000)], 'referral_claim',
  );
  return rows.map(toEarning);
}

/**
 * The whole queue at a glance, for the admin dashboard.
 *
 * One statement rather than two aggregates and a lookup for the next position,
 * so the counts, the money and the head of the queue all describe the same
 * instant. Three reads a moment apart can show a queue whose head has already
 * been paid.
 */
export async function queueSummary() {
  const { rows } = await pgQuery(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'QUEUED')::int  AS queued_count,
       COUNT(*) FILTER (WHERE status = 'BLOCKED')::int AS blocked_count,
       COALESCE(SUM(amount_paise) FILTER (WHERE status = 'QUEUED'), 0)  AS queued_paise,
       COALESCE(SUM(amount_paise) FILTER (WHERE status = 'BLOCKED'), 0) AS blocked_paise,
       MIN(queue_position) FILTER (WHERE status = 'QUEUED')             AS next_position
     FROM referral_earnings`,
    [], 'referral_queue_summary',
  );
  const r = rows[0];
  return {
    queuedCount: r.queued_count,
    queuedPaise: Number(r.queued_paise),
    blockedCount: r.blocked_count,
    blockedPaise: Number(r.blocked_paise),
    nextQueuePosition: r.next_position === null ? null : Number(r.next_position),
  };
}

/**
 * Mark an earning paid.
 *
 * REQUIRES the ledger tx id, because the table refuses a PAID row without one:
 * a payment nothing in the books accounts for is the one kind of money movement
 * reconciliation cannot see.
 */
export async function markPaid(earningId, { batchId, walletTxId }) {
  if (!walletTxId) throw new Error('markPaid requires the walletTxId that moved the money');
  const { rows } = await pgQuery(
    `UPDATE referral_earnings SET
       status = 'PAID', disbursal_batch_id = $2, wallet_tx_id = $3, disbursed_at = now()
      WHERE earning_id = $1 AND status = 'QUEUED'
      RETURNING *`,
    [String(earningId), batchId ? String(batchId) : null, String(walletTxId)],
    'referral_mark_paid',
  );
  return rows[0] ? { ok: true, earning: toEarning(rows[0]) } : { ok: false, reason: 'NOT_QUEUED' };
}

/** Block an earning, with the reason the row requires. */
export async function markBlocked(earningId, reason, { batchId = null } = {}) {
  if (!String(reason ?? '').trim()) throw new Error('markBlocked requires a reason');
  const { rows } = await pgQuery(
    `UPDATE referral_earnings SET
       status = 'BLOCKED', blocked_reason = $2, disbursal_batch_id = $3
      WHERE earning_id = $1 AND status = 'QUEUED' RETURNING *`,
    [String(earningId), String(reason).trim(), batchId], 'referral_mark_blocked',
  );
  return rows[0] ? { ok: true, earning: toEarning(rows[0]) } : { ok: false, reason: 'NOT_QUEUED' };
}

// ── Disbursal batches ───────────────────────────────────────────────────────

const toBatch = (r) => (r ? {
  batchId: r.batch_id,
  pool: paiseToRupees(Number(r.pool_paise)), poolPaise: Number(r.pool_paise),
  spent: paiseToRupees(Number(r.spent_paise)), spentPaise: Number(r.spent_paise),
  paidCount: r.paid_count, blockedCount: r.blocked_count,
  lastQueuePosition: r.last_queue_position === null ? null : Number(r.last_queue_position),
  actorId: r.actor_id, status: r.status, error: r.error,
  createdAt: r.created_at, completedAt: r.completed_at,
} : null);

export async function openBatch({ batchId = null, poolRupees, actorId = null }) {
  const { rows } = await pgQuery(
    `INSERT INTO referral_disbursals (batch_id, pool_paise, actor_id)
     VALUES ($1,$2,$3) RETURNING *`,
    [String(batchId || newId()), rupeesToPaise(poolRupees), actorId], 'referral_batch_open',
  );
  return toBatch(rows[0]);
}

/**
 * Spend from a batch's pool.
 *
 * The ceiling is in the WHERE clause, so a payment that would overspend the
 * pool matches no row and is refused — rather than being caught by an
 * application check two concurrent payments can both pass. `ok: false` means
 * the pool is exhausted, which is an answer the disburser acts on.
 */
export async function spendFromBatch(batchId, amountRupees, { blocked = false } = {}) {
  const paise = rupeesToPaise(amountRupees);
  const { rows } = await pgQuery(
    `UPDATE referral_disbursals SET
       spent_paise   = spent_paise + $2,
       paid_count    = paid_count + (CASE WHEN $3 THEN 0 ELSE 1 END),
       blocked_count = blocked_count + (CASE WHEN $3 THEN 1 ELSE 0 END)
      WHERE batch_id = $1 AND status = 'RUNNING'
        AND spent_paise + $2 <= pool_paise
      RETURNING *`,
    [String(batchId), blocked ? 0 : paise, Boolean(blocked)], 'referral_batch_spend',
  );
  return rows[0] ? { ok: true, batch: toBatch(rows[0]) } : { ok: false, reason: 'POOL_EXHAUSTED' };
}

export async function closeBatch(batchId, { lastQueuePosition = null, error = null } = {}) {
  const { rows } = await pgQuery(
    `UPDATE referral_disbursals SET
       status = $3, completed_at = now(),
       last_queue_position = COALESCE($2, last_queue_position),
       error = $4
      WHERE batch_id = $1 RETURNING *`,
    [String(batchId), lastQueuePosition, error ? 'FAILED' : 'COMPLETED',
      // The CHECK requires a message on a FAILED batch: a failure nobody can
      // investigate is worse than no record of the run.
      error ? String(error) : null],
    'referral_batch_close',
  );
  return toBatch(rows[0]);
}

export async function listBatches({ limit = 50 } = {}) {
  const { rows } = await pgQuery(
    'SELECT * FROM referral_disbursals ORDER BY created_at DESC LIMIT $1',
    [Math.min(Math.max(Number(limit) || 50, 1), 200)], 'referral_batch_list',
  );
  return rows.map(toBatch);
}

// ── Programme ───────────────────────────────────────────────────────────────

const toProgramme = (r) => (r ? {
  key: r.programme_key,
  budget: paiseToRupees(Number(r.budget_paise)), budgetPaise: Number(r.budget_paise),
  disbursed: paiseToRupees(Number(r.disbursed_paise)), disbursedPaise: Number(r.disbursed_paise),
  remaining: paiseToRupees(Number(r.budget_paise) - Number(r.disbursed_paise)),
  memberCap: r.member_cap, verifiedMembers: r.verified_members,
  active: r.active, updatedAt: r.updated_at,
} : null);

export async function getProgramme(key = 'main') {
  const { rows } = await pgQuery(
    'SELECT * FROM referral_programmes WHERE programme_key = $1', [String(key)], 'programme_get',
  );
  return toProgramme(rows[0]);
}

export async function upsertProgramme({ key = 'main', budgetRupees, memberCap, active }) {
  const { rows } = await pgQuery(
    `INSERT INTO referral_programmes (programme_key, budget_paise, member_cap, active)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (programme_key) DO UPDATE SET
       budget_paise = COALESCE(EXCLUDED.budget_paise, referral_programmes.budget_paise),
       member_cap   = COALESCE(EXCLUDED.member_cap, referral_programmes.member_cap),
       active       = COALESCE(EXCLUDED.active, referral_programmes.active),
       updated_at   = now()
     RETURNING *`,
    [String(key),
      budgetRupees === undefined ? null : rupeesToPaise(budgetRupees),
      memberCap === undefined ? null : Number(memberCap),
      active === undefined ? null : Boolean(active)],
    'programme_upsert',
  );
  return toProgramme(rows[0]);
}

/**
 * Draw from the programme budget.
 *
 * Same shape as the batch pool, and the same reason: the budget is a ceiling
 * enforced by the row. An application-side check lets two concurrent
 * disbursals both read the same total and both pass it.
 */
export async function drawFromProgramme(key, amountRupees) {
  const { rows } = await pgQuery(
    `UPDATE referral_programmes SET disbursed_paise = disbursed_paise + $2, updated_at = now()
      WHERE programme_key = $1 AND active AND disbursed_paise + $2 <= budget_paise
      RETURNING *`,
    [String(key), rupeesToPaise(amountRupees)], 'programme_draw',
  );
  return rows[0] ? { ok: true, programme: toProgramme(rows[0]) } : { ok: false, reason: 'BUDGET_EXHAUSTED_OR_INACTIVE' };
}

/** Count a newly verified member against the cap. */
export async function countVerifiedMember(key = 'main') {
  const { rows } = await pgQuery(
    `UPDATE referral_programmes SET verified_members = verified_members + 1, updated_at = now()
      WHERE programme_key = $1 AND (member_cap = 0 OR verified_members < member_cap)
      RETURNING *`,
    [String(key)], 'programme_count_member',
  );
  return rows[0] ? { ok: true, programme: toProgramme(rows[0]) } : { ok: false, reason: 'MEMBER_CAP_REACHED' };
}

// ── Click attribution ───────────────────────────────────────────────────────

/**
 * Record a click on a referral link.
 *
 * One click per viewer per code within the window, decided by the unique
 * constraint. Without it a refresh loop inflates a referrer's click count
 * without bound, and the count is what a payout tier is read from.
 */
export async function recordClick({ code, viewerHash, ttlHours = 24 }) {
  const { rows } = await pgQuery(
    `INSERT INTO referral_clicks (code, viewer_hash, expires_at)
     VALUES ($1, $2, now() + ($3 || ' hours')::interval)
     ON CONFLICT (code, viewer_hash) DO NOTHING
     RETURNING id`,
    [String(code), String(viewerHash), String(Math.max(Number(ttlHours) || 24, 1))],
    'referral_click',
  );
  return { counted: rows.length > 0 };
}

/**
 * Move the running click total on the referrer's own row.
 *
 * -- Why a stored counter beside the click rows -----------------------------
 * `referral_clicks` rows EXPIRE — retention deletes them continuously — so a
 * count over them shrinks over time. The aggregate is the thing that has to
 * survive, and the rows are only the evidence that stops one viewer counting
 * twice inside the window.
 *
 * The arithmetic is in the statement. A read-modify-write loses one of two
 * concurrent clicks, and the count is what a payout tier is read from.
 *
 * Returns false when no row carries this code: a mistyped or retired link is
 * not an error — the visitor was still sent to the bot — but the caller needs
 * to tell "nobody has this code" from "counted".
 */
export async function bumpClickCount(code) {
  const { rowCount } = await pgQuery(
    'UPDATE users SET referral_clicks = referral_clicks + 1 WHERE referral_code = $1',
    [String(code)], 'referral_click_bump',
  );
  return rowCount > 0;
}

export async function countClicks(code) {
  const { rows } = await pgQuery(
    'SELECT COUNT(*)::int AS n FROM referral_clicks WHERE code = $1', [String(code)],
    'referral_click_count',
  );
  return rows[0].n;
}

/** Reclaim space. Expiry is decided by the read; this only frees pages. */
export async function sweepExpiredClicks() {
  const { rowCount } = await pgQuery(
    "DELETE FROM referral_clicks WHERE expires_at < now() - interval '1 day'", [],
    'referral_click_sweep',
  );
  return rowCount;
}
