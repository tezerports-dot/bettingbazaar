// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * coldArchive.js — the one writer of `cold_archive` (owner, 2026-10-20: old
 * history "only the server readable ... admin can access that separately ...
 * no one can request those old cold histories", and it "doesn't affect the
 * users overall data").
 *
 * Old rows leave the live tables, so no player, merchant or staff screen can
 * ask for them, and are kept here whole, never deleted. Each move is ONE
 * transaction: the rows are copied, then exactly the copied rows are deleted
 * (by id, under their row locks), so a row is in one place or the other,
 * never both and never neither.
 *
 * What moves: a round past the 1,440 kept (from `pruneCycleHistory`), an ended
 * order's chat and a player's notifications once COLD_AFTER_DAYS old. What
 * never moves: bets, wallets, orders, the ledger and every other money row;
 * so balances, profiles and every total stay exactly as they were.
 */
import { withTransaction, pgQuery } from '../client.js';

/** Days a chat (from its last message) or a notification stays live (owner, 2026-10-21). */
export const COLD_AFTER_DAYS = 30;
export const COLD_KINDS = Object.freeze(['CYCLE', 'CHAT', 'NOTIFICATION']);

/**
 * Inside the pruning transaction: copy these rounds and their settlement rows
 * (the caller then deletes them). Rows already locked by the caller.
 * @returns {Promise<number>} rounds archived
 */
export async function archiveCyclesWithin(client, cycleIds) {
  if (!cycleIds.length) return 0;
  const { rowCount } = await client.query(
    `INSERT INTO cold_archive (kind, ref, first_at, last_at, row_count, rows)
     SELECT 'CYCLE', c.cycle_id, c.start_time, c.end_time,
            1 + COALESCE(s.n, 0),
            jsonb_build_array(jsonb_build_object('table', 'cycles', 'row', to_jsonb(c)))
              || COALESCE(s.rows, '[]'::jsonb)
       FROM cycles c
       LEFT JOIN LATERAL (
         SELECT COUNT(*)::int AS n,
                jsonb_agg(jsonb_build_object('table', 'cycle_settlements', 'row', to_jsonb(cs))) AS rows
           FROM cycle_settlements cs WHERE cs.cycle_id = c.cycle_id
       ) s ON TRUE
      WHERE c.cycle_id = ANY($1::text[])`,
    [cycleIds],
  );
  return rowCount;
}

/** An order whose chat can no longer matter to anyone: ended, and out of any dispute window. */
const ENDED_ORDER = `o.state IN ('COMPLETED', 'CANCELLED', 'FAILED')
  OR (o.state = 'REJECTED' AND (o.dispute_window_until IS NULL OR o.dispute_window_until < now()))`;

/**
 * Move the chats of ended orders whose last message is older than `days`,
 * one archive row per order, at most `batch` orders per call.
 * @returns {Promise<{orders:number, messages:number}>}
 */
export async function archiveOldChats({ days = COLD_AFTER_DAYS, batch = 500 } = {}) {
  return withTransaction(async (client) => {
    const { rows: picked } = await client.query(
      `SELECT m.order_id FROM chat_messages m JOIN order_states o ON o.order_id = m.order_id
        WHERE ${ENDED_ORDER}
        GROUP BY m.order_id
       HAVING max(m.created_at) < now() - make_interval(days => $1)
        ORDER BY max(m.created_at)
        LIMIT $2`,
      [days, batch],
    );
    if (!picked.length) return { orders: 0, messages: 0 };
    // Lock exactly the messages being moved; a message written after this
    // read is not among them and stays live.
    const { rows: msgs } = await client.query(
      `SELECT id FROM chat_messages WHERE order_id = ANY($1::text[]) FOR UPDATE SKIP LOCKED`,
      [picked.map((r) => r.order_id)],
    );
    const ids = msgs.map((r) => r.id);
    if (!ids.length) return { orders: 0, messages: 0 };
    const { rowCount: orders } = await client.query(
      `INSERT INTO cold_archive (kind, ref, first_at, last_at, row_count, rows)
       SELECT 'CHAT', m.order_id, min(m.created_at), max(m.created_at), COUNT(*)::int,
              jsonb_agg(jsonb_build_object('table', 'chat_messages', 'row', to_jsonb(m)) ORDER BY m.id)
         FROM chat_messages m WHERE m.id = ANY($1::bigint[])
        GROUP BY m.order_id`,
      [ids],
    );
    const { rowCount: messages } = await client.query('DELETE FROM chat_messages WHERE id = ANY($1::bigint[])', [ids]);
    return { orders, messages };
  });
}

