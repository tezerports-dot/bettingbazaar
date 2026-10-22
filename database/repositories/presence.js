// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * How many players are online, minute by minute (owner, 2026-10-22: "peak
 * concurrent users live and with historical peak with times").
 *
 * The one writer of `presence_samples`. Each realtime worker records, once a
 * minute, how many players hold a live stream on it
 * (`backend/domains/analytics/presenceSampler.js`); a minute's figure is the
 * sum over workers. A player whose streams land on two workers counts on both,
 * so the figure can read high by those few; it never misses one.
 */
import { pgQuery } from '../client.js';

/** How long samples are kept, in days. */
export const PRESENCE_KEEP_DAYS = 400;

/** This worker's count for the current minute (the database's clock). A second write in the minute replaces the first. */
export async function recordSample(workerId, players) {
  const n = Math.max(0, Math.trunc(Number(players) || 0));
  await pgQuery(
    `INSERT INTO presence_samples (worker_id, minute, players)
     VALUES ($1, date_trunc('minute', now()), $2)
     ON CONFLICT (minute, worker_id) DO UPDATE SET players = EXCLUDED.players`,
    [String(workerId), n], 'presence_record',
  );
}

/** Drop samples past the keep window. Returns rows removed. */
export async function pruneSamples() {
  const { rowCount } = await pgQuery(
    `DELETE FROM presence_samples WHERE minute < now() - make_interval(days => $1)`,
    [PRESENCE_KEEP_DAYS], 'presence_prune',
  );
  return rowCount;
}

const TOTALS = `SELECT minute, SUM(players)::int AS players FROM presence_samples GROUP BY minute`;

/**
 * Online now (the latest minute sampled within the last three), the peak in
 * the window `from`..`to` (timestamps, either null) and the peak ever, each
 * with its minute.
 */
export async function presenceSummary({ from = null, to = null } = {}) {
  const { rows } = await pgQuery(
    `WITH t AS (${TOTALS})
     SELECT
       (SELECT row_to_json(x) FROM (SELECT minute, players FROM t
          WHERE minute >= date_trunc('minute', now()) - interval '3 minutes'
          ORDER BY minute DESC LIMIT 1) x) AS now,
       (SELECT row_to_json(x) FROM (SELECT minute, players FROM t
          WHERE ($1::timestamptz IS NULL OR minute >= $1) AND ($2::timestamptz IS NULL OR minute < $2)
          ORDER BY players DESC, minute DESC LIMIT 1) x) AS peak,
       (SELECT row_to_json(x) FROM (SELECT minute, players FROM t
          ORDER BY players DESC, minute DESC LIMIT 1) x) AS ever`,
    [from, to], 'presence_summary',
  );
  const pick = (v) => (v ? { players: Number(v.players), at: v.minute } : null);
  const r = rows[0] ?? {};
  return { now: pick(r.now)?.players ?? 0, peak: pick(r.peak), allTimePeak: pick(r.ever) };
}
