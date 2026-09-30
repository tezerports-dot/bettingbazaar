// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * androidRelease.admin.routes.js — Admin › Android App (mounted under /api/admin).
 *
 *   GET    /android/releases               list + readiness checks
 *   POST   /android/releases               upload an APK (the raw body IS the file)
 *   PATCH  /android/releases/:id           notes / mandatory
 *   POST   /android/releases/:id/publish
 *   DELETE /android/releases/:id           drafts only
 *
 * Why the app updates itself, and what "mandatory" means: androidRelease.shared.js.
 */
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { db } from '#db';
import { authenticate, isAdmin } from '../identity/auth.middleware.js';
import { inspectApk } from './apkInspector.js';
import { respondError, serverError } from '../../shared/httpError.js';
import {
  MAX_APK_BYTES, RELEASES_DIR, callerFault, configuredFingerprints, expectedPackage,
  readinessChecks, refused, storeApk,
} from './androidRelease.shared.js';

const router = express.Router();

router.get('/android/releases', authenticate, isAdmin, async (req, res) => {
  try {
    const [releases, policy] = await Promise.all([db.androidReleases.listReleases(), db.androidReleases.getUpdatePolicy()]);
    res.json({
      success: true,
      releases,
      latestPublishedVersionCode: policy.latest?.versionCode ?? null,
      minRequiredVersionCode: policy.minRequiredVersionCode,
      ...readinessChecks(),
    });
  } catch (err) {
    return serverError(res, err, 'GET /admin/android/releases', 'Failed to load Android releases');
  }
});

// The body is the APK itself — no base64, no multipart parser. Scoped to this
// one route so no other path accepts a 150 MB body.
router.post('/android/releases',
  authenticate, isAdmin,
  express.raw({ type: () => true, limit: MAX_APK_BYTES }),
  async (req, res) => {
    try {
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        throw callerFault('Choose an .apk file to upload.');
      }
      const info = inspectApk(req.body);

      // ── The three mistakes, each named ─────────────────────────────────────
      if (info.packageName !== expectedPackage()) {
        throw callerFault(`This APK is ${info.packageName}, but this platform ships ${expectedPackage()}. Installed, it would appear as a second app and the real one would never update.`);
      }
      if (info.debugSigned) {
        throw callerFault('This APK is signed with the Android debug key. Android will refuse it as an update to any release build — upload the one from the "Android release" workflow.');
      }
      const fps = configuredFingerprints();
      if (fps.length && !fps.includes(info.signerSha256)) {
        throw callerFault(`This APK is signed with a key (${info.signerSha256.slice(0, 16)}…) that ANDROID_SHA256_CERT_FINGERPRINTS does not list. Android would refuse it as an update.`);
      }
      const { latest } = await db.androidReleases.getUpdatePolicy();
      if (latest && latest.signerSha256 !== info.signerSha256) {
        throw callerFault(`This APK is signed with a different key than version ${latest.versionName}, which players have installed. Android refuses an update signed with a different key.`);
      }
      if (latest && info.versionCode <= latest.versionCode) {
        throw callerFault(`This APK's version code is ${info.versionCode}, but ${latest.versionCode} (${latest.versionName}) is already published. Android refuses a downgrade — build a newer version.`);
      }
      if (await db.androidReleases.getReleaseByVersionCode(info.versionCode)) {
        throw callerFault(`Version code ${info.versionCode} has already been uploaded. Delete that draft first, or build a newer version.`);
      }

      const stored = await storeApk(req.body, info);
      const release = await db.androidReleases.createRelease({
        packageName: info.packageName,
        versionCode: info.versionCode,
        versionName: info.versionName,
        minSdk: info.minSdk,
        signerSha256: info.signerSha256,
        fileSha256: info.sha256,
        sizeBytes: info.sizeBytes,
        ...stored,
        uploadedBy: req.user.userId,
      });
      await db.audit.recordDetailed({
        performedBy: req.user.userId, performedByName: req.user.username, performedByRole: 'admin',
        action: 'ANDROID_RELEASE_UPLOADED', category: 'SYSTEM',
        targetType: 'android_release', targetId: release.releaseId, targetName: `${release.versionName} (${release.versionCode})`,
        details: { sha256: release.fileSha256, signer: release.signerSha256, size: release.sizeBytes },
        ip: req.ip, method: req.method, endpoint: req.originalUrl,
      });
      res.status(201).json({ success: true, release });
    } catch (err) {
      if (err?.type === 'entity.too.large') {
        return refused(res, 413, `The APK is larger than ${MAX_APK_BYTES / (1024 * 1024)} MB.`);
      }
      return respondError(res, err, 'POST /admin/android/releases', { message: 'Failed to upload the APK' });
    }
  });

