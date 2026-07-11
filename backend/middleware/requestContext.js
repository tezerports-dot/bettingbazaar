// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * middleware/requestContext.js — correlation IDs (Phase X X-6, 2026-07-10).
 *
 * Threads a request/correlation ID through the whole async call graph so any
 * log line — in a route, a service, a wallet authority, an event handler —
 * can be tied back to the originating HTTP request WITHOUT passing the id
 * through every function signature. Uses Node's built-in AsyncLocalStorage
 * (no external APM/tracing dependency — stays portable to any host).
 *
 * Accepts an inbound `X-Request-Id` (so a gateway/load balancer's trace id is
 * preserved end to end) or generates one; always echoes it back on the
 * response so clients and support can quote it.
 */
import { AsyncLocalStorage } from 'async_hooks';
import crypto from 'crypto';

const als = new AsyncLocalStorage();

// Accept a client/gateway id only if it's a sane token; otherwise generate.
const SAFE_ID = /^[A-Za-z0-9_.-]{1,64}$/;

export function requestContext(req, res, next) {
  const incoming = req.get('x-request-id');
  const reqId = incoming && SAFE_ID.test(incoming) ? incoming : crypto.randomUUID();
  req.id = reqId;
  res.setHeader('X-Request-Id', reqId);
  als.run({ reqId, userId: undefined }, () => next());
}

/** The current request's id, or undefined outside a request (e.g. a cron tick). */
export function getRequestId() {
  return als.getStore()?.reqId;
}

/** Attach the authenticated user to the context once auth resolves (for logs). */
export function setContextUser(userId) {
  const store = als.getStore();
  if (store) store.userId = userId ? String(userId) : undefined;
}

export function getContextUser() {
  return als.getStore()?.userId;
}

/**
 * runWithContext — run an arbitrary async fn under a fresh context id. Used by
 * background workers (cron) so their logs also carry a correlation id
 * (`cron:<job>:<uuid>`), even though there is no HTTP request.
 */
export function runWithContext(reqId, fn) {
  return als.run({ reqId, userId: undefined }, fn);
}
