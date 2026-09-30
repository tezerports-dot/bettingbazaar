// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * apkInspector.js — read an uploaded APK's identity from the file itself.
 *
 * An admin publishing an Android release is shipping code to every installed
 * copy of the app, and the three mistakes that are easy to make are all
 * invisible until a player's phone refuses the update:
 *
 *   • the wrong APP     — another package id installs as a SECOND app beside
 *                         this one, and the old one keeps nagging for ever
 *   • the wrong KEY     — a debug build, or one signed with a new keystore;
 *                         Android refuses it as an update ("App not installed")
 *   • the wrong VERSION — a versionCode not above what players have; Android
 *                         refuses a downgrade, so the update screen loops
 *
 * So the release route reads package, versionCode, versionName and the signing
 * certificate out of the bytes rather than trusting what the admin typed, and
 * refuses each mistake with a sentence that says which one it was.
 *
 * ── What this does NOT do ──────────────────────────────────────────────────
 * It reports the certificate the signing block NAMES; it does not verify the
 * signature cryptographically. That is deliberate and sufficient: the check is
 * against operator error, and Android itself verifies every signature at
 * install time and refuses an update whose key differs from the installed
 * app's. A forged block naming our certificate would pass here and be refused
 * by the phone — it cannot reach a player as a working install.
 *
 * No dependency: an APK is a zip, the manifest is Android's binary XML, and the
 * signing block is a documented length-prefixed structure. All three are read
 * with Buffer and zlib from the standard library.
 */
import { inflateRawSync } from 'node:zlib';
import { createHash } from 'node:crypto';

