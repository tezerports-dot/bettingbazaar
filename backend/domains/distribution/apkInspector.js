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
 * ── The signature is VERIFIED, not just read (R7, owner 2026-10-01) ────────
 * Reading the certificate a signing block NAMES says nothing about whether the
 * file was signed with it: anybody can paste our certificate into a block over
 * different contents. So every v2 and v3 signer is verified the way Android's
 * own `apksigner verify` does it:
 *
 *   1. the CONTENT digest is recomputed from the file — the zip entries, the
 *      central directory, and the end-of-central-directory record with its
 *      directory offset pointed at the signing block — in 1 MB chunks, and
 *      must equal the digest the signer signed;
 *   2. the signer's SIGNATURE over its signed data is checked with the
 *      signer's public key, for every algorithm it lists;
 *   3. the first CERTIFICATE's public key must BE that public key, or the
 *      fingerprint reported below would name a key that signed nothing.
 *
 * A tampered, re-zipped or forged APK is therefore refused at UPLOAD, before
 * it can be published, rather than by every phone at install. Proven against
 * real `apksigner` output (RSA and EC, v2 and v3) in the unit suite.
 *
 * No dependency: an APK is a zip, the manifest is Android's binary XML, and the
 * signing block is a documented length-prefixed structure. All three are read
 * with Buffer and zlib from the standard library.
 */
import { inflateRawSync } from 'node:zlib';
import { createHash, createPublicKey, verify as verifySignature, X509Certificate, constants as cryptoConstants } from 'node:crypto';

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
  return { entries, cdOffset, eocd };
}

/**
 * The most a MANIFEST may inflate to. A real binary AndroidManifest.xml is a
 * few kilobytes; this app's is under 4 KB. The bound is what makes a zip bomb
 * on that one entry — kilobytes uploaded, gigabytes inflated inside the API
 * process — a refusal instead of an outage (review P197-2). The upload is
 * admin-only; the process it would take down serves every player.
 */
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;

