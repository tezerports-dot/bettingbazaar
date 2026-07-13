// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * middleware/mongoSanitize.js — NoSQL operator-injection defense (AQ-6).
 *
 * Replaces `express-mongo-sanitize@2`, which is incompatible with Express 5:
 * that package does `req.query = sanitize(req.query)`, but Express 5 makes
 * `req.query` a GETTER with no setter, so the reassignment throws on every
 * request. This version sanitizes IN PLACE — it deletes dangerous keys from the
 * existing objects without reassigning req.query/body/params — which works
 * identically under Express 4 and 5.
 *
 * Policy (matches express-mongo-sanitize's default): remove any key that starts
 * with '$' (a MongoDB query operator, e.g. {$gt:''}) or contains '.' (a dotted
 * path used to reach into nested documents). Recurses through nested objects and
 * arrays. Values are never altered — only offending keys are dropped.
 */

const isForbiddenKey = (k) => k.startsWith('$') || k.includes('.');

export function sanitizeInPlace(value, depth = 0) {
  if (value == null || typeof value !== 'object' || depth > 20) return value;
  if (Array.isArray(value)) {
    for (const item of value) sanitizeInPlace(item, depth + 1);
    return value;
  }
  for (const key of Object.keys(value)) {
    if (isForbiddenKey(key)) {
      delete value[key];
    } else {
      sanitizeInPlace(value[key], depth + 1);
    }
  }
  return value;
}

/** Express middleware — sanitizes body, params, and query in place. */
export function mongoSanitize(req, _res, next) {
  if (req.body)   sanitizeInPlace(req.body);
  if (req.params) sanitizeInPlace(req.params);
  // Express 5: req.query is a cached getter — mutating its contents in place is
  // safe (and persists), whereas reassigning it would throw.
  try { if (req.query) sanitizeInPlace(req.query); } catch { /* query is immutable in some setups — body/params already covered */ }
  next();
}

export default mongoSanitize;
