// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 250;

function parsePositiveInt(value, fallback = DEFAULT_LIMIT, max = MAX_LIMIT) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

export function normalizeLimit(value, fallback = DEFAULT_LIMIT, max = MAX_LIMIT) {
  return parsePositiveInt(value, fallback, max);
}

export function encodeCompoundCursor(doc, dateField = 'createdAt') {
  if (!doc?.[dateField] || !doc?._id) return null;
  return Buffer.from(JSON.stringify({
    [dateField]: new Date(doc[dateField]).toISOString(),
    id: String(doc._id),
  })).toString('base64url');
}

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

export function buildDescendingCursorFilter(cursor, dateField = 'createdAt', idField = '_id') {
  const decoded = decodeCompoundCursor(cursor, dateField);
  if (!decoded) return {};

  return {
    $or: [
      { [dateField]: { $lt: decoded[dateField] } },
      { [dateField]: decoded[dateField], [idField]: { $lt: decoded.id } },
    ],
  };
}

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
