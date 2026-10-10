// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The signed gateway document (CLAUDE.md §2, "The API host player apps are
 * sent to"): the offline CLI, the verifier and the route that serves it.
 *
 * What this pins:
 *   · a document signed by the CLI verifies, and every byte of it matters
 *     (payload, signature, key);
 *   · the format: exact keys, bb-gateway-config/1, an integer version, ISO
 *     instants in order, 1–8 plain lowercase hostnames, no repeats;
 *   · an expired document and one below the version floor are refused, and
 *     the opposite cases (just before expiry, at the floor) still pass;
 *   · the CLI refuses a private key inside a git checkout and never
 *     overwrites one;
 *   · the server serves only a document that verifies now, as it was signed.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import request from 'supertest';
import {
  GATEWAY_CLOCK_SKEW_MS, GATEWAY_FORMAT, GATEWAY_MAX_HOSTS, GATEWAY_MAX_LIFETIME_DAYS, checkGatewayPayload, rawPublicKey, signGatewayPayload,
  verifyGatewayDocument, servedGatewayDocument,
} from '../../domains/configuration/gatewayConfig.js';
import { main } from '../../../scripts/gateway-config.mjs';

const NOW = Date.parse('2026-10-10T12:00:00.000Z');
const { privateKey } = generateKeyPairSync('ed25519');
const PUBLIC = rawPublicKey(privateKey);
const other = rawPublicKey(generateKeyPairSync('ed25519').privateKey);

const payload = (over = {}) => ({
  format: GATEWAY_FORMAT,
  version: 3,
  issuedAt: '2026-10-10T00:00:00.000Z',
  expiresAt: '2026-11-10T00:00:00.000Z',
  hosts: ['api.example.com', 'edge.example.org'],
  ...over,
});

/** Sign bytes the checker would refuse, to prove the VERIFIER refuses them too. */
function signRaw(obj) {
  const bytes = Buffer.from(JSON.stringify(obj));
  return { payload: bytes.toString('base64url'), signature: sign(null, bytes, privateKey).toString('base64url') };
}

