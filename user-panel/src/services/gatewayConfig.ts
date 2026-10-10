// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * services/gatewayConfig.ts — the signed gateway document, verified in the app.
 *
 * The only way this app learns an API host its build did not ship with
 * (CLAUDE.md §2, "The API host player apps are sent to"). A document is signed
 * OFFLINE (`scripts/gateway-config.mjs`) and verified here against the
 * build-time public key (VITE_GATEWAY_CONFIG_PUBLIC_KEY), so whoever serves it
 * (our own servers, a mirror, an attacker on the path) cannot change a host.
 *
 * Mirror of `backend/domains/configuration/gatewayConfig.js` (GATEWAY_FORMAT,
 * GATEWAY_MAX_HOSTS, GATEWAY_MAX_DOCUMENT_BYTES, GATEWAY_MAX_LIFETIME_DAYS,
 * GATEWAY_CLOCK_SKEW_MS and the payload rules); a change
 * there changes this in the same commit (§5).
 *
 * Replay: the highest version ever accepted UNDER THIS BUILD'S KEY is kept as
 * a floor; a lower version is refused, and the same version is accepted only
 * byte-for-byte as stored. The floor and the stored document are keyed by the
 * public key, so a document signed with a leaked key (at any version) cannot
 * block the documents of the key that replaces it. A document is refused if
 * issued more than a day ahead of this clock or meant to live over 400 days;
 * an expired one contributes no hosts.
 */
import { verifyAsync } from '@noble/ed25519';

export const GATEWAY_FORMAT = 'bb-gateway-config/1';
export const GATEWAY_MAX_HOSTS = 8;
export const GATEWAY_MAX_DOCUMENT_BYTES = 4096;
export const GATEWAY_MAX_LIFETIME_DAYS = 400;
export const GATEWAY_CLOCK_SKEW_MS = 86_400_000;

/** Storage names, one pair per public key (`:<base64url key>`). */
const DOCUMENT_KEY = 'bb_gateway_document';
const FLOOR_KEY = 'bb_gateway_version_floor';
const B64URL = /^[A-Za-z0-9_-]+$/;
const PAYLOAD_KEYS = ['expiresAt', 'format', 'hosts', 'issuedAt', 'version'];
/** Same rule as `isPlainHostname` (backend/config/apiHosts.js): lowercase only, two labels or more, not an address. */
const HOSTNAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

export type GatewayPayload = {
  format: string; version: number; issuedAt: string; expiresAt: string; hosts: string[];
};

/** A refusal; `message` is the stable code (GATEWAY_*), as the backend's `code`. */
function refuse(code: string): Error { return new Error(code); }

function sameKeys(obj: object, keys: string[]): boolean {
  const own = Object.keys(obj).sort();
  return own.length === keys.length && keys.every((k, i) => k === own[i]);
}

function isIsoInstant(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  const ms = Date.parse(v);
  return Number.isFinite(ms) && new Date(ms).toISOString() === v;
}

function fromBase64url(text: string): Uint8Array {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export function checkGatewayPayload(p: unknown): GatewayPayload {
  if (!p || typeof p !== 'object' || Array.isArray(p) || !sameKeys(p, PAYLOAD_KEYS)) throw refuse('GATEWAY_BAD_PAYLOAD');
  const { format, version, issuedAt, expiresAt, hosts } = p as GatewayPayload;
  if (format !== GATEWAY_FORMAT) throw refuse('GATEWAY_BAD_FORMAT');
  if (!Number.isSafeInteger(version) || version < 1) throw refuse('GATEWAY_BAD_VERSION');
  if (!isIsoInstant(issuedAt) || !isIsoInstant(expiresAt) || Date.parse(expiresAt) <= Date.parse(issuedAt)) throw refuse('GATEWAY_BAD_TIME');
  if (Date.parse(expiresAt) - Date.parse(issuedAt) > GATEWAY_MAX_LIFETIME_DAYS * 86_400_000) throw refuse('GATEWAY_BAD_TIME');
  if (!Array.isArray(hosts) || hosts.length < 1 || hosts.length > GATEWAY_MAX_HOSTS) throw refuse('GATEWAY_BAD_HOSTS');
  for (const h of hosts) {
    if (typeof h !== 'string' || !HOSTNAME.test(h) || IPV4.test(h)) throw refuse('GATEWAY_BAD_HOSTS');
  }
  if (new Set(hosts).size !== hosts.length) throw refuse('GATEWAY_BAD_HOSTS');
  return p as GatewayPayload;
}

/** The public key as 32 bytes, or null when it is not a base64url 32-byte key. */
export function parsePublicKey(raw: string): Uint8Array | null {
  const text = raw.trim();
  if (!B64URL.test(text)) return null;
  try {
    const bytes = fromBase64url(text);
    return bytes.length === 32 ? bytes : null;
  } catch { return null; }
}

/**
 * Verify a document's text. Resolves with the payload, or rejects with a
 * GATEWAY_* code: size, envelope, signature, format, expiry, then the floor.
 */
export async function verifyGatewayDocument(
  text: string, publicKey: Uint8Array, { now = Date.now(), floor = 0 }: { now?: number; floor?: number } = {},
): Promise<GatewayPayload> {
  if (text.length > GATEWAY_MAX_DOCUMENT_BYTES) throw refuse('GATEWAY_TOO_LARGE');
  let doc: any;
  try { doc = JSON.parse(text); } catch { throw refuse('GATEWAY_BAD_DOCUMENT'); }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc) || !sameKeys(doc, ['payload', 'signature'])
    || typeof doc.payload !== 'string' || typeof doc.signature !== 'string'
    || !B64URL.test(doc.payload) || !B64URL.test(doc.signature)) throw refuse('GATEWAY_BAD_DOCUMENT');

  const bytes = fromBase64url(doc.payload);
  const signature = fromBase64url(doc.signature);
  let ok: boolean;
  try {
    // RFC 8032 strict verification, as the server's OpenSSL does.
    ok = signature.length === 64 && await verifyAsync(signature, bytes, publicKey, { zip215: false });
  } catch { ok = false; }
  if (!ok) throw refuse('GATEWAY_BAD_SIGNATURE');

  let payload: unknown;
  try { payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw refuse('GATEWAY_BAD_PAYLOAD'); }
  const checked = checkGatewayPayload(payload);
  if (Date.parse(checked.issuedAt) > now + GATEWAY_CLOCK_SKEW_MS) throw refuse('GATEWAY_NOT_YET_ISSUED');
  if (now >= Date.parse(checked.expiresAt)) throw refuse('GATEWAY_EXPIRED');
  if (checked.version < floor) throw refuse('GATEWAY_REPLAYED');
  return checked;
}

