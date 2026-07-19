// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * paseto.util.js — single authority for platform authentication tokens.
 *
 * This implements PASETO v2.public with Ed25519 signatures. There is no
 * caller-selected algorithm header, so algorithm-swapping / `none` attacks are
 * impossible by construction. Tokens are signed as:
 *   v2.public.<base64url(JSON payload || Ed25519 signature)>
 * where the signature covers PASETO's Pre-Authentication Encoding (PAE) of the
 * header, payload and optional footer per the public PASETO spec.
 */
import nacl from 'tweetnacl';
import util from 'tweetnacl-util';

const { decodeUTF8, encodeUTF8, encodeBase64, decodeBase64 } = util;

const HEADER = 'v2.public.';
const DEFAULT_EXP = process.env.PASETO_EXPIRES_IN || process.env.JWT_EXPIRES_IN || '24h';
export const PASETO_ISSUER = process.env.PASETO_ISSUER || process.env.JWT_ISSUER || 'bettingbazaar';
export const PASETO_AUDIENCE = process.env.PASETO_AUDIENCE || process.env.JWT_AUDIENCE || 'bettingbazaar';
export const PASETO_EXPIRES_IN = DEFAULT_EXP;

const secretSeed = process.env.PASETO_SECRET_KEY || process.env.JWT_SECRET;
if (!secretSeed) {
  throw new Error('FATAL: PASETO_SECRET_KEY (or legacy JWT_SECRET) environment variable is not set. Refusing to start.');
}

function b64url(input) {
  return encodeBase64(input).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function unb64url(input) {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - input.length % 4) % 4);
  return decodeBase64(padded);
}

function le64(n) {
  const out = new Uint8Array(8);
  let x = BigInt(n);
  for (let i = 0; i < 8; i += 1) { out[i] = Number(x & 0xffn); x >>= 8n; }
  return out;
}

function concat(...parts) {
  const len = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

function pae(pieces) {
  return concat(le64(pieces.length), ...pieces.flatMap((p) => [le64(p.length), p]));
}

function seedFromSecret(secret) {
  const bytes = decodeUTF8(String(secret));
  return nacl.hash(bytes).slice(0, 32);
}

const keyPair = nacl.sign.keyPair.fromSeed(seedFromSecret(secretSeed));
const previousPublicKeys = (process.env.PASETO_PREVIOUS_PUBLIC_KEYS || '')
  .split(',').map((s) => s.trim()).filter(Boolean).map(unb64url);
const verifyKeys = [keyPair.publicKey, ...previousPublicKeys];

function parseDurationMs(value) {
  if (typeof value === 'number') return value * 1000;
  const m = String(value).trim().match(/^(-?\d+)(ms|s|m|h|d)?$/i);
  if (!m) throw new Error(`Invalid token expiry duration: ${value}`);
  const n = Number(m[1]);
  const unit = (m[2] || 's').toLowerCase();
  return n * ({ ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000 }[unit]);
}

function normalizePayload(payload, expiresIn) {
  const now = new Date();
  return {
    ...payload,
    iss: PASETO_ISSUER,
    aud: PASETO_AUDIENCE,
    iat: now.toISOString(),
    exp: new Date(now.getTime() + parseDurationMs(expiresIn)).toISOString(),
  };
}

export function signToken(payload, options = {}) {
  const body = decodeUTF8(JSON.stringify(normalizePayload(payload, options.expiresIn || PASETO_EXPIRES_IN)));
  const sig = nacl.sign.detached(pae([decodeUTF8(HEADER), body, new Uint8Array()]), keyPair.secretKey);
  return `${HEADER}${b64url(concat(body, sig))}`;
}

export function verifyPaseto(token) {
  if (typeof token !== 'string' || !token.startsWith(HEADER)) throw Object.assign(new Error('Invalid PASETO format'), { name: 'PasetoError' });
  const decoded = unb64url(token.slice(HEADER.length));
  if (decoded.length <= 64) throw Object.assign(new Error('Invalid PASETO payload'), { name: 'PasetoError' });
  const body = decoded.slice(0, decoded.length - 64);
  const sig = decoded.slice(decoded.length - 64);
  const msg = pae([decodeUTF8(HEADER), body, new Uint8Array()]);
  if (!verifyKeys.some((key) => nacl.sign.detached.verify(msg, sig, key))) throw Object.assign(new Error('Invalid token signature'), { name: 'PasetoError' });
  const claims = JSON.parse(encodeUTF8(body));
  if (claims.iss !== PASETO_ISSUER || claims.aud !== PASETO_AUDIENCE) throw Object.assign(new Error('Invalid token claims'), { name: 'PasetoError' });
  if (claims.exp && Date.parse(claims.exp) <= Date.now()) throw Object.assign(new Error('Token has expired'), { name: 'TokenExpiredError' });
  return claims;
}

export function tryVerifyPaseto(token) {
  try { return verifyPaseto(token); } catch { return null; }
}

export function decodeTokenClaims(token) {
  if (typeof token !== 'string' || !token.startsWith(HEADER)) return null;
  const decoded = unb64url(token.slice(HEADER.length));
  if (decoded.length <= 64) return null;
  try {
    return JSON.parse(encodeUTF8(decoded.slice(0, decoded.length - 64)));
  } catch {
    return null;
  }
}

export const PASETO_PUBLIC_KEY = b64url(keyPair.publicKey);
