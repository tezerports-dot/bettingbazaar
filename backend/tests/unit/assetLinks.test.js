// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * /.well-known/assetlinks.json — the document that makes the APK signable-into.
 *
 * ── Why this is worth a test ────────────────────────────────────────────────
 * Player auth is Telegram-only. The bot sends a one-time link at
 * PUBLIC_APP_ORIGIN, and whichever context opens it spends the token. Android
 * routes that tap to the installed app only if this file verifies the app's
 * claim on the origin — so a wrong or absent answer here does not degrade the
 * app, it makes the app impossible to sign in to, silently, on a handset,
 * long after anyone was looking.
 *
 * Every case below is a way that has actually gone wrong for people:
 * a lowercase fingerprint pasted from `keytool`, a colon-stripped one pasted
 * from a CI log, an empty document served while the value was still unset (which
 * Android caches as a verification FAILURE, unlike a 404), and — the expensive
 * one — listing only the upload certificate, which verifies for every sideloaded
 * build and fails for every Play install, because Play App Signing re-signs the
 * APK with a different key.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import wellKnownRoutes from '../../routes/wellKnown.routes.js';

const UPLOAD_FP = 'AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99';
const PLAY_FP   = '11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00';

function app() {
  const a = express();
  a.use('/.well-known', wellKnownRoutes);
  return a;
}

const saved = {};
beforeEach(() => {
  saved.pkg = process.env.ANDROID_PACKAGE_ID;
  saved.fp = process.env.ANDROID_SHA256_CERT_FINGERPRINTS;
  process.env.ANDROID_PACKAGE_ID = 'com.bettingbazaar.app';
  process.env.ANDROID_SHA256_CERT_FINGERPRINTS = UPLOAD_FP;
});
afterEach(() => {
  if (saved.pkg === undefined) delete process.env.ANDROID_PACKAGE_ID;
  else process.env.ANDROID_PACKAGE_ID = saved.pkg;
  if (saved.fp === undefined) delete process.env.ANDROID_SHA256_CERT_FINGERPRINTS;
  else process.env.ANDROID_SHA256_CERT_FINGERPRINTS = saved.fp;
});

describe('/.well-known/assetlinks.json', () => {
  it('serves a Digital Asset Links document Android will accept', async () => {
    const res = await request(app()).get('/.well-known/assetlinks.json');

    expect(res.status).toBe(200);
    // Android requires application/json — a text/plain answer fails verification.
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(Array.isArray(res.body)).toBe(true);
    // Exactly one relation. get_login_creds would let the player APK pull
    // credentials saved for this origin — which is where the admin and
    // merchant panels live. It buys nothing here (players have no password)
    // and is the kind of line that gets pasted in from a tutorial.
    expect(res.body[0].relation).toEqual(['delegate_permission/common.handle_all_urls']);
    expect(res.body[0].target).toMatchObject({
      namespace: 'android_app',
      package_name: 'com.bettingbazaar.app',
      sha256_cert_fingerprints: [UPLOAD_FP],
    });
  });

  it('carries every configured fingerprint, so Play App Signing does not break it', async () => {
    // The upload key signs what CI produces; Play re-signs with its own key
    // before any user installs it. A site naming only the first verifies for
    // sideload and fails for the store.
    process.env.ANDROID_SHA256_CERT_FINGERPRINTS = `${UPLOAD_FP},${PLAY_FP}`;

    const res = await request(app()).get('/.well-known/assetlinks.json');

    expect(res.status).toBe(200);
    expect(res.body[0].target.sha256_cert_fingerprints).toEqual([UPLOAD_FP, PLAY_FP]);
  });

  it('normalises a fingerprint pasted in any form keytool or a CI log produces', async () => {
    process.env.ANDROID_SHA256_CERT_FINGERPRINTS = UPLOAD_FP.replace(/:/g, '').toLowerCase();

    const res = await request(app()).get('/.well-known/assetlinks.json');

    expect(res.body[0].target.sha256_cert_fingerprints).toEqual([UPLOAD_FP]);
  });

  it('404s rather than publishing an empty document when nothing is configured', async () => {
    // An empty relation array is a positive claim — "this site vouches for no
    // app" — which Android caches as a failure. A 404 leaves the next
    // verification attempt free to succeed once the value is set.
    delete process.env.ANDROID_SHA256_CERT_FINGERPRINTS;

    const res = await request(app()).get('/.well-known/assetlinks.json');

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });

  it('404s when the package id is missing', async () => {
    delete process.env.ANDROID_PACKAGE_ID;

    const res = await request(app()).get('/.well-known/assetlinks.json');

    expect(res.status).toBe(404);
  });

  it('drops a malformed fingerprint instead of serving an invalid document', async () => {
    // A truncated paste is the common case. Serving it would make the whole
    // document invalid; dropping it leaves the valid entries verifiable.
    process.env.ANDROID_SHA256_CERT_FINGERPRINTS = `AA:BB:CC,${UPLOAD_FP}`;

    const res = await request(app()).get('/.well-known/assetlinks.json');

    expect(res.status).toBe(200);
    expect(res.body[0].target.sha256_cert_fingerprints).toEqual([UPLOAD_FP]);
  });

  it('404s when every configured fingerprint is malformed', async () => {
    process.env.ANDROID_SHA256_CERT_FINGERPRINTS = 'AA:BB:CC,not-a-fingerprint';

    const res = await request(app()).get('/.well-known/assetlinks.json');

    expect(res.status).toBe(404);
  });
});
