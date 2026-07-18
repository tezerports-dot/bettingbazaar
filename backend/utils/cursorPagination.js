// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
import mongoose from 'mongoose';


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
  return Buffer.from(JSON.stringify({
    [dateField]: new Date(doc[dateField]).toISOString(),
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
 * Build a Mongo filter for the next page in descending date/id order.
 */
export function buildDescendingCursorFilter(cursor, dateField = 'createdAt', idField = '_id') {
  const decoded = decodeCompoundCursor(cursor, dateField);
  if (!decoded) return {};

  const id = idField === '_id' && mongoose.Types.ObjectId.isValid(decoded.id)
    ? new mongoose.Types.ObjectId(decoded.id)
    : decoded.id;

  return {
    $or: [
      { [dateField]: { $lt: decoded[dateField] } },
      { [dateField]: decoded[dateField], [idField]: { $lt: id } },
    ],
  };
}

/**
 * Return page items and cursor metadata from one over-fetched result set.
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
