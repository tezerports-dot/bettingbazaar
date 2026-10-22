// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * repositories/supportDesk.js — the support desks, the one writer of
 * `support_tickets`, `support_messages`, `support_contacts` and
 * `support_number_reveals` (CLAUDE.md §2, "Support desks").
 *
 * Two desks, PLAYER and MERCHANT (owner, 2026-10-21). A ticket is the form an
 * account filled in; the conversation happens on Telegram, from the account's
 * own Telegram to the support account the ticket was given. The server holds
 * the form, the status and the agent's notes, never the chat.
 *
 * Every read and write names its desk in the WHERE, so an agent who holds one
 * desk's permission cannot reach the other's tickets by guessing an id.
 */
import { pgQuery } from '../client.js';
import { randomBytes, randomInt } from 'node:crypto';

const newId = () => randomBytes(12).toString('hex');

/** The desks an account can open a ticket on. */
export const TICKET_DESKS = Object.freeze(['PLAYER', 'MERCHANT']);
/** Every desk a support Telegram account can serve; DISPUTE is the Dispute Managers'. */
export const CONTACT_DESKS = Object.freeze(['PLAYER', 'MERCHANT', 'DISPUTE']);

/**
 * What a ticket can be about, per desk. A payment problem on a buy or sell is
 * not here on purpose: it is a dispute, raised on the order (owner, 2026-10-21).
 */
export const TICKET_TOPICS = Object.freeze({
  PLAYER: Object.freeze([
    { key: 'ACCOUNT', label: 'Account and sign-in' },
    { key: 'DEPOSIT', label: 'Buying tokens' },
    { key: 'WITHDRAWAL', label: 'Selling tokens' },
    { key: 'BETS', label: 'Bets and results' },
    { key: 'BONUS', label: 'Bonus and referral' },
    { key: 'APP', label: 'App problem' },
    { key: 'OTHER', label: 'Something else' },
  ]),
  MERCHANT: Object.freeze([
    { key: 'ONBOARDING', label: 'Account and approval' },
    { key: 'POOL', label: 'Token pool' },
    { key: 'ORDERS', label: 'Orders and routing' },
    { key: 'PAYMENT_ACCOUNTS', label: 'Payment accounts' },
    { key: 'COMMISSION', label: 'Commission' },
    { key: 'APP', label: 'Panel problem' },
    { key: 'OTHER', label: 'Something else' },
  ]),
});

/** How far back an account sees its own tickets (owner, 2026-10-21). */
export const ACCOUNT_HISTORY_DAYS = 7;
/** How far back the desk lists closed tickets unless asked for older ones. */
export const DESK_RECENT_DAYS = 7;

export const DESCRIPTION_MIN = 20;
export const DESCRIPTION_MAX = 1000;
export const REFERENCE_MAX = 64;

/** Statuses an agent may move a ticket to. OPEN and ASSIGNED follow from notes. */
export const AGENT_STATUSES = Object.freeze(['WAITING_USER', 'RESOLVED', 'CLOSED']);
const LIVE = `('OPEN', 'ASSIGNED', 'WAITING_USER')`;

// Crockford base32 without I, L, O, U: a code read aloud or retyped from a
// screenshot survives.
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const newCode = () => `S-${Array.from({ length: 6 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('')}`;

/** "98•••••210": the shape of a number, never the number. */
export function maskMobile(mobile) {
  const d = String(mobile || '');
  if (d.length < 6) return d ? '•'.repeat(d.length) : '';
  return `${d.slice(0, 2)}${'•'.repeat(d.length - 5)}${d.slice(-3)}`;
}

/** The link that opens the account's own Telegram on the support account, code typed in. */
export function telegramChatLink(username, text) {
  if (!username) return '';
  return `https://t.me/${username}?text=${encodeURIComponent(text)}`;
}

const toContact = (r) => (r ? {
  contactId: r.contact_id, desk: r.desk, telegramUsername: r.telegram_username,
  label: r.label, active: r.active, createdAt: r.created_at, updatedAt: r.updated_at,
} : null);

const toTicket = (r) => (r ? {
  ticketId: r.ticket_id, code: r.code, desk: r.desk, userId: r.user_id,
  topic: r.category, subject: r.subject, reference: r.reference,
  status: r.status, assignedTo: r.assigned_to, assignedAt: r.assigned_at,
  resolvedAt: r.resolved_at, closedAt: r.closed_at,
  rating: r.rating, lastReplyAt: r.last_reply_at, createdAt: r.created_at,
  telegramUsername: r.contact_username ?? null,
  telegramLink: r.contact_username && r.code
    ? telegramChatLink(r.contact_username, `Ticket ${r.code}`) : '',
} : null);