// ── What this app has accepted ───────────────────────────────────────────────
// Storage can be absent or throw (private mode); then the floor lives for
// this run only, which still refuses a replay within it. Everything is held
// per public key.
let accepted: { key: string; text: string; payload: GatewayPayload } | null = null;
const memoryFloor = new Map<string, number>();

function keyId(publicKey: Uint8Array): string {
  let bin = '';
  publicKey.forEach((b) => { bin += String.fromCharCode(b); });
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function readStored(name: string): string {
  try { return globalThis.localStorage?.getItem(name) ?? ''; } catch { return ''; }
}
function writeStored(name: string, value: string): void {
  try { globalThis.localStorage?.setItem(name, value); } catch { /* the in-memory copy still holds */ }
}

/** The highest version this app ever accepted under `publicKey`. */
export function versionFloor(publicKey: Uint8Array): number {
  const id = keyId(publicKey);
  const stored = Number(readStored(`${FLOOR_KEY}:${id}`));
  return Math.max(memoryFloor.get(id) ?? 0, Number.isSafeInteger(stored) && stored > 0 ? stored : 0);
}

function hold(id: string, text: string, payload: GatewayPayload): void {
  accepted = { key: id, text, payload };
  memoryFloor.set(id, Math.max(memoryFloor.get(id) ?? 0, payload.version));
}

/**
 * Verify and, if it is new, adopt a document. Resolves with the payload now
 * in force, or rejects with a GATEWAY_* code. The floor and stored copy only rise.
 */
export async function acceptGatewayDocument(text: string, publicKey: Uint8Array, now = Date.now()): Promise<GatewayPayload> {
  const id = keyId(publicKey);
  const floor = versionFloor(publicKey);
  const payload = await verifyGatewayDocument(text, publicKey, { now, floor });
  if (payload.version === floor) {
    const held = (accepted?.key === id ? accepted.text : '') || readStored(`${DOCUMENT_KEY}:${id}`);
    // The same version with other bytes is a second document under one number.
    if (held && held !== text) throw refuse('GATEWAY_REPLAYED');
  }
  hold(id, text, payload);
  writeStored(`${DOCUMENT_KEY}:${id}`, text);
  writeStored(`${FLOOR_KEY}:${id}`, String(payload.version));
  return payload;
}

/** Re-verify the document stored under this key at launch. Resolves with its hosts, or []. */
export async function loadStoredGateway(publicKey: Uint8Array, now = Date.now()): Promise<string[]> {
  const id = keyId(publicKey);
  const text = readStored(`${DOCUMENT_KEY}:${id}`);
  if (!text) return [];
  try {
    const payload = await verifyGatewayDocument(text, publicKey, { now, floor: versionFloor(publicKey) });
    hold(id, text, payload);
    return payload.hosts;
  } catch { return []; }
}

/** The hosts of the accepted document, while it has not expired. */
export function signedHosts(now = Date.now()): string[] {
  if (!accepted || now >= Date.parse(accepted.payload.expiresAt)) return [];
  return accepted.payload.hosts;
}

/** Test seam: forget what this run accepted (storage is the test's to clear). */
export function resetGatewayState(): void { accepted = null; memoryFloor.clear(); }
