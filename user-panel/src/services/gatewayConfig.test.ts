// GOVERNANCE: Read CLAUDE.md before editing this file.
/**
 * The signed gateway document, verified in the app (CLAUDE.md §2).
 *
 * What these pin: only a document signed by the build's key is accepted; the
 * format matches the backend's (`backend/domains/configuration/gatewayConfig.js`);
 * an expired, over-long-lived or future-issued document is refused; the
 * version floor refuses a replay, is held per key (a leaked key's huge version
 * cannot block its replacement), and the opposite cases still pass.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { generateKeyPairSync, sign, createPublicKey, type KeyObject } from 'node:crypto';
import {
  GATEWAY_FORMAT, GATEWAY_MAX_HOSTS, acceptGatewayDocument, checkGatewayPayload, loadStoredGateway,
  parsePublicKey, resetGatewayState, signedHosts, verifyGatewayDocument, versionFloor,
} from './gatewayConfig';

const NOW = Date.parse('2026-10-10T12:00:00.000Z');
const DAY = 86_400_000;

function keypair() {
  const { privateKey } = generateKeyPairSync('ed25519');
  const raw = createPublicKey(privateKey).export({ format: 'jwk' }).x as string;
  return { privateKey, raw, bytes: parsePublicKey(raw)! };
}
const A = keypair();
const B = keypair();

const payload = (over: Record<string, unknown> = {}) => ({
  format: GATEWAY_FORMAT,
  version: 3,
  issuedAt: '2026-10-10T00:00:00.000Z',
  expiresAt: '2026-11-10T00:00:00.000Z',
  hosts: ['api.example.com', 'edge.example.org'],
  ...over,
});

/** Signs whatever it is given, so the verifier (not the signer) is what refuses. */
function signed(p: object, key: KeyObject = A.privateKey): string {
  const bytes = Buffer.from(JSON.stringify(p));
  return JSON.stringify({ payload: bytes.toString('base64url'), signature: sign(null, bytes, key).toString('base64url') });
}

const code = (p: Promise<unknown>) => p.then(() => 'accepted', (e: Error) => e.message);

beforeEach(() => { localStorage.clear(); resetGatewayState(); });

describe('parsePublicKey', () => {
  it('takes a base64url 32-byte key and nothing else', () => {
    expect(parsePublicKey(A.raw)).toHaveLength(32);
    expect(parsePublicKey('')).toBeNull();
    expect(parsePublicKey(`${A.raw}=`)).toBeNull();
    expect(parsePublicKey(A.raw.slice(0, -2))).toBeNull();
  });
});

