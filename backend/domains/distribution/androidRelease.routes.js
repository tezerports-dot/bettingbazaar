// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * androidRelease.routes.js — what an installed Android app asks (mounted under /api).
 *
 *   GET /app/android/update?versionCode=N&sdk=API
 *                                           required | unsupported | available | current
 *                                           and the release, chosen FOR this phone's Android
 *   GET /download/android                   302 to the newest published APK
 *
 * Public on purpose: the app asks before anyone signs in, and a player who is
 * blocked by a mandatory update must still be able to fetch it.
 */
import express from 'express';
import { db } from '#db';
import { serverError } from '../../shared/httpError.js';
import { androidLabel, expectedPackage, parseSdk, publicRelease, refused, updateStatus } from './androidRelease.shared.js';

const router = express.Router();

router.get('/app/android/update', async (req, res) => {
  try {
    const installed = Number(req.query.versionCode);
    const policy = await db.androidReleases.getUpdatePolicy(expectedPackage(), { sdk: parseSdk(req.query.sdk) });
    const status = updateStatus(installed, policy);
    res.set('Cache-Control', 'no-store');
    res.json({
      success: true,
      status,
      minRequiredVersionCode: policy.minRequiredVersionCode,
      latest: publicRelease(policy.latest),
      // Only when the phone is too old: the Android it would need, in words.
      ...(status === 'unsupported' ? { requiredAndroid: androidLabel(policy.unsupportedMinSdk) } : {}),
    });
  } catch (err) {
    return serverError(res, err, 'GET /app/android/update', 'Could not check for updates');
  }
});

router.get('/download/android', async (req, res) => {
  try {
    const { latest } = await db.androidReleases.getUpdatePolicy(expectedPackage());
    if (!latest) return refused(res, 404, 'The Android app is not available right now.');
    return res.redirect(302, latest.fileUrl);
  } catch (err) {
    return serverError(res, err, 'GET /download/android', 'Server error');
  }
});

export default router;
