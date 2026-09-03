// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * The caller-supplied idempotency key.
 *
 * ── What this is guarding against ───────────────────────────────────────────
 * A shipped bug, not a hypothetical. `/admin/merchants/:id/fund` keyed its
 * merchant credit on a freshly generated id — a new value per delivery,
 * which is `random()`. The UNIQUE constraint behind it
 * could never fire, so every retry funded the merchant again while the code
 * read as though it were protected.
 *
 * The lesson is narrow and worth stating exactly: a server-generated
 * idempotency key is WORSE than none, because it looks like a gate. So the
 * tests below care about two things — that the key must come from the caller,
 * and that a key which reaches a UNIQUE database column is validated rather
 * than trusted.
 */
import { describe, it, expect } from 'vitest';
import {
  readIdempotencyKey, requireIdempotencyKey, assertValidIdempotencyKey,
  requireIdempotencyKeyMiddleware, IdempotencyKeyError,
  MIN_KEY_LENGTH, MAX_KEY_LENGTH,
} from '../../middleware/idempotencyKey.js';

/** An Express-shaped request. `get` is case-insensitive, as Express's is. */
const req = ({ headers = {}, body = {} } = {}) => ({
  headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])),
  body,
  get(name) { return this.headers[name.toLowerCase()]; },
});

describe('reading the key', () => {
  it('prefers the header, which survives a proxy that rebuilds the body', () => {
    expect(readIdempotencyKey(req({
      headers: { 'Idempotency-Key': 'header-key-1' },
      body: { idempotencyKey: 'body-key-1' },
    }))).toBe('header-key-1');
  });

  it('accepts a body field for clients that cannot set headers', () => {
    expect(readIdempotencyKey(req({ body: { idempotencyKey: 'body-key-1' } }))).toBe('body-key-1');
  });

  it('treats whitespace as absent rather than as a key', () => {
    // A key of spaces would pass a truthiness check and give the caller the
    // impression they are protected while every request carries the same value
    // — or none at all, depending on how it is later concatenated.
    expect(readIdempotencyKey(req({ headers: { 'Idempotency-Key': '   ' } }))).toBeNull();
    expect(readIdempotencyKey(req({}))).toBeNull();
  });

  it('refuses a non-string, which is what a JSON body can smuggle in', () => {
    expect(() => readIdempotencyKey(req({ body: { idempotencyKey: { $ne: null } } })))
      .toThrow(IdempotencyKeyError);
    expect(() => readIdempotencyKey(req({ body: { idempotencyKey: 12345678 } })))
      .toThrow(/must be a string/);
  });
});

describe('validating the key', () => {
  it('accepts the identifier shapes callers actually use', () => {
    for (const key of [
      '7c9e6679-7425-40de-944b-e07fc1f90ae7',   // UUID
      '5f8d0d55b54764421b7156c3',               // ObjectId
      '01ARZ3NDEKTSV4RRFFQ69G5FAV',             // ULID
      'topup-2026-08-04-0001',                  // a human scheme
      'a'.repeat(MAX_KEY_LENGTH),
    ]) {
      expect(assertValidIdempotencyKey(key)).toBe(key);
    }
  });

  it('rejects a colon — it is the separator a multi-leg movement uses', () => {
    // merchant_wallet_entries keys each leg `<txId>:<pocket>`. A caller key
    // containing ':' could forge a leg id that collides with a DIFFERENT
    // movement's leg, which is a cross-request collision on a UNIQUE column.
    expect(() => assertValidIdempotencyKey('abcdefgh:available')).toThrow(/only letters/);
  });

  it('rejects lengths that make a bad database key', () => {
    expect(() => assertValidIdempotencyKey('a'.repeat(MIN_KEY_LENGTH - 1)))
      .toThrow(new RegExp(`${MIN_KEY_LENGTH}-${MAX_KEY_LENGTH} characters`));
    // Unbounded input in an indexed column is a denial-of-service shape.
    expect(() => assertValidIdempotencyKey('a'.repeat(MAX_KEY_LENGTH + 1)))
      .toThrow(/characters/);
  });

  it('rejects characters that would change the meaning of a composed id', () => {
    for (const bad of ['key with space', 'key/slash', 'key%20', "key'--", 'key\n2', 'ключ12345']) {
      expect(() => assertValidIdempotencyKey(bad)).toThrow(IdempotencyKeyError);
    }
  });

  it('never silently corrects — the caller and server must mean the same key', () => {
    // Trimming or rewriting would leave the caller believing they hold a key
    // the server never saw, so a deliberate retry would not match.
    expect(() => assertValidIdempotencyKey('has space')).toThrow();
  });
});

describe('requiring the key', () => {
  it('refuses rather than inventing one', () => {
    const err = (() => { try { requireIdempotencyKey(req({})); } catch (e) { return e; } })();
    expect(err).toBeInstanceOf(IdempotencyKeyError);
    expect(err.status).toBe(400);
    // The message has to say what a caller should DO, because the whole point
    // is that they own the distinction the server cannot make.
    expect(err.message).toMatch(/SAME key when retrying/);
    expect(err.message).toMatch(/NEW key/);
  });

  it('returns the validated key when the caller sent a good one', () => {
    expect(requireIdempotencyKey(req({ headers: { 'Idempotency-Key': 'good-key-0001' } })))
      .toBe('good-key-0001');
  });

  it('validates as well as requires — a present but malformed key is still a 400', () => {
    expect(() => requireIdempotencyKey(req({ headers: { 'Idempotency-Key': 'short' } })))
      .toThrow(/8-128 characters/);
  });
});

describe('the middleware form', () => {
  const run = (request) => {
    const res = {
      code: null, body: null,
      status(c) { this.code = c; return this; },
      json(b) { this.body = b; return this; },
    };
    let nexted = false;
    let nextedWith = null;
    requireIdempotencyKeyMiddleware(request, res, (e) => { nexted = true; nextedWith = e; });
    return { res, nexted, nextedWith, request };
  };

  it('puts the VALIDATED key on the request, so a handler cannot read the raw header', () => {
    const { request, nexted } = run(req({ headers: { 'Idempotency-Key': ' padded-key-01 ' } }));
    expect(nexted).toBe(true);
    // Trimmed here and only here: the handler sees exactly what the gate will.
    expect(request.idempotencyKey).toBe('padded-key-01');
  });

  it('answers 400 without reaching the handler', () => {
    const { res, nexted } = run(req({}));
    expect(nexted).toBe(false);
    expect(res.code).toBe(400);
    expect(res.body.success).toBe(false);
  });
});
