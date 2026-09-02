// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * tlsFingerprintDefense.js — admin-controlled JA3 policy enforcement.
 *
 * Important boundary: JA3 is derived from the CLIENT'S TLS ClientHello. A
 * Node/Express app behind a TLS terminator cannot randomize inbound handshakes;
 * the TLS edge must compute JA3 and forward x-ja3-hash / x-tls-ja3-hash. This
 * middleware makes that signal actionable everywhere in the app through
 * the platform's `tlsFingerprintDefense` configuration.
 */
import logger from '../services/logger.js';
import { getSystemConfig } from '#db/repositories/config.js';

const DEFAULTS = {
  enabled: true,
  logOnly: true,
  requireJa3Hash: false,
  blockJa3Hashes: [],
};

let cfg = { ...DEFAULTS };
let refreshTimer = null;

function normalizeHashes(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((v) => String(v || '').trim().toLowerCase())
    .filter((v) => /^[a-f0-9]{32}$/.test(v)) )];
}

async function refreshConfig({ throwOnError = false } = {}) {
  try {
    const doc = await getSystemConfig();
    const s = doc?.tlsFingerprintDefense || {};
    cfg = {
      enabled: s.enabled !== undefined ? !!s.enabled : DEFAULTS.enabled,
      logOnly: s.logOnly !== undefined ? !!s.logOnly : DEFAULTS.logOnly,
      requireJa3Hash: !!s.requireJa3Hash,
      blockJa3Hashes: normalizeHashes(s.blockJa3Hashes),
    };
  } catch (error) {
    if (throwOnError) throw error;
    logger.error('TLS fingerprint policy config refresh failed', { error });
  }
}

export async function startTlsFingerprintDefenseConfigRefresh(everyMs = 30_000) {
  if (refreshTimer) return;
  // Do not serve with the permissive log-only defaults if the initial DB load
  // fails; the server startup path awaits this call and fails closed.
  await refreshConfig({ throwOnError: true });
  refreshTimer = setInterval(refreshConfig, everyMs);
  if (refreshTimer.unref) refreshTimer.unref();
}


function violation(res, reason) {
  if (cfg.logOnly) return false;
  res.status(403).json({ success: false, message: 'TLS fingerprint policy blocked this request', reason });
  return true;
}

export function tlsFingerprintDefense(req, res, next) {
  if (!cfg.enabled) return next();
  const fp = req.tlsFingerprint || {};
  const ja3Hash = fp.ja3Hash;

  if (fp.trusted === false) {
    logger.warn('TLS fingerprint policy: ignored untrusted edge headers', { path: req.path, method: req.method });
  }

  if (cfg.requireJa3Hash && !ja3Hash) {
    logger.warn('TLS fingerprint policy: missing JA3 hash', { path: req.path, method: req.method });
    if (violation(res, 'missing_ja3_hash')) return;
  }

  if (ja3Hash && cfg.blockJa3Hashes.includes(ja3Hash)) {
    logger.warn('TLS fingerprint policy: blocked JA3 hash', { path: req.path, method: req.method, ja3Hash });
    if (violation(res, 'blocked_ja3_hash')) return;
  }

  next();
}
