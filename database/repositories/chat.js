// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * postgres/chatPg.js — order chat.
 *
 * The conversation between a player and a merchant about one payment order,
 * plus the system notices posted into it. It is the evidence a dispute is
 * decided from.
 *
 * ── This never persisted anything ───────────────────────────────────────────
 * Every one of the nine call sites asked for a model registered NOWHERE, so
 * every write raised MissingSchemaError. Four of them caught it and discarded
 * it; the reads returned an error the client showed as an empty thread. So the
 * chat appeared to work in the browser — messages echo over the socket — and
 * nothing survived a reload, and a dispute was resolved against no record at
 * all.
 *
 * ── Append-only in practice ─────────────────────────────────────────────────
 * Nothing here edits or deletes a message. A thread that can be revised after
 * the fact is not evidence, and the disputes that read it are decided with
 * money.
 */
import { pgQuery } from '../client.js';

/**
 * Senders `postMessage` accepts (the schema's `chat_messages_sender_type_check`
 * also admits SUPERVISOR). Anything else is a bug at the call site. A
 * supervisor speaking for their member to the dispute manager (Step 2f) has
 * one path, `postSupervisorMessage`, whose guards are in its INSERT.
 */
const SENDER_TYPES = new Set(['USER', 'MERCHANT', 'ADMIN', 'SYSTEM']);

/**
 * The shape every caller and the browser already expect.
 *
 * `timestamp` and `message`/`text` are duplicated deliberately: the merchant
 * panel reads `text`, the admin panel reads `message`, and both existed before
 * this table did. Renaming either is a frontend change, not a storage one.
 */
function toMessage(r) {
  const id = String(r.id);
  return {
    id,
    _id: id,                       // the panels index on this
    orderId: r.order_id,
    senderId: r.sender_id ?? null,
    senderType: r.sender_type,
    senderName: r.sender_type === 'MERCHANT' ? 'Merchant'
      : r.sender_type === 'SUPERVISOR' ? 'Supervisor'
      : r.sender_type === 'SYSTEM' ? 'System'
      : r.sender_type === 'ADMIN' ? 'Admin' : 'User',
    message: r.message,
    text: r.message,
    attachmentUrl: r.attachment_url ?? null,
    attachmentKey: r.attachment_key ?? null,
    isSystem: r.is_system,
    timestamp: r.created_at,
    createdAt: r.created_at,
  };
}

/**
 * Post a message.
 *
 * `orderId` is coerced to text here rather than at nine call sites, because the
 * callers hold it in three different forms and a thread split across two
 * spellings of the same order is a thread nobody can read.
 */
export async function postMessage({
  orderId, senderId = null, senderType, message = '',
  attachmentUrl = null, attachmentKey = null, isSystem = false,
}) {
  if (!orderId) throw new Error('postMessage requires an orderId');
  const type = String(senderType || '').toUpperCase();
  if (!SENDER_TYPES.has(type)) throw new Error(`postMessage: unknown senderType ${senderType}`);

  const { rows } = await pgQuery(
    `INSERT INTO chat_messages
       (order_id, sender_id, sender_type, message, attachment_url, attachment_key, is_system)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, order_id, sender_id, sender_type, message,
               attachment_url, attachment_key, is_system, created_at`,
    [
      String(orderId),
      senderId == null ? null : String(senderId),
      type,
      String(message ?? ''),
      attachmentUrl ? String(attachmentUrl) : null,
      attachmentKey ? String(attachmentKey) : null,
      Boolean(isSystem),
    ],
    'chat_post',
  );
  return toMessage(rows[0]);
}

/**
 * The most messages a supervisor may post into one dispute. Without a bound,
 * a few hundred posts push the dispute manager's own messages and the
 * resolution notice past what a thread view lists.
 */
export const SUPERVISOR_MESSAGES_PER_DISPUTE = 50;

/**
 * A supervisor's message into their member's dispute (Step 2f), or null when
 * it may not be posted: the order is not DISPUTED, is not on one of this
 * supervisor's teams, or they have posted `SUPERVISOR_MESSAGES_PER_DISPUTE`
 * already. Every condition is in the statement that inserts (S6), and the
 * order row is share-locked while it does, so a decision committing at the
 * same moment either waits for the message or is seen by it — a message
 * never lands in a thread already decided. The caller reads the order again
 * to say which condition refused.
 */
export async function postSupervisorMessage({ orderId, supervisorId, message }) {
  const { rows } = await pgQuery(
    `WITH open_dispute AS (
       SELECT os.order_id FROM order_states os
        WHERE os.order_id = $1 AND os.state = 'DISPUTED'
          AND os.team_id IN (SELECT team_id FROM teams WHERE supervisor_id = $2)
        FOR SHARE OF os)
     INSERT INTO chat_messages (order_id, sender_id, sender_type, message, is_system)
     SELECT d.order_id, $2, 'SUPERVISOR', $3, false FROM open_dispute d
      WHERE (SELECT count(*) FROM chat_messages c
              WHERE c.order_id = $1 AND c.sender_type = 'SUPERVISOR') < $4
     RETURNING id, order_id, sender_id, sender_type, message,
               attachment_url, attachment_key, is_system, created_at`,
    [String(orderId), String(supervisorId), String(message ?? ''), SUPERVISOR_MESSAGES_PER_DISPUTE],
    'chat_post_supervisor',
  );
  return rows[0] ? toMessage(rows[0]) : null;
}

/**
 * A system notice. Separate from `postMessage` because a notice must never fail
 * the operation it is describing: an order really was rejected whether or not
 * the note about it landed. The failure is logged rather than thrown — the four
 * call sites that wrapped this in a bare `catch (_) {}` are exactly how nine
 * broken writes went unnoticed for as long as they did.
 */
export async function postSystemMessage(orderId, message, { senderId = null, senderType = 'SYSTEM' } = {}) {
  try {
    return await postMessage({ orderId, senderId, senderType, message, isSystem: true });
  } catch (e) {
    console.error('[chat] system notice not recorded for order', String(orderId), '—', e.message);
    return null;
  }
}

/**
 * The thread, oldest first.
 *
 * Ordered by `(created_at, id)`: two messages inserted in the same millisecond
 * order arbitrarily under `created_at` alone, and a chat is read as a sequence.
 */
export async function listMessages(orderId, { limit = 200 } = {}) {
  if (!orderId) return [];
  const { rows } = await pgQuery(
    `SELECT id, order_id, sender_id, sender_type, message,
            attachment_url, attachment_key, is_system, created_at
       FROM chat_messages
      WHERE order_id = $1
      ORDER BY created_at ASC, id ASC
      LIMIT $2`,
    [String(orderId), Math.min(Math.max(Number(limit) || 200, 1), 1000)],
    'chat_list',
  );
  return rows.map(toMessage);
}

/** How many messages a thread holds. Used by the dispute view's summary. */
export async function countMessages(orderId) {
  const { rows } = await pgQuery(
    'SELECT COUNT(*)::int AS n FROM chat_messages WHERE order_id = $1',
    [String(orderId)], 'chat_count',
  );
  return rows[0].n;
}
