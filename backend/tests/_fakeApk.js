// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Build a structurally real APK in memory, for the release tests.
 *
 * Real enough for apkInspector.js to read it the way it reads a build from the
 * Android toolchain: a zip whose AndroidManifest.xml is Android binary XML (a
 * UTF-16 string pool, the android.R.attr resource map, <manifest> and
 * <uses-sdk> start elements) and an APK Signing Block with a v2 signer carrying
 * one certificate. The signature is REAL (R7): each subject gets an EC P-256
 * key and a genuine self-signed X.509 certificate, and the v2 signer signs the
 * real content digest, because the inspector now verifies it the way
 * `apksigner verify` does. The committed `fixtures/signed-*.apk` are the other
 * proof: signed by Google's own apksigner, so the verifier is checked against
 * output it did not write.
 *
 * The committed fixture `fixtures/AndroidManifest.release.bin` is the other
 * half: the bytes aapt2 actually produced for this app (UTF-8 pool), so the
 * parser is proven against both encodings Android emits.
 */
import { crc32, deflateRawSync } from 'node:zlib';
import { createHash, generateKeyPairSync, sign as signBytes } from 'node:crypto';

const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const lp = (buf) => Buffer.concat([u32(buf.length), buf]);
const NONE = 0xffffffff;

function stringPool(strings) {
  const encoded = strings.map((s) => Buffer.concat([u16(s.length), Buffer.from(s, 'utf16le'), u16(0)]));
  const offsets = [];
  let at = 0;
  for (const e of encoded) { offsets.push(at); at += e.length; }
  let body = Buffer.concat(encoded);
  if (body.length % 4) body = Buffer.concat([body, Buffer.alloc(4 - (body.length % 4))]);
  const headerSize = 28;
  const stringsStart = headerSize + 4 * strings.length;
  const size = stringsStart + body.length;
  return Buffer.concat([
    u16(0x0001), u16(headerSize), u32(size), u32(strings.length), u32(0), u32(0),
    u32(stringsStart), u32(0), ...offsets.map(u32), body,
  ]);
}

function startElement(nameIdx, attrs) {
  const attrBytes = attrs.map(({ ns, name, raw, type, data }) =>
    Buffer.concat([u32(ns), u32(name), u32(raw), u16(8), Buffer.from([0, type]), u32(data)]));
  const ext = Buffer.concat([u32(NONE), u32(nameIdx), u16(20), u16(20), u16(attrs.length), u16(0), u16(0), u16(0)]);
  const size = 16 + ext.length + 20 * attrs.length;
  return Buffer.concat([u16(0x0102), u16(16), u32(size), u32(1), u32(NONE), ext, ...attrBytes]);
}

/** Android binary XML for <manifest package versionCode versionName><uses-sdk minSdkVersion/>. */
export function buildManifest({ packageName, versionCode, versionName, minSdk = 24 }) {
  const S = ['versionCode', 'versionName', 'minSdkVersion', 'package', 'manifest', 'uses-sdk',
    packageName, versionName, 'http://schemas.android.com/apk/res/android'];
  const [VC, VN, MIN, PKG, MANIFEST, USES_SDK, PKG_V, VN_V, NS] = S.map((_, i) => i);
  const pool = stringPool(S);
  const resMap = Buffer.concat([u16(0x0180), u16(8), u32(8 + 12), u32(0x0101021b), u32(0x0101021c), u32(0x0101020c)]);
  const manifest = startElement(MANIFEST, [
    { ns: NS, name: VC, raw: NONE, type: 0x10, data: versionCode },
    { ns: NS, name: VN, raw: VN_V, type: 0x03, data: VN_V },
    { ns: NONE, name: PKG, raw: PKG_V, type: 0x03, data: PKG_V },
  ]);
  const usesSdk = startElement(USES_SDK, [{ ns: NS, name: MIN, raw: NONE, type: 0x10, data: minSdk }]);
  const body = Buffer.concat([pool, resMap, manifest, usesSdk]);
  return Buffer.concat([u16(0x0003), u16(8), u32(8 + body.length), body]);
}

// ── A real certificate and a real signature ──────────────────────────────────
const der = (tag, ...parts) => {
  const body = Buffer.concat(parts);
  const len = body.length < 0x80 ? Buffer.from([body.length])
    : body.length < 0x100 ? Buffer.from([0x81, body.length])
      : Buffer.from([0x82, body.length >> 8, body.length & 0xff]);
  return Buffer.concat([Buffer.from([tag]), len, body]);
};
const seq = (...p) => der(0x30, ...p);
const OIDS = { CN: [0x55, 0x04, 0x03], O: [0x55, 0x04, 0x0a], C: [0x55, 0x04, 0x06] };
const ECDSA_SHA256 = seq(der(0x06, Buffer.from([0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02])));

/** "CN=x, O=y, C=z" as an X.501 Name. */
function x501(subject) {
  return seq(...subject.split(',').map((part) => {
    const [k, ...v] = part.trim().split('=');
    const value = Buffer.from(v.join('='), 'utf8');
    return der(0x31, seq(der(0x06, Buffer.from(OIDS[k])), der(k === 'C' ? 0x13 : 0x0c, value)));
  }));
}

