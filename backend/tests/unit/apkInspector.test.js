// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The APK inspector reads identity out of the file, never out of a form.
 *
 * Two encodings are proven: the synthetic builder writes a UTF-16 string pool,
 * and `fixtures/AndroidManifest.release.bin` is what aapt2 produced for this
 * very app (UTF-8 pool, attribute names resolved through the resource map).
 * The signer hash of a real release APK was checked against `apksigner verify
 * --print-certs` when this was written; the builder's hash is checked here
 * against a SHA-256 computed independently of the parser.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { inspectApk, normaliseFingerprint } from '../../domains/distribution/apkInspector.js';
import { buildApk } from '../_fakeApk.js';

const fixture = readFileSync(fileURLToPath(new URL('../fixtures/AndroidManifest.release.bin', import.meta.url)));
const sha = (b) => createHash('sha256').update(b).digest('hex');
/** Every occurrence of an entry name in the zip rewritten — the file stays a valid zip. */
const renamed = (buf, from, to) => Buffer.from(buf.toString('latin1').split(from).join(to), 'latin1');

describe('inspectApk', () => {
  it('reads package, version, minSdk and signer from a built APK', () => {
    const cert = Buffer.from('CN=Unit Release, O=BB, C=IN');
    const apk = buildApk({ versionCode: 314, versionName: '3.1.4', minSdk: 26, cert });
    const info = inspectApk(apk);
    expect(info).toMatchObject({
      packageName: 'com.bettingbazaar.app', versionCode: 314, versionName: '3.1.4', minSdk: 26,
      signatureScheme: 2, debugSigned: false, sizeBytes: apk.length,
    });
    expect(info.signerSha256).toBe(sha(cert).toUpperCase());
    expect(info.sha256).toBe(sha(apk));
  });

  it('reads the manifest aapt2 actually produced for this app', () => {
    const info = inspectApk(buildApk({ manifest: fixture }));
    expect(info.packageName).toBe('com.bettingbazaar.app');
    expect(info.versionCode).toBe(7);
    expect(info.versionName).toBe('0.9.0-test');
    expect(info.minSdk).toBe(24);
  });

  it('flags a build signed with the Android debug key', () => {
    const info = inspectApk(buildApk({ cert: Buffer.from('CN=Android Debug, O=Android, C=US') }));
    expect(info.debugSigned).toBe(true);
  });

  it.each([
    ['not a zip', Buffer.alloc(400, 9), /not a zip/],
    ['a zip with no manifest', renamed(buildApk(), 'AndroidManifest.xml', 'AndroidManifesX.xml'), /no AndroidManifest\.xml/],
    ['no v2/v3 signing block', buildApk({ signed: false }), /no v2\/v3 signature/],
    ['an empty upload', Buffer.alloc(0), /No APK file/],
  ])('refuses %s with a 400 the uploader can act on', (_label, bytes, message) => {
    let caught;
    try { inspectApk(bytes); } catch (e) { caught = e; }
    expect(caught?.status).toBe(400);
    expect(caught?.message).toMatch(message);
  });

  it('never lets a malformed file escape as a 500', () => {
    // Truncate a valid APK at every 37th byte: each must be refused, not thrown raw.
    const apk = buildApk({ versionCode: 9 });
    for (let cut = 30; cut < apk.length; cut += 37) {
      let caught = null;
      try { inspectApk(Buffer.concat([apk.subarray(0, cut), Buffer.alloc(120)])); } catch (e) { caught = e; }
      if (caught) expect(caught.status, `cut at ${cut}`).toBe(400);
    }
  });

  it('normalises a fingerprint however it was pasted', () => {
    expect(normaliseFingerprint('ab:cd:ef')).toBe('ABCDEF');
    expect(normaliseFingerprint(' AB CD EF ')).toBe('ABCDEF');
  });
});
