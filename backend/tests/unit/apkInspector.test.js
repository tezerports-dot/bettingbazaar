// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The APK inspector reads identity out of the file, never out of a form.
 *
 * Two encodings are proven: the synthetic builder writes a UTF-16 string pool,
 * and `fixtures/AndroidManifest.release.bin` is what aapt2 produced for this
 * very app (UTF-8 pool, attribute names resolved through the resource map).
 *
 * The SIGNATURE is verified, not just read (R7). Two kinds of proof:
 *   - `fixtures/apksigner-{rsa,ec}-v2v3.apk` were signed by Google's own
 *     apksigner (build-tools 34) with throwaway keys, v2 and v3, and the
 *     fingerprints below are what `apksigner verify --print-certs` printed for
 *     them. Their content is 3 MB, so the digest spans several 1 MB chunks.
 *     The keys were never committed; only the public certificates are inside.
 *   - the builder signs for real with an EC key per subject, so each way a
 *     signature can be wrong is constructed and must be refused.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { inspectApk, normaliseFingerprint } from '../../domains/distribution/apkInspector.js';
import { buildApk, certificateFor } from '../_fakeApk.js';

const fixture = readFileSync(fileURLToPath(new URL('../fixtures/AndroidManifest.release.bin', import.meta.url)));
const sha = (b) => createHash('sha256').update(b).digest('hex');
/** Every occurrence of an entry name in the zip rewritten — the file stays a valid zip. */
const renamed = (buf, from, to) => Buffer.from(buf.toString('latin1').split(from).join(to), 'latin1');

describe('inspectApk', () => {
  it('reads package, version, minSdk and signer from a built APK', () => {
    const signer = 'CN=Unit Release, O=BB, C=IN';
    const apk = buildApk({ versionCode: 314, versionName: '3.1.4', minSdk: 26, signer });
    const info = inspectApk(apk);
    expect(info).toMatchObject({
      packageName: 'com.bettingbazaar.app', versionCode: 314, versionName: '3.1.4', minSdk: 26,
      signatureScheme: 2, debugSigned: false, sizeBytes: apk.length,
    });
    expect(info.signerSha256).toBe(sha(certificateFor(signer)).toUpperCase());
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
    const info = inspectApk(buildApk({ signer: 'CN=Android Debug, O=Android, C=US' }));
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

  it('reads a DEFLATED manifest, the way build tools usually store it', () => {
    const info = inspectApk(buildApk({ versionCode: 77, deflateManifest: true }));
    expect(info.versionCode).toBe(77);
  });

  it('refuses a manifest that inflates past any real one, without inflating it', () => {
    // A zip bomb on AndroidManifest.xml: kilobytes on the wire, 64 MB inflated.
    // The upload is admin-only, but it is inflated inside the API process, so
    // an unbounded inflate is a way to take that process down (review P197-2).
    const bomb = buildApk({ manifest: Buffer.alloc(64 * 1024 * 1024), deflateManifest: true });
    expect(bomb.length).toBeLessThan(1024 * 1024);
    let err;
    try { inspectApk(bomb); } catch (e) { err = e; }
    expect(err?.status).toBe(400);
    expect(err?.message).toMatch(/manifest is larger than any real one/);
  });

  describe('the signature is verified, not just read (R7)', () => {
    const real = (name) => readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)));
    const refusal = (bytes) => { try { inspectApk(bytes); } catch (e) { return e; } return null; };

    it.each([
      // What `apksigner verify --print-certs` printed for each fixture.
      ['apksigner-rsa-v2v3.apk', '1173F36A4971856E5A2120215D6C73D2EDB31E5D5CBB2F21BD671633EDBA9C87'],
      ['apksigner-ec-v2v3.apk', '23054A8B75B363FB5EDBE83209340A0EE658CAC58895A4F3147BF05B026B72C0'],
    ])('verifies %s, signed by the real apksigner, v2 and v3', (file, fingerprint) => {
      const info = inspectApk(real(file));
      expect(info.signatureSchemes).toEqual([2, 3]);
      expect(info.signerSha256).toBe(fingerprint);
      expect(info.versionCode).toBe(7);
    });

    it.each([
      ['apksigner-rsa-v2v3.apk'], ['apksigner-ec-v2v3.apk'],
    ])('refuses %s with one byte of its contents changed', (file) => {
      const t = Buffer.from(real(file));
      t[2_000_000] ^= 1;   // inside the 3 MB entry, two chunks in
      const err = refusal(t);
      expect(err?.status).toBe(400);
      expect(err?.message).toMatch(/do not match its v3 signature/);
    });

    it('refuses a change to the zip entries of a builder-signed APK', () => {
      const apk = buildApk({ versionCode: 41 });
      const t = Buffer.from(apk);
      t[t.indexOf(Buffer.alloc(16, 7))] ^= 1;   // a byte of classes.dex
      expect(refusal(t)?.message).toMatch(/do not match its v2 signature/);
    });

    it('refuses a signature that does not verify', () => {
      const apk = buildApk({ versionCode: 42 });
      const block = apk.indexOf(Buffer.from('APK Sig Block 42', 'latin1'));
      // The signature bytes sit just before the public key at the block's end;
      // flip one in the middle of the block, inside the signer.
      const t = Buffer.from(apk);
      const spkiAt = t.lastIndexOf(Buffer.from([0x30, 0x59, 0x30, 0x13]), block);
      t[spkiAt - 20] ^= 1;
      expect(refusal(t)?.message).toMatch(/signature does not verify|does not match its own digests/);
    });

    it('refuses a certificate that is not the key that signed', () => {
      // A VALID signature by Signer A's key over signed data naming Signer B's
      // certificate: the forgery the old reader reported as Signer B. Only the
      // certificate-key check can refuse this one; the signature is genuine.
      const apk = buildApk({ versionCode: 43, signer: 'CN=Signer A, O=BB, C=IN', embedCertOf: 'CN=Signer B, O=BB, C=IN' });
      const err = refusal(apk);
      expect(err?.status).toBe(400);
      expect(err?.message).toMatch(/not the key that signed it/);
    });
  });

  it('normalises a fingerprint however it was pasted', () => {
    expect(normaliseFingerprint('ab:cd:ef')).toBe('ABCDEF');
    expect(normaliseFingerprint(' AB CD EF ')).toBe('ABCDEF');
  });
});