describe('verifyGatewayDocument', () => {
  it('accepts a signed document and returns its payload', () => {
    const doc = signGatewayPayload(payload(), privateKey);
    expect(verifyGatewayDocument(doc, PUBLIC, { now: NOW })).toEqual(payload());
    expect(verifyGatewayDocument(JSON.stringify(doc), PUBLIC, { now: NOW }).version).toBe(3);
  });

  it('refuses another key, a changed payload and a changed signature', () => {
    const doc = signGatewayPayload(payload(), privateKey);
    expect(() => verifyGatewayDocument(doc, other, { now: NOW })).toThrow(expect.objectContaining({ code: 'GATEWAY_BAD_SIGNATURE' }));
    const forged = { ...doc, payload: Buffer.from(JSON.stringify(payload({ hosts: ['evil.example.com'] }))).toString('base64url') };
    expect(() => verifyGatewayDocument(forged, PUBLIC, { now: NOW })).toThrow(expect.objectContaining({ code: 'GATEWAY_BAD_SIGNATURE' }));
    const sig = Buffer.from(doc.signature, 'base64url'); sig[0] ^= 1;
    expect(() => verifyGatewayDocument({ ...doc, signature: sig.toString('base64url') }, PUBLIC, { now: NOW }))
      .toThrow(expect.objectContaining({ code: 'GATEWAY_BAD_SIGNATURE' }));
  });

  it.each([
    ['an extra envelope key', (d) => ({ ...d, keyId: 'x' })],
    ['a missing signature', (d) => ({ payload: d.payload })],
    ['standard base64 padding', (d) => ({ ...d, signature: `${d.signature}=` })],
    ['an array', () => []],
  ])('refuses %s', (_why, mutate) => {
    const doc = mutate(signGatewayPayload(payload(), privateKey));
    expect(() => verifyGatewayDocument(doc, PUBLIC, { now: NOW })).toThrow(expect.objectContaining({ code: 'GATEWAY_BAD_DOCUMENT' }));
  });

  it('refuses a document over the size cap before parsing it', () => {
    expect(() => verifyGatewayDocument(' '.repeat(5000), PUBLIC, { now: NOW })).toThrow(expect.objectContaining({ code: 'GATEWAY_TOO_LARGE' }));
  });

  it('refuses a validly signed payload that breaks the format', () => {
    const doc = signRaw(payload({ hosts: ['API.example.com'] }));
    expect(() => verifyGatewayDocument(doc, PUBLIC, { now: NOW })).toThrow(expect.objectContaining({ code: 'GATEWAY_BAD_HOSTS' }));
  });

  it('refuses an expired document; accepts one a millisecond before expiry', () => {
    const doc = signGatewayPayload(payload(), privateKey);
    const expiry = Date.parse(payload().expiresAt);
    expect(verifyGatewayDocument(doc, PUBLIC, { now: expiry - 1 }).version).toBe(3);
    expect(() => verifyGatewayDocument(doc, PUBLIC, { now: expiry })).toThrow(expect.objectContaining({ code: 'GATEWAY_EXPIRED' }));
  });

  it('refuses a document issued over a day ahead of the clock; accepts one within it', () => {
    const at = (issued) => signGatewayPayload(payload({ issuedAt: new Date(issued).toISOString(), expiresAt: new Date(NOW + 30 * 86_400_000).toISOString() }), privateKey);
    expect(verifyGatewayDocument(at(NOW + GATEWAY_CLOCK_SKEW_MS), PUBLIC, { now: NOW }).version).toBe(3);
    expect(() => verifyGatewayDocument(at(NOW + GATEWAY_CLOCK_SKEW_MS + 1), PUBLIC, { now: NOW })).toThrow(expect.objectContaining({ code: 'GATEWAY_NOT_YET_ISSUED' }));
  });

  it('refuses a version below the floor; accepts one at it', () => {
    const doc = signGatewayPayload(payload(), privateKey);
    expect(verifyGatewayDocument(doc, PUBLIC, { now: NOW, floor: 3 }).version).toBe(3);
    expect(() => verifyGatewayDocument(doc, PUBLIC, { now: NOW, floor: 4 })).toThrow(expect.objectContaining({ code: 'GATEWAY_REPLAYED' }));
  });
});

