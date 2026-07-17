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
// JA3 is a TLS-client fingerprint, so in Node/Express it must be computed by
// the TLS edge (nginx/Envoy/Cloudflare Worker/etc.) and forwarded as x-ja3-hash
// or x-tls-ja3-hash; we validate and thread it through logs/context here.
const SAFE_ID = /^[A-Za-z0-9_.-]{1,64}$/;
const SAFE_JA3_HASH = /^[a-f0-9]{32}$/i;
const SAFE_JA3 = /^[0-9,\-]{1,256}$/;
const EDGE_SECRET = process.env.TLS_FINGERPRINT_EDGE_SECRET || '';

function trustedTlsFingerprintHeaders(req) {
  if (!EDGE_SECRET) return true;
  return req.get('x-edge-fingerprint-secret') === EDGE_SECRET;
}

// Plan item 35 (2026-07-13): W3C Trace Context interop. When a gateway/mesh
// sends a standard `traceparent` header (00-<32hex traceid>-<16hex spanid>-
// <2hex flags>), we adopt its TRACE ID as the correlation id, so our logs
// join the caller's distributed trace by id without an APM dependency. This
// deliberately layers ON TOP of the AsyncLocalStorage design (per the plan:
// don't replace it) — a full OpenTelemetry SDK slots in later by reusing
// these ids when an OTLP collector exists (env OTEL_EXPORTER_OTLP_ENDPOINT
// is its activation trigger).
const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

export function requestContext(req, res, next) {
  const incoming = req.get('x-request-id');
  const tp = TRACEPARENT.exec(req.get('traceparent') || '');
  const reqId =
    (incoming && SAFE_ID.test(incoming) && incoming) ||
    (tp && tp[1] !== '0'.repeat(32) && tp[1]) ||
    crypto.randomUUID();
  const trustTlsHeaders = trustedTlsFingerprintHeaders(req);
  const ja3Hash = trustTlsHeaders ? (req.get('x-ja3-hash') || req.get('x-tls-ja3-hash')) : '';
  const ja3 = trustTlsHeaders ? (req.get('x-ja3') || req.get('x-tls-ja3')) : '';
  const tlsFingerprint = {
    ...(ja3Hash && SAFE_JA3_HASH.test(ja3Hash) ? { ja3Hash: ja3Hash.toLowerCase() } : {}),
    ...(ja3 && SAFE_JA3.test(ja3) ? { ja3 } : {}),
  };
  req.id = reqId;
  req.tlsFingerprint = { ...tlsFingerprint, trusted: trustTlsHeaders };
  res.setHeader('X-Request-Id', reqId);
  if (tlsFingerprint.ja3Hash) res.setHeader('X-JA3-Observed', '1');
  als.run({ reqId, userId: undefined, tlsFingerprint: req.tlsFingerprint }, () => next());
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

export function getTlsFingerprint() {
  return als.getStore()?.tlsFingerprint || {};
}

/**
 * runWithContext — run an arbitrary async fn under a fresh context id. Used by
 * background workers (cron) so their logs also carry a correlation id
 * (`cron:<job>:<uuid>`), even though there is no HTTP request.
 */
export function runWithContext(reqId, fn) {
  return als.run({ reqId, userId: undefined, tlsFingerprint: {} }, fn);
}
