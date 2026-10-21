// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * repositories/telegramChannels.js — the signup channels, the join requests
 * Telegram reports for them, and how far each bot's update reading has got
 * (owner, 2026-10-21). The one writer of `telegram_channels`,
 * `telegram_join_requests` and `telegram_update_offsets`.
 *
 * A player is asked to join at Verify; the request is Telegram's, made by the
 * person in Telegram. Nothing here approves one on its own: `markApproved` is
 * called only for a request an admin chose to approve and Telegram accepted.
 */
import { pgQuery } from '../client.js';

const CHANNEL_COLUMNS = `chat_id, title, username, invite_link, link_bot_id, link_checked_at,
  link_error, active, added_at, added_by, switched_at, switched_by`;

const toChannel = (r) => ({
  chatId: r.chat_id,
  title: r.title,
  username: r.username || '',
  inviteLink: r.invite_link || '',
  linkBotId: r.link_bot_id || '',
  linkCheckedAt: r.link_checked_at,
  linkError: r.link_error || '',
  active: Boolean(r.active),
  addedAt: r.added_at,
  addedBy: r.added_by,
  switchedAt: r.switched_at,
  switchedBy: r.switched_by,
});

/** Every channel ever saved, the ones on first, with its request counts. */
export async function listChannels() {
  const { rows } = await pgQuery(
    `SELECT ${CHANNEL_COLUMNS.split(',').map((c) => `c.${c.trim()}`).join(', ')},
            COUNT(r.*) FILTER (WHERE r.status = 'PENDING')  AS waiting,
            COUNT(r.*) FILTER (WHERE r.status = 'APPROVED') AS approved,
            COUNT(r.*) FILTER (WHERE r.status = 'GONE')     AS gone
       FROM telegram_channels c
       LEFT JOIN telegram_join_requests r ON r.chat_id = c.chat_id
      GROUP BY c.chat_id
      ORDER BY c.active DESC, c.added_at DESC`,
    [], 'tg_channels_list',
  );
  return rows.map((r) => ({
    ...toChannel(r),
    waiting: Number(r.waiting), approved: Number(r.approved), gone: Number(r.gone),
  }));
}

/** The channels switched on. */
export async function activeChannels() {
  const { rows } = await pgQuery(
    `SELECT ${CHANNEL_COLUMNS} FROM telegram_channels WHERE active ORDER BY added_at`,
    [], 'tg_channels_active',
  );
  return rows.map(toChannel);
}

/**
 * The channels switched on, with a link, that this Telegram account has no
 * waiting or approved request for: what its Verify asks it to join. A request
 * Telegram dropped (GONE) is asked for again.
 */
export async function channelsToJoin(telegramUserId) {
  const { rows } = await pgQuery(
    `SELECT c.chat_id, c.title, c.invite_link
       FROM telegram_channels c
      WHERE c.active AND c.invite_link <> ''
        AND NOT EXISTS (SELECT 1 FROM telegram_join_requests r
                         WHERE r.chat_id = c.chat_id AND r.telegram_user_id = $1
                           AND r.status IN ('PENDING', 'APPROVED'))
      ORDER BY c.added_at`,
    [String(telegramUserId)], 'tg_channels_to_join',
  );
  return rows.map((r) => ({ chatId: r.chat_id, title: r.title, inviteLink: r.invite_link }));
}

/**
 * Save a channel Telegram described, switched on. Saving one already known
 * switches it back on and takes Telegram's current title.
 */
export async function saveChannel({ chatId, title, username = '', addedBy }) {
  const { rows } = await pgQuery(
    `INSERT INTO telegram_channels (chat_id, title, username, added_by)
          VALUES ($1, $2, $3, $4)
     ON CONFLICT (chat_id) DO UPDATE
           SET title = EXCLUDED.title, username = EXCLUDED.username,
               active = true, switched_at = now(), switched_by = EXCLUDED.added_by
     RETURNING ${CHANNEL_COLUMNS}`,
    [String(chatId), String(title).slice(0, 255), String(username || ''), addedBy ?? null],
    'tg_channel_save',
  );
  return toChannel(rows[0]);
}

