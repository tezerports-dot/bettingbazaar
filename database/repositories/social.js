// GOVERNANCE: Read CLAUDE.md before editing this file.
/**
 * repositories/social.js — the public chat room. (The support desk is
 * `supportDesk.js`.)
 *
 * Both are moderated, and moderation is why the deletes here are SOFT. A
 * moderator removing a message must not destroy the evidence of what was said —
 * that evidence is the whole content of the report that prompted the removal.
 */
import { pgQuery } from '../client.js';

// ── Public chat ─────────────────────────────────────────────────────────────

const toMessage = (r) => (r ? {
  id: Number(r.id), _id: String(r.id),
  userId: r.user_id, displayName: r.display_name, profilePic: r.profile_pic,
  vipLevel: r.vip_level, type: r.kind, content: r.content, imageKey: r.image_key,
  status: r.status, approvedBy: r.approved_by, approvedAt: r.approved_at,
  rejectReason: r.reject_reason, isDeleted: r.is_deleted,
  reportCount: r.report_count, createdAt: r.created_at, expiresAt: r.expires_at,
} : null);

/**
 * Post to the room.
 *
 * The ban check is a JOIN in the INSERT, not a pre-read: a ban applied between
 * a check and a write would otherwise let one more message through, and the
 * message that gets through is usually the one the ban was for.
 */
export async function postChatMessage({
  userId, displayName = '', profilePic = null, vipLevel = 0,
  kind = 'TEXT', content = '', imageKey = null,
  status = 'APPROVED', expiresAt = null,
}) {
  if (!userId) throw new Error('postChatMessage requires a userId');
  const { rows } = await pgQuery(
    `INSERT INTO public_chat_messages
       (user_id, display_name, profile_pic, vip_level, kind, content, image_key, status, expires_at)
     SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9
      WHERE NOT EXISTS (
        SELECT 1 FROM chat_bans
         WHERE user_id = $1 AND (ban_until IS NULL OR ban_until > now()))
     RETURNING *`,
    [String(userId), String(displayName), profilePic, Number(vipLevel) || 0,
      String(kind), String(content), imageKey, String(status), expiresAt],
    'chat_post',
  );
  return rows[0] ? { ok: true, message: toMessage(rows[0]) } : { ok: false, reason: 'BANNED' };
}

/**
 * The room's feed, newest first.
 *
 * `(created_at, id)` because two messages in the same millisecond order
 * arbitrarily under the timestamp alone, and a chat read out of order is a
 * different conversation. Expiry is in the READ.
 */
export async function listChatMessages({ limit = 50, before = null } = {}) {
  const params = []; const where = [
    "status = 'APPROVED'", 'NOT is_deleted',
    '(expires_at IS NULL OR expires_at > now())',
  ];
  if (before?.createdAt && before?.id !== undefined) {
    params.push(before.createdAt, Number(before.id));
    where.push(`(created_at, id) < ($${params.length - 1}, $${params.length})`);
  }
  const size = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const { rows } = await pgQuery(
    `SELECT * FROM public_chat_messages WHERE ${where.join(' AND ')}
      ORDER BY created_at DESC, id DESC LIMIT ${size}`,
    params, 'chat_list',
  );
  return rows.map(toMessage);
}

/**
 * What a MODERATOR sees: everything, including deleted and rejected messages.
 *
 * Deliberately not `listChatMessages` with a flag. That function's filters are
 * correct for a player — approved, not deleted, not expired — and loosening
 * them with an option is how a moderation-only view ends up one boolean away
 * from the public feed. A moderator reviewing a report needs the deleted
 * message in front of them; a player must never see it.
 */
export async function moderationFeed({ limit = 60, includeDeleted = false } = {}) {
  const { rows } = await pgQuery(
    `SELECT * FROM public_chat_messages
      ${includeDeleted ? '' : 'WHERE NOT is_deleted'}
      ORDER BY created_at DESC, id DESC
      LIMIT ${Math.min(Math.max(Number(limit) || 60, 1), 200)}`,
    [], 'chat_moderation_feed',
  );
  return rows.map(toMessage);
}



/** Soft delete. The row survives, marked — see the module header. */
export async function deleteChatMessage(id, moderatorId) {
  const { rows } = await pgQuery(
    `UPDATE public_chat_messages SET is_deleted = TRUE, deleted_by = $2, deleted_at = now()
      WHERE id = $1 AND NOT is_deleted RETURNING *`,
    [Number(id), String(moderatorId)], 'chat_delete',
  );
  return rows[0] ? { ok: true } : { ok: false, reason: 'NOT_FOUND_OR_ALREADY_DELETED' };
}


// ── Chat bans ───────────────────────────────────────────────────────────────

/**
 * Ban a player from the room.
 *
 * `banUntil: null` means PERMANENT — a real state, and not the same as an
 * expired ban. Every read distinguishes them.
 */
export async function banFromChat(userId, { bannedBy = null, reason = '', banUntil = null } = {}) {
  const { rows } = await pgQuery(
    `INSERT INTO chat_bans (user_id, banned_by, reason, ban_until)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (user_id) DO UPDATE SET
       banned_by = EXCLUDED.banned_by, reason = EXCLUDED.reason,
       ban_until = EXCLUDED.ban_until, created_at = now()
     RETURNING *`,
    [String(userId), bannedBy, String(reason), banUntil], 'chat_ban',
  );
  return {
    userId: rows[0].user_id, bannedBy: rows[0].banned_by,
    reason: rows[0].reason, banUntil: rows[0].ban_until, createdAt: rows[0].created_at,
  };
}


export async function unbanFromChat(userId) {
  const { rowCount } = await pgQuery(
    'DELETE FROM chat_bans WHERE user_id = $1', [String(userId)], 'chat_unban',
  );
  return rowCount > 0;
}

export async function listChatBans() {
  const { rows } = await pgQuery(
    `SELECT *, (ban_until IS NULL OR ban_until > now()) AS active
       FROM chat_bans ORDER BY created_at DESC`, [], 'chat_ban_list',
  );
  return rows.map((r) => ({
    userId: r.user_id, bannedBy: r.banned_by, reason: r.reason,
    banUntil: r.ban_until, active: r.active, createdAt: r.created_at,
  }));
}
