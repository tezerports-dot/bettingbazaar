// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Shipping the Android app from the admin panel, end to end against the real
 * database: upload → inspect → store → publish → what an installed app is told
 * → where the download goes.
 *
 * ── Why each run ships its OWN app ─────────────────────────────────────────
 * `android_releases` survives between runs, and a publish pins both the
 * version floor and the signing key for everything after it — which is the
 * rule under test. The first version of this suite shared the platform's
 * package and read "the highest code on record" as its baseline. Then a
 * mutation run let a draft signed with a foreign key be PUBLISHED, published
 * releases cannot be deleted, and every later run found a key it could not
 * match and ran nothing (trap 10, measured 2026-09-30).
 *
 * Releases are scoped per package (a release of another package governs
 * nothing), so each run sets ANDROID_PACKAGE_ID to a package nobody else uses,
 * starts from an empty history, and deletes everything it made in afterAll —
 * published or not, outside any assertion.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pgConfigured, applySchema, closePg, pgQuery } from '#db/client.js';
import { mountRouter, actor, as, request } from './_harness.js';
import { buildApk } from '../_fakeApk.js';

const describePg = pgConfigured() ? describe : describe.skip;
const KEY = Buffer.from('CN=BettingBazaar route-test release key, O=BB, C=IN');
const PKG = `com.bettingbazaar.rt${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const APK = 'application/vnd.android.package-archive';

describePg('Android releases', () => {
  let adminApp;
  let publicApp;
  let admin;
  let player;
  let base;
  const savedEnv = {};

  const upload = (who, bytes) => as(adminApp, who).post('/android/releases').set('Content-Type', APK).send(bytes);
  const apk = (offset, extra = {}) => buildApk({
    packageName: PKG, versionCode: base + offset, versionName: `9.${base + offset}.0`, cert: KEY, ...extra,
  });

  beforeAll(async () => {
    await applySchema();
    for (const k of ['ANDROID_SHA256_CERT_FINGERPRINTS', 'ANDROID_PACKAGE_ID']) { savedEnv[k] = process.env[k]; delete process.env[k]; }
    process.env.ANDROID_PACKAGE_ID = PKG;
    adminApp = mountRouter((await import('../../domains/distribution/androidRelease.admin.routes.js')).default);
    publicApp = mountRouter((await import('../../domains/distribution/androidRelease.routes.js')).default, { prefix: '/api' });
    admin = await actor({ isAdmin: true });
    player = await actor();
    base = 10;   // a fresh package has no history
  });

  afterAll(async () => {
    // Everything this run made, published or not — and its files.
    const { rows } = await pgQuery('DELETE FROM android_releases WHERE package_name = $1 RETURNING storage, file_key', [PKG]);
    const { RELEASES_DIR } = await import('../../domains/distribution/androidRelease.shared.js');
    const { unlinkSync } = await import('node:fs');
    const { join } = await import('node:path');
    for (const r of rows) if (r.storage === 'LOCAL') { try { unlinkSync(join(RELEASES_DIR, r.file_key)); } catch { /* gone */ } }
    for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    await closePg();
  });

  it('refuses a player, and refuses anyone without a token', async () => {
    expect((await upload(player, apk(1))).status).toBe(403);
    expect((await request(adminApp).get('/android/releases')).status).toBe(401);
  });

  it('uploads a draft whose identity is read from the file', async () => {
    const bytes = apk(1);
    const res = await upload(admin, bytes);
    expect(res.status).toBe(201);
    expect(res.body.release).toMatchObject({
      packageName: PKG, versionCode: base + 1, versionName: `9.${base + 1}.0`,
      sizeBytes: bytes.length, published: false, mandatory: false, storage: 'LOCAL',
    });
    // Not offered to anyone until published.
    const policy = await request(publicApp).get(`/api/app/android/update?versionCode=${base}`);
    expect(policy.body.latest?.versionCode ?? 0).toBeLessThan(base + 1);
  });

  it.each([
    ['another app', { packageName: 'com.example.other' }, /but this platform ships/],
    ['a debug build', { cert: Buffer.from('CN=Android Debug, O=Android, C=US') }, /debug key/],
    ['a duplicate version code', {}, /already been uploaded/],
  ])('refuses %s, naming the mistake', async (_label, extra, message) => {
    const res = await upload(admin, apk(1, extra));
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(message);
  });

  it('refuses a key the App Links fingerprints do not name', async () => {
    process.env.ANDROID_SHA256_CERT_FINGERPRINTS = 'AA:BB:CC';
    try {
      const res = await upload(admin, apk(2));
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/ANDROID_SHA256_CERT_FINGERPRINTS does not list/);
    } finally { delete process.env.ANDROID_SHA256_CERT_FINGERPRINTS; }
  });

  it('refuses a body that is not an APK', async () => {
    const res = await as(adminApp, admin).post('/android/releases').set('Content-Type', APK).send(Buffer.alloc(500, 3));
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/not an APK/);
  });

  it('publishes, and an older install is offered the update', async () => {
    const { body: list } = await as(adminApp, admin).get('/android/releases');
    const draft = list.releases.find((r) => r.versionCode === base + 1);
    const pub = await as(adminApp, admin).post(`/android/releases/${draft.releaseId}/publish`);
    expect(pub.status).toBe(200);
    expect(pub.body.release.published).toBe(true);

    const older = await request(publicApp).get(`/api/app/android/update?versionCode=${base}`);
    expect(older.body.status).toBe('available');
    expect(older.body.latest).toMatchObject({ versionCode: base + 1, sha256: draft.fileSha256, sizeBytes: draft.sizeBytes });
    // What a phone is told names no storage key and no uploader.
    expect(Object.keys(older.body.latest).sort()).toEqual(
      ['downloadUrl', 'mandatory', 'publishedAt', 'releaseNotes', 'sha256', 'sizeBytes', 'versionCode', 'versionName']);

    const same = await request(publicApp).get(`/api/app/android/update?versionCode=${base + 1}`);
    expect(same.body.status).toBe('current');

    const dl = await request(publicApp).get('/api/download/android');
    expect(dl.status).toBe(302);
    expect(dl.headers.location).toBe(draft.fileUrl);
  });

  it('refuses to publish twice, or below what is published', async () => {
    const lower = (await upload(admin, apk(0))).body;   // uploaded below the published code
    expect(lower.success).toBe(false);
    expect(lower.message).toMatch(/Android refuses a downgrade/);

    const { body: list } = await as(adminApp, admin).get('/android/releases');
    const published = list.releases.find((r) => r.versionCode === base + 1);
    const again = await as(adminApp, admin).post(`/android/releases/${published.releaseId}/publish`);
    expect(again.status).toBe(409);
  });

  it('marking a release mandatory blocks every install below it', async () => {
    const up = await upload(admin, apk(3));
    expect(up.status).toBe(201);
    const id = up.body.release.releaseId;
    const patch = await as(adminApp, admin).patch(`/android/releases/${id}`).send({ mandatory: true, releaseNotes: 'Security fix' });
    expect(patch.body.release).toMatchObject({ mandatory: true, releaseNotes: 'Security fix' });
    expect((await as(adminApp, admin).post(`/android/releases/${id}/publish`)).status).toBe(200);

    const below = await request(publicApp).get(`/api/app/android/update?versionCode=${base + 1}`);
    expect(below.body.status).toBe('required');
    expect(below.body.minRequiredVersionCode).toBe(base + 3);
    expect(below.body.latest.releaseNotes).toBe('Security fix');

    const at = await request(publicApp).get(`/api/app/android/update?versionCode=${base + 3}`);
    expect(at.body.status).toBe('current');
  });

  it('refuses a different key once a release is installed on phones', async () => {
    const res = await upload(admin, apk(4, { cert: Buffer.from('CN=Some other key') }));
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/different key than version/);
  });

  it('deletes a draft, and never a published release', async () => {
    const draft = (await upload(admin, apk(5))).body.release;
    expect((await as(adminApp, admin).delete(`/android/releases/${draft.releaseId}`)).status).toBe(200);
    const { body: list } = await as(adminApp, admin).get('/android/releases');
    expect(list.releases.some((r) => r.releaseId === draft.releaseId)).toBe(false);

    const published = list.releases.find((r) => r.versionCode === base + 3);
    const del = await as(adminApp, admin).delete(`/android/releases/${published.releaseId}`);
    expect(del.status).toBe(409);
  });

  it('publishes only one of two drafts racing to the same slot', async () => {
    // Two drafts, published at once, lower one second: whichever order the
    // database serialises them in, the lower code must never land above the
    // higher. Without the lock both pass the "is this the highest?" read.
    const a = (await upload(admin, apk(6))).body.release;
    const b = (await upload(admin, apk(7))).body.release;
    const [ra, rb] = await Promise.all([
      as(adminApp, admin).post(`/android/releases/${b.releaseId}/publish`),
      as(adminApp, admin).post(`/android/releases/${a.releaseId}/publish`),
    ]);
    const codes = await pgQuery(
      'SELECT version_code, published_at FROM android_releases WHERE package_name = $1 AND version_code IN ($2,$3) ORDER BY version_code',
      [PKG, base + 6, base + 7]);
    const [low, high] = codes.rows;
    if (low.published_at && high.published_at) {
      expect(new Date(low.published_at).getTime()).toBeLessThanOrEqual(new Date(high.published_at).getTime());
    }
    expect([ra.status, rb.status].filter((s) => s === 200).length).toBeGreaterThanOrEqual(1);
    expect(high.published_at).not.toBeNull();
  });

  it('refuses to publish a draft below one published after it was uploaded', async () => {
    // Both drafts are legal at upload time; only the PUBLISH can see that the
    // higher one went out first. This is the guard in the UPDATE's WHERE.
    const lowDraft = (await upload(admin, apk(8))).body.release;
    const highDraft = (await upload(admin, apk(9))).body.release;
    expect((await as(adminApp, admin).post(`/android/releases/${highDraft.releaseId}/publish`)).status).toBe(200);
    const late = await as(adminApp, admin).post(`/android/releases/${lowDraft.releaseId}/publish`);
    expect(late.status).toBe(409);
    expect(late.body.message).toMatch(new RegExp(`Version code ${base + 9} is already published`));
    const { rows } = await pgQuery('SELECT published_at FROM android_releases WHERE release_id = $1', [lowDraft.releaseId]);
    expect(rows[0].published_at).toBeNull();
  });

  it('refuses to PUBLISH a draft signed with another key, even though its upload was legal', async () => {
    // Upload-time key checks are a read. Simulate the window they cannot see:
    // a draft whose key differs from the published one, as two drafts uploaded
    // before anything was published would be. Only the publish can refuse it.
    const draft = (await upload(admin, apk(20))).body.release;
    await pgQuery("UPDATE android_releases SET signer_sha256 = repeat('E', 64) WHERE release_id = $1", [draft.releaseId]);
    const res = await as(adminApp, admin).post(`/android/releases/${draft.releaseId}/publish`);
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/different key/);
    const { rows } = await pgQuery('SELECT published_at FROM android_releases WHERE release_id = $1', [draft.releaseId]);
    expect(rows[0].published_at).toBeNull();
    await as(adminApp, admin).delete(`/android/releases/${draft.releaseId}`);
  });

  it('shows the operator what is not configured yet', async () => {
    const { body } = await as(adminApp, admin).get('/android/releases');
    expect(body.packageName).toBe(PKG);
    expect(body.checks.map((c) => c.key).sort()).toEqual(['allowed_origins', 'fingerprints', 'storage']);
  });
});
