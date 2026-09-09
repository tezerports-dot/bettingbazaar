// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file.
/**
 * webhookRawBody.js — which paths must be handed the BYTES.
 *
 * ── Why this is a module and not two lines in server.js ────────────────────
 * The USDT webhook verifies an HMAC over the raw request body. If the JSON
 * parser reaches it first, `req.body` is an OBJECT, the verifier digests
 * `Buffer.from(String({}))` — the literal text `[object Object]` — and EVERY
 * legitimate callback is refused. A player pays, BTCPay retries until it gives
 * up, and nobody is credited.
 *
 * That failure is invisible to a route test, because a route test mounts its
 * own app and would mount the raw parser itself. It is the "a route test proves
 * a handler works, it can never prove anything calls it" shape, one layer down:
 * the handler is right and the parser in front of it is wrong.
 *
 * So the decision has ONE owner. server.js reads it, and the webhook's own
 * suite builds its app from the same function — a test that passes is asserting
 * the parser the server actually uses.
 */

/** Paths whose handler needs `req.body` as a Buffer. */
export const RAW_BODY_PATHS = Object.freeze(['/api/payment/usdt/webhook']);

/**
 * Does this request path need the raw bytes?
 *
 * Matched on the full path, exactly. A prefix match would hand raw bytes to
 * anything mounted below one of these, and a handler expecting a parsed body
 * would read `undefined` from every field.
 */
export function usesRawBody(path) {
  return RAW_BODY_PATHS.includes(String(path || ''));
}
