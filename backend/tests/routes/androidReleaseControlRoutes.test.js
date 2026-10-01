// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Admin control of the Android app beyond upload and publish (R9, owner
 * 2026-10-01: "proper admin control for version control and everything that
 * apk is needed"), against the real database.
 *
 *   - HALT a published release: phones stop being offered it, the download
 *     link moves back, and a mandatory floor it set is lifted — while the
 *     publish floor still counts it, because phones may already run it.
 *   - ANDROID VERSION: a phone is never offered, or blocked by, a release its
 *     Android cannot install; below a mandatory release it cannot install it
 *     is told its phone is too old ('unsupported'), not sent round an update
 *     loop.
 *   - What the admin card is told: the Android a release needs, the signature
 *     schemes its upload verified, and who uploaded, published and halted it.
 *
 * Its own package, as androidReleaseRoutes does, so the publish history this
 * suite builds governs nothing else and is deleted in afterAll (trap 10).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pgConfigured, applySchema, closePg, pgQuery } from '#db/client.js';
import { mountRouter, actor, as, request } from './_harness.js';
import { buildApk } from '../_fakeApk.js';

const describePg = pgConfigured() ? describe : describe.skip;
const KEY = 'CN=BettingBazaar control-test key, O=BB, C=IN';
const PKG = `com.bettingbazaar.ct${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const APK = 'application/vnd.android.package-archive';

describePg('Android release control', () => {
  let adminApp;
  let publicApp;
  let admin;
  const savedEnv = {};

  const upload = (bytes) => as(adminApp, admin).post('/android/releases').set('Content-Type', APK).send(bytes);
  const ship = async (code, { minSdk = 24, mandatory = false } = {}) => {
    const up = await upload(buildApk({ packageName: PKG, versionCode: code, versionName: `1.${code}.0`, signer: KEY, minSdk }));
    expect(up.status, JSON.stringify(up.body)).toBe(201);
    const id = up.body.release.releaseId;
    if (mandatory) await as(adminApp, admin).patch(`/android/releases/${id}`).send({ mandatory: true });
    expect((await as(adminApp, admin).post(`/android/releases/${id}/publish`)).status).toBe(200);
    return id;
  };
  const ask = (versionCode, sdk) => request(publicApp)
    .get(`/api/app/android/update?versionCode=${versionCode}${sdk ? `&sdk=${sdk}` : ''}`).then((r) => r.body);
  const halt = (id, reason = 'Crashes on start') => as(adminApp, admin).post(`/android/releases/${id}/halt`).send({ reason });

  beforeAll(async () => {
    await applySchema();
    for (const k of ['ANDROID_SHA256_CERT_FINGERPRINTS', 'ANDROID_PACKAGE_ID']) { savedEnv[k] = process.env[k]; delete process.env[k]; }
    process.env.ANDROID_PACKAGE_ID = PKG;
    adminApp = mountRouter((await import('../../domains/distribution/androidRelease.admin.routes.js')).default);
    publicApp = mountRouter((await import('../../domains/distribution/androidRelease.routes.js')).default, { prefix: '/api' });
    admin = await actor({ isAdmin: true });
  });

  afterAll(async () => {
    const { rows } = await pgQuery('DELETE FROM android_releases WHERE package_name = $1 RETURNING storage, file_key', [PKG]);
    const { RELEASES_DIR } = await import('../../domains/distribution/androidRelease.shared.js');
    const { unlinkSync } = await import('node:fs');
    const { join } = await import('node:path');
    for (const r of rows) if (r.storage === 'LOCAL') { try { unlinkSync(join(RELEASES_DIR, r.file_key)); } catch { /* gone */ } }
    for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    await closePg();
  });

  it('tells the admin which Android a release needs and which signature schemes were verified', async () => {
    const up = await upload(buildApk({ packageName: PKG, versionCode: 5, versionName: '1.5.0', signer: KEY, minSdk: 28 }));
    expect(up.status).toBe(201);
    expect(up.body.release).toMatchObject({ requiresAndroid: 'Android 9 (API 28)', signatureSchemes: [2] });
    const list = await as(adminApp, admin).get('/android/releases');
    const row = list.body.releases.find((r) => r.versionCode === 5);
    expect(row).toMatchObject({ requiresAndroid: 'Android 9 (API 28)', signatureSchemes: [2], uploadedByName: expect.any(String) });
    await as(adminApp, admin).delete(`/android/releases/${row.releaseId}`);
  });

  describe('halting a published release', () => {
    let good;
    let bad;

    it('needs a reason, and refuses a draft', async () => {
      good = await ship(10);
      const draft = (await upload(buildApk({ packageName: PKG, versionCode: 11, versionName: '1.11.0', signer: KEY }))).body.release;
      expect((await halt(draft.releaseId)).status).toBe(409);
      await as(adminApp, admin).delete(`/android/releases/${draft.releaseId}`);
      bad = await ship(12, { mandatory: true });
      const noReason = await halt(bad, ' ');
      expect(noReason.status).toBe(400);
      expect(noReason.body.message).toMatch(/Say why/);
      // Nothing changed: the bad release is still offered, and still required.
      expect(await ask(10)).toMatchObject({ status: 'required', latest: { versionCode: 12 } });
    });

    it('stops it being offered, downloaded or required, and points phones at the previous release', async () => {
      const res = await halt(bad);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.message).toMatch(/Phones are now offered 1\.10\.0/);
      // The mandatory floor it set is lifted: a phone on 10 is current again.
      expect(await ask(10)).toMatchObject({ status: 'current', minRequiredVersionCode: 0, latest: { versionCode: 10 } });
      const dl = await request(publicApp).get('/api/download/android');
      expect(dl.status).toBe(302);
      expect(dl.headers.location).toMatch(/-10-/);
      // A phone already on the halted build is not told to "update" downwards.
      expect((await ask(12)).status).toBe('current');
      const row = (await as(adminApp, admin).get('/android/releases')).body.releases.find((r) => r.versionCode === 12);
      expect(row).toMatchObject({ halted: true, haltReason: 'Crashes on start', haltedByName: expect.any(String) });
    });

    it('still counts it when publishing: a fix must be above the halted build phones may run', async () => {
      // 11 is above the offered 10 but below the halted 12, which some phones
      // already run — publishing it would be a downgrade for them.
      const lower = (await upload(buildApk({ packageName: PKG, versionCode: 11, versionName: '1.11.0', signer: KEY }))).body;
      expect(lower.success === false || lower.release == null).toBe(true);
      expect(String(lower.message)).toMatch(/12 \(1\.12\.0\) is already published/);
    });

    it('resumes: offered and required again', async () => {
      expect((await as(adminApp, admin).post(`/android/releases/${bad}/resume`)).status).toBe(200);
      expect(await ask(10)).toMatchObject({ status: 'required', latest: { versionCode: 12 } });
      expect((await as(adminApp, admin).post(`/android/releases/${bad}/resume`)).status).toBe(409);
      expect(good).toBeTruthy();
    });

    it('halting every release leaves nothing offered, and the download says so', async () => {
      await halt(bad);
      await halt(good);
      expect(await ask(9)).toMatchObject({ status: 'current', latest: null });
      const dl = await request(publicApp).get('/api/download/android');
      expect(dl.status).toBe(404);
      expect(dl.body.message).toMatch(/not available right now/);
      await as(adminApp, admin).post(`/android/releases/${good}/resume`);
      await as(adminApp, admin).post(`/android/releases/${bad}/resume`);
    });
  });

  describe('a release a phone\'s Android cannot install', () => {
    it('is not offered to that phone, and the newest release it CAN install is', async () => {
      await ship(20, { minSdk: 30 });            // needs Android 11
      expect((await ask(12, 28)).latest.versionCode).toBe(12);   // Android 9 phone
      expect((await ask(12, 33)).latest.versionCode).toBe(20);   // Android 13 phone
      // An older app that does not report its Android: offered, as before.
      expect((await ask(12)).latest.versionCode).toBe(20);
      expect((await ask(12, 28)).status).toBe('current');
    });

    it('below a MANDATORY release it cannot install, the phone is told it is too old, not sent round an update loop', async () => {
      await ship(21, { minSdk: 30, mandatory: true });
      const old = await ask(12, 28);
      expect(old).toMatchObject({ status: 'unsupported', requiredAndroid: 'Android 11 (API 30)' });
      // It is never told to install something it cannot.
      expect(old.latest.versionCode).toBe(12);
      // A phone whose Android can install it is simply required to update.
      expect(await ask(12, 33)).toMatchObject({ status: 'required', latest: { versionCode: 21 } });
      expect((await ask(12, 33)).requiredAndroid).toBeUndefined();
    });

    it('a phone already on the mandatory build is current, whatever it reports', async () => {
      expect((await ask(21, 33)).status).toBe('current');
    });
  });
});
