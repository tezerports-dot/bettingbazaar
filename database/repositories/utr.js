// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file.
/**
 * repositories/utr.js — the bank-reference registry.
 *
 * A UTR is a bank's reference for a real transfer. Reusing one across two
 * orders is either a mistake or an attempt to claim a single payment twice, and
 * detecting it is an anti-fraud control an operator is expected to have.
 *
 * ── Three rules the table enforces, not this module ─────────────────────────
 *
 * 1. THE REFERENCE IS THE PRIMARY KEY. Two orders cannot claim one UTR, decided
 *    by the index rather than by a pre-read that two submissions arriving
 *    together both pass. The previous implementation had exactly that shape:
 *    `checkUTR` then `markUTRAsUsed`, with the window between them open.
 *
 * 2. THE ROW OUTLIVES THE ORDER. `RELEASED` means the order finished and the
 *    reference is SPENT — not that it is free again.
 *
 * 3. NOTHING DELETES A ROW. Enforced by trigger, because the convention was
 *    `clearAllUTRs()`: an exported function that emptied the whole registry,
 *    one import away from any route. A table that can be emptied prevents
 *    reuse only until somebody empties it.
 *
 * ── The duplicate attempt is recorded, not just refused ─────────────────────
 * Someone submitting a reference that is already spent is the signal. Counting
 * the attempts turns a refused request into a reviewable pattern.
 */
import { pgQuery } from '../client.js';
import { rupeesToPaise, paiseToRupees } from '../../backend/shared/money.js';

export const UTR_STATUS = Object.freeze({
  ACTIVE: 'ACTIVE', RELEASED: 'RELEASED', FRAUD: 'FRAUD',
});

/**
 * Uppercase, and strip every kind of space.
 *
 * A reference typed with a space in it is the same reference. Normalising at
 * the boundary is what makes the primary key mean "this transfer" rather than
 * "this spelling of this transfer".
 */
export function normalizeUtr(utr) {
  if (!utr) return null;
  return String(utr).toUpperCase().replace(/\s+/g, '');
}

const toEntry = (r) => (r ? {
  utr: r.utr, orderId: r.order_id, userId: r.user_id,
  amount: r.amount_paise === null ? null : paiseToRupees(Number(r.amount_paise)),
  status: r.status,
  registeredAt: r.registered_at, releasedAt: r.released_at,
  flaggedAt: r.flagged_at, flaggedBy: r.flagged_by, flagReason: r.flag_reason,
  duplicateAttempts: r.duplicate_attempts,
  lastContestedAt: r.last_contested_at,
} : null);

const COLUMNS = `utr, order_id, user_id, amount_paise, status, registered_at,
  released_at, flagged_at, flagged_by, flag_reason, duplicate_attempts,
  last_contested_at`;

/**
 * Claim a reference for an order.
 *
 * ONE STATEMENT decides. `ON CONFLICT DO NOTHING` plus a follow-up read
 * distinguishes the three outcomes a caller must treat differently:
 *
 *   claimed    — the reference is now this order's
 *   idempotent — this same order already claimed it (a retried submission)
 *   duplicate  — somebody else's, and the attempt is COUNTED
 *
 * The previous implementation checked then inserted, so two submissions of the
 * same reference arriving together both passed the check.
 */
export async function claimUtr({ utr, orderId, userId = null, amountRupees = null }) {
  const normalized = normalizeUtr(utr);
  if (!normalized) return { ok: false, reason: 'MISSING_UTR' };
  if (!orderId) throw new Error('claimUtr requires an orderId');

  const { rows } = await pgQuery(
    `INSERT INTO utr_registry (utr, order_id, user_id, amount_paise, status)
     VALUES ($1, $2, $3, $4, 'ACTIVE')
     ON CONFLICT (utr) DO NOTHING
     RETURNING ${COLUMNS}`,
    [normalized, String(orderId), userId ? String(userId) : null,
      amountRupees === null ? null : rupeesToPaise(amountRupees)],
    'utr_claim',
  );
  if (rows[0]) return { ok: true, entry: toEntry(rows[0]) };

  // Taken. Count the attempt and report whose it is — the count is what turns a
  // refusal into a reviewable pattern.
  const { rows: contested } = await pgQuery(
    `UPDATE utr_registry SET duplicate_attempts = duplicate_attempts + 1,
                             last_contested_at  = now()
      WHERE utr = $1 AND order_id <> $2
      RETURNING ${COLUMNS}`,
    [normalized, String(orderId)], 'utr_duplicate_attempt',
  );
  if (contested[0]) {
    const entry = toEntry(contested[0]);
    return {
      ok: false,
      reason: entry.status === UTR_STATUS.FRAUD ? 'FRAUD_FLAGGED' : 'DUPLICATE_UTR',
      entry,
    };
  }

  // Same order, same reference: a retried submission, not a duplicate.
  const existing = await getUtr(normalized);
  return { ok: true, idempotent: true, entry: existing };
}