describe('checkGatewayPayload — the format', () => {
  it.each([
    ['an unknown key', payload({ note: 'x' }), 'GATEWAY_BAD_PAYLOAD'],
    ['another format', payload({ format: 'bb-gateway-config/2' }), 'GATEWAY_BAD_FORMAT'],
    ['version 0', payload({ version: 0 }), 'GATEWAY_BAD_VERSION'],
    ['a fractional version', payload({ version: 1.5 }), 'GATEWAY_BAD_VERSION'],
    ['a string version', payload({ version: '3' }), 'GATEWAY_BAD_VERSION'],
    ['a non-ISO time', payload({ issuedAt: '2026-10-10' }), 'GATEWAY_BAD_TIME'],
    ['expiry before issue', payload({ expiresAt: '2026-10-09T00:00:00.000Z' }), 'GATEWAY_BAD_TIME'],
    ['a lifetime over 400 days', payload({ expiresAt: new Date(Date.parse('2026-10-10T00:00:00.000Z') + GATEWAY_MAX_LIFETIME_DAYS * 86_400_000 + 1).toISOString() }), 'GATEWAY_BAD_TIME'],
    ['a year-9999 expiry', payload({ expiresAt: '9999-12-31T00:00:00.000Z' }), 'GATEWAY_BAD_TIME'],
    ['no hosts', payload({ hosts: [] }), 'GATEWAY_BAD_HOSTS'],
    ['too many hosts', payload({ hosts: Array.from({ length: GATEWAY_MAX_HOSTS + 1 }, (_, i) => `h${i}.example.com`) }), 'GATEWAY_BAD_HOSTS'],
    ['an uppercase host', payload({ hosts: ['Api.example.com'] }), 'GATEWAY_BAD_HOSTS'],
    ['a URL', payload({ hosts: ['https://api.example.com'] }), 'GATEWAY_BAD_HOSTS'],
    ['a port', payload({ hosts: ['api.example.com:8443'] }), 'GATEWAY_BAD_HOSTS'],
    ['a wildcard', payload({ hosts: ['*.example.com'] }), 'GATEWAY_BAD_HOSTS'],
    ['an IPv4 address', payload({ hosts: ['203.0.113.7'] }), 'GATEWAY_BAD_HOSTS'],
    ['a single label', payload({ hosts: ['localhost'] }), 'GATEWAY_BAD_HOSTS'],
    ['a trailing dot', payload({ hosts: ['api.example.com.'] }), 'GATEWAY_BAD_HOSTS'],
    ['a repeated host', payload({ hosts: ['api.example.com', 'api.example.com'] }), 'GATEWAY_BAD_HOSTS'],
  ])('refuses %s', (_why, p, code) => {
    expect(() => checkGatewayPayload(p)).toThrow(expect.objectContaining({ code, status: 400 }));
  });

  it(`accepts exactly ${GATEWAY_MAX_LIFETIME_DAYS} days`, () => {
    const expiresAt = new Date(Date.parse('2026-10-10T00:00:00.000Z') + GATEWAY_MAX_LIFETIME_DAYS * 86_400_000).toISOString();
    expect(checkGatewayPayload(payload({ expiresAt })).expiresAt).toBe(expiresAt);
  });

  it(`accepts exactly ${GATEWAY_MAX_HOSTS} hosts`, () => {
    const hosts = Array.from({ length: GATEWAY_MAX_HOSTS }, (_, i) => `h${i}.example.com`);
    expect(checkGatewayPayload(payload({ hosts })).hosts).toHaveLength(GATEWAY_MAX_HOSTS);
  });
});

describe('scripts/gateway-config.mjs', () => {
  let dir;
  beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'bb-gateway-')); });
  afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

  const run = (argv, now = NOW) => {
    const lines = []; const errors = [];
    const code = main(argv, { out: (l) => lines.push(l), err: (l) => errors.push(l), now });
    return { code, out: lines.join('\n'), err: errors.join('\n') };
  };

  it('keygen → sign → verify round-trips, and the key file is private', () => {
    const key = join(dir, 'gateway.pem');
    const gen = run(['keygen', '--out', key]);
    expect(gen.code).toBe(0);
    const pub = gen.out.match(/public key: (\S+)/)[1];
    expect(statSync(key).mode & 0o777).toBe(0o600);

    const docFile = join(dir, 'doc.json');
    expect(run(['sign', '--key', key, '--version', '7', '--hosts', 'api.example.com,edge.example.org', '--days', '30', '--out', docFile]).code).toBe(0);
    const doc = JSON.parse(readFileSync(docFile, 'utf8'));
    expect(verifyGatewayDocument(doc, pub, { now: NOW })).toMatchObject({
      version: 7, issuedAt: new Date(NOW).toISOString(), hosts: ['api.example.com', 'edge.example.org'],
    });

    expect(run(['verify', '--public-key', pub, docFile]).code).toBe(0);
    expect(run(['verify', '--public-key', pub, '--floor', '8', docFile])).toMatchObject({ code: 1, err: expect.stringMatching(/GATEWAY_REPLAYED/) });
    expect(run(['verify', '--public-key', other, docFile])).toMatchObject({ code: 1, err: expect.stringMatching(/GATEWAY_BAD_SIGNATURE/) });
    expect(run(['verify', '--public-key', pub, docFile], NOW + 31 * 86_400_000)).toMatchObject({ code: 1, err: expect.stringMatching(/GATEWAY_EXPIRED/) });
  });

  it('never overwrites a key', () => {
    const key = join(dir, 'once.pem');
    expect(run(['keygen', '--out', key]).code).toBe(0);
    const before = readFileSync(key, 'utf8');
    expect(run(['keygen', '--out', key])).toMatchObject({ code: 1, err: expect.stringMatching(/never overwritten/) });
    expect(readFileSync(key, 'utf8')).toBe(before);
  });

  it('refuses a private key inside this repository, for keygen and sign', () => {
    const inside = join(process.cwd(), 'gateway-test-key.pem');
    expect(run(['keygen', '--out', inside])).toMatchObject({ code: 1, err: expect.stringMatching(/inside a git checkout/) });
    expect(() => statSync(inside)).toThrow();
    expect(run(['sign', '--key', inside, '--version', '1', '--hosts', 'api.example.com', '--days', '1'])).toMatchObject({ code: 1, err: expect.stringMatching(/inside a git checkout/) });
  });

  it('refuses --days beyond the 400-day lifetime', () => {
    const key = join(dir, 'life.pem');
    run(['keygen', '--out', key]);
    expect(run(['sign', '--key', key, '--version', '1', '--hosts', 'api.example.com', '--days', '401']))
      .toMatchObject({ code: 1, err: expect.stringMatching(/GATEWAY_BAD_TIME/) });
  });

  it('refuses a document the format refuses (an uppercase host) without writing it', () => {
    const key = join(dir, 'fmt.pem');
    run(['keygen', '--out', key]);
    const docFile = join(dir, 'bad.json');
    expect(run(['sign', '--key', key, '--version', '1', '--hosts', 'API.example.com', '--days', '1', '--out', docFile]))
      .toMatchObject({ code: 1, err: expect.stringMatching(/GATEWAY_BAD_HOSTS/) });
    expect(() => statSync(docFile)).toThrow();
  });
});