/** A refusal is the uploader's to fix, so it carries status 400 (§32 S35). */
function refuse(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

// ── ZIP ───────────────────────────────────────────────────────────────────────
const EOCD_SIG = 0x06054b50;
const CDIR_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

function findEocd(buf) {
  // The comment field is at most 65535 bytes, so the record is within this window.
  const stop = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= stop; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  return -1;
}

function readZip(buf) {
  const eocd = findEocd(buf);
  if (eocd < 0) throw refuse('This file is not an APK (it is not a zip archive).');
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (cdOffset + cdSize > eocd) throw refuse('This APK is truncated or corrupt.');

  const entries = new Map();
  let p = cdOffset;
  while (p < cdOffset + cdSize) {
    if (buf.readUInt32LE(p) !== CDIR_SIG) throw refuse('This APK is truncated or corrupt.');
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    entries.set(name, { method, compSize, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return { entries, cdOffset };
}

function readEntry(buf, entry) {
  const at = entry.localOffset;
  if (buf.readUInt32LE(at) !== LOCAL_SIG) throw refuse('This APK is truncated or corrupt.');
  const start = at + 30 + buf.readUInt16LE(at + 26) + buf.readUInt16LE(at + 28);
  const raw = buf.subarray(start, start + entry.compSize);
  if (entry.method === 0) return raw;
  if (entry.method === 8) return inflateRawSync(raw);
  throw refuse('This APK uses a compression method Android does not.');
}

// ── Android binary XML (AXML) ─────────────────────────────────────────────────
const RES_STRING_POOL = 0x0001;
const RES_XML_RESOURCE_MAP = 0x0180;
const RES_XML_START_ELEMENT = 0x0102;
const UTF8_FLAG = 0x100;

// android.R.attr ids — aapt2 may strip attribute NAMES, never these ids.
const ATTR_ID = { versionCode: 0x0101021b, versionName: 0x0101021c, minSdkVersion: 0x0101020c };

function readStringPool(buf, at) {
  const count = buf.readUInt32LE(at + 8);
  const flags = buf.readUInt32LE(at + 16);
  const stringsStart = at + buf.readUInt32LE(at + 20);
  const offsets = at + buf.readUInt16LE(at + 2);
  const utf8 = (flags & UTF8_FLAG) !== 0;
  const strings = [];
  for (let i = 0; i < count; i++) {
    let p = stringsStart + buf.readUInt32LE(offsets + i * 4);
    if (utf8) {
      // Two lengths (chars, then bytes), each one byte or two with the high bit set.
      p += buf[p] & 0x80 ? 2 : 1;
      let len = buf[p];
      if (len & 0x80) { len = ((len & 0x7f) << 8) | buf[p + 1]; p += 2; } else p += 1;
      strings.push(buf.toString('utf8', p, p + len));
    } else {
      let len = buf.readUInt16LE(p);
      if (len & 0x8000) { len = ((len & 0x7fff) << 16) | buf.readUInt16LE(p + 2); p += 4; } else p += 2;
      strings.push(buf.toString('utf16le', p, p + len * 2));
    }
  }
  return strings;
}

/** The attributes of the first `<manifest>` and `<uses-sdk>` elements. */
function readManifest(axml) {
  if (axml.readUInt16LE(0) !== 0x0003) throw refuse('This APK has no readable AndroidManifest.xml.');
  let strings = [];
  let resIds = [];
  const found = {};
  let p = axml.readUInt16LE(2);
  while (p + 8 <= axml.length) {
    const type = axml.readUInt16LE(p);
    const headerSize = axml.readUInt16LE(p + 2);
    const size = axml.readUInt32LE(p + 4);
    if (size < 8) break;
    if (type === RES_STRING_POOL) strings = readStringPool(axml, p);
    else if (type === RES_XML_RESOURCE_MAP) {
      resIds = [];
      for (let q = p + headerSize; q < p + size; q += 4) resIds.push(axml.readUInt32LE(q));
    } else if (type === RES_XML_START_ELEMENT) {
      const ext = p + headerSize;
      const tag = strings[axml.readUInt32LE(ext + 4)];
      const attrStart = axml.readUInt16LE(ext + 8);
      const attrSize = axml.readUInt16LE(ext + 10);
      const attrCount = axml.readUInt16LE(ext + 12);
      if (tag === 'manifest' || tag === 'uses-sdk') {
        const attrs = {};
        for (let i = 0; i < attrCount; i++) {
          const a = ext + attrStart + i * attrSize;
          const nameIdx = axml.readUInt32LE(a + 4);
          const rawIdx = axml.readUInt32LE(a + 8);
          const dataType = axml[a + 15];
          const data = axml.readUInt32LE(a + 16);
          const byId = Object.entries(ATTR_ID).find(([, id]) => resIds[nameIdx] === id)?.[0];
          const name = byId || strings[nameIdx];
          // 0x03 string; 0x10/0x11 integer (decimal/hex).
          const value = dataType === 0x03 ? strings[data]
            : (dataType === 0x10 || dataType === 0x11) ? data
            : (rawIdx !== 0xffffffff ? strings[rawIdx] : data);
          attrs[name] = value;
        }
        found[tag] = attrs;
        if (found.manifest && found['uses-sdk']) break;
      }
    }
    p += size;
  }
  if (!found.manifest) throw refuse('This APK has no readable AndroidManifest.xml.');
  return found;
}

// ── APK Signing Block (v2 / v3) ────────────────────────────────────────────────
const SIG_MAGIC = 'APK Sig Block 42';
const SCHEMES = [[0xf05368c0, 3], [0x7109871a, 2]];

/** A u32-length-prefixed slice at `at`. */
function lp(buf, at) {
  const len = buf.readUInt32LE(at);
  return { body: buf.subarray(at + 4, at + 4 + len), next: at + 4 + len };
}

function readSigner(buf, cdOffset) {
  if (cdOffset < 32 || buf.toString('latin1', cdOffset - 16, cdOffset) !== SIG_MAGIC) {
    throw refuse('This APK has no v2/v3 signature. Build it with the release workflow, which signs with APK Signature Scheme v2.');
  }
  const blockSize = Number(buf.readBigUInt64LE(cdOffset - 24));
  const start = cdOffset - blockSize - 8;
  const pairs = new Map();
  let p = start + 8;
  while (p < cdOffset - 24) {
    const len = Number(buf.readBigUInt64LE(p));
    pairs.set(buf.readUInt32LE(p + 8), buf.subarray(p + 12, p + 8 + len));
    p += 8 + len;
  }
  for (const [id, scheme] of SCHEMES) {
    const value = pairs.get(id);
    if (!value) continue;
    // signers → first signer → signed data → (digests, certificates) → first cert
    const signers = lp(value, 0).body;
    const signer = lp(signers, 0).body;
    const signedData = lp(signer, 0).body;
    const digests = lp(signedData, 0);
    const certs = lp(signedData, digests.next).body;
    const der = lp(certs, 0).body;
    if (!der.length) break;
    return {
      scheme,
      certSha256: createHash('sha256').update(der).digest('hex').toUpperCase(),
      // The Android SDK's debug key is issued to "CN=Android Debug" — the
      // subject is plain text inside the DER, so no X.509 parser is needed.
      debug: der.includes(Buffer.from('Android Debug', 'latin1')),
    };
  }
  throw refuse('This APK has no v2/v3 signature. Build it with the release workflow, which signs with APK Signature Scheme v2.');
}

/** `AB:CD:…` or `abcd…` → `ABCD…`, so fingerprints compare however they were pasted. */
export function normaliseFingerprint(fp) {
  return String(fp || '').replace(/[^0-9a-f]/gi, '').toUpperCase();
}

/**
 * Everything the release route needs to know about an APK.
 *
 * @param {Buffer} buf the whole file
 * @returns {{ packageName, versionCode, versionName, minSdk, signatureScheme,
 *             signerSha256, debugSigned, sha256, sizeBytes }}
 * @throws  an Error with status 400 naming what is wrong with the file
 */
export function inspectApk(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 100) throw refuse('No APK file was received.');
  let zip;
  let manifest;
  try {
    zip = readZip(buf);
    const entry = zip.entries.get('AndroidManifest.xml');
    if (!entry) throw refuse('This file is not an APK (it has no AndroidManifest.xml).');
    manifest = readManifest(readEntry(buf, entry));
  } catch (err) {
    if (err.status) throw err;
    throw refuse('This APK is truncated or corrupt.');   // a RangeError off a malformed file
  }

  const m = manifest.manifest;
  const versionCode = Number(m.versionCode);
  if (!m.package || !Number.isInteger(versionCode) || versionCode < 1) {
    throw refuse('This APK does not declare a package name and version code.');
  }

  let signer;
  try { signer = readSigner(buf, zip.cdOffset); } catch (err) {
    if (err.status) throw err;
    throw refuse('This APK\'s signing block is corrupt.');
  }

  return {
    packageName: String(m.package),
    versionCode,
    versionName: m.versionName != null ? String(m.versionName) : String(versionCode),
    minSdk: manifest['uses-sdk']?.minSdkVersion != null ? Number(manifest['uses-sdk'].minSdkVersion) : null,
    signatureScheme: signer.scheme,
    signerSha256: signer.certSha256,
    debugSigned: signer.debug,
    sha256: createHash('sha256').update(buf).digest('hex'),
    sizeBytes: buf.length,
  };
}
