// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * androidRelease.shared.js — what the Android release routes share: the
 * package this platform ships, where an APK is stored, what a phone is told,
 * and the readiness checks. The routes are in androidRelease.admin.routes.js
 * (upload/publish) and androidRelease.routes.js (what installed apps ask).
 *
 *   ADMIN   GET    /api/admin/android/releases          list + readiness checks
 *           POST   /api/admin/android/releases          upload an APK (raw body)
 *           PATCH  /api/admin/android/releases/:id      notes / mandatory
 *           POST   /api/admin/android/releases/:id/publish
 *           POST   /api/admin/android/releases/:id/halt     stop offering a published release
 *           POST   /api/admin/android/releases/:id/resume   offer it again
 *           DELETE /api/admin/android/releases/:id      drafts only
 *   PUBLIC  GET    /api/app/android/update             what an installed app is told
 *           GET    /api/download/android               302 to the newest published APK
 *
 * ── Why the app downloads and installs its own update ───────────────────────
 * A sideloaded APK has no store to update it. Before this, "update" meant the
 * player leaving the app, finding a link in a browser, downloading, and
 * installing — every time. Now the installed app asks /api/app/android/update
 * on launch and on every return to the foreground, downloads the file itself,
 * checks its SHA-256 against the one this route publishes, and hands it to
 * Android's installer (android/.../ApkUpdaterPlugin.java). One tap to start,
 * one tap on Android's own "Install" — which no app can skip on a phone it does
 * not manage, and should not be able to.
 *
 * ── Mandatory ─────────────────────────────────────────────────────────────
 * A release marked mandatory makes every install BELOW it unusable until it
 * updates: the app shows only the update screen. Any other newer release is
 * offered and can be postponed. The policy is computed here, from the table
 * (§2), and the app only compares its own versionCode against it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normaliseFingerprint } from './apkInspector.js';
import { isS3Configured, uploadBufferToS3 } from '../../services/cdn.service.js';
import { csv } from '../../startup/validateEnv.js';

/**
 * The package this platform ships. A §5 mirror of `appId` in
 * user-panel/capacitor.config.ts and `applicationId` in android/app/build.gradle;
 * ANDROID_PACKAGE_ID (which also feeds assetlinks.json) overrides it.
 */
export const DEFAULT_ANDROID_PACKAGE = 'com.bettingbazaar.app';
export const expectedPackage = () => String(process.env.ANDROID_PACKAGE_ID || DEFAULT_ANDROID_PACKAGE).trim();
export const configuredFingerprints = () => csv(process.env.ANDROID_SHA256_CERT_FINGERPRINTS).map(normaliseFingerprint);

/** An APK is a few MB today; the bound is generous and still refuses a mistake. */
export const MAX_APK_BYTES = 150 * 1024 * 1024;
export const APK_TYPE = 'application/vnd.android.package-archive';

// Local-disk fallback for development (production refuses to boot without S3).
export const RELEASES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'app-releases');
export const LOCAL_RELEASE_PATH = '/downloads/android';

export const refused = (res, status, message, extra = {}) => res.status(status).json({ success: false, message, ...extra });

/** Mark a refusal as the caller's so respondError keeps its wording (§2 httpError). */
export function callerFault(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

/** The public projection — what a phone is told. Never the storage key or the uploader. */
export function publicRelease(r) {
  if (!r) return null;
  return {
    versionCode: r.versionCode,
    versionName: r.versionName,
    downloadUrl: r.fileUrl,
    sha256: r.fileSha256,
    sizeBytes: r.sizeBytes,
    releaseNotes: r.releaseNotes,
    mandatory: r.mandatory,
    minSdk: r.minSdk,
    publishedAt: r.publishedAt,
  };
}

/**
 * The Android release each API level first shipped in. The one place this
 * mapping lives: the admin card and the phone's "too old" screen both get the
 * words from the server rather than keeping a copy (§5).
 */
const ANDROID_RELEASE = {
  21: '5.0', 22: '5.1', 23: '6', 24: '7.0', 25: '7.1', 26: '8.0', 27: '8.1', 28: '9',
  29: '10', 30: '11', 31: '12', 32: '12L', 33: '13', 34: '14', 35: '15', 36: '16',
};
/** "Android 9 (API 28)", or null when the APK declared no minimum. */
export function androidLabel(sdk) {
  if (!Number.isInteger(sdk) || sdk < 1) return null;
  return ANDROID_RELEASE[sdk] ? `Android ${ANDROID_RELEASE[sdk]} (API ${sdk})` : `Android API ${sdk}`;
}

/** The `sdk` a phone reported, or null when it is absent or not a plausible API level. */
export function parseSdk(raw) {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 1000 ? n : null;
}

/**
 * Everything the admin page needs to show before an operator trusts a release
 * to reach phones. Each is a real failure that is invisible on the server.
 */
export function readinessChecks() {
  const origins = csv(process.env.ALLOWED_ORIGINS);
  return {
    packageName: expectedPackage(),
    fingerprints: configuredFingerprints(),
    storage: isS3Configured() ? 'S3' : 'LOCAL',
    checks: [
      {
        key: 'allowed_origins',
        ok: process.env.NODE_ENV !== 'production' || origins.includes('https://localhost'),
        label: 'ALLOWED_ORIGINS includes https://localhost',
        why: 'The app runs at https://localhost inside the phone. Without it every request the app makes is refused by CORS.',
      },
      {
        key: 'fingerprints',
        ok: configuredFingerprints().length > 0,
        label: 'ANDROID_SHA256_CERT_FINGERPRINTS is set',
        why: 'Password-reset links open the app only when your site vouches for its signing key (/.well-known/assetlinks.json). Uploads are also checked against it.',
      },
      {
        key: 'storage',
        ok: isS3Configured() || process.env.NODE_ENV !== 'production',
        label: 'APK storage is S3/CDN',
        why: 'Every instance must serve the same file. Local disk is for development only.',
      },
    ],
  };
}

export async function storeApk(buffer, info) {
  const name = `${info.packageName}-${info.versionName.replace(/[^0-9A-Za-z._-]/g, '_')}-${info.versionCode}-${info.sha256.slice(0, 8)}.apk`;
  if (isS3Configured()) {
    const fileKey = `android/${name}`;
    return { fileUrl: await uploadBufferToS3(fileKey, buffer, APK_TYPE), storage: 'S3', fileKey };
  }
  fs.mkdirSync(RELEASES_DIR, { recursive: true });
  fs.writeFileSync(path.join(RELEASES_DIR, name), buffer);
  return { fileUrl: `${LOCAL_RELEASE_PATH}/${name}`, storage: 'LOCAL', fileKey: name };
}

/**
 * `?versionCode=` is the installed build's own code; the answer is computed
 * here so no client carries its own copy of the rule:
 *   status 'required'    — below the highest mandatory release this phone can
 *                          install: block the app until it updates
 *   status 'unsupported' — below a mandatory release this phone's Android can
 *                          NOT install: block, and say the phone is too old,
 *                          rather than offer an update that can never install
 *   status 'available'   — below the newest release it can install: offer it
 *   status 'current'     — nothing to do
 * Halted releases never appear in the policy (androidReleases.getUpdatePolicy).
 */
export function updateStatus(installedCode, policy) {
  if (!Number.isInteger(installedCode) || installedCode < 1) return 'current';
  if (installedCode < policy.minRequiredVersionCode) return 'required';
  if (policy.unsupportedBelow && installedCode < policy.unsupportedBelow) return 'unsupported';
  if (policy.latest && installedCode < policy.latest.versionCode) return 'available';
  return 'current';
}
