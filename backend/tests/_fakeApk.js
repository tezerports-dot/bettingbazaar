// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Build a structurally real APK in memory, for the release tests.
 *
 * Real enough for apkInspector.js to read it the way it reads a build from the
 * Android toolchain: a zip whose AndroidManifest.xml is Android binary XML (a
 * UTF-16 string pool, the android.R.attr resource map, <manifest> and
 * <uses-sdk> start elements) and an APK Signing Block with a v2 signer carrying
 * one certificate. It is not installable — nothing is signed — which is fine:
 * the inspector does not verify signatures, the phone does (see the note at the
 * top of apkInspector.js).
 *
 * The committed fixture `fixtures/AndroidManifest.release.bin` is the other
 * half: the bytes aapt2 actually produced for this app (UTF-8 pool), so the
 * parser is proven against both encodings Android emits.
 */
import { crc32 } from 'node:zlib';

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

/** A v2 APK Signing Block naming one certificate (any bytes — only its hash is read). */
function signingBlock(certDer) {
  const signedData = Buffer.concat([lp(Buffer.alloc(0)), lp(lp(certDer)), lp(Buffer.alloc(0))]);
  const signer = Buffer.concat([lp(signedData), lp(Buffer.alloc(0)), lp(Buffer.alloc(0))]);
  const value = lp(lp(signer));
  const pair = Buffer.concat([u64(4 + value.length), u32(0x7109871a), value]);
  const size = pair.length + 8 + 16;
  return Buffer.concat([u64(size), pair, u64(size), Buffer.from('APK Sig Block 42', 'latin1')]);
}

/**
 * @param opts.cert      the "certificate" bytes; its SHA-256 is the signer fingerprint
 * @param opts.manifest  raw AndroidManifest.xml bytes (overrides the built one)
 * @param opts.signed    false to omit the signing block (a v1-only / unsigned APK)
 */
export function buildApk({
  packageName = 'com.bettingbazaar.app', versionCode = 1, versionName = '1.0.0', minSdk = 24,
  cert = Buffer.from('CN=Test Release Key, O=Test, C=IN'), manifest = null, signed = true,
  padding = 0,
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
    const local = Buffer.concat([
      u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0), u32(crc),
      u32(data.length), u32(data.length), u16(n.length), u16(0), n, data,
    ]);
    central.push(Buffer.concat([
      u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0), u32(crc),
      u32(data.length), u32(data.length), u16(n.length), u16(0), u16(0), u16(0), u16(0), u32(0),
      u32(offset), n,
    ]));
    locals.push(local);
    offset += local.length;
  }
  const block = signed ? signingBlock(cert) : Buffer.alloc(0);
  const cd = Buffer.concat(central);
  const cdOffset = offset + block.length;
  const eocd = Buffer.concat([
    u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length),
    u32(cd.length), u32(cdOffset), u16(0),
  ]);
  return Buffer.concat([...locals, block, cd, eocd]);
}
