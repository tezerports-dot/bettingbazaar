// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * utils/cursorPagination.js — keyset cursors, over the wire.
 *
 * A cursor is `(timestamp, id)` base64url-encoded, so a client cannot construct
 * one by guessing the shape and a caller does not have to know what is in it.
 *
 * ── Why keyset and not an offset ───────────────────────────────────────────
 * A row created while somebody pages shifts every later row by one, so the page
 * after an offset page silently SKIPS a row. On a merchant's order queue that
 * is an order nobody works; on an audit trail it is an entry nobody sees. The
 * cursor names the last row of the previous page, so nothing can slide past it.
 *
 * The repositories build the WHERE clause from the decoded pair. This module no
 * longer builds a query fragment of its own — a filter assembled here and a
 * filter assembled in the repository are two descriptions of one rule, and the
 * one that drifts is whichever nobody is looking at.
 */


const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 250;

/**
 * Parse a caller-supplied positive integer limit and clamp it to a maximum.
 */
function parsePositiveInt(value, fallback = DEFAULT_LIMIT, max = MAX_LIMIT) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

/**
 * Normalize an untrusted page-size parameter.
 */
export function normalizeLimit(value, fallback = DEFAULT_LIMIT, max = MAX_LIMIT) {
  return parsePositiveInt(value, fallback, max);
}

/**
 * Encode a descending date/id cursor for a result document.
 */
export function encodeCompoundCursor(doc, dateField = 'createdAt') {
  if (!doc?.[dateField] || !doc?._id) return null;
  const at = new Date(doc[dateField]);
  // NULL, not a throw. The function already answers "no cursor" with null for a
  // missing field, and a value that is present but unusable is the same answer
  // — `toISOString()` on an invalid date raises a RangeError, which would take
  // down the response that was merely trying to say "there is no next page".
  if (Number.isNaN(at.getTime())) return null;
  return Buffer.from(JSON.stringify({
    [dateField]: at.toISOString(),
    id: String(doc._id),
  })).toString('base64url');
}

/**
 * Decode a compound cursor into its date and id components.
 */
export function decodeCompoundCursor(cursor, dateField = 'createdAt') {
  if (!cursor) return null;
  try {
    const decoded = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'));
    const date = new Date(decoded[dateField]);
    if (!decoded.id || Number.isNaN(date.getTime())) return null;
    return { [dateField]: date, id: decoded.id };
  } catch {
    return null;
  }
}

/**
 * A decoded cursor in the shape the ORDER repository takes.
 *
 * Returns null for an absent or unparseable cursor rather than throwing: a
 * client that pasted half a URL should get the first page, not a 400 it cannot
 * act on.
 */
export function decodeOrderCursor(cursor) {
  const decoded = decodeCompoundCursor(cursor, 'createdAt');
  return decoded ? { createdAt: decoded.createdAt, orderId: decoded.id } : null;
}

/** The cursor for the next page of orders, or null when there is no next page. */
export function encodeOrderCursor(next) {
  if (!next?.createdAt || !next?.orderId) return null;
  return encodeCompoundCursor({ createdAt: next.createdAt, _id: next.orderId });
}

/**
 * Page items and cursor metadata from one over-fetched result set.
 *
 * Kept for callers that fetch `limit + 1` rows themselves. The order
 * repository does its own over-fetch and hands back `nextCursor` directly, so
 * the SSE snapshots no longer come through here — a page shaped in the
 * repository and a page shaped in a route are two descriptions of one rule.
 */
export function paginatedResponse(items, limit, dateField = 'createdAt') {
  const hasMore = items.length > limit;
  const pageItems = hasMore ? items.slice(0, limit) : items;
  const lastItem = pageItems[pageItems.length - 1];

  return {
    items: pageItems,
    nextCursor: hasMore ? encodeCompoundCursor(lastItem, dateField) : null,
    hasMore,
    serverTime: new Date().toISOString(),
  };
}
