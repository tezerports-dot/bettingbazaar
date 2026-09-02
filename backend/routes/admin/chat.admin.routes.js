// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * routes/admin/chat.admin.routes.js
 * Admin console for the public chat + support ticket system (models live in
 * models/social.model.js: PublicChatMsg, ChatBan, SupportTicket, SupportMsg).
 *
 * These collections were already modelled but had no admin surface — this file
 * adds the moderation + support-desk endpoints the "Chat & Support" console
 * needs. Gated by canManageSupport (a real sub-admin permission; full admins
 * always pass — see auth.middleware.hasPermission).
 *
 * Scope note (GOVERNANCE §1): chat *rules/config* (cooldown, length, banned
 * words) are a single-owner authority — the ChatRoomConfig document — and are
 * intentionally NOT writable here. This file only performs moderation actions
 * (delete message, ban/unban) and support-ticket replies, none of which own
 * configurable business values.
 */
import { express, hasPermission } from './_adminShared.js';
import { db } from '#db';

const router = express.Router();
const canManageSupport = hasPermission('canManageSupport');

/** Best-effort audit trail entry; never fails the request. */
async function audit(req, { action, category, targetType, targetId, targetName, details }) {
  try {
    await db.audit.recordDetailed({
      performedBy: req.user.userId,
      performedByName: req.user.username,
      performedByRole: req.user.isAdmin ? 'admin' : 'subadmin',
      action, category,
      targetType, targetId, targetName, details,
      ip: req.ip,
      method: req.method,
      endpoint: req.originalUrl,
    });
  } catch (e) {
    console.error('[chat audit] failed:', e.message);
  }
}

// ─── PUBLIC CHAT MODERATION ─────────────────────────────────────────────────

// Recent public chat messages (newest first) for moderation.
router.get('/chat/messages', canManageSupport, async (req, res) => {
  try {
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 60));
    const messages = await db.social.moderationFeed({
      limit,
      includeDeleted: req.query.includeDeleted === 'true',
    });
    res.json({ success: true, messages });
  } catch (error) {
    console.error('[chat] messages error:', error.message);
    res.status(500).json({ success: false, message: 'Failed to load chat messages' });
  }
});

// Soft-delete a public chat message.
router.post('/chat/messages/:id/delete', canManageSupport, async (req, res) => {
  try {
    // One statement: the flag, the moderator and the timestamp cannot disagree,
    // and a message already deleted comes back false rather than being deleted
    // twice with a new attribution.
    const removed = await db.social.deleteChatMessage(req.params.id, req.user.userId);
    if (!removed.ok) {
      return res.status(404).json({ success: false, message: 'Message not found, or already deleted' });
    }

    if (global.io) global.io.to('public-chat').emit('chat_message_deleted', { messageId: String(req.params.id) });
    await audit(req, {
      action: 'DELETE_CHAT_MESSAGE', category: 'CONTENT',
      targetType: 'PublicChatMessage', targetId: String(req.params.id),
    });
    res.json({ success: true });
  } catch (error) {
    console.error('[chat] delete message error:', error.message);
    res.status(500).json({ success: false, message: 'Failed to delete message' });
  }
});

/**
 * Chat bans.
 *
 * Expired ones are included and marked, rather than filtered out. A moderator
 * looking at somebody's history needs to see that they were banned last week
 * and it lapsed — a list of only ACTIVE bans makes a repeat offender look like
 * a first-time one.
 */
router.get('/chat/bans', canManageSupport, async (req, res) => {
  try {
    const bans = await db.social.listChatBans();
    res.json({
      success: true,
      bans: req.query.activeOnly === 'false' ? bans : bans.filter((b) => b.active),
      total: bans.length,
    });
  } catch (error) {
    console.error('[chat] bans error:', error.message);
    res.status(500).json({ success: false, message: 'Failed to load bans' });
  }
});

