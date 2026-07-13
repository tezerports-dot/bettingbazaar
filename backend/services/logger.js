// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * services/logger.js — thin structured logger (Phase X X-6, 2026-07-10).
 *
 * Dependency-free (no pino/winston) so the codebase stays portable to any
 * host. In production it emits one JSON object per line (ready for ingestion
 * by any log system — Datadog, Loki, CloudWatch, ELK, …); in dev it prints a
 * readable coloured line. Every record automatically carries the current
 * request/correlation id (from requestContext's AsyncLocalStorage) when one
 * exists, so a single deposit's journey across route → service → wallet →
 * event can be reconstructed by filtering on one reqId.
 *
 * Level is controlled by LOG_LEVEL (error|warn|info|debug); default info in
 * production, debug otherwise.
 */
import { getRequestId, getContextUser } from '../middleware/requestContext.js';

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const THRESHOLD = LEVELS[process.env.LOG_LEVEL] ??
  (process.env.NODE_ENV === 'production' ? LEVELS.info : LEVELS.debug);

const COLOR = { error: '\x1b[31m', warn: '\x1b[33m', info: '\x1b[36m', debug: '\x1b[90m' };
const RESET = '\x1b[0m';

// AQ-13: secret redaction. A structured logger is a leak vector — one
// `logger.info('login', { body })` can dump a password, OTP, or bearer token
// into the log pipeline (and then into whatever ingests it). redact() walks the
// meta object and masks any key whose name matches a sensitive pattern, so
// secrets never reach the sink even if a caller passes a whole request body.
const SENSITIVE_KEY = /pass(word|code)?|secret|token|authorization|auth_token|otp|jwt|api[-_]?key|cookie|cvv|card|pan|aadhaar|ssn|privateKey|mnemonic|seed/i;
const REDACTED = '[REDACTED]';

export function redact(value, depth = 0) {
  if (value == null || depth > 4) return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (typeof value === 'object') {
    // Preserve Error objects as readable info rather than masking/serializing oddly.
    if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack };
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SENSITIVE_KEY.test(k) ? REDACTED : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

function emit(level, msg, meta) {
  if (LEVELS[level] > THRESHOLD) return;
  const reqId = getRequestId();
  const userId = getContextUser();
  const safeMeta = meta && typeof meta === 'object' ? redact(meta) : meta;

  if (process.env.NODE_ENV === 'production') {
    const rec = {
      ts: new Date().toISOString(),
      level,
      msg: String(msg),
      ...(reqId ? { reqId } : {}),
      ...(userId ? { userId } : {}),
      ...(safeMeta && typeof safeMeta === 'object' ? safeMeta : {}),
    };
    (level === 'error' ? console.error : console.log)(JSON.stringify(rec));
  } else {
    const tag = reqId ? ` (${String(reqId).slice(0, 8)})` : '';
    const extra = safeMeta && Object.keys(safeMeta).length ? safeMeta : '';
    (level === 'error' ? console.error : console.log)(
      `${COLOR[level]}[${level}]${RESET}${tag} ${msg}`, extra);
  }
}

export const logger = {
  error: (msg, meta) => emit('error', msg, meta),
  warn:  (msg, meta) => emit('warn', msg, meta),
  info:  (msg, meta) => emit('info', msg, meta),
  debug: (msg, meta) => emit('debug', msg, meta),
};

export default logger;
