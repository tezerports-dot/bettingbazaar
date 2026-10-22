// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * errorLog.js — the one writer of `error_log` (owner, 2026-10-20: "full error
 * log whether it's server or user or merchant or admin panels errors, with
 * category and severity, red green yellow, time stamped, fixed or not yet").
 *
 * One row per distinct error. What makes two reports the SAME error is the
 * fingerprint: source, category, where, and the message with its numbers and
 * ids blanked (§32 S45), so "order ORD123 failed" and "order ORD124 failed"
 * are one row counted twice, not two rows. A repeat adds to `occurrences`,
 * moves `last_seen_at`, keeps the worst severity seen, and reopens a row an
 * admin had marked FIXED (`reopened` counts how often that happened).
 */
import { createHash } from 'node:crypto';
import { pgQuery } from '../client.js';

export const ERROR_SOURCES = Object.freeze(['SERVER', 'PLAYER_APP', 'MERCHANT_PANEL', 'ADMIN_PANEL']);
export const ERROR_CATEGORIES = Object.freeze([
  'API', 'JOB', 'MONEY_ALERT', 'SERVER_LOG', 'SCREEN_CRASH', 'SCRIPT', 'PROMISE', 'UPDATE_LOAD',
]);
/** Worst first: red, yellow, green on the admin's screen. */
export const ERROR_SEVERITIES = Object.freeze(['CRITICAL', 'WARNING', 'MINOR']);
export const ERROR_STATUSES = Object.freeze(['OPEN', 'FIXED']);

const LIMITS = Object.freeze({ message: 2000, detail: 20000, component: 8000, location: 500 });

const clip = (v, n) => (v == null || v === '' ? null : String(v).slice(0, n));

