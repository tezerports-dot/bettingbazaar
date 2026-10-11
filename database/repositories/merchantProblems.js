// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * A merchant account's problems and the flags they raise (owner, 2026-10-11 —
 * Phase B of the merchants-and-agents plan). The ONE writer of
 * `merchant_problems` and `merchant_flags`.
 *
 * ── Problems flag; they never suspend ────────────────────────────────────────
 * For an agent, three refusals in a row suspend, three unpaid buys pause
 * assignment, and lost disputes suspend. A merchant account is a business
 * with several people and accounts, and the owner's rule for it is different:
 * a refusal, an unpaid buy counted against it, or a lost dispute is a PROBLEM,
 * recorded once per order and kind on the IST day of the DATABASE clock. When
 * one day's problems reach `directMerchants.dailyProblemFlagThreshold` (default
 * 5) the merchant account is FLAGGED for that day, once. The flag acts on
 * nothing: the admin reads it and may suspend by hand.
 *
 * ── The count and the flag in one transaction, under the merchant's lock ─────
 * Two problems landing together would each count the other's absence and
 * neither raise the flag (§32 S6). So the merchant row is locked, the problem
 * written, the day COUNTED AGAIN and the flag written — one transaction; the
 * flag's UNIQUE (merchant, day) makes it once a day whatever races.
 */
import { pgQuery, withTransaction } from '../client.js';

export const PROBLEM_KINDS = Object.freeze({ REFUSAL: 'REFUSAL', EXPIRY: 'EXPIRY', DISPUTE_LOST: 'DISPUTE_LOST' });

/** The threshold from the config row, or the schema default. */
export function flagThresholdOf(cfg) {
  const n = Number(cfg?.directMerchants?.dailyProblemFlagThreshold ?? 5); // schema default: 5
  return Number.isInteger(n) && n >= 1 ? n : 5; // schema default: 5
}

/** Whether this merchant owns a merchant account (a DIRECT team). */
export async function isDirectMerchant(merchantId) {
  if (!merchantId) return false;
  const { rows } = await pgQuery('SELECT 1 FROM teams WHERE owner_merchant_id = $1',
    [String(merchantId)], 'merchant_is_direct');
  return rows.length > 0;
}

/**
 * Record one problem. Returns { ok: true, recorded, count, day, flagged, flag }:
 * `recorded` false when this order already counted for this kind; `flagged`
 * true only on the call that raised today's flag.
 */
export async function recordProblem({ merchantId, kind, orderId, threshold }) {
  return withTransaction((client) => recordProblemWithin(client, { merchantId, kind, orderId, threshold }));
}

/** The same, inside the caller's transaction (a lost dispute records its fault and its problem together). */
export async function recordProblemWithin(client, { merchantId, kind, orderId, threshold }) {
  if (!PROBLEM_KINDS[kind]) throw new TypeError(`recordProblem: unknown kind ${kind}`);
  if (!orderId) throw new TypeError('recordProblem requires an orderId');
  const limit = Number(threshold);
  if (!Number.isInteger(limit) || limit < 1) throw new TypeError(`recordProblem: threshold must be a whole number >= 1, got ${threshold}`);
  {
    await client.query('SELECT 1 FROM merchants WHERE merchant_id = $1 FOR UPDATE', [String(merchantId)]);
    const ins = await client.query(
      `INSERT INTO merchant_problems (merchant_id, kind, order_id) VALUES ($1, $2, $3)
       ON CONFLICT ON CONSTRAINT merchant_problems_once DO NOTHING
       RETURNING problem_day::text AS problem_day`,
      [String(merchantId), kind, String(orderId)]);
    const { rows: [c] } = await client.query(
      `SELECT (now() AT TIME ZONE 'Asia/Kolkata')::date::text AS day,
              count(*)::int AS n
         FROM merchant_problems
        WHERE merchant_id = $1 AND problem_day = (now() AT TIME ZONE 'Asia/Kolkata')::date`,
      [String(merchantId)]);
    let flag = null;
    if (c.n >= limit) {
      const { rows } = await client.query(
        `INSERT INTO merchant_flags (merchant_id, flag_day, problem_count, threshold)
         VALUES ($1, $2::date, $3, $4)
         ON CONFLICT ON CONSTRAINT merchant_flags_once_a_day DO NOTHING
         RETURNING id, merchant_id, flag_day::text AS flag_day, problem_count, threshold, created_at`,
        [String(merchantId), c.day, c.n, limit]);
      flag = rows[0] ? toFlag(rows[0]) : null;
    }
    return { ok: true, recorded: ins.rowCount > 0, count: c.n, day: c.day, flagged: Boolean(flag), flag };
  }
}

function toFlag(r) {
  return {
    id: Number(r.id),
    merchantId: r.merchant_id,
    merchantName: r.merchant_name ?? undefined,
    publicRef: r.public_ref ?? undefined,
    day: r.flag_day,
    problemCount: Number(r.problem_count),
    threshold: Number(r.threshold),
    createdAt: r.created_at,
  };
}

/** Flags, newest first, over the last `days` IST days; one merchant when named. */
export async function listFlags({ merchantId = null, days = 30, limit = 200 } = {}) {
  const { rows } = await pgQuery(
    `SELECT f.id, f.merchant_id, f.flag_day::text AS flag_day, f.problem_count, f.threshold, f.created_at,
            m.name AS merchant_name, m.public_ref
       FROM merchant_flags f JOIN merchants m ON m.merchant_id = f.merchant_id
      WHERE ($1::text IS NULL OR f.merchant_id = $1)
        AND f.flag_day > (now() AT TIME ZONE 'Asia/Kolkata')::date - $2::int
      ORDER BY f.flag_day DESC, f.id DESC LIMIT $3`,
    [merchantId === null ? null : String(merchantId), Math.min(Math.max(Number(days) || 30, 1), 366),
      Math.min(Math.max(Number(limit) || 200, 1), 1000)],
    'merchant_flags_list');
  return rows.map(toFlag);
}

/** A merchant's problems per IST day and kind, over the last `days` days. */
export async function problemDays(merchantId, { days = 14 } = {}) {
  const { rows } = await pgQuery(
    `SELECT problem_day::text AS problem_day, kind, count(*)::int AS n FROM merchant_problems
      WHERE merchant_id = $1 AND problem_day > (now() AT TIME ZONE 'Asia/Kolkata')::date - $2::int
      GROUP BY problem_day, kind ORDER BY problem_day DESC, kind`,
    [String(merchantId), Math.min(Math.max(Number(days) || 14, 1), 366)], 'merchant_problem_days');
  return rows.map((r) => ({ day: r.problem_day, kind: r.kind, count: r.n }));
}
