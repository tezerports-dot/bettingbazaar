// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * middleware/inputSanitize.js — request-key hygiene (AQ-6).
 *
 * ── What this defends, now ──────────────────────────────────────────────────
 * PROTOTYPE POLLUTION is the live threat and is store-independent: a request
 * body carrying `__proto__`, `constructor` or `prototype` can, through any code
 * that merges or spreads it into an object, change the behaviour of every
 * object in the process. That has nothing to do with which database is behind
 * the request, and this middleware runs before every route.
 *
 * `$`-prefixed and dotted keys stay stripped as DEFENCE IN DEPTH. They were an
 * operator-injection defence for a query language this platform no longer
 * speaks, and no PostgreSQL statement here interpolates a key name — every
 * query is parameterised, and the config store refuses an undeclared key
 * outright rather than storing it. But request bodies do reach JSONB columns,
 * and a key shape that means something to some other consumer is not worth
 * carrying for the sake of round-tripping it.
 *
 * ── Why it is hand-written ──────────────────────────────────────────────────
 * It replaced a package that was incompatible with Express 5: that package did
 * `req.query = sanitize(req.query)`, but Express 5 makes `req.query` a GETTER
 * with no setter, so the reassignment threw on every request. This sanitizes IN
 * PLACE — deleting keys from the existing objects rather than reassigning
 * req.query/body/params — which works identically under Express 4 and 5.
 *
 * Recurses through nested objects and arrays. Values are never altered; only
 * offending keys are dropped.
 */

const PROTOTYPE_POLLUTION_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const isForbiddenKey = (k) => k.startsWith('$') || k.includes('.') || PROTOTYPE_POLLUTION_KEYS.has(k);

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
export function inputSanitize(req, _res, next) {
  if (req.body)   sanitizeInPlace(req.body);
  if (req.params) sanitizeInPlace(req.params);
  // Express 5: req.query is a cached getter — mutating its contents in place is
  // safe (and persists), whereas reassigning it would throw.
  try { if (req.query) sanitizeInPlace(req.query); } catch { /* query is immutable in some setups — body/params already covered */ }
  next();
}

export default inputSanitize;
