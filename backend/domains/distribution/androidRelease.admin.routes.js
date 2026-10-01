// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * androidRelease.admin.routes.js — Admin › Android App (mounted under /api/admin).
 *
 *   GET    /android/releases               list + readiness checks
 *   POST   /android/releases               upload an APK (the raw body IS the file)
 *   PATCH  /android/releases/:id           notes / mandatory
 *   POST   /android/releases/:id/publish
 *   POST   /android/releases/:id/halt      stop offering a published release (reason required)
 *   POST   /android/releases/:id/resume    offer a halted release again
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
import { deleteFile } from '../../services/cdn.service.js';
import { respondError, serverError } from '../../shared/httpError.js';
import {
  MAX_APK_BYTES, RELEASES_DIR, androidLabel, callerFault, configuredFingerprints, expectedPackage,
  readinessChecks, refused, storeApk,
} from './androidRelease.shared.js';

/** What the admin card shows beside the stored row: the Android it needs, in words. */
const forAdmin = (r) => ({ ...r, requiresAndroid: androidLabel(r.minSdk) });

function audit(req, action, release, details) {
  return db.audit.recordDetailed({
    performedBy: req.user.userId, performedByName: req.user.username, performedByRole: 'admin',
    action, category: 'SYSTEM',
    targetType: 'android_release', targetId: release.releaseId, targetName: `${release.versionName} (${release.versionCode})`,
    details, ip: req.ip, method: req.method, endpoint: req.originalUrl,
  });
}

const router = express.Router();

router.get('/android/releases', authenticate, isAdmin, async (req, res) => {
  try {
    const [releases, policy] = await Promise.all([db.androidReleases.listReleases(expectedPackage()), db.androidReleases.getUpdatePolicy(expectedPackage())]);
    res.json({
      success: true,
      releases: releases.map(forAdmin),
      latestPublishedVersionCode: policy.latest?.versionCode ?? null,
      minRequiredVersionCode: policy.minRequiredVersionCode,
      ...readinessChecks(),
    });
  } catch (err) {
    return serverError(res, err, 'GET /admin/android/releases', 'Failed to load Android releases');
  }
});

/**
 * Remove an APK's stored bytes, best-effort. Used for a draft being deleted and
 * for an upload that lost the race for its version code; never for a file a
 * release row still names.
 */
async function discardStored({ storage, fileKey }) {
  if (storage === 'LOCAL') {
    try { fs.unlinkSync(path.join(RELEASES_DIR, path.basename(fileKey))); } catch { /* already gone */ }
  } else {
    try { await deleteFile(fileKey); } catch (e) { console.warn('[android release] object not deleted:', e.message); }
  }
}

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
      // Every published release, halted or not: phones may run a halted one.
      const latest = await db.androidReleases.getHighestPublished(expectedPackage());
      if (latest && latest.signerSha256 !== info.signerSha256) {
        throw callerFault(`This APK is signed with a different key than version ${latest.versionName}, which players have installed. Android refuses an update signed with a different key.`);
      }
      if (latest && info.versionCode <= latest.versionCode) {
        throw callerFault(`This APK's version code is ${info.versionCode}, but ${latest.versionCode} (${latest.versionName}) is already published. Android refuses a downgrade — build a newer version.`);
      }
      if (await db.androidReleases.getReleaseByVersionCode(info.packageName, info.versionCode)) {
        throw callerFault(`Version code ${info.versionCode} has already been uploaded. Delete that draft first, or build a newer version.`);
      }

      const stored = await storeApk(req.body, info);
      let release;
      try {
        release = await db.androidReleases.createRelease({
          packageName: info.packageName,
          versionCode: info.versionCode,
          versionName: info.versionName,
          minSdk: info.minSdk,
          signerSha256: info.signerSha256,
          fileSha256: info.sha256,
          sizeBytes: info.sizeBytes,
          ...stored,
          uploadedBy: req.user.userId,
          signatureSchemes: info.signatureSchemes,
        });
      } catch (err) {
        if (err?.code !== '23505') throw err;
        // Two uploads of one version code both passed the read above (§32 S6);
        // the unique index decided and this one lost. It was a 500 and left its
        // file behind (review P197-3). Remove the file — unless the winner's row
        // names the same one, which identical bytes produce — then say why.
        const winner = await db.androidReleases.getReleaseByVersionCode(info.packageName, info.versionCode);
        if (winner?.fileKey !== stored.fileKey) await discardStored(stored);
        throw callerFault(`Version code ${info.versionCode} has already been uploaded. Delete that draft first, or build a newer version.`);
      }
      await db.audit.recordDetailed({
        performedBy: req.user.userId, performedByName: req.user.username, performedByRole: 'admin',
        action: 'ANDROID_RELEASE_UPLOADED', category: 'SYSTEM',
        targetType: 'android_release', targetId: release.releaseId, targetName: `${release.versionName} (${release.versionCode})`,
        details: { sha256: release.fileSha256, signer: release.signerSha256, size: release.sizeBytes, schemes: release.signatureSchemes },
        ip: req.ip, method: req.method, endpoint: req.originalUrl,
      });
      res.status(201).json({ success: true, release: forAdmin(release) });
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
    res.json({ success: true, release: forAdmin(release) });
  } catch (err) {
    return respondError(res, err, 'PATCH /admin/android/releases/:id', { message: 'Failed to update the release' });
  }
});