describe('verifyGatewayDocument', () => {
  it('accepts a document signed by the build key', async () => {
    expect(await verifyGatewayDocument(signed(payload()), A.bytes, { now: NOW })).toEqual(payload());
  });

  it('refuses another key, a changed payload and a changed signature', async () => {
    expect(await code(verifyGatewayDocument(signed(payload()), B.bytes, { now: NOW }))).toBe('GATEWAY_BAD_SIGNATURE');
    const doc = JSON.parse(signed(payload()));
    const forged = { ...doc, payload: Buffer.from(JSON.stringify(payload({ hosts: ['evil.example.com'] }))).toString('base64url') };
    expect(await code(verifyGatewayDocument(JSON.stringify(forged), A.bytes, { now: NOW }))).toBe('GATEWAY_BAD_SIGNATURE');
    const sig = Buffer.from(doc.signature, 'base64url'); sig[5] ^= 1;
    expect(await code(verifyGatewayDocument(JSON.stringify({ ...doc, signature: sig.toString('base64url') }), A.bytes, { now: NOW })))
      .toBe('GATEWAY_BAD_SIGNATURE');
  });

  it.each([
    ['not JSON', 'nope'],
    ['an extra key', JSON.stringify({ ...JSON.parse(signed(payload())), keyId: 'x' })],
    ['an array', '[]'],
  ])('refuses %s', async (_why, text) => {
    expect(await code(verifyGatewayDocument(text, A.bytes, { now: NOW }))).toBe('GATEWAY_BAD_DOCUMENT');
  });

  it('refuses an oversized document', async () => {
    expect(await code(verifyGatewayDocument(' '.repeat(5000), A.bytes, { now: NOW }))).toBe('GATEWAY_TOO_LARGE');
  });

  it('refuses an expired document; accepts one a millisecond before expiry', async () => {
    const exp = Date.parse(payload().expiresAt);
    expect(await code(verifyGatewayDocument(signed(payload()), A.bytes, { now: exp - 1 }))).toBe('accepted');
    expect(await code(verifyGatewayDocument(signed(payload()), A.bytes, { now: exp }))).toBe('GATEWAY_EXPIRED');
  });

  it('refuses a document issued over a day ahead of this clock; accepts one within it', async () => {
    const soon = payload({ issuedAt: new Date(NOW + DAY).toISOString(), expiresAt: new Date(NOW + 30 * DAY).toISOString() });
    expect(await code(verifyGatewayDocument(signed(soon), A.bytes, { now: NOW }))).toBe('accepted');
    const later = payload({ issuedAt: new Date(NOW + DAY + 1).toISOString(), expiresAt: new Date(NOW + 30 * DAY).toISOString() });
    expect(await code(verifyGatewayDocument(signed(later), A.bytes, { now: NOW }))).toBe('GATEWAY_NOT_YET_ISSUED');
  });

  it('refuses a validly signed payload that breaks the format (uppercase host)', async () => {
    expect(await code(verifyGatewayDocument(signed(payload({ hosts: ['API.example.com'] })), A.bytes, { now: NOW }))).toBe('GATEWAY_BAD_HOSTS');
  });
});

describe('checkGatewayPayload — the same rules as the backend', () => {
  const issued = '2026-10-10T00:00:00.000Z';
  it.each([
    ['an unknown key', payload({ note: 1 }), 'GATEWAY_BAD_PAYLOAD'],
    ['another format', payload({ format: 'bb-gateway-config/2' }), 'GATEWAY_BAD_FORMAT'],
    ['version 0', payload({ version: 0 }), 'GATEWAY_BAD_VERSION'],
    ['a string version', payload({ version: '3' }), 'GATEWAY_BAD_VERSION'],
    ['a date without time', payload({ issuedAt: '2026-10-10' }), 'GATEWAY_BAD_TIME'],
    ['expiry before issue', payload({ expiresAt: '2026-10-09T00:00:00.000Z' }), 'GATEWAY_BAD_TIME'],
    ['a lifetime over 400 days', payload({ issuedAt: issued, expiresAt: new Date(Date.parse(issued) + 400 * DAY + 1).toISOString() }), 'GATEWAY_BAD_TIME'],
    ['a year-9999 expiry', payload({ expiresAt: '9999-12-31T00:00:00.000Z' }), 'GATEWAY_BAD_TIME'],
    ['no hosts', payload({ hosts: [] }), 'GATEWAY_BAD_HOSTS'],
    ['nine hosts', payload({ hosts: Array.from({ length: GATEWAY_MAX_HOSTS + 1 }, (_, i) => `h${i}.example.com`) }), 'GATEWAY_BAD_HOSTS'],
    ['an uppercase host', payload({ hosts: ['Api.example.com'] }), 'GATEWAY_BAD_HOSTS'],
    ['a URL', payload({ hosts: ['https://api.example.com'] }), 'GATEWAY_BAD_HOSTS'],
    ['a port', payload({ hosts: ['api.example.com:443'] }), 'GATEWAY_BAD_HOSTS'],
    ['a wildcard', payload({ hosts: ['*.example.com'] }), 'GATEWAY_BAD_HOSTS'],
    ['an IPv4 address', payload({ hosts: ['203.0.113.7'] }), 'GATEWAY_BAD_HOSTS'],
    ['a single label', payload({ hosts: ['localhost'] }), 'GATEWAY_BAD_HOSTS'],
    ['a repeated host', payload({ hosts: ['api.example.com', 'api.example.com'] }), 'GATEWAY_BAD_HOSTS'],
    ['a non-string host', payload({ hosts: [42] }), 'GATEWAY_BAD_HOSTS'],
  ])('refuses %s', (_why, p, want) => {
    expect(() => checkGatewayPayload(p)).toThrow(want);
  });

  it('accepts exactly 8 hosts and exactly 400 days', () => {
    const hosts = Array.from({ length: GATEWAY_MAX_HOSTS }, (_, i) => `h${i}.example.com`);
    const expiresAt = new Date(Date.parse(issued) + 400 * DAY).toISOString();
    expect(checkGatewayPayload(payload({ hosts, issuedAt: issued, expiresAt })).hosts).toHaveLength(8);
  });
});

