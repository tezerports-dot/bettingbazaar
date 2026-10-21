// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * domains/support/supportDesk.admin.routes.js — the staff side of the support
 * desks (CLAUDE.md §2, "Support desks"). Mounted under /api/admin.
 *
 * Each desk is its own set of routes behind its own permission, and every query
 * names the desk in its WHERE, so a player-desk agent cannot open a merchant
 * ticket by its id, and the other way round:
 *
 *   player desk    /support/tickets...           canManageSupportTickets
 *   merchant desk  /merchant-support/tickets...  canManageMerchantSupport
 *
 *     GET  <base>                       queue (status, older=1, q=<code or @username>)
 *     GET  <base>/:id                   one ticket, its notes, who looked at the number
 *     POST <base>/:id/reveal-number     the full verified mobile; logged
 *     POST <base>/:id/notes             a note the account reads in the app
 *     POST <base>/:id/status            WAITING_USER, RESOLVED or CLOSED
 *
 * The support Telegram accounts tickets are given, and the Dispute Managers':
 *
 *     GET  /support/contacts            canManageTelegram
 *     POST /support/contacts            canManageTelegram
 *     PUT  /support/contacts/:id        canManageTelegram
 *
 * Who chats with players is a Telegram setting: an account pointed at the
 * wrong username sends players' chats to a stranger, so it sits with the
 * Telegram setup permission, not with the agents who answer tickets.
 */
import { express, authenticate, hasPermission } from '../../routes/admin/_adminShared.js';
import { db } from '#db';
import { emitToPlayer } from '../notification/realtimeEmitters.js';
import { respondError, refusal } from '../../shared/httpError.js';

const router = express.Router();
const { AGENT_STATUSES, CONTACT_DESKS } = db.supportDesk;

/** Best-effort audit trail entry; never fails the request. */
async function audit(req, { action, targetType = 'support_ticket', targetId, details }) {
  try {
    await db.audit.recordDetailed({
      performedBy: req.user.userId,
      performedByName: req.user.username,
      performedByRole: req.user.isAdmin ? 'admin' : 'subadmin',
      action, category: 'support',
      targetType, targetId, details,
      ip: req.ip, method: req.method, endpoint: req.originalUrl,
    });
  } catch (e) {
    console.error('[support audit] failed:', e.message);
  }
}

/** The handlers of one desk; each route below names its own path and permission. */
function deskHandlers(desk, base) {
  return {
    async list(req, res) {
      try {
        const status = req.query.status ? String(req.query.status).toUpperCase() : null;
        const result = await db.supportDesk.deskTickets({
          desk, status, older: req.query.older === '1', search: String(req.query.q || ''),
          limit: parseInt(req.query.limit, 10) || 50,
        });
        res.json({ success: true, ...result });
      } catch (e) { return respondError(res, e, `GET /admin${base}`); }
    },

    async one(req, res) {
      try {
        const found = await db.supportDesk.deskTicket({ ticketId: req.params.id, desk });
        if (!found) return res.status(404).json({ success: false, message: 'Ticket not found' });
        res.json({ success: true, ...found });
      } catch (e) { return respondError(res, e, `GET /admin${base}/:id`); }
    },

    async reveal(req, res) {
      try {
        const found = await db.supportDesk.revealNumber({ ticketId: req.params.id, desk, staffId: req.user.userId });
        if (!found) return res.status(404).json({ success: false, message: 'Ticket not found' });
        await audit(req, { action: 'SUPPORT_NUMBER_REVEALED', targetId: req.params.id, details: { desk } });
        res.json({ success: true, ...found });
      } catch (e) { return respondError(res, e, `POST /admin${base}/:id/reveal-number`); }
    },

    async note(req, res) {
      try {
        const content = String(req.body?.content ?? '').trim();
        if (!content) throw refusal(400, 'NOTE_REQUIRED', 'Write the note first.');
        const saved = await db.supportDesk.addNote({ ticketId: req.params.id, desk, agentId: req.user.userId, content });
        if (!saved) return res.status(404).json({ success: false, message: 'Ticket not found' });
        if (desk === 'PLAYER') emitToPlayer(saved.ticket.userId, 'support_reply', { ticketId: saved.ticket.ticketId });
        res.json({ success: true, ...saved });
      } catch (e) { return respondError(res, e, `POST /admin${base}/:id/notes`); }
    },

    async status(req, res) {
      try {
        const status = String(req.body?.status || '').toUpperCase();
        if (!AGENT_STATUSES.includes(status)) throw refusal(400, 'UNKNOWN_STATUS', `Status is one of ${AGENT_STATUSES.join(', ')}.`);
        const ticket = await db.supportDesk.setStatus({ ticketId: req.params.id, desk, agentId: req.user.userId, status });
        if (!ticket) return res.status(404).json({ success: false, message: 'Ticket not found' });
        if (desk === 'PLAYER') emitToPlayer(ticket.userId, 'support_reply', { ticketId: ticket.ticketId });
        res.json({ success: true, ticket });
      } catch (e) { return respondError(res, e, `POST /admin${base}/:id/status`); }
    },
  };
}

