// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * androidRelease.routes.js — what an installed Android app asks (mounted under /api).
 *
 *   GET /app/android/update?versionCode=N   required | available | current, and the release
 *   GET /download/android                   302 to the newest published APK
 *
 * Public on purpose: the app asks before anyone signs in, and a player who is
 * blocked by a mandatory update must still be able to fetch it.
 */
import express from 'express';
import { db } from '#db';
import { serverError } from '../../shared/httpError.js';
import { expectedPackage, publicRelease, refused, updateStatus } from './androidRelease.shared.js';

const router = express.Router();

router.get('/app/android/update', async (req, res) => {
  try {
    const installed = Number(req.query.versionCode);
    const policy = await db.androidReleases.getUpdatePolicy(expectedPackage());
    res.set('Cache-Control', 'no-store');
    res.json({
      success: true,
      status: updateStatus(installed, policy),
      minRequiredVersionCode: policy.minRequiredVersionCode,
      latest: publicRelease(policy.latest),
    });
  } catch (err) {
    return serverError(res, err, 'GET /app/android/update', 'Could not check for updates');
  }
});

router.get('/download/android', async (req, res) => {
  try {
    const { latest } = await db.androidReleases.getUpdatePolicy(expectedPackage());
    if (!latest) return refused(res, 404, 'The Android app is not available yet.');
    return res.redirect(302, latest.fileUrl);
  } catch (err) {
    return serverError(res, err, 'GET /download/android', 'Server error');
  }
});

export default router;