describe('GET /api/v1/client/gateway-config', () => {
  let dir; let app;
  const env = { file: process.env.GATEWAY_CONFIG_FILE, key: process.env.GATEWAY_CONFIG_PUBLIC_KEY };
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'bb-gateway-route-'));
    app = express().use('/api', (await import('../../routes/clientEndpoint.routes.js')).default);
  });
  afterEach(() => {
    for (const [name, value] of [['GATEWAY_CONFIG_FILE', env.file], ['GATEWAY_CONFIG_PUBLIC_KEY', env.key]]) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  });
  afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

  const serve = (doc, name) => {
    const file = join(dir, name);
    writeFileSync(file, `${JSON.stringify(doc)}\n`);
    process.env.GATEWAY_CONFIG_FILE = file;
    process.env.GATEWAY_CONFIG_PUBLIC_KEY = PUBLIC;
  };
  const farFuture = { issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86_400_000).toISOString() };

  it('serves the signed document as it was signed', async () => {
    const doc = signGatewayPayload(payload(farFuture), privateKey);
    serve(doc, 'ok.json');
    const res = await request(app).get('/api/v1/client/gateway-config');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toMatch(/max-age=\d+/);
    expect(JSON.parse(res.text)).toEqual(doc);
  });

  it('answers 404 with nothing configured', async () => {
    delete process.env.GATEWAY_CONFIG_FILE;
    const res = await request(app).get('/api/v1/client/gateway-config');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NO_GATEWAY_CONFIG');
  });

  it('never serves an expired document or one signed by another key', async () => {
    serve(signGatewayPayload(payload({ issuedAt: '2020-01-01T00:00:00.000Z', expiresAt: '2020-02-01T00:00:00.000Z' }), privateKey), 'expired.json');
    expect((await request(app).get('/api/v1/client/gateway-config')).status).toBe(404);
    serve(signGatewayPayload(payload(farFuture), privateKey), 'other-key.json');
    process.env.GATEWAY_CONFIG_PUBLIC_KEY = other;
    expect(await servedGatewayDocument()).toBeNull();
  });
});