router.post('/android/releases/:id/publish', authenticate, isAdmin, async (req, res) => {
  try {
    const out = await db.androidReleases.publishRelease(req.params.id, req.user.userId);
    if (out.refused === 'not_found') return refused(res, 404, 'Release not found.');
    if (out.refused === 'already_published') return refused(res, 409, 'This release is already published.');
    if (out.refused === 'different_key') {
      return refused(res, 409, `This APK is signed with a different key than ${out.publishedVersionName}, which players have installed. Android refuses an update signed with a different key — delete this draft.`);
    }
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
    res.json({ success: true, release: forAdmin(out.release) });
  } catch (err) {
    return serverError(res, err, 'POST /admin/android/releases/:id/publish', 'Failed to publish the release');
  }
});

// ── Halt and resume (R9) ─────────────────────────────────────────────────────
// A broken build that is already published cannot be deleted (phones may run
// it) and could only be replaced. Halting stops it being OFFERED at once:
// phones are pointed back at the newest release that is not halted, and the
// download link follows. Players who already installed it keep it until a
// newer release reaches them; the screen says so.
router.post('/android/releases/:id/halt', authenticate, isAdmin, async (req, res) => {
  try {
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
    if (reason.length < 3 || reason.length > 500) {
      throw callerFault('Say why this release is being halted (3–500 characters). It is kept in the release history.');
    }
    const out = await db.androidReleases.haltRelease(req.params.id, req.user.userId, reason);
    if (out.refused === 'not_found') return refused(res, 404, 'Release not found.');
    if (out.refused === 'not_published') return refused(res, 409, 'Only a published release can be halted. A draft is simply not published — delete it instead.');
    if (out.refused === 'already_halted') return refused(res, 409, 'This release is already halted.');
    await audit(req, 'ANDROID_RELEASE_HALTED', out.release, { reason });
    const { latest } = await db.androidReleases.getUpdatePolicy(expectedPackage());
    res.json({
      success: true,
      release: forAdmin(out.release),
      message: latest
        ? `${out.release.versionName} is halted. Phones are now offered ${latest.versionName}.`
        : `${out.release.versionName} is halted. No release is offered until you publish or resume one.`,
    });
  } catch (err) {
    return respondError(res, err, 'POST /admin/android/releases/:id/halt', { message: 'Failed to halt the release' });
  }
});

router.post('/android/releases/:id/resume', authenticate, isAdmin, async (req, res) => {
  try {
    const out = await db.androidReleases.resumeRelease(req.params.id);
    if (out.refused === 'not_found') return refused(res, 404, 'Release not found.');
    if (out.refused === 'not_halted') return refused(res, 409, 'This release is not halted.');
    await audit(req, 'ANDROID_RELEASE_RESUMED', out.release, {});
    res.json({ success: true, release: forAdmin(out.release) });
  } catch (err) {
    return serverError(res, err, 'POST /admin/android/releases/:id/resume', 'Failed to resume the release');
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
    // The row is gone either way; the bytes are best-effort. A leftover object
    // is storage nobody links to, never a release anybody is offered.
    await discardStored(gone);
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
