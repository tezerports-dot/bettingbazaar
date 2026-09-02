// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file.
/**
 * repositories/social.js — the public chat room and the support desk.
 *
 * Both are moderated, and moderation is why the deletes here are SOFT. A
 * moderator removing a message must not destroy the evidence of what was said —
 * that evidence is the whole content of the report that prompted the removal.
 */
import { pgQuery } from '../client.js';
import { randomBytes } from 'node:crypto';

const newId = () => randomBytes(12).toString('hex');

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

/** The moderation queue. */
export async function listPendingChatMessages({ limit = 100 } = {}) {
  const { rows } = await pgQuery(
    `SELECT * FROM public_chat_messages WHERE status = 'PENDING' AND NOT is_deleted
      ORDER BY created_at ASC LIMIT $1`,
    [Math.min(Math.max(Number(limit) || 100, 1), 500)], 'chat_pending',
  );
  return rows.map(toMessage);
}

export async function moderateChatMessage(id, { approve, moderatorId, reason = null }) {
  const { rows } = await pgQuery(
    `UPDATE public_chat_messages SET
       status = $2, approved_by = $3, approved_at = now(),
       reject_reason = $4
      WHERE id = $1 AND status = 'PENDING'
      RETURNING *`,
    [Number(id), approve ? 'APPROVED' : 'REJECTED', String(moderatorId),
      // The CHECK requires a reason on a rejection: a moderation decision the
      // author cannot be told the reason for is one they cannot appeal.
      approve ? null : (reason || 'Rejected by moderator')],
    'chat_moderate',
  );
  return rows[0] ? { ok: true, message: toMessage(rows[0]) } : { ok: false, reason: 'NOT_PENDING' };
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

export async function reportChatMessage(id) {
  const { rows } = await pgQuery(
    'UPDATE public_chat_messages SET report_count = report_count + 1 WHERE id = $1 RETURNING report_count',
    [Number(id)], 'chat_report',
  );
  return rows[0] ? rows[0].report_count : 0;
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

/** Is this player banned right now? Expiry decided by the read. */
export async function isChatBanned(userId) {
  const { rows } = await pgQuery(
    `SELECT 1 FROM chat_bans WHERE user_id = $1 AND (ban_until IS NULL OR ban_until > now())`,
    [String(userId)], 'chat_is_banned',
  );
  return rows.length > 0;
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

// ── Support tickets ─────────────────────────────────────────────────────────

const toTicket = (r) => (r ? {
  ticketId: r.ticket_id, _id: r.ticket_id, userId: r.user_id,
  subject: r.subject, category: r.category, priority: r.priority, status: r.status,
  assignedTo: r.assigned_to, assignedAt: r.assigned_at,
  resolvedAt: r.resolved_at, closedAt: r.closed_at,
  rating: r.rating, ratingNote: r.rating_note,
  lastReplyAt: r.last_reply_at, createdAt: r.created_at,
} : null);

export async function openTicket({ userId, subject, category = 'GENERAL', priority = 'NORMAL' }) {
  if (!userId || !subject) throw new Error('openTicket requires a userId and a subject');
  const { rows } = await pgQuery(
    `INSERT INTO support_tickets (ticket_id, user_id, subject, category, priority)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [newId(), String(userId), String(subject), String(category), String(priority)],
    'ticket_open',
  );
  return toTicket(rows[0]);
}

export async function getTicket(ticketId) {
  const { rows } = await pgQuery(
    'SELECT * FROM support_tickets WHERE ticket_id = $1', [String(ticketId)], 'ticket_get',
  );
  return toTicket(rows[0]);
}

/**
 * Claim a ticket for an agent.
 *
 * Guarded on the current state IN the statement, so two agents opening the same
 * ticket produce one owner rather than a last-write-wins overwrite — and the
 * one who loses is told, instead of both believing they have it.
 */
export async function assignTicket(ticketId, agentId) {
  const { rows } = await pgQuery(
    `UPDATE support_tickets SET status = 'ASSIGNED', assigned_to = $2, assigned_at = now()
      WHERE ticket_id = $1 AND status IN ('OPEN', 'WAITING_USER') AND assigned_to IS NULL
      RETURNING *`,
    [String(ticketId), String(agentId)], 'ticket_assign',
  );
  if (rows[0]) return { ok: true, ticket: toTicket(rows[0]) };
  const current = await getTicket(ticketId);
  if (!current) return { ok: false, reason: 'NOT_FOUND' };
  return { ok: false, reason: 'ALREADY_ASSIGNED', assignedTo: current.assignedTo };
}

/** Move a ticket's state. The timestamp for each state moves with it. */
export async function setTicketStatus(ticketId, status) {
  const { rows } = await pgQuery(
    `UPDATE support_tickets SET
       status = $2,
       resolved_at = CASE WHEN $2 = 'RESOLVED' THEN now() ELSE resolved_at END,
       closed_at   = CASE WHEN $2 = 'CLOSED'   THEN now() ELSE closed_at   END
      WHERE ticket_id = $1 RETURNING *`,
    [String(ticketId), String(status)], 'ticket_set_status',
  );
  return toTicket(rows[0]);
}

/** The player's rating of the resolution. 1–5, enforced by the row. */
export async function rateTicket(ticketId, userId, { rating, note = null }) {
  const { rows } = await pgQuery(
    `UPDATE support_tickets SET rating = $3, rating_note = $4
      WHERE ticket_id = $1 AND user_id = $2 AND status IN ('RESOLVED', 'CLOSED')
      RETURNING *`,
    [String(ticketId), String(userId), Number(rating), note], 'ticket_rate',
  );
  return rows[0] ? { ok: true, ticket: toTicket(rows[0]) } : { ok: false, reason: 'NOT_RATEABLE' };
}

export async function listTickets({ userId = null, status = null, assignedTo = null, limit = 100 } = {}) {
  const where = []; const params = [];
  if (userId) { params.push(String(userId)); where.push(`user_id = $${params.length}`); }
  if (status) { params.push(String(status)); where.push(`status = $${params.length}`); }
  if (assignedTo) { params.push(String(assignedTo)); where.push(`assigned_to = $${params.length}`); }
  const { rows } = await pgQuery(
    `SELECT * FROM support_tickets ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY created_at DESC LIMIT ${Math.min(Math.max(Number(limit) || 100, 1), 500)}`,
    params, 'ticket_list',
  );
  return rows.map(toTicket);
}

/** The agent queue: open work, most urgent and oldest first. */
export async function listTicketQueue({ limit = 100 } = {}) {
  const { rows } = await pgQuery(
    `SELECT * FROM support_tickets
      WHERE status IN ('OPEN', 'ASSIGNED', 'WAITING_USER')
      ORDER BY CASE priority
        WHEN 'URGENT' THEN 0 WHEN 'HIGH' THEN 1 WHEN 'NORMAL' THEN 2 ELSE 3 END,
        created_at ASC
      LIMIT $1`,
    [Math.min(Math.max(Number(limit) || 100, 1), 500)], 'ticket_queue',
  );
  return rows.map(toTicket);
}

// ── Support messages ────────────────────────────────────────────────────────

const toSupportMessage = (r) => (r ? {
  id: Number(r.id), ticketId: r.ticket_id, senderId: r.sender_id,
  senderType: r.sender_type, content: r.content, attachments: r.attachments,
  isRead: r.is_read, readAt: r.read_at, createdAt: r.created_at,
} : null);

/**
 * Reply on a ticket.
 *
 * The reply and the ticket's `last_reply_at` move in ONE transaction: a queue
 * ordered by last reply must not show a ticket as untouched because the second
 * write failed.
 */
export async function replyToTicket({ ticketId, senderId = null, senderType, content = '', attachments = [] }) {
  const { rows } = await pgQuery(
    `WITH inserted AS (
       INSERT INTO support_messages (ticket_id, sender_id, sender_type, content, attachments)
       VALUES ($1,$2,$3,$4,$5) RETURNING *
     ), touched AS (
       UPDATE support_tickets SET last_reply_at = now() WHERE ticket_id = $1
     )
     SELECT * FROM inserted`,
    [String(ticketId), senderId ? String(senderId) : null, String(senderType),
      String(content), attachments], 'ticket_reply',
  );
  return toSupportMessage(rows[0]);
}

export async function listTicketMessages(ticketId, { limit = 200 } = {}) {
  const { rows } = await pgQuery(
    `SELECT * FROM support_messages WHERE ticket_id = $1
      ORDER BY created_at ASC, id ASC LIMIT $2`,
    [String(ticketId), Math.min(Math.max(Number(limit) || 200, 1), 1000)], 'ticket_messages',
  );
  return rows.map(toSupportMessage);
}

export async function markTicketMessagesRead(ticketId, { forType = 'USER' } = {}) {
  const { rowCount } = await pgQuery(
    `UPDATE support_messages SET is_read = TRUE, read_at = now()
      WHERE ticket_id = $1 AND NOT is_read AND sender_type <> $2`,
    [String(ticketId), String(forType)], 'ticket_messages_read',
  );
  return rowCount;
}