/**
 * Move notifications older than `days`, read or not, one archive row per
 * player per run, at most `batch` notifications per call.
 * @returns {Promise<{users:number, notifications:number}>}
 */
export async function archiveOldNotifications({ days = COLD_AFTER_DAYS, batch = 5000 } = {}) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT id FROM notifications WHERE created_at < now() - make_interval(days => $1)
        ORDER BY id LIMIT $2 FOR UPDATE SKIP LOCKED`,
      [days, batch],
    );
    const ids = rows.map((r) => r.id);
    if (!ids.length) return { users: 0, notifications: 0 };
    const { rowCount: users } = await client.query(
      `INSERT INTO cold_archive (kind, ref, first_at, last_at, row_count, rows)
       SELECT 'NOTIFICATION', n.user_id, min(n.created_at), max(n.created_at), COUNT(*)::int,
              jsonb_agg(jsonb_build_object('table', 'notifications', 'row', to_jsonb(n)) ORDER BY n.id)
         FROM notifications n WHERE n.id = ANY($1::bigint[])
        GROUP BY n.user_id`,
      [ids],
    );
    const { rowCount: notifications } = await client.query('DELETE FROM notifications WHERE id = ANY($1::bigint[])', [ids]);
    return { users, notifications };
  });
}

const kindOf = (kind) => {
  if (kind == null || kind === '' || kind === 'ALL') return null;
  if (!COLD_KINDS.includes(kind)) throw Object.assign(new Error(`unknown kind ${kind}`), { status: 400, code: 'UNKNOWN_KIND' });
  return kind;
};

const toEntry = (r) => ({
  id: Number(r.id),
  kind: r.kind,
  ref: r.ref,
  firstAt: r.first_at,
  lastAt: r.last_at,
  rowCount: r.row_count,
  archivedAt: r.archived_at,
});

/**
 * What is in cold storage, newest first, without the rows. `ref` finds one
 * round, order or player exactly. Totals per kind are over the whole archive.
 */
export async function listArchive({ kind = null, ref = null, limit = 100, offset = 0 } = {}) {
  const k = kindOf(kind);
  const r = ref ? String(ref).trim().slice(0, 200) : null;
  const [{ rows }, totals] = await Promise.all([
    pgQuery(
      `SELECT id, kind, ref, first_at, last_at, row_count, archived_at FROM cold_archive
        WHERE ($1::text IS NULL OR kind = $1) AND ($2::text IS NULL OR ref = $2)
        ORDER BY archived_at DESC, id DESC
        LIMIT $3 OFFSET $4`,
      [k, r || null, Math.min(Math.max(Number(limit) || 100, 1), 500), Math.max(Number(offset) || 0, 0)],
      'cold_archive_list',
    ),
    pgQuery(
      `SELECT kind, COUNT(*)::int AS entries, COALESCE(SUM(row_count), 0)::bigint AS rows
         FROM cold_archive GROUP BY kind`,
      [], 'cold_archive_totals',
    ),
  ]);
  const byKind = Object.fromEntries(COLD_KINDS.map((x) => [x, { entries: 0, rows: 0 }]));
  for (const t of totals.rows) byKind[t.kind] = { entries: t.entries, rows: Number(t.rows) };
  return { entries: rows.map(toEntry), totals: byKind };
}

/** One archive entry with its rows, or null. */
export async function getArchiveEntry(id) {
  const n = Number(id);
  if (!Number.isSafeInteger(n) || n < 1) return null;
  const { rows } = await pgQuery('SELECT * FROM cold_archive WHERE id = $1', [n], 'cold_archive_get');
  return rows[0] ? { ...toEntry(rows[0]), rows: rows[0].rows } : null;
}