/** Switch a channel on or off. Null when there is no such channel. */
export async function setChannelActive({ chatId, active, by }) {
  const { rows } = await pgQuery(
    `UPDATE telegram_channels SET active = $2, switched_at = now(), switched_by = $3
      WHERE chat_id = $1 RETURNING ${CHANNEL_COLUMNS}`,
    [String(chatId), Boolean(active), by ?? null], 'tg_channel_switch',
  );
  return rows[0] ? toChannel(rows[0]) : null;
}

/** Record the invite link a bot made (or the reason it could not). */
export async function setInviteLink({ chatId, inviteLink, botId, error = '' }) {
  const { rows } = await pgQuery(
    `UPDATE telegram_channels
        SET invite_link = COALESCE($2, invite_link),
            link_bot_id = COALESCE($3, link_bot_id),
            link_error = $4, link_checked_at = now()
      WHERE chat_id = $1 RETURNING ${CHANNEL_COLUMNS}`,
    [String(chatId), inviteLink ?? null, botId ?? null, String(error).slice(0, 500)],
    'tg_channel_link',
  );
  return rows[0] ? toChannel(rows[0]) : null;
}

/**
 * A join request Telegram reported, for a channel we know. A new request on a
 * row already APPROVED leaves it approved; one on a GONE row reopens it.
 * Returns false for a channel that is not ours (nothing written).
 */
export async function recordJoinRequest({ chatId, telegramUserId, requestedAt }) {
  const { rowCount } = await pgQuery(
    `INSERT INTO telegram_join_requests (chat_id, telegram_user_id, requested_at)
     SELECT $1, $2, $3 WHERE EXISTS (SELECT 1 FROM telegram_channels WHERE chat_id = $1)
     ON CONFLICT (chat_id, telegram_user_id) DO UPDATE
           SET status = CASE WHEN telegram_join_requests.status = 'APPROVED' THEN 'APPROVED' ELSE 'PENDING' END,
               requested_at = EXCLUDED.requested_at, seen_at = now(), error = ''`,
    [String(chatId), String(telegramUserId), requestedAt], 'tg_join_request_record',
  );
  return rowCount > 0;
}

/** The oldest waiting requests of a channel, up to `limit`. */
export async function waitingRequests(chatId, { limit = 500 } = {}) {
  const { rows } = await pgQuery(
    `SELECT telegram_user_id FROM telegram_join_requests
      WHERE chat_id = $1 AND status = 'PENDING'
      ORDER BY requested_at LIMIT $2`,
    [String(chatId), Math.max(1, Math.min(Number(limit) || 500, 5000))], 'tg_join_requests_waiting',
  );
  return rows.map((r) => r.telegram_user_id);
}

/**
 * Close a waiting request: APPROVED once Telegram accepted the approval, GONE
 * when Telegram no longer holds it. Only a PENDING row moves (the WHERE), so a
 * request decided twice is decided once.
 */
export async function decideRequest({ chatId, telegramUserId, status, by, error = '' }) {
  if (status !== 'APPROVED' && status !== 'GONE') throw new Error(`decideRequest: unknown status ${status}`);
  const { rowCount } = await pgQuery(
    `UPDATE telegram_join_requests
        SET status = $3, decided_at = now(), decided_by = $4, error = $5
      WHERE chat_id = $1 AND telegram_user_id = $2 AND status = 'PENDING'`,
    [String(chatId), String(telegramUserId), status, by ?? null, String(error).slice(0, 300)],
    'tg_join_request_decide',
  );
  return rowCount > 0;
}

/** The next update id this bot should ask Telegram for. */
export async function updateOffset(botId) {
  const { rows } = await pgQuery(
    'SELECT next_offset FROM telegram_update_offsets WHERE bot_id = $1',
    [String(botId)], 'tg_update_offset_get',
  );
  return rows[0] ? Number(rows[0].next_offset) : 0;
}

/** Move a bot's reading forward; never backward. */
export async function advanceOffset(botId, nextOffset) {
  await pgQuery(
    `INSERT INTO telegram_update_offsets (bot_id, next_offset) VALUES ($1, $2)
     ON CONFLICT (bot_id) DO UPDATE SET next_offset = EXCLUDED.next_offset, updated_at = now()
      WHERE telegram_update_offsets.next_offset < EXCLUDED.next_offset`,
    [String(botId), Number(nextOffset)], 'tg_update_offset_advance',
  );
}
