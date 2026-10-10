// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * POST /api/v1/client/endpoint-events — the player app reports how it found
 * its API origin: discovery success/failure, which source it adopted, and
 * failovers (`user-panel/src/services/originFailover.ts`). Counted into
 * `bb_client_endpoint_events_total` on /metrics; nothing is stored.
 *
 * Unauthenticated (it is sent before sign-in) and therefore treated as noise
 * an attacker controls: every label is a closed enum checked here, the host
 * label is this server's own Host only when it is a configured domain, the
 * batch is capped, the limiter's counters are shared across workers, and
 * nothing in the body is logged or echoed. It cannot change any state.
 */
import express from 'express';
import rateLimit from 'express-rate-limit';
import { createRateLimitStore } from '../middleware/redisRateLimitStore.js';
import { clientEndpointEvents } from '../services/metrics.service.js';
import { network } from '../config/network.config.js';

export const ENDPOINT_EVENT_KINDS = new Set(['discovery_ok', 'discovery_failed', 'adopted', 'failover', 'unavailable']);
export const ENDPOINT_EVENT_SOURCES = new Set(['discovery', 'configured', 'same-origin', 'none']);
export const ENDPOINT_EVENT_REASONS = new Set([
  'none', 'timeout', 'unreachable', 'http_error', 'invalid_json', 'invalid_shape', 'rejected_url', 'too_large', 'error',
]);
const MAX_EVENTS = 20;

function hostLabel(req) {
  const host = String(req.hostname || '').toLowerCase();
  return (network.domains || []).map((d) => String(d).toLowerCase()).includes(host) ? host : 'other';
}

/** Pure: the counted label sets for a body, or null when the body is refused. */
export function endpointEventLabels(body, host = 'other') {
  const events = body?.events;
  if (!Array.isArray(events) || events.length === 0 || events.length > MAX_EVENTS) return null;
  const out = [];
  for (const e of events) {
    if (!e || typeof e !== 'object') return null;
    const kind = String(e.kind);
    const source = e.source === undefined ? 'none' : String(e.source);
    const reasonRaw = e.reason === undefined ? 'none' : String(e.reason);
    const reason = /^http_\d{3}$/.test(reasonRaw) ? 'http_error' : reasonRaw;
    if (!ENDPOINT_EVENT_KINDS.has(kind) || !ENDPOINT_EVENT_SOURCES.has(source) || !ENDPOINT_EVENT_REASONS.has(reason)) {
      return null;
    }
    out.push({ kind, source, reason, host });
  }
  return out;
}

const router = express.Router();

const limiter = rateLimit({
  windowMs: 60_000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  store: createRateLimitStore('rl:clientendpoint:'),
  message: { success: false, message: 'Too many reports' },
});

router.post('/v1/client/endpoint-events', limiter, (req, res) => {
  const labels = endpointEventLabels(req.body, hostLabel(req));
  if (!labels) return res.status(400).json({ success: false, code: 'INVALID_ENDPOINT_EVENTS', message: 'Unrecognised endpoint events' });
  for (const l of labels) clientEndpointEvents.inc(l);
  return res.status(204).end();
});

export default router;