const keys = new Map();
/** One EC key and one self-signed certificate per subject, for the whole run. */
export function signerFor(subject) {
  if (!keys.has(subject)) {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const spki = publicKey.export({ type: 'spki', format: 'der' });
    const name = x501(subject);
    const tbs = seq(
      der(0xa0, der(0x02, Buffer.from([2]))),
      der(0x02, Buffer.from([1])),
      ECDSA_SHA256, name,
      seq(der(0x17, Buffer.from('250101000000Z')), der(0x17, Buffer.from('491231000000Z'))),
      name, spki,
    );
    const certDer = seq(tbs, ECDSA_SHA256, der(0x03, Buffer.from([0]), signBytes('sha256', tbs, privateKey)));
    keys.set(subject, { privateKey, spki, certDer });
  }
  return keys.get(subject);
}
/** The certificate the builder signs with for `subject` — what the inspector fingerprints. */
export const certificateFor = (subject) => signerFor(subject).certDer;

/** The v2 content digest (chunked SHA-256), over the APK as it will be laid out. */
function contentDigest(entries, cd, eocdWithBlockOffset) {
  const chunks = [];
  for (const section of [entries, cd, eocdWithBlockOffset]) {
    for (let at = 0; at < section.length; at += 1024 * 1024) {
      const c = section.subarray(at, Math.min(at + 1024 * 1024, section.length));
      chunks.push(createHash('sha256').update(Buffer.concat([Buffer.from([0xa5]), u32(c.length), c])).digest());
    }
  }
  return createHash('sha256').update(Buffer.concat([Buffer.from([0x5a]), u32(chunks.length), ...chunks])).digest();
}

/** A v2 APK Signing Block, really signed by `subject`'s key (ECDSA SHA-256, 0x0201). */
function signingBlock(subject, digest, embedCertOf = subject) {
  const { privateKey, spki } = signerFor(subject);
  const certDer = signerFor(embedCertOf).certDer;
  const digests = lp(Buffer.concat([u32(0x0201), lp(digest)]));
  const signedData = Buffer.concat([lp(digests), lp(lp(certDer)), lp(Buffer.alloc(0))]);
  const signature = lp(Buffer.concat([u32(0x0201), lp(signBytes('sha256', signedData, privateKey))]));
  const signer = Buffer.concat([lp(signedData), lp(signature), lp(spki)]);
  const value = lp(lp(signer));
  const pair = Buffer.concat([u64(4 + value.length), u32(0x7109871a), value]);
  const size = pair.length + 8 + 16;
  return Buffer.concat([u64(size), pair, u64(size), Buffer.from('APK Sig Block 42', 'latin1')]);
}

/**
 * @param opts.signer    the certificate SUBJECT; `certificateFor(subject)` is the
 *                       certificate whose SHA-256 the inspector reports
 * @param opts.manifest  raw AndroidManifest.xml bytes (overrides the built one)
 * @param opts.signed    false to omit the signing block (a v1-only / unsigned APK)
 */
export function buildApk({
  packageName = 'com.bettingbazaar.app', versionCode = 1, versionName = '1.0.0', minSdk = 24,
  signer = 'CN=Test Release Key, O=Test, C=IN', manifest = null, signed = true,
  padding = 0,
  // Embed THIS subject's certificate while signing with `signer`'s key: a
  // validly signed block whose certificate names a key that signed nothing.
  embedCertOf = signer,
  // Store the manifest DEFLATED (method 8), as real build tools usually do.
  deflateManifest = false,
} = {}) {
  const files = [
    ['AndroidManifest.xml', manifest || buildManifest({ packageName, versionCode, versionName, minSdk })],
    ['classes.dex', Buffer.alloc(64 + padding, 7)],
  ];
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, data] of files) {
    const n = Buffer.from(name);
    const crc = crc32(data);
    const deflate = deflateManifest && name === 'AndroidManifest.xml';
    const stored = deflate ? deflateRawSync(data) : data;
    const method = deflate ? 8 : 0;
    const local = Buffer.concat([
      u32(0x04034b50), u16(20), u16(0), u16(method), u16(0), u16(0), u32(crc),
      u32(stored.length), u32(data.length), u16(n.length), u16(0), n, stored,
    ]);
    central.push(Buffer.concat([
      u32(0x02014b50), u16(20), u16(20), u16(0), u16(method), u16(0), u16(0), u32(crc),
      u32(stored.length), u32(data.length), u16(n.length), u16(0), u16(0), u16(0), u16(0), u32(0),
      u32(offset), n,
    ]));
    locals.push(local);
    offset += local.length;
  }
  const entries = Buffer.concat(locals);
  const cd = Buffer.concat(central);
  const eocdAt = (cdOffset) => Buffer.concat([
    u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length),
    u32(cd.length), u32(cdOffset), u16(0),
  ]);
  // The digest covers the EOCD with its offset pointed at the block's start,
  // so it is computed before the block exists — exactly as apksigner does.
  const block = signed ? signingBlock(signer, contentDigest(entries, cd, eocdAt(offset)), embedCertOf) : Buffer.alloc(0);
  return Buffer.concat([entries, block, cd, eocdAt(offset + block.length)]);
}