const player = deskHandlers('PLAYER', '/support/tickets');
const playerDesk = [authenticate, hasPermission('canManageSupportTickets')];
router.get('/support/tickets', playerDesk, player.list);
router.get('/support/tickets/:id', playerDesk, player.one);
router.post('/support/tickets/:id/reveal-number', playerDesk, player.reveal);
router.post('/support/tickets/:id/notes', playerDesk, player.note);
router.post('/support/tickets/:id/status', playerDesk, player.status);

const merchant = deskHandlers('MERCHANT', '/merchant-support/tickets');
const merchantDesk = [authenticate, hasPermission('canManageMerchantSupport')];
router.get('/merchant-support/tickets', merchantDesk, merchant.list);
router.get('/merchant-support/tickets/:id', merchantDesk, merchant.one);
router.post('/merchant-support/tickets/:id/reveal-number', merchantDesk, merchant.reveal);
router.post('/merchant-support/tickets/:id/notes', merchantDesk, merchant.note);
router.post('/merchant-support/tickets/:id/status', merchantDesk, merchant.status);

const CONTACT_REFUSALS = {
  DUPLICATE: [409, 'That Telegram username is already on this desk.'],
  INVALID: [400, 'A Telegram username is 5 to 32 letters, digits or underscores, starting with a letter.'],
  NOT_FOUND: [404, 'Support account not found.'],
};

router.get('/support/contacts', authenticate, hasPermission('canManageTelegram'), async (req, res) => {
  try {
    res.json({ success: true, desks: CONTACT_DESKS, contacts: await db.supportDesk.listContacts() });
  } catch (e) { return respondError(res, e, 'GET /admin/support/contacts'); }
});

async function saveContact(req, res, contactId) {
  const { desk, telegramUsername, label = '', active = true } = req.body || {};
  if (!contactId && !CONTACT_DESKS.includes(desk)) throw refusal(400, 'UNKNOWN_DESK', `Desk is one of ${CONTACT_DESKS.join(', ')}.`);
  if (typeof active !== 'boolean') throw refusal(400, 'ACTIVE_BOOLEAN', 'active is true or false.');
  if (String(label).length > 60) throw refusal(400, 'LABEL_TOO_LONG', 'A label is at most 60 characters.');
  const saved = await db.supportDesk.saveContact({ contactId, desk, telegramUsername, label, active });
  if (!saved.ok) {
    const [status, message] = CONTACT_REFUSALS[saved.reason];
    return res.status(status).json({ success: false, code: `CONTACT_${saved.reason}`, message });
  }
  await audit(req, { action: contactId ? 'SUPPORT_CONTACT_CHANGED' : 'SUPPORT_CONTACT_ADDED',
    targetType: 'support_contact', targetId: saved.contact.contactId, details: saved.contact });
  res.json({ success: true, contact: saved.contact });
}

router.post('/support/contacts', authenticate, hasPermission('canManageTelegram'), async (req, res) => {
  try { await saveContact(req, res, null); }
  catch (e) { return respondError(res, e, 'POST /admin/support/contacts'); }
});

router.put('/support/contacts/:id', authenticate, hasPermission('canManageTelegram'), async (req, res) => {
  try { await saveContact(req, res, String(req.params.id)); }
  catch (e) { return respondError(res, e, 'PUT /admin/support/contacts/:id'); }
});

export default router;
