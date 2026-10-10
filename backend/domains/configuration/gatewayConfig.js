// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * domains/configuration/gatewayConfig.js — the signed gateway document: the
 * one way a player app learns an API host its build did not ship with
 * (CLAUDE.md §2, "The API host player apps are sent to").
 *
 * A document is signed OFFLINE with an Ed25519 key that never touches this
 * repository or any server (`scripts/gateway-config.mjs`). The server only
 * serves the operator's signed file; it cannot write or sign one, so a
 * compromised server or admin account cannot add a host.
 *
 *   { "payload": "<base64url of the payload's JSON bytes>",
 *     "signature": "<base64url of the 64-byte Ed25519 signature over those bytes>" }
 *
 * The payload (the signed bytes, so no canonical JSON is needed):
 *
 *   { "format": "bb-gateway-config/1", "version": <integer ≥ 1, rising>,
 *     "issuedAt": "<ISO-8601 UTC>", "expiresAt": "<ISO-8601 UTC>",
 *     "hosts": ["api.example.com", …] }   // 1–8 plain lowercase hostnames
 *
 * The player app's mirror of these rules is `user-panel/src/services/gatewayConfig.ts`
 * (§5: a change here changes it in the same commit).
 *
 *   GATEWAY_CONFIG_FILE        path of the signed document this server serves
 *   GATEWAY_CONFIG_PUBLIC_KEY  base64url raw 32-byte Ed25519 public key
 *
 * Node's own Ed25519 (OpenSSL) verifies here; no pure-JS crypto on the request
 * path (§32 S38), and the verified document is cached.
 */
import { createPublicKey, sign, verify } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { isPlainHostname } from '../../config/apiHosts.js';

export const GATEWAY_FORMAT = 'bb-gateway-config/1';
export const GATEWAY_MAX_HOSTS = 8;
/** The longest a document may live (expiresAt − issuedAt), so a signed document cannot outlast a rotation by years. */
export const GATEWAY_MAX_LIFETIME_DAYS = 400;
/** How far issuedAt may lie ahead of the verifier's clock (a phone's clock is not ours). */
export const GATEWAY_CLOCK_SKEW_MS = 86_400_000;
/** A document larger than this is not a gateway document (the app holds the same cap). */
export const GATEWAY_MAX_DOCUMENT_BYTES = 4096;

const B64URL = /^[A-Za-z0-9_-]+$/;
const PAYLOAD_KEYS = ['format', 'version', 'issuedAt', 'expiresAt', 'hosts'];

/** A refusal with a stable code; `status: 400` because it is the caller's input (§32 S35). */
function refuse(code, message) {
  return Object.assign(new Error(message), { code, status: 400 });
}

function sameKeys(obj, keys) {
  const own = Object.keys(obj).sort();
  return own.length === keys.length && [...keys].sort().every((k, i) => k === own[i]);
}

function isIsoInstant(value) {
  if (typeof value !== 'string') return false;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString() === value;
}

/**
 * Check a payload object against the format. Returns it, or throws a refusal.
 * Pure: says nothing about the signature, the clock or the version floor.
 */
export function checkGatewayPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !sameKeys(payload, PAYLOAD_KEYS)) {
    throw refuse('GATEWAY_BAD_PAYLOAD', `payload must have exactly: ${PAYLOAD_KEYS.join(', ')}`);
  }
  const { format, version, issuedAt, expiresAt, hosts } = payload;
  if (format !== GATEWAY_FORMAT) throw refuse('GATEWAY_BAD_FORMAT', `format must be ${GATEWAY_FORMAT}`);
  if (!Number.isSafeInteger(version) || version < 1) throw refuse('GATEWAY_BAD_VERSION', 'version must be an integer of at least 1');
  if (!isIsoInstant(issuedAt) || !isIsoInstant(expiresAt)) throw refuse('GATEWAY_BAD_TIME', 'issuedAt and expiresAt must be ISO-8601 UTC instants');
  if (Date.parse(expiresAt) <= Date.parse(issuedAt)) throw refuse('GATEWAY_BAD_TIME', 'expiresAt must be after issuedAt');
  if (Date.parse(expiresAt) - Date.parse(issuedAt) > GATEWAY_MAX_LIFETIME_DAYS * 86_400_000) {
    throw refuse('GATEWAY_BAD_TIME', `a document may live at most ${GATEWAY_MAX_LIFETIME_DAYS} days`);
  }
  if (!Array.isArray(hosts) || hosts.length < 1 || hosts.length > GATEWAY_MAX_HOSTS) {
    throw refuse('GATEWAY_BAD_HOSTS', `hosts must list 1 to ${GATEWAY_MAX_HOSTS} hostnames`);
  }
  for (const host of hosts) {
    // Exactly as written: a host that would need lowercasing is refused, never normalised.
    if (!isPlainHostname(host)) throw refuse('GATEWAY_BAD_HOSTS', `"${String(host)}" is not a plain lowercase hostname`);
  }
  if (new Set(hosts).size !== hosts.length) throw refuse('GATEWAY_BAD_HOSTS', 'hosts must not repeat');
  return payload;
}

