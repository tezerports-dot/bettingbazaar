// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * routes/admin/chat.admin.routes.js
 * Admin console for public chat moderation (`canModerateChat`). The support
 * desks moved to domains/support/supportDesk.admin.routes.js (2026-10-21).
 *
 * Scope note (GOVERNANCE §1): chat *rules/config* (cooldown, length, banned
 * words) are a single-owner authority — the ChatRoomConfig document — and are
 * intentionally NOT writable here. This file only performs moderation actions
 * (delete message, ban/unban), none of which own
 * configurable business values.
 */
import { express, hasPermission } from './_adminShared.js';
import { db } from '#db';

const router = express.Router();

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
router.get('/chat/messages', hasPermission('canModerateChat'), async (req, res) => {
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
router.post('/chat/messages/:id/delete', hasPermission('canModerateChat'), async (req, res) => {
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
router.get('/chat/bans', hasPermission('canModerateChat'), async (req, res) => {
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
router.post('/chat/ban', hasPermission('canModerateChat'), async (req, res) => {
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

    emitToPlayer(userId, 'chat_banned', { until: ban.banUntil });
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
router.delete('/chat/ban/:userId', hasPermission('canModerateChat'), async (req, res) => {
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

export default router;