router.patch('/android/releases/:id', authenticate, isAdmin, async (req, res) => {
  try {
    const { releaseNotes, mandatory } = req.body || {};
    if (releaseNotes !== undefined && (typeof releaseNotes !== 'string' || releaseNotes.length > 4000)) {
      throw callerFault('Release notes must be text of at most 4000 characters.');
    }
    if (mandatory !== undefined && typeof mandatory !== 'boolean') {
      throw callerFault('mandatory must be true or false.');
    }
    const release = await db.androidReleases.updateRelease(req.params.id, { releaseNotes, mandatory });
    if (!release) return refused(res, 404, 'Release not found.');
    await db.audit.recordDetailed({
      performedBy: req.user.userId, performedByName: req.user.username, performedByRole: 'admin',
      action: 'ANDROID_RELEASE_UPDATED', category: 'SYSTEM',
      targetType: 'android_release', targetId: release.releaseId, targetName: `${release.versionName} (${release.versionCode})`,
      details: { mandatory: release.mandatory, notesChanged: releaseNotes !== undefined },
      ip: req.ip, method: req.method, endpoint: req.originalUrl,
    });
    res.json({ success: true, release });
  } catch (err) {
    return respondError(res, err, 'PATCH /admin/android/releases/:id', { message: 'Failed to update the release' });
  }
});

router.post('/android/releases/:id/publish', authenticate, isAdmin, async (req, res) => {
  try {
    const out = await db.androidReleases.publishRelease(req.params.id, req.user.userId);
    if (out.refused === 'not_found') return refused(res, 404, 'Release not found.');
    if (out.refused === 'already_published') return refused(res, 409, 'This release is already published.');
    if (out.refused === 'not_newest') {
      return refused(res, 409, `Version code ${out.publishedVersionCode} is already published. Only a newer version can be published — Android refuses a downgrade.`);
    }
    await db.audit.recordDetailed({
      performedBy: req.user.userId, performedByName: req.user.username, performedByRole: 'admin',
      action: 'ANDROID_RELEASE_PUBLISHED', category: 'SYSTEM',
      targetType: 'android_release', targetId: out.release.releaseId,
      targetName: `${out.release.versionName} (${out.release.versionCode})`,
      details: { mandatory: out.release.mandatory },
      ip: req.ip, method: req.method, endpoint: req.originalUrl,
    });
    res.json({ success: true, release: out.release });
  } catch (err) {
    return serverError(res, err, 'POST /admin/android/releases/:id/publish', 'Failed to publish the release');
  }
});

router.delete('/android/releases/:id', authenticate, isAdmin, async (req, res) => {
  try {
    const existing = await db.androidReleases.getRelease(req.params.id);
    if (!existing) return refused(res, 404, 'Release not found.');
    if (existing.published) {
      return refused(res, 409, 'A published release cannot be deleted — players may have it installed. Publish a newer one instead.');
    }
    const gone = await db.androidReleases.deleteDraft(req.params.id);
    if (!gone) return refused(res, 409, 'This release was published while you were looking at it.');
    if (gone.storage === 'LOCAL') {
      try { fs.unlinkSync(path.join(RELEASES_DIR, path.basename(gone.fileKey))); } catch { /* already gone */ }
    }
    await db.audit.recordDetailed({
      performedBy: req.user.userId, performedByName: req.user.username, performedByRole: 'admin',
      action: 'ANDROID_RELEASE_DELETED', category: 'SYSTEM',
      targetType: 'android_release', targetId: gone.releaseId, targetName: `${gone.versionName} (${gone.versionCode})`,
      ip: req.ip, method: req.method, endpoint: req.originalUrl,
    });
    res.json({ success: true });
  } catch (err) {
    return serverError(res, err, 'DELETE /admin/android/releases/:id', 'Failed to delete the draft');
  }
});


export default router;