/** The message with what varies between repeats of one error blanked out. */
export function normaliseMessage(message) {
  return String(message ?? '')
    .replace(/https?:\/\/[^\s)'"]+/g, (u) => u.replace(/[?#].*$/, '').replace(/-[A-Za-z0-9_]{6,}\.(js|css)$/, '-*.$1'))
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<id>')
    .replace(/\b(?=\w*\d)(?=\w*[A-Za-z])\w{4,}\b/g, '<id>')
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

/** Where, without the parts that differ per visit (query, fragment ids, numbers). */
export function normaliseLocation(location) {
  return String(location ?? '')
    .replace(/^https?:\/\/[^/]+/, '')
    .replace(/\?.*$/, '')
    .replace(/\/(?=[^/]*\d)[^/]+/g, '/:id')
    .slice(0, 200);
}

export function fingerprintOf({ source, category, message, location }) {
  return createHash('sha256')
    .update([source, category, normaliseLocation(location), normaliseMessage(message)].join('|'))
    .digest('hex');
}

/**
 * Record one or more occurrences of an error. Never throws for a bad report:
 * an unknown source, category or severity is refused by name (status 400).
 * @returns {Promise<{id:number, occurrences:number, status:string}>}
 */
export async function recordError({
  source, category, severity, message, detail = null, component = null, location = null, count = 1,
}) {
  if (!ERROR_SOURCES.includes(source)) throw Object.assign(new Error(`unknown error source ${source}`), { status: 400 });
  if (!ERROR_CATEGORIES.includes(category)) throw Object.assign(new Error(`unknown error category ${category}`), { status: 400 });
  if (!ERROR_SEVERITIES.includes(severity)) throw Object.assign(new Error(`unknown error severity ${severity}`), { status: 400 });
  const text = clip(message, LIMITS.message);
  if (!text) throw Object.assign(new Error('an error needs a message'), { status: 400 });
  const n = Math.max(1, Math.min(Number.isInteger(count) ? count : 1, 1_000_000));
  const fingerprint = fingerprintOf({ source, category, message: text, location });
  // The worst severity seen wins: CRITICAL < WARNING < MINOR by array_position.
  const { rows } = await pgQuery(
    `INSERT INTO error_log AS e
       (fingerprint, source, category, severity, message, detail, component, location, occurrences)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (fingerprint) DO UPDATE SET
       occurrences  = LEAST(e.occurrences::bigint + EXCLUDED.occurrences, 2147483647)::int,
       last_seen_at = now(),
       message      = EXCLUDED.message,
       detail       = COALESCE(EXCLUDED.detail, e.detail),
       component    = COALESCE(EXCLUDED.component, e.component),
       location     = COALESCE(EXCLUDED.location, e.location),
       severity     = CASE WHEN array_position($10::text[], EXCLUDED.severity) < array_position($10::text[], e.severity)
                           THEN EXCLUDED.severity ELSE e.severity END,
       reopened     = e.reopened + (e.status = 'FIXED')::int,
       status       = 'OPEN',
       fixed_at     = NULL,
       fixed_by     = NULL
     RETURNING id, occurrences, status`,
    [fingerprint, source, category, severity, text, clip(detail, LIMITS.detail),
      clip(component, LIMITS.component), clip(location, LIMITS.location), n, ERROR_SEVERITIES],
    'error_log_record',
  );
  return { id: Number(rows[0].id), occurrences: rows[0].occurrences, status: rows[0].status };
}

const toEntry = (r) => ({
  id: Number(r.id),
  source: r.source,
  category: r.category,
  severity: r.severity,
  message: r.message,
  detail: r.detail,
  component: r.component,
  location: r.location,
  occurrences: r.occurrences,
  firstSeenAt: r.first_seen_at,
  lastSeenAt: r.last_seen_at,
  status: r.status,
  fixedAt: r.fixed_at,
  fixedBy: r.fixed_by,
  reopened: r.reopened,
});

const oneOf = (value, list, name) => {
  if (value == null || value === '' || value === 'ALL') return null;
  if (!list.includes(value)) throw Object.assign(new Error(`unknown ${name} ${value}`), { status: 400, code: 'UNKNOWN_FILTER' });
  return value;
};

/**
 * The log, open errors worst first then newest, or by filter. Counts are over
 * every row the filters match, not just the page.
 */
export async function listErrors({ source, category, severity, status, limit = 200 } = {}) {
  const params = [
    oneOf(source, ERROR_SOURCES, 'source'),
    oneOf(category, ERROR_CATEGORIES, 'category'),
    oneOf(severity, ERROR_SEVERITIES, 'severity'),
    oneOf(status, ERROR_STATUSES, 'status'),
  ];
  const where = `($1::text IS NULL OR source = $1) AND ($2::text IS NULL OR category = $2)
             AND ($3::text IS NULL OR severity = $3) AND ($4::text IS NULL OR status = $4)`;
  const [{ rows }, totals] = await Promise.all([
    pgQuery(
      `SELECT * FROM error_log WHERE ${where}
        ORDER BY (status = 'FIXED'), array_position($5::text[], severity), last_seen_at DESC
        LIMIT $6`,
      [...params, ERROR_SEVERITIES, Math.min(Math.max(Number(limit) || 200, 1), 1000)], 'error_log_list',
    ),
    pgQuery(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE status = 'OPEN')::int AS open,
              COUNT(*) FILTER (WHERE status = 'OPEN' AND severity = 'CRITICAL')::int AS critical,
              COUNT(*) FILTER (WHERE status = 'OPEN' AND severity = 'WARNING')::int AS warning,
              COUNT(*) FILTER (WHERE status = 'OPEN' AND severity = 'MINOR')::int AS minor,
              COUNT(*) FILTER (WHERE status = 'FIXED')::int AS fixed
         FROM error_log WHERE ${where}`,
      params, 'error_log_totals',
    ),
  ]);
  return { entries: rows.map(toEntry), totals: totals.rows[0] };
}

/**
 * Mark an error fixed, or open again. The guard is in the WHERE: marking a row
 * that is already in that state changes nothing and says so.
 * @returns {Promise<object|null>} the row, or null when it does not exist
 */
export async function setErrorStatus(id, status, actor) {
  if (!ERROR_STATUSES.includes(status)) throw Object.assign(new Error(`unknown status ${status}`), { status: 400, code: 'UNKNOWN_STATUS' });
  const { rows } = await pgQuery(
    `UPDATE error_log SET status = $2,
            fixed_at = CASE WHEN $2 = 'FIXED' THEN now() END,
            fixed_by = CASE WHEN $2 = 'FIXED' THEN $3 END
      WHERE id = $1
      RETURNING *`,
    [Number(id), status, actor ? String(actor).slice(0, 100) : null], 'error_log_status',
  );
  return rows[0] ? toEntry(rows[0]) : null;
}

/** Delete the rows marked FIXED. Open errors are never cleared by hand. */
export async function clearFixedErrors() {
  const { rowCount } = await pgQuery(`DELETE FROM error_log WHERE status = 'FIXED'`, [], 'error_log_clear_fixed');
  return rowCount;
}