/**
 * Has this reference been used, and by whom?
 *
 * A READ, for showing a warning before a player commits. It is NOT the guard —
 * `claimUtr` is, because anything decided here can be invalidated before the
 * write. Kept separate so nobody mistakes one for the other.
 */
export async function checkUtr(utr) {
  const entry = await getUtr(utr);
  if (!entry) return { isUsed: false, warning: null, previousData: null };
  return {
    isUsed: true,
    warning: entry.status === UTR_STATUS.FRAUD ? 'FRAUD_ALERT' : 'DUPLICATE_UTR',
    previousData: {
      orderId: entry.orderId, userId: entry.userId,
      status: entry.status, registeredAt: entry.registeredAt,
    },
  };
}

export async function getUtr(utr) {
  const normalized = normalizeUtr(utr);
  if (!normalized) return null;
  const { rows } = await pgQuery(
    `SELECT ${COLUMNS} FROM utr_registry WHERE utr = $1`, [normalized], 'utr_get',
  );
  return toEntry(rows[0]);
}

export async function getUtrForOrder(orderId) {
  const { rows } = await pgQuery(
    `SELECT ${COLUMNS} FROM utr_registry WHERE order_id = $1`, [String(orderId)], 'utr_for_order',
  );
  return toEntry(rows[0]);
}

/**
 * Mark a reference spent, because its order finished.
 *
 * RELEASED does not free it. The row stays and the primary key still refuses a
 * second claim — this only records that the order it belonged to is closed.
 * Never applied to a FRAUD row: releasing one would quietly retire a flag an
 * operator raised deliberately.
 */
export async function releaseUtr(orderId) {
  const { rows } = await pgQuery(
    `UPDATE utr_registry SET status = 'RELEASED', released_at = now()
      WHERE order_id = $1 AND status = 'ACTIVE'
      RETURNING ${COLUMNS}`,
    [String(orderId)], 'utr_release',
  );
  return toEntry(rows[0]);
}

/**
 * Flag a reference as fraudulent.
 *
 * Requires an actor and a reason, because the row does: an unattributed fraud
 * marking is one nobody can defend in a dispute, and it blocks a real customer
 * who then has nobody to appeal to.
 */
export async function flagFraud(utr, { actor, reason }) {
  if (!actor) throw new Error('flagFraud requires an actor');
  if (!String(reason ?? '').trim()) throw new Error('flagFraud requires a reason');
  const { rows } = await pgQuery(
    `UPDATE utr_registry SET
       status = 'FRAUD', flagged_at = now(), flagged_by = $2, flag_reason = $3,
       last_contested_at = now()
      WHERE utr = $1 RETURNING ${COLUMNS}`,
    [normalizeUtr(utr), String(actor), String(reason).trim()], 'utr_flag_fraud',
  );
  return rows[0] ? { ok: true, entry: toEntry(rows[0]) } : { ok: false, reason: 'NOT_FOUND' };
}

/** Lift a flag. Recorded as a state change, not by erasing the previous one. */
export async function clearFraudFlag(utr, { actor }) {
  const { rows } = await pgQuery(
    `UPDATE utr_registry SET
       status = CASE WHEN released_at IS NOT NULL THEN 'RELEASED' ELSE 'ACTIVE' END,
       flag_reason = 'Cleared by ' || $2 || ' (was: ' || COALESCE(flag_reason, '') || ')',
       flagged_by = $2, flagged_at = now()
      WHERE utr = $1 AND status = 'FRAUD'
      RETURNING ${COLUMNS}`,
    [normalizeUtr(utr), String(actor)], 'utr_clear_flag',
  );
  return rows[0] ? { ok: true, entry: toEntry(rows[0]) } : { ok: false, reason: 'NOT_FLAGGED' };
}

/**
 * The registry, paged, with the player and order attached.
 *
 * ── The join a populate cannot do ───────────────────────────────────────────
 * The admin screen showed the order's amount and the player's username beside
 * each reference. Two `populate` calls fetched them per page and yielded null
 * for a since-deleted player or order — rendered as a blank cell that reads as
 * missing data rather than as a closed account.
 *
 * Page and total come from one query, so a reference claimed while an operator
 * is paging cannot make the footer disagree with the rows.
 */