describe('acceptGatewayDocument — the version floor', () => {
  it('stores what it accepts and raises the floor', async () => {
    await acceptGatewayDocument(signed(payload({ version: 5 })), A.bytes, NOW);
    expect(versionFloor(A.bytes)).toBe(5);
    expect(signedHosts(NOW)).toEqual(['api.example.com', 'edge.example.org']);
  });

  it('refuses a lower version after a higher one (replay)', async () => {
    await acceptGatewayDocument(signed(payload({ version: 5 })), A.bytes, NOW);
    expect(await code(acceptGatewayDocument(signed(payload({ version: 4, hosts: ['old.example.com'] })), A.bytes, NOW))).toBe('GATEWAY_REPLAYED');
    expect(signedHosts(NOW)).toEqual(['api.example.com', 'edge.example.org']);
  });

  it('takes the same document again, but not other bytes under the same version', async () => {
    const doc = signed(payload({ version: 5 }));
    await acceptGatewayDocument(doc, A.bytes, NOW);
    expect(await code(acceptGatewayDocument(doc, A.bytes, NOW))).toBe('accepted');
    expect(await code(acceptGatewayDocument(signed(payload({ version: 5, hosts: ['other.example.com'] })), A.bytes, NOW))).toBe('GATEWAY_REPLAYED');
  });

  it('holds the floor across a restart (storage), and re-verifies the stored copy', async () => {
    await acceptGatewayDocument(signed(payload({ version: 6 })), A.bytes, NOW);
    resetGatewayState();
    expect(signedHosts(NOW)).toEqual([]);
    expect(await loadStoredGateway(A.bytes, NOW)).toEqual(['api.example.com', 'edge.example.org']);
    expect(await code(acceptGatewayDocument(signed(payload({ version: 5 })), A.bytes, NOW))).toBe('GATEWAY_REPLAYED');
  });

  it('a stored document that has expired gives no hosts', async () => {
    await acceptGatewayDocument(signed(payload()), A.bytes, NOW);
    resetGatewayState();
    expect(await loadStoredGateway(A.bytes, Date.parse(payload().expiresAt))).toEqual([]);
    expect(signedHosts(Date.parse(payload().expiresAt))).toEqual([]);
  });

  it('the floor is per key: a leaked key at the largest version does not block the next key', async () => {
    await acceptGatewayDocument(signed(payload({ version: Number.MAX_SAFE_INTEGER })), A.bytes, NOW);
    expect(versionFloor(B.bytes)).toBe(0);
    expect(await code(acceptGatewayDocument(signed(payload({ version: 1 }), B.privateKey), B.bytes, NOW))).toBe('accepted');
  });

  it('works with storage that throws (private mode): the floor holds for the run', async () => {
    const real = Object.getOwnPropertyDescriptor(window, 'localStorage')!;
    Object.defineProperty(window, 'localStorage', { configurable: true, get() { throw new Error('denied'); } });
    try {
      await acceptGatewayDocument(signed(payload({ version: 5 })), A.bytes, NOW);
      expect(await code(acceptGatewayDocument(signed(payload({ version: 4 })), A.bytes, NOW))).toBe('GATEWAY_REPLAYED');
    } finally {
      Object.defineProperty(window, 'localStorage', real);
    }
  });
});