/** The KeyObject for a base64url raw 32-byte Ed25519 public key; throws a refusal otherwise. */
export function gatewayPublicKey(raw) {
  const text = String(raw || '').trim();
  if (!B64URL.test(text) || Buffer.from(text, 'base64url').length !== 32) {
    throw refuse('GATEWAY_BAD_KEY', 'the public key must be 32 bytes, base64url');
  }
  return createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: text }, format: 'jwk' });
}

/** The base64url raw public key of an Ed25519 key (private or public KeyObject). */
export function rawPublicKey(keyObject) {
  return createPublicKey(keyObject).export({ format: 'jwk' }).x;
}

/** Sign a payload with an Ed25519 private KeyObject. Checks the payload first. */
export function signGatewayPayload(payload, privateKey) {
  const bytes = Buffer.from(JSON.stringify(checkGatewayPayload(payload)), 'utf8');
  return { payload: bytes.toString('base64url'), signature: sign(null, bytes, privateKey).toString('base64url') };
}

/**
 * Verify a document (parsed object or JSON text). Returns the payload, or
 * throws a refusal: signature first, then format, then the clock (issued no
 * more than GATEWAY_CLOCK_SKEW_MS ahead, not expired), then the version floor
 * (`floor`: the highest version already accepted under this key; lower is a replay).
 */
export function verifyGatewayDocument(document, publicKey, { now = Date.now(), floor = 0 } = {}) {
  let doc = document;
  if (typeof doc === 'string') {
    if (Buffer.byteLength(doc, 'utf8') > GATEWAY_MAX_DOCUMENT_BYTES) throw refuse('GATEWAY_TOO_LARGE', 'document is too large');
    try { doc = JSON.parse(doc); } catch { throw refuse('GATEWAY_BAD_DOCUMENT', 'document is not JSON'); }
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc) || !sameKeys(doc, ['payload', 'signature'])
    || typeof doc.payload !== 'string' || typeof doc.signature !== 'string'
    || !B64URL.test(doc.payload) || !B64URL.test(doc.signature)) {
    throw refuse('GATEWAY_BAD_DOCUMENT', 'document must be {payload, signature}, both base64url');
  }
  const bytes = Buffer.from(doc.payload, 'base64url');
  const signature = Buffer.from(doc.signature, 'base64url');
  const key = typeof publicKey === 'string' ? gatewayPublicKey(publicKey) : publicKey;
  if (signature.length !== 64 || !verify(null, bytes, key, signature)) throw refuse('GATEWAY_BAD_SIGNATURE', 'signature does not verify');

  let payload;
  try { payload = JSON.parse(bytes.toString('utf8')); } catch { throw refuse('GATEWAY_BAD_PAYLOAD', 'payload is not JSON'); }
  checkGatewayPayload(payload);
  if (Date.parse(payload.issuedAt) > now + GATEWAY_CLOCK_SKEW_MS) throw refuse('GATEWAY_NOT_YET_ISSUED', `document is issued in the future (${payload.issuedAt})`);
  if (now >= Date.parse(payload.expiresAt)) throw refuse('GATEWAY_EXPIRED', `document expired at ${payload.expiresAt}`);
  if (payload.version < floor) throw refuse('GATEWAY_REPLAYED', `version ${payload.version} is below ${floor}`);
  return payload;
}

// ── What this server serves ─────────────────────────────────────────────────
/** How long a read of the operator's file is reused. */
export const GATEWAY_CACHE_MS = 60_000;
let cache = { at: 0, file: '', mtimeMs: 0, text: null };
let lastWarning = '';

/**
 * The operator's signed document as served text, or null when none is
 * configured or it does not verify now (expired, wrong key, malformed). A
 * document that fails is logged and never served: the app would refuse it.
 */
export async function servedGatewayDocument({ now = Date.now() } = {}) {
  const file = process.env.GATEWAY_CONFIG_FILE || '';
  const key = process.env.GATEWAY_CONFIG_PUBLIC_KEY || '';
  if (!file || !key) return null;
  try {
    const { mtimeMs } = await stat(file);
    if (!(cache.file === file && cache.mtimeMs === mtimeMs && now - cache.at < GATEWAY_CACHE_MS)) {
      cache = { at: now, file, mtimeMs, text: (await readFile(file, 'utf8')).trim() };
    }
    verifyGatewayDocument(cache.text, key, { now });
    lastWarning = '';
    return cache.text;
  } catch (err) {
    const warning = `[gatewayConfig] not serving ${file}: ${err.code || 'ERROR'} ${err.message}`;
    if (warning !== lastWarning) console.warn(warning);   // once per cause, not per request
    lastWarning = warning;
    return null;
  }
}