function readEntry(buf, entry) {
  const at = entry.localOffset;
  if (buf.readUInt32LE(at) !== LOCAL_SIG) throw refuse('This APK is truncated or corrupt.');
  const start = at + 30 + buf.readUInt16LE(at + 26) + buf.readUInt16LE(at + 28);
  const raw = buf.subarray(start, start + entry.compSize);
  if (entry.method === 0) return raw;
  if (entry.method === 8) {
    try {
      return inflateRawSync(raw, { maxOutputLength: MAX_MANIFEST_BYTES });
    } catch (err) {
      if (err.code === 'ERR_BUFFER_TOO_LARGE' || err instanceof RangeError) {
        throw refuse('This APK\'s manifest is larger than any real one. It is not a build this platform produced.');
      }
      throw err;
    }
  }
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
// v3 first: on a phone that understands v3 it is the one Android enforces, and
// its certificate is the key the app is now signed with (after a key rotation
// the v2 block still names the original key).
const SCHEMES = [[0xf05368c0, 3], [0x7109871a, 2]];

/**
 * The signature algorithms APK Signature Scheme v2/v3 defines, with how each
 * signs and how the content digest it signs is computed. The `verity` variants
 * (0x0421…) are deliberately absent: they are always accompanied by one of
 * these, and a signer offering only those is refused rather than trusted.
 */
const ALGORITHMS = Object.freeze({
  0x0101: { digest: 'sha256', kind: 'pss', salt: 32 },
  0x0102: { digest: 'sha512', kind: 'pss', salt: 64 },
  0x0103: { digest: 'sha256', kind: 'pkcs1' },
  0x0104: { digest: 'sha512', kind: 'pkcs1' },
  0x0201: { digest: 'sha256', kind: 'plain' },   // ECDSA
  0x0202: { digest: 'sha512', kind: 'plain' },   // ECDSA
  0x0301: { digest: 'sha256', kind: 'plain' },   // DSA
});

const CHUNK = 1024 * 1024;

/** A u32-length-prefixed slice at `at`. Throws a RangeError past the end. */
function lp(buf, at) {
  const len = buf.readUInt32LE(at);
  if (at + 4 + len > buf.length) throw new RangeError('length prefix past end');
  return { body: buf.subarray(at + 4, at + 4 + len), next: at + 4 + len };
}

/** Every length-prefixed element of a length-prefixed sequence. */
function sequence(buf) {
  const out = [];
  for (let p = 0; p < buf.length;) { const e = lp(buf, p); out.push(e.body); p = e.next; }
  return out;
}

function locateSigningBlock(buf, cdOffset) {
  if (cdOffset < 32 || buf.toString('latin1', cdOffset - 16, cdOffset) !== SIG_MAGIC) {
    throw refuse('This APK has no v2/v3 signature. Build it with the release workflow, which signs with APK Signature Scheme v2.');
  }
  const blockSize = Number(buf.readBigUInt64LE(cdOffset - 24));
  const start = cdOffset - blockSize - 8;
  if (start < 0 || Number(buf.readBigUInt64LE(start)) !== blockSize) {
    throw refuse('This APK\'s signing block is corrupt.');
  }
  const pairs = new Map();
  let p = start + 8;
  while (p < cdOffset - 24) {
    const len = Number(buf.readBigUInt64LE(p));
    if (len < 4 || p + 8 + len > cdOffset - 24) throw refuse('This APK\'s signing block is corrupt.');
    pairs.set(buf.readUInt32LE(p + 8), buf.subarray(p + 12, p + 8 + len));
    p += 8 + len;
  }
  return { start, pairs };
}

/**
 * The digest APK Signature Scheme v2/v3 signs: the three sections outside the
 * signing block, each cut into 1 MB chunks, every chunk hashed with a 0xa5
 * prefix and its length, then the chunk hashes hashed with a 0x5a prefix and
 * their count. The fourth section is the end-of-central-directory record with
 * the directory's offset pointed at the start of the signing block — so the
 * digest does not depend on the block it is stored in.
 */
function contentDigest(buf, { blockStart, cdOffset, eocd }, algorithm) {
  const eocdCopy = Buffer.from(buf.subarray(eocd));
  eocdCopy.writeUInt32LE(blockStart, 16);
  const sections = [buf.subarray(0, blockStart), buf.subarray(cdOffset, eocd), eocdCopy];
  const chunkDigests = [];
  for (const section of sections) {
    for (let at = 0; at < section.length; at += CHUNK) {
      const chunk = section.subarray(at, Math.min(at + CHUNK, section.length));
      const head = Buffer.alloc(5);
      head[0] = 0xa5;
      head.writeUInt32LE(chunk.length, 1);
      chunkDigests.push(createHash(algorithm).update(head).update(chunk).digest());
    }
  }
  const top = Buffer.alloc(5);
  top[0] = 0x5a;
  top.writeUInt32LE(chunkDigests.length, 1);
  return createHash(algorithm).update(top).update(Buffer.concat(chunkDigests)).digest();
}

function signatureVerifies(algorithmId, publicKeyDer, signedData, signature) {
  const algo = ALGORITHMS[algorithmId];
  const key = createPublicKey({ key: publicKeyDer, format: 'der', type: 'spki' });
  const opts = algo.kind === 'pss'
    ? { key, padding: cryptoConstants.RSA_PKCS1_PSS_PADDING, saltLength: algo.salt }
    : algo.kind === 'pkcs1' ? { key, padding: cryptoConstants.RSA_PKCS1_PADDING } : key;
  return verifySignature(algo.digest, signedData, opts, signature);
}

/**
 * Verify every signer of one scheme. Returns the first signer's certificate.
 * Any failure is a refusal naming what failed, never a pass.
 */
function verifyScheme(scheme, value, layout, buf, digestCache) {
  const signers = sequence(lp(value, 0).body);
  if (!signers.length) throw refuse(`This APK's v${scheme} signature has no signer.`);
  let firstCert = null;

  for (const signerBytes of signers) {
    // v2: signedData, signatures, publicKey
    // v3: signedData, minSdk, maxSdk, signatures, publicKey
    const signed = lp(signerBytes, 0);
    let p = signed.next;
    if (scheme === 3) p += 8;
    const sigs = lp(signerBytes, p);
    const publicKey = lp(signerBytes, sigs.next).body;

    const data = signed.body;
    const digestsField = lp(data, 0);
    const certsField = lp(data, digestsField.next);

    const signatures = sequence(sigs.body).map((e) => ({ id: e.readUInt32LE(0), value: lp(e, 4).body }));
    const digests = sequence(digestsField.body).map((e) => ({ id: e.readUInt32LE(0), value: lp(e, 4).body }));
    const supported = signatures.filter((s) => ALGORITHMS[s.id]);
    if (!supported.length) {
      throw refuse(`This APK's v${scheme} signature uses no algorithm this platform can verify.`);
    }
    // Android requires the signed digests to name exactly the signature algorithms.
    const sigIds = signatures.map((s) => s.id).sort();
    const digIds = digests.map((d) => d.id).sort();
    if (sigIds.join() !== digIds.join()) {
      throw refuse(`This APK's v${scheme} signature does not match its own digests.`);
    }

    for (const sig of supported) {
      if (!signatureVerifies(sig.id, publicKey, data, sig.value)) {
        throw refuse(`This APK's v${scheme} signature does not verify. The file was changed after it was signed, or was never signed by the key it names.`);
      }
      const algorithm = ALGORITHMS[sig.id].digest;
      if (!digestCache.has(algorithm)) digestCache.set(algorithm, contentDigest(buf, layout, algorithm));
      const signedDigest = digests.find((d) => d.id === sig.id).value;
      if (!digestCache.get(algorithm).equals(signedDigest)) {
        throw refuse(`This APK's contents do not match its v${scheme} signature. The file was changed after it was signed.`);
      }
    }

    const certs = sequence(certsField.body);
    if (!certs.length) throw refuse(`This APK's v${scheme} signer has no certificate.`);
    let certKey;
    try {
      certKey = new X509Certificate(certs[0]).publicKey.export({ type: 'spki', format: 'der' });
    } catch {
      throw refuse(`This APK's v${scheme} certificate cannot be read.`);
    }
    if (!certKey.equals(publicKey)) {
      throw refuse(`This APK's v${scheme} certificate is not the key that signed it.`);
    }
    if (!firstCert) firstCert = certs[0];
  }
  return firstCert;
}

/**
 * Verify every v2/v3 scheme present and report the signer of the strongest.
 * @returns {{ scheme, schemes, certSha256, debug }}
 */
function readSigner(buf, zip) {
  const { start, pairs } = locateSigningBlock(buf, zip.cdOffset);
  const layout = { blockStart: start, cdOffset: zip.cdOffset, eocd: zip.eocd };
  const digestCache = new Map();
  const verified = [];
  for (const [id, scheme] of SCHEMES) {
    const value = pairs.get(id);
    if (!value) continue;
    verified.push({ scheme, cert: verifyScheme(scheme, value, layout, buf, digestCache) });
  }
  if (!verified.length) {
    throw refuse('This APK has no v2/v3 signature. Build it with the release workflow, which signs with APK Signature Scheme v2.');
  }
  const der = verified[0].cert;
  return {
    scheme: verified[0].scheme,
    schemes: verified.map((v) => v.scheme).sort(),
    certSha256: createHash('sha256').update(der).digest('hex').toUpperCase(),
    // The Android SDK's debug key is issued to "CN=Android Debug".
    debug: new X509Certificate(der).subject.includes('CN=Android Debug'),
  };
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
 *             signatureSchemes, signerSha256, debugSigned, sha256, sizeBytes }}
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
  try { signer = readSigner(buf, zip); } catch (err) {
    if (err.status) throw err;
    throw refuse('This APK\'s signing block is corrupt.');
  }

  return {
    packageName: String(m.package),
    versionCode,
    versionName: m.versionName != null ? String(m.versionName) : String(versionCode),
    minSdk: manifest['uses-sdk']?.minSdkVersion != null ? Number(manifest['uses-sdk'].minSdkVersion) : null,
    signatureScheme: signer.scheme,
    signatureSchemes: signer.schemes,
    signerSha256: signer.certSha256,
    debugSigned: signer.debug,
    sha256: createHash('sha256').update(buf).digest('hex'),
    sizeBytes: buf.length,
  };
}