const toMessage = (r) => (r ? {
  id: Number(r.id), ticketId: r.ticket_id, senderType: r.sender_type,
  content: r.content, createdAt: r.created_at,
} : null);

// ── Support Telegram accounts ───────────────────────────────────────────────

export async function listContacts({ desk = null } = {}) {
  const { rows } = await pgQuery(
    `SELECT c.*,
            (SELECT COUNT(*) FROM support_tickets t
              WHERE t.contact_id = c.contact_id AND t.status IN ${LIVE}) AS open_tickets
       FROM support_contacts c
      WHERE ($1::text IS NULL OR c.desk = $1)
      ORDER BY c.desk, c.active DESC, c.created_at`,
    [desk], 'support_contacts_list',
  );
  return rows.map((r) => ({ ...toContact(r), openTickets: Number(r.open_tickets) }));
}

/**
 * The desk's support account to talk to straight away, without a ticket
 * (owner, 2026-10-22: merchants "directly click and talk on Telegram"): the
 * active one with the fewest live tickets, as a ticket would be given. Null
 * when the desk has none.
 */
export async function directContact({ desk }) {
  if (!TICKET_DESKS.includes(desk)) throw new Error(`directContact: unknown desk ${desk}`);
  const { rows } = await pgQuery(
    `SELECT c.telegram_username
       FROM support_contacts c
       LEFT JOIN support_tickets t ON t.contact_id = c.contact_id AND t.status IN ${LIVE}
      WHERE c.desk = $1 AND c.active
      GROUP BY c.contact_id
      ORDER BY COUNT(t.ticket_id), c.created_at
      LIMIT 1`,
    [desk], 'support_direct_contact',
  );
  const username = rows[0]?.telegram_username;
  return username ? { telegramUsername: username, telegramLink: telegramChatLink(username, 'Hello, I need merchant support.') } : null;
}

/**
 * Add a support account, or change one. The username's shape is the row's CHECK;
 * a duplicate on the same desk is the unique index. Both come back as
 * `{ ok: false, reason }` so the route can say which.
 */