// Ban a user from public chat. `hours` omitted or 0 means permanent.
router.post('/chat/ban', canManageSupport, async (req, res) => {
  try {
    const { userId, reason, hours } = req.body || {};
    if (!userId) return res.status(400).json({ success: false, message: 'userId is required' });
    if (!String(reason ?? '').trim()) {
      // The row insists too. A ban nobody can explain is one nobody can appeal.
      return res.status(400).json({ success: false, message: 'A ban reason is required' });
    }

    const ban = await db.social.banFromChat(userId, {
      bannedBy: req.user.userId,
      reason: String(reason).trim(),
      // Omitted or zero means permanent. Computed here rather than passed as an
      // hour count, so the deadline is one value the row stores rather than an
      // interval two callers could reckon from different clocks.
      banUntil: Number(hours) > 0 ? new Date(Date.now() + Number(hours) * 3_600_000) : null,
    });

    if (global.io) global.io.to(`user-${userId}`).emit('chat_banned', { until: ban.banUntil });
    await audit(req, {
      action: 'BAN_CHAT_USER', category: 'SECURITY', targetType: 'User',
      targetId: String(userId), details: { reason: ban.reason, banUntil: ban.banUntil },
    });
    res.json({ success: true, ban });
  } catch (error) {
    console.error('[chat] ban error:', error.message);
    res.status(500).json({ success: false, message: 'Failed to ban user' });
  }
});

// Lift a chat ban.
router.delete('/chat/ban/:userId', canManageSupport, async (req, res) => {
  try {
    // 404 rather than a silent success: this answered `{success:true}` whatever
    // came back, so lifting a ban that was never there looked identical to
    // lifting a real one.
    const lifted = await db.social.unbanFromChat(req.params.userId);
    if (!lifted) return res.status(404).json({ success: false, message: 'That user is not banned' });
    await audit(req, {
      action: 'UNBAN_CHAT_USER', category: 'SECURITY',
      targetType: 'User', targetId: String(req.params.userId),
    });
    res.json({ success: true });
  } catch (error) {
    console.error('[chat] unban error:', error.message);
    res.status(500).json({ success: false, message: 'Failed to lift ban' });
  }
});

// ─── SUPPORT TICKETS ────────────────────────────────────────────────────────

/**
 * The support desk.
 *
 * The ticket list and the open count come from ONE query, so the badge and the
 * list describe the same instant — they were two reads, and a ticket arriving
 * between them made them disagree.
 *
 * Statuses are OPEN / ASSIGNED / WAITING_USER / RESOLVED / CLOSED. The filter
 * here passed lowercase, which the table's CHECK constraint refuses outright.
 */
router.get('/support/tickets', canManageSupport, async (req, res) => {
  try {
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const status = req.query.status ? String(req.query.status).toUpperCase() : null;
    const { tickets, openCount } = await db.social.supportDesk({ status, limit });
    res.json({ success: true, tickets, openCount });
  } catch (error) {
    console.error('[support] tickets error:', error.message);
    res.status(500).json({ success: false, message: 'Failed to load tickets' });
  }
});

// One ticket with its full message thread.
router.get('/support/tickets/:id', canManageSupport, async (req, res) => {
  try {
    const ticket = await db.social.getTicketWithUser(req.params.id);
    if (!ticket) return res.status(404).json({ success: false, message: 'Ticket not found' });
    const messages = await db.social.listTicketMessages(ticket.ticketId);
    // Opening the thread marks the player's messages read — an unread badge
    // that survives an agent reading the ticket is one agents learn to ignore.
    await db.social.markTicketMessagesRead(ticket.ticketId, { forType: 'AGENT' });
    res.json({ success: true, ticket, messages });
  } catch (error) {
    console.error('[support] ticket error:', error.message);
    res.status(500).json({ success: false, message: 'Failed to load ticket' });
  }
});

/**
 * Agent reply.
 *
 * The message, the ticket's last-activity time, the claim and the status move
 * TOGETHER. They were four writes: two agents replying at once both read
 * "unassigned" and both claimed the ticket, and a crash between the insert and
 * the save left a reply the player could see on a ticket that still looked
 * untouched.
 */
router.post('/support/tickets/:id/reply', canManageSupport, async (req, res) => {
  try {
    const { content } = req.body || {};
    if (!String(content ?? '').trim()) {
      return res.status(400).json({ success: false, message: 'Reply content is required' });
    }

    const result = await db.social.agentReply({
      ticketId: req.params.id, agentId: req.user.userId, content,
    });
    if (!result.ok) return res.status(404).json({ success: false, message: 'Ticket not found' });

    if (global.io) {
      global.io.to(`user-${result.ticket.userId}`).emit('support_reply', { ticketId: result.ticket.ticketId });
    }
    res.json({ success: true, message: result.message, ticket: result.ticket });
  } catch (error) {
    console.error('[support] reply error:', error.message);
    res.status(500).json({ success: false, message: 'Failed to send reply' });
  }
});

export default router;
