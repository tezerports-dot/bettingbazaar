// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * middleware/idempotencyKey.js — the caller's name for "this one request".
 *
 * ── Why the server cannot supply this ───────────────────────────────────────
 * An idempotency key answers exactly one question: is this delivery a RETRY of
 * a request I already made, or a NEW request that happens to look identical?
 *
 * Only the caller knows. "Top up merchant X by ₹5,000" is the same bytes
 * whether it is a retried request or a second deliberate top-up, so a key the
 * server derives from the payload cannot tell them apart — it would collapse
 * two intentional top-ups into one. A key the server generates per request
 * (`new ObjectId()`) has the opposite failure and is worse, because it looks
 * like idempotency while providing none:
 *
 *     txId: `mw_topup_${new mongoose.Types.ObjectId()}`   // shipped in production
 *
 * That is `random()`. Every delivery got a fresh key, so the UNIQUE gate behind
 * it could never fire and every retry funded the merchant again. The gate
 * existed, was tested, and protected nothing — which is the specific failure
 * this module exists to make impossible to repeat.
 *
 * ── Shape rules, and why they are not fussiness ─────────────────────────────
 * The key becomes part of a database key: it lands in `tx_id` / `movement_id`
 * columns with UNIQUE constraints, and is concatenated into namespaced ids like
 * `mint_<key>`. So it is constrained at the boundary rather than trusted:
 *
 *  - LENGTH. Unbounded input in an indexed column is a denial-of-service shape
 *    (btree entries have a size limit) and makes log lines unreadable.
 *  - CHARSET. `:` is the separator multi-leg movements use internally
 *    (`<txId>:<pocket>`), so a key containing one could forge a leg id that
 *    collides with a different movement's. The allowed set deliberately
 *    excludes it.
 *  - NON-EMPTY after trimming, so whitespace cannot pass as a key and give a
 *    caller the impression they are protected.
 *
 * ── Scoping ─────────────────────────────────────────────────────────────────
 * Callers namespace the key per operation (`mint_<key>`, `mw_topup_<key>`), so
 * the same client key used on two different endpoints cannot collide. This
 * module deliberately does NOT do that namespacing: it belongs with the
 * operation, where the reader can see which gate a given id feeds.
 */

/** Long enough to be unique in practice, short enough to index and read. */
export const MIN_KEY_LENGTH = 8;
export const MAX_KEY_LENGTH = 128;

/**
 * Excludes ':' on purpose — see the header. A UUID, an ObjectId, a ULID and a
 * `<scope>-<n>` counter all pass.
 */
const KEY_PATTERN = /^[A-Za-z0-9_.\-]+$/;

export class IdempotencyKeyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'IdempotencyKeyError';
    this.status = 400;
  }
}

/**
 * Pull the key out of a request. Header first — `Idempotency-Key` is the
 * conventional place for it and survives proxies and retries that rebuild a
 * body — with a body field accepted as a fallback for clients that cannot set
 * headers.
 *
 * @returns {string|null} the trimmed key, or null when the caller sent none.
 */
export function readIdempotencyKey(req) {
  const raw = req?.get?.('Idempotency-Key')
    ?? req?.headers?.['idempotency-key']
    ?? req?.body?.idempotencyKey;
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') {
    throw new IdempotencyKeyError('Idempotency-Key must be a string');
  }
  const key = raw.trim();
  return key.length ? key : null;
}

/**
 * Validate a key the caller did send. Throws a 400-shaped error, never returns
 * a silently corrected value — quietly trimming or rewriting a key would mean
 * the caller's idea of it and the server's could differ, which defeats the
 * point of the caller owning it.
 */
export function assertValidIdempotencyKey(key) {
  if (key.length < MIN_KEY_LENGTH || key.length > MAX_KEY_LENGTH) {
    throw new IdempotencyKeyError(
      `Idempotency-Key must be ${MIN_KEY_LENGTH}-${MAX_KEY_LENGTH} characters, got ${key.length}`,
    );
  }
  if (!KEY_PATTERN.test(key)) {
    throw new IdempotencyKeyError(
      'Idempotency-Key may contain only letters, digits, underscore, dot and hyphen',
    );
  }
  return key;
}

/**
 * The key for a financial request that MUST have one.
 *
 * Refuses rather than inventing one. A generated fallback is what made the
 * original bug invisible: the code read as though it had a gate, so nobody
 * looked again. An endpoint that moves money on the caller's behalf should fail
 * loudly when the caller has not said which request this is.
 *
 * @throws {IdempotencyKeyError} 400 when absent or malformed.
 */
export function requireIdempotencyKey(req) {
  const key = readIdempotencyKey(req);
  if (!key) {
    throw new IdempotencyKeyError(
      'Idempotency-Key is required for this request. Send the SAME key when retrying, '
      + 'and a NEW key for a genuinely separate operation.',
    );
  }
  return assertValidIdempotencyKey(key);
}

/**
 * Express middleware form. Puts the validated key on `req.idempotencyKey` so a
 * handler cannot accidentally read the unvalidated header instead.
 */
export function requireIdempotencyKeyMiddleware(req, res, next) {
  try {
    req.idempotencyKey = requireIdempotencyKey(req);
    next();
  } catch (error) {
    if (error instanceof IdempotencyKeyError) {
      return res.status(400).json({ success: false, message: error.message });
    }
    next(error);
  }
}