export async function saveContact({ contactId = null, desk, telegramUsername, label = '', active = true }) {
  const username = String(telegramUsername || '').trim().replace(/^@/, '').replace(/^https?:\/\/t\.me\//i, '');
  try {
    const { rows } = contactId
      ? await pgQuery(
        `UPDATE support_contacts SET telegram_username = $2, label = $3, active = $4, updated_at = now()
          WHERE contact_id = $1 RETURNING *`,
        [String(contactId), username, String(label).trim(), active === true], 'support_contact_update')
      : await pgQuery(
        `INSERT INTO support_contacts (contact_id, desk, telegram_username, label, active)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [newId(), String(desk), username, String(label).trim(), active === true], 'support_contact_insert');
    if (!rows[0]) return { ok: false, reason: 'NOT_FOUND' };
    return { ok: true, contact: toContact(rows[0]) };
  } catch (e) {
    if (e.code === '23505') return { ok: false, reason: 'DUPLICATE' };
    if (e.code === '23514') return { ok: false, reason: 'INVALID', constraint: e.constraint };
    throw e;
  }
}

/**
 * The Dispute Manager account for a disputed order: the same one every time for
 * the same order (picked by the order id among the active DISPUTE accounts), so
 * a player and a merchant on one dispute reach one person.
 *
 * Only for the order's own player (`userId`) or its own merchant
 * (`merchantId`), and only while it is DISPUTED: asked in the WHERE, so an
 * order id guessed by someone else answers exactly like no order at all.
 */
export async function disputeContactFor({ orderId, userId = null, merchantId = null }) {
  const { rows } = await pgQuery(
    `WITH disputed AS (
       SELECT order_id FROM order_states
        WHERE order_id = $1 AND state = 'DISPUTED'
          AND (($2::text IS NOT NULL AND user_id = $2) OR ($3::text IS NOT NULL AND merchant_id = $3))
     ), active AS (
       SELECT c.*, ROW_NUMBER() OVER (ORDER BY c.created_at, c.contact_id) - 1 AS n,
              COUNT(*) OVER () AS total
         FROM support_contacts c WHERE c.desk = 'DISPUTE' AND c.active
     )
     SELECT EXISTS (SELECT 1 FROM disputed) AS disputed,
            (SELECT row_to_json(a) FROM active a
              WHERE a.n = mod(abs(hashtext($1)::bigint), GREATEST(a.total, 1))) AS contact`,
    [String(orderId), userId ? String(userId) : null, merchantId ? String(merchantId) : null],
    'support_dispute_contact',
  );
  if (!rows[0].disputed) return { disputed: false, contact: null };
  const contact = toContact(rows[0].contact);
  return {
    disputed: true,
    contact: contact && {
      telegramUsername: contact.telegramUsername,
      label: contact.label,
      telegramLink: telegramChatLink(contact.telegramUsername, `Dispute ${orderId}`),
    },
  };
}

// ── An account's own tickets ────────────────────────────────────────────────

/**
 * Open a ticket, give it a support account, and store the description as its
 * first message, in ONE statement.
 *
 * The support account is the desk's active one with the fewest live tickets
 * (ties at random), chosen in the INSERT, so two tickets arriving together are
 * not both handed to whichever account a separate read saw as free.
 *
 * One ticket per account per India day is the unique index; its refusal comes
 * back as `{ ok: false, reason: 'ONE_PER_DAY' }`.
 */
export async function openTicket({ userId, desk, topic, reference = '', description }) {
  if (!userId) throw new Error('openTicket requires a userId');
  if (!TICKET_DESKS.includes(desk)) throw new Error(`openTicket: unknown desk ${desk}`);
  const text = String(description).trim();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const { rows } = await pgQuery(
        `WITH pick AS (
           SELECT c.contact_id, c.telegram_username
             FROM support_contacts c
             LEFT JOIN support_tickets t ON t.contact_id = c.contact_id AND t.status IN ${LIVE}
            WHERE c.desk = $3 AND c.active
            GROUP BY c.contact_id
            ORDER BY COUNT(t.ticket_id), random()
            LIMIT 1
         ), ticket AS (
           INSERT INTO support_tickets (ticket_id, code, user_id, desk, category, subject, reference, contact_id)
           VALUES ($1, $2, $4, $3, $5, $6, $7, (SELECT contact_id FROM pick))
           RETURNING *
         ), first_message AS (
           INSERT INTO support_messages (ticket_id, sender_id, sender_type, content)
           SELECT ticket_id, user_id, 'USER', $8 FROM ticket
         )
         SELECT ticket.*, (SELECT telegram_username FROM pick) AS contact_username FROM ticket`,
        [newId(), newCode(), desk, String(userId), String(topic),
          text.slice(0, 120), String(reference).trim(), text],
        'support_ticket_open',
      );
      return { ok: true, ticket: toTicket(rows[0]) };
    } catch (e) {
      if (e.code === '23505' && e.constraint === 'support_tickets_one_per_day') return { ok: false, reason: 'ONE_PER_DAY' };
      if (e.code === '23505' && e.constraint === 'support_tickets_code_unique') continue;
      throw e;
    }
  }
  throw new Error('openTicket: could not draw a free ticket code');
}

const ACCOUNT_SELECT = `
  SELECT t.*, c.telegram_username AS contact_username
    FROM support_tickets t
    LEFT JOIN support_contacts c ON c.contact_id = t.contact_id`;

/** The account's tickets on one desk from the last ACCOUNT_HISTORY_DAYS, newest first. */
export async function accountTickets({ userId, desk }) {
  const { rows } = await pgQuery(
    `${ACCOUNT_SELECT}
      WHERE t.user_id = $1 AND t.desk = $2
        AND t.created_at > now() - make_interval(days => $3)
      ORDER BY t.created_at DESC LIMIT 50`,
    [String(userId), String(desk), ACCOUNT_HISTORY_DAYS], 'support_account_tickets',
  );
  return rows.map(toTicket);
}

/**
 * Whether the account may open a ticket today, and when it next may. Display
 * only: the unique index is what refuses.
 */
export async function openedToday({ userId }) {
  const { rows } = await pgQuery(
    `SELECT EXISTS (SELECT 1 FROM support_tickets
                     WHERE user_id = $1 AND opened_day = (now() AT TIME ZONE 'Asia/Kolkata')::date) AS opened,
            ((now() AT TIME ZONE 'Asia/Kolkata')::date + 1)::timestamp AT TIME ZONE 'Asia/Kolkata' AS next_at`,
    [String(userId)], 'support_opened_today',
  );
  return { openedToday: rows[0].opened, nextTicketAt: rows[0].next_at };
}

/**
 * One of the account's own tickets with its messages, or null. Someone else's
 * ticket, another desk's, or one older than the window is the same null, so the
 * route answers 404 for all three (a 403 would confirm the id is real).
 */
export async function accountTicket({ ticketId, userId, desk }) {
  const { rows } = await pgQuery(
    `${ACCOUNT_SELECT}
      WHERE t.ticket_id = $1 AND t.user_id = $2 AND t.desk = $3
        AND t.created_at > now() - make_interval(days => $4)`,
    [String(ticketId), String(userId), String(desk), ACCOUNT_HISTORY_DAYS], 'support_account_ticket',
  );
  if (!rows[0]) return null;
  const messages = await ticketMessages(rows[0].ticket_id);
  return { ticket: toTicket(rows[0]), messages };
}

/** Rate a resolved or closed ticket, once, by its owner. */
export async function rateTicket({ ticketId, userId, desk, rating }) {
  const { rows } = await pgQuery(
    `UPDATE support_tickets SET rating = $4
      WHERE ticket_id = $1 AND user_id = $2 AND desk = $3
        AND status IN ('RESOLVED', 'CLOSED') AND rating IS NULL
      RETURNING ticket_id`,
    [String(ticketId), String(userId), String(desk), Number(rating)], 'support_ticket_rate',
  );
  return rows.length > 0;
}

async function ticketMessages(ticketId) {
  const { rows } = await pgQuery(
    `SELECT * FROM support_messages WHERE ticket_id = $1 ORDER BY created_at ASC, id ASC LIMIT 200`,
    [String(ticketId)], 'support_ticket_messages',
  );
  return rows.map(toMessage);
}

// ── The desk ────────────────────────────────────────────────────────────────

/**
 * The account as an agent sees it: name, Telegram @username and account id (to
 * match the chat that arrives on the support account), and the verified mobile
 * MASKED. The full number is `revealNumber`, one click that leaves a row.
 */
const DESK_SELECT = `
  SELECT t.*, c.telegram_username AS contact_username, c.label AS contact_label,
         u.username, COALESCE(tl.phone, u.mobile) AS mobile,
         tl.telegram_username AS account_telegram_username, tl.telegram_user_id AS account_telegram_id,
         tl.first_name AS account_first_name, tl.verified_at AS telegram_verified_at
    FROM support_tickets t
    LEFT JOIN support_contacts c ON c.contact_id = t.contact_id
    LEFT JOIN users u ON u.user_id = t.user_id
    LEFT JOIN telegram_links tl ON tl.user_id = t.user_id`;

const toDeskTicket = (r) => ({
  ...toTicket(r),
  contactLabel: r.contact_label ?? '',
  account: {
    username: r.username ?? null,
    mobileMasked: maskMobile(r.mobile),
    telegramUsername: r.account_telegram_username || '',
    telegramId: r.account_telegram_id || '',
    firstName: r.account_first_name || '',
    telegramVerifiedAt: r.telegram_verified_at ?? null,
  },
});

/**
 * One desk's queue: every live ticket, and closed ones from the last
 * DESK_RECENT_DAYS (or only older ones, when asked). The open count is over the
 * same filtered set, so the badge and the list describe one instant.
 */
export async function deskTickets({ desk, status = null, older = false, search = '', limit = 50 }) {
  const params = [String(desk), DESK_RECENT_DAYS];
  const where = ['t.desk = $1'];
  where.push(older
    ? `t.status NOT IN ${LIVE} AND t.created_at <= now() - make_interval(days => $2)`
    : `(t.status IN ${LIVE} OR t.created_at > now() - make_interval(days => $2))`);
  if (status) { params.push(String(status)); where.push(`t.status = $${params.length}`); }
  if (search) {
    params.push(String(search).trim().toUpperCase());
    where.push(`(upper(t.code) = $${params.length} OR upper(tl.telegram_username) = ltrim($${params.length}, '@'))`);
  }
  const { rows } = await pgQuery(
    `${DESK_SELECT}
      WHERE ${where.join(' AND ')}
      ORDER BY (t.status IN ${LIVE}) DESC, COALESCE(t.last_reply_at, t.created_at) DESC
      LIMIT ${Math.min(Math.max(Number(limit) || 50, 1), 200)}`,
    params, 'support_desk_list',
  );
  const { rows: counts } = await pgQuery(
    `SELECT COUNT(*) AS open FROM support_tickets WHERE desk = $1 AND status IN ${LIVE}`,
    [String(desk)], 'support_desk_open_count',
  );
  return { tickets: rows.map(toDeskTicket), openCount: Number(counts[0].open) };
}

export async function deskTicket({ ticketId, desk }) {
  const { rows } = await pgQuery(
    `${DESK_SELECT} WHERE t.ticket_id = $1 AND t.desk = $2`,
    [String(ticketId), String(desk)], 'support_desk_ticket',
  );
  if (!rows[0]) return null;
  const { rows: reveals } = await pgQuery(
    `SELECT staff_id, revealed_at FROM support_number_reveals
      WHERE ticket_id = $1 ORDER BY revealed_at DESC LIMIT 20`,
    [rows[0].ticket_id], 'support_desk_reveals',
  );
  return {
    ticket: toDeskTicket(rows[0]),
    messages: await ticketMessages(rows[0].ticket_id),
    reveals: reveals.map((r) => ({ staffId: r.staff_id, revealedAt: r.revealed_at })),
  };
}

/**
 * The full verified mobile, and the row that says who looked, in ONE statement:
 * a number is never returned without its reveal being written.
 */
export async function revealNumber({ ticketId, desk, staffId }) {
  const { rows } = await pgQuery(
    `WITH ticket AS (
       SELECT t.ticket_id, COALESCE(tl.phone, u.mobile) AS mobile, tl.verified_at
         FROM support_tickets t
         LEFT JOIN users u ON u.user_id = t.user_id
         LEFT JOIN telegram_links tl ON tl.user_id = t.user_id
        WHERE t.ticket_id = $1 AND t.desk = $2
     ), logged AS (
       INSERT INTO support_number_reveals (ticket_id, staff_id)
       SELECT ticket_id, $3 FROM ticket
     )
     SELECT * FROM ticket`,
    [String(ticketId), String(desk), String(staffId)], 'support_reveal_number',
  );
  if (!rows[0]) return null;
  return { mobile: rows[0].mobile || '', telegramVerified: Boolean(rows[0].verified_at), verifiedAt: rows[0].verified_at };
}

/**
 * An agent's note, which the account reads in the app, and the ticket state
 * that follows from it, together. `COALESCE(assigned_to, $3)` is the claim:
 * whoever gets there first keeps it, decided by the database.
 */
export async function addNote({ ticketId, desk, agentId, content }) {
  const text = String(content ?? '').trim();
  if (!agentId || !text) throw new Error('addNote requires an agent and content');
  const { rows } = await pgQuery(
    `WITH touched AS (
       UPDATE support_tickets SET
         last_reply_at = now(),
         assigned_to = COALESCE(assigned_to, $3),
         assigned_at = CASE WHEN assigned_to IS NULL THEN now() ELSE assigned_at END,
         status = CASE WHEN status = 'OPEN' THEN 'ASSIGNED' ELSE status END
        WHERE ticket_id = $1 AND desk = $2
        RETURNING *
     ), inserted AS (
       INSERT INTO support_messages (ticket_id, sender_id, sender_type, content)
       SELECT ticket_id, $3, 'AGENT', $4 FROM touched
       RETURNING *
     )
     SELECT (SELECT row_to_json(i) FROM inserted i) AS message,
            (SELECT row_to_json(t) FROM touched t) AS ticket`,
    [String(ticketId), String(desk), String(agentId), text.slice(0, 2000)], 'support_add_note',
  );
  const r = rows[0];
  if (!r?.ticket) return null;
  return { message: toMessage(r.message), ticket: toTicket(r.ticket) };
}

/** Move a ticket to WAITING_USER, RESOLVED or CLOSED; the claim moves with it. */
export async function setStatus({ ticketId, desk, agentId, status }) {
  if (!AGENT_STATUSES.includes(status)) throw new Error(`setStatus: ${status} is not an agent status`);
  const { rows } = await pgQuery(
    `UPDATE support_tickets SET
       status = $3,
       assigned_to = COALESCE(assigned_to, $4),
       assigned_at = COALESCE(assigned_at, now()),
       resolved_at = CASE WHEN $3 = 'RESOLVED' THEN now() ELSE resolved_at END,
       closed_at   = CASE WHEN $3 = 'CLOSED'   THEN now() ELSE closed_at   END
      WHERE ticket_id = $1 AND desk = $2
      RETURNING *`,
    [String(ticketId), String(desk), String(status), String(agentId)], 'support_set_status',
  );
  return toTicket(rows[0]);
}