export async function listRegistry({ status = null, page = 1, limit = 50 } = {}) {
  const params = []; const where = [];
  if (status) { params.push(String(status)); where.push(`r.status = $${params.length}`); }

  const size = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const offset = Math.max((Number(page) || 1) - 1, 0) * size;
  params.push(size, offset);

  const { rows } = await pgQuery(
    `SELECT ${COLUMNS.split(',').map((c) => `r.${c.trim()}`).join(', ')},
            u.username, u.mobile, u.kyc_status,
            o.order_type, o.state AS order_state,
            o.fiat_amount_paise, o.token_amount_paise, o.proof_screenshot,
            COUNT(*) OVER () AS total_rows
       FROM utr_registry r
       LEFT JOIN users u        ON u.user_id  = r.user_id
       LEFT JOIN order_states o ON o.order_id = r.order_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY r.registered_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params, 'utr_list_registry',
  );

  return {
    total: rows.length ? Number(rows[0].total_rows) : 0,
    page: Math.max(Number(page) || 1, 1),
    limit: size,
    entries: rows.map((r) => ({
      ...toEntry(r),
      user: r.username === null ? null : {
        username: r.username, mobile: r.mobile, kycStatus: r.kyc_status,
      },
      order: r.order_type === null ? null : {
        orderId: r.order_id, type: r.order_type, status: r.order_state,
        fiatAmount: paiseToRupees(Number(r.fiat_amount_paise)),
        tokenAmount: paiseToRupees(Number(r.token_amount_paise)),
        proofScreenshot: r.proof_screenshot,
      },
    })),
  };
}

/** One reference with everything an operator reviewing it needs. */
export async function getRegistryEntry(utr) {
  const normalized = normalizeUtr(utr);
  if (!normalized) return null;
  const { rows } = await pgQuery(
    `SELECT ${COLUMNS.split(',').map((c) => `r.${c.trim()}`).join(', ')},
            u.username, u.mobile, u.kyc_status,
            o.order_type, o.state AS order_state,
            o.fiat_amount_paise, o.token_amount_paise, o.proof_screenshot
       FROM utr_registry r
       LEFT JOIN users u        ON u.user_id  = r.user_id
       LEFT JOIN order_states o ON o.order_id = r.order_id
      WHERE r.utr = $1`,
    [normalized], 'utr_registry_entry',
  );
  const r = rows[0];
  if (!r) return null;
  return {
    ...toEntry(r),
    user: r.username === null ? null : {
      username: r.username, mobile: r.mobile, kycStatus: r.kyc_status,
    },
    order: r.order_type === null ? null : {
      orderId: r.order_id, type: r.order_type, status: r.order_state,
      fiatAmount: paiseToRupees(Number(r.fiat_amount_paise)),
      tokenAmount: paiseToRupees(Number(r.token_amount_paise)),
      proofScreenshot: r.proof_screenshot,
    },
  };
}

/** A player's payment references, most recent first. */
export async function userUtrHistory(userId, { limit = 20 } = {}) {
  const { rows } = await pgQuery(
    `SELECT ${COLUMNS} FROM utr_registry WHERE user_id = $1
      ORDER BY registered_at DESC LIMIT $2`,
    [String(userId), Math.min(Math.max(Number(limit) || 20, 1), 100)], 'utr_user_history',
  );
  return rows.map(toEntry);
}

/**
 * References somebody tried to reuse, or that an operator flagged.
 *
 * The review queue. A refused duplicate is a signal, and a signal nobody looks
 * at is not a control.
 */
/**
 * The review queue, NEWEST CONTEST FIRST.
 *
 * It used to be ordered by `duplicate_attempts DESC`, and that made it a queue
 * nobody could work. Nothing ever leaves this table — a released reference is
 * spent, not free — so contested rows accumulate for the life of the platform.
 * A count-ordered queue therefore converges on a fixed list of the oldest, most
 * attacked references, and every new attempt sorts underneath it. A manual
 * FRAUD flag starts at zero attempts and sorted DEAD LAST, so the one entry a
 * human had already judged worth flagging was the one an operator could never
 * reach. Recency is what a queue is worked by; the count is still the tiebreak.
 *
 * Paged, and it reports the total, because a fixed slice of an unbounded list
 * silently hides everything past it.
 */
export async function contestedUtrs({ limit = 100, page = 1 } = {}) {
  const size = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const offset = Math.max((Number(page) || 1) - 1, 0) * size;
  const { rows } = await pgQuery(
    `SELECT ${COLUMNS}, COUNT(*) OVER () AS total_rows FROM utr_registry
      WHERE duplicate_attempts > 0 OR status = 'FRAUD'
      ORDER BY COALESCE(last_contested_at, flagged_at, registered_at) DESC,
               duplicate_attempts DESC
      LIMIT $1 OFFSET $2`,
    [size, offset], 'utr_contested',
  );
  return {
    entries: rows.map(toEntry),
    total: rows.length ? Number(rows[0].total_rows) : 0,
    page: Math.max(Number(page) || 1, 1),
    limit: size,
  };
}

/** Registry totals, in one pass so the figures cannot contradict each other. */
export async function utrStats() {
  const { rows } = await pgQuery(
    `SELECT
       COUNT(*)::int                                        AS total,
       COUNT(*) FILTER (WHERE status = 'ACTIVE')::int        AS active,
       COUNT(*) FILTER (WHERE status = 'RELEASED')::int      AS released,
       COUNT(*) FILTER (WHERE status = 'FRAUD')::int         AS fraud,
       COUNT(*) FILTER (WHERE duplicate_attempts > 0)::int   AS contested,
       COALESCE(SUM(duplicate_attempts), 0)::int             AS total_attempts
     FROM utr_registry`, [], 'utr_stats',
  );
  const r = rows[0];
  return {
    available: true, total: r.total, active: r.active, released: r.released,
    fraud: r.fraud, contested: r.contested, duplicateAttempts: r.total_attempts,
  };
}
