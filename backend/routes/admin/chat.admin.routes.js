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
import { express, mongoose, hasPermission } from './_adminShared.js';
import { db } from '#db';

const router = express.Router();
const canManageSupport = hasPermission('canManageSupport');

const M = () => ({
  PublicChatMsg: mongoose.model('PublicChatMsg'),
  ChatBan: mongoose.model('ChatBan'),
  SupportTicket: mongoose.model('SupportTicket'),
  SupportMsg: mongoose.model('SupportMsg'),
});

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
    const { PublicChatMsg } = M();
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 60));
    const includeDeleted = req.query.includeDeleted === 'true';
    const q = includeDeleted ? {} : { isDeleted: false };
    const messages = await PublicChatMsg.find(q).sort({ createdAt: -1 }).limit(limit).lean();
    res.json({ success: true, messages });
  } catch (error) {
    console.error('[chat] messages error:', error.message);
    res.status(500).json({ success: false, message: 'Failed to load chat messages' });
  }
});

// Soft-delete a public chat message.
router.post('/chat/messages/:id/delete', canManageSupport, async (req, res) => {
  try {
    const { PublicChatMsg } = M();
    const msg = await PublicChatMsg.findById(req.params.id);
    if (!msg) return res.status(404).json({ success: false, message: 'Message not found' });
    msg.isDeleted = true;
    msg.deletedBy = req.user.userId;
    msg.deletedAt = new Date();
    await msg.save();

    if (global.io) global.io.to('public-chat').emit('chat_message_deleted', { messageId: String(msg._id) });
    await audit(req, { action: 'DELETE_CHAT_MESSAGE', category: 'CONTENT', targetType: 'PublicChatMsg', targetId: String(msg._id), targetName: msg.displayName });
    res.json({ success: true });
  } catch (error) {
    console.error('[chat] delete message error:', error.message);
    res.status(500).json({ success: false, message: 'Failed to delete message' });
  }
});

// Active chat bans.
router.get('/chat/bans', canManageSupport, async (req, res) => {
  try {
    const { ChatBan } = M();
    const now = new Date();
    const bans = await ChatBan.find({ $or: [{ banUntil: null }, { banUntil: { $gt: now } }] })
      .populate('userId', 'username mobile')
      .sort({ createdAt: -1 })
      .lean();
    res.json({ success: true, bans });
  } catch (error) {
    console.error('[chat] bans error:', error.message);
    res.status(500).json({ success: false, message: 'Failed to load bans' });
  }
});

// Ban a user from public chat (upsert; hours omitted/0 = permanent).
router.post('/chat/ban', canManageSupport, async (req, res) => {
  try {
    const { ChatBan } = M();
    const { userId, reason, hours } = req.body || {};
    if (!userId) return res.status(400).json({ success: false, message: 'userId is required' });
    if (!reason || !String(reason).trim()) return res.status(400).json({ success: false, message: 'A ban reason is required' });
    const banUntil = hours && Number(hours) > 0 ? new Date(Date.now() + Number(hours) * 3600000) : null;
    const ban = await ChatBan.findOneAndUpdate(
      { userId },
      { userId, bannedBy: req.user.userId, reason: String(reason).trim(), banUntil, createdAt: new Date() },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    if (global.io) global.io.to(`user-${userId}`).emit('chat_banned', { until: banUntil });
    await audit(req, { action: 'BAN_CHAT_USER', category: 'SECURITY', targetType: 'User', targetId: String(userId), details: { reason, banUntil } });
    res.json({ success: true, ban });
  } catch (error) {
    console.error('[chat] ban error:', error.message);
    res.status(500).json({ success: false, message: 'Failed to ban user' });
  }
});

// Lift a chat ban.
router.delete('/chat/ban/:userId', canManageSupport, async (req, res) => {
  try {
    const { ChatBan } = M();
    await ChatBan.deleteOne({ userId: req.params.userId });
    await audit(req, { action: 'UNBAN_CHAT_USER', category: 'SECURITY', targetType: 'User', targetId: String(req.params.userId) });
    res.json({ success: true });
  } catch (error) {
    console.error('[chat] unban error:', error.message);
    res.status(500).json({ success: false, message: 'Failed to lift ban' });
  }
});

// ─── SUPPORT TICKETS ────────────────────────────────────────────────────────

// List support tickets (newest activity first).
router.get('/support/tickets', canManageSupport, async (req, res) => {
  try {
    const { SupportTicket } = M();
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const filter = {};
    if (req.query.status) filter.status = req.query.status;
    const tickets = await SupportTicket.find(filter)
      .populate('userId', 'username mobile')
      .sort({ lastReplyAt: -1, createdAt: -1 })
      .limit(limit)
      .lean();
    const openCount = await SupportTicket.countDocuments({ status: { $in: ['open', 'assigned', 'waiting_user'] } });
    res.json({ success: true, tickets, openCount });
  } catch (error) {
    console.error('[support] tickets error:', error.message);
    res.status(500).json({ success: false, message: 'Failed to load tickets' });
  }
});

// Get one ticket with its full message thread.
router.get('/support/tickets/:id', canManageSupport, async (req, res) => {
  try {
    const { SupportTicket, SupportMsg } = M();
    const ticket = await SupportTicket.findById(req.params.id).populate('userId', 'username mobile').lean();
    if (!ticket) return res.status(404).json({ success: false, message: 'Ticket not found' });
    const messages = await SupportMsg.find({ ticketId: ticket._id }).sort({ createdAt: 1 }).lean();
    res.json({ success: true, ticket, messages });
  } catch (error) {
    console.error('[support] ticket error:', error.message);
    res.status(500).json({ success: false, message: 'Failed to load ticket' });
  }
});

// Agent reply to a ticket.
router.post('/support/tickets/:id/reply', canManageSupport, async (req, res) => {
  try {
    const { SupportTicket, SupportMsg } = M();
    const { content } = req.body || {};
    if (!content || !String(content).trim()) return res.status(400).json({ success: false, message: 'Reply content is required' });
    const ticket = await SupportTicket.findById(req.params.id);
    if (!ticket) return res.status(404).json({ success: false, message: 'Ticket not found' });

    const msg = await SupportMsg.create({
      ticketId: ticket._id,
      senderId: req.user.userId,
      senderType: 'agent',
      content: String(content).trim(),
    });
    ticket.lastReplyAt = new Date();
    if (!ticket.assignedTo) { ticket.assignedTo = req.user.userId; ticket.assignedAt = new Date(); }
    if (ticket.status === 'open') ticket.status = 'assigned';
    await ticket.save();

    if (global.io) global.io.to(`user-${ticket.userId}`).emit('support_reply', { ticketId: String(ticket._id) });
    res.json({ success: true, message: msg });
  } catch (error) {
    console.error('[support] reply error:', error.message);
    res.status(500).json({ success: false, message: 'Failed to send reply' });
  }
});

export default router;
