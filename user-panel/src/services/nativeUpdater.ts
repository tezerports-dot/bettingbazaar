// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * services/nativeUpdater.ts — the installed Android app keeping itself current.
 *
 * Asks the server what it should be running (`/api/app/android/update`, whose
 * rule lives in androidRelease.routes.js — this file carries no copy of it),
 * then drives the native ApkUpdater plugin (android/.../ApkUpdaterPlugin.java):
 * download with progress, verify the SHA-256, hand to Android's installer.
 *
 * Only ever loaded inside the native shell (NativeUpdateGate imports it
 * lazily), so the web bundle never carries the plugin bridge.
 */
import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import { apiUrl } from './apiUrl';

export interface ReleaseInfo {
  versionCode: number;
  versionName: string;
  downloadUrl: string;
  sha256: string;
  sizeBytes: number;
  releaseNotes: string;
  mandatory: boolean;
  minSdk: number | null;
  publishedAt: string | null;
}

export interface UpdateCheck {
  /**
   * 'unsupported': below a mandatory release this phone's Android cannot
   * install — the app must stop, and say the phone is too old.
   */
  status: 'required' | 'unsupported' | 'available' | 'current';
  minRequiredVersionCode: number;
  latest: ReleaseInfo | null;
  installedVersionCode: number;
  /** Only with 'unsupported': the Android it needs, worded by the server. */
  requiredAndroid?: string;
}

interface ApkUpdaterPlugin {
  download(o: { url: string; sha256: string; sizeBytes: number }): Promise<{ path: string }>;
  install(o: { path: string }): Promise<{ status: 'started' | 'needs_permission' }>;
  canInstall(): Promise<{ allowed: boolean }>;
  sdkLevel(): Promise<{ sdkInt: number }>;
  openInstallSettings(): Promise<void>;
  addListener(
    event: 'downloadProgress',
    cb: (p: { received: number; total: number }) => void,
  ): Promise<PluginListenerHandle>;
}

export const ApkUpdater = registerPlugin<ApkUpdaterPlugin>('ApkUpdater');

/** The installed build's versionCode — Android's own integer, never the label. */
export async function installedVersionCode(): Promise<number | null> {
  try {
    const { App } = await import('@capacitor/app');
    const code = Number((await App.getInfo()).build);
    return Number.isInteger(code) && code > 0 ? code : null;
  } catch {
    return null;
  }
}

/**
 * This phone's Android API level, or null — an install older than this plugin
 * method has no way to say, and the server then treats every release as
 * installable, which is what it did before.
 */
export async function deviceSdk(): Promise<number | null> {
  try {
    const { sdkInt } = await ApkUpdater.sdkLevel();
    return Number.isInteger(sdkInt) && sdkInt > 0 ? sdkInt : null;
  } catch {
    return null;
  }
}

/**
 * Where the APK is. The server hands back an absolute CDN URL in production;
 * in development the file is served by the API itself under a relative path,
 * which inside the app must be resolved against the API origin, not the phone.
 */
export function resolveDownloadUrl(url: string): string {
  return /^https?:\/\//i.test(url) ? url : apiUrl(url.startsWith('/') ? url : `/${url}`);
}

/** Null when the check could not be made — offline, or the server is down. Never blocks on that. */
export async function checkForUpdate(): Promise<UpdateCheck | null> {
  const installed = await installedVersionCode();
  if (installed == null) return null;
  try {
    const sdk = await deviceSdk();
    const query = `versionCode=${installed}${sdk ? `&sdk=${sdk}` : ''}`;
    const res = await fetch(apiUrl(`/api/app/android/update?${query}`), { cache: 'no-store' });
    if (!res.ok) return null;
    const body = await res.json();
    if (!body?.success) return null;
    return {
      status: body.status,
      minRequiredVersionCode: Number(body.minRequiredVersionCode) || 0,
      latest: body.latest ? { ...body.latest, downloadUrl: resolveDownloadUrl(body.latest.downloadUrl) } : null,
      installedVersionCode: installed,
      ...(body.requiredAndroid ? { requiredAndroid: String(body.requiredAndroid) } : {}),
    };
  } catch {
    return null;
  }
}

// ── Postponing an optional update ────────────────────────────────────────────
const SNOOZE_KEY = 'bb_update_snoozed';
// §11: how long "Later" lasts on this phone — a UI convenience. It can never
// hide a REQUIRED update (shouldShow), which is the server's decision.
export const SNOOZE_MS = 24 * 60 * 60 * 1000;

/**
 * Whether to show the update now. A REQUIRED update is always shown and cannot
 * be postponed; an available one is shown unless the player chose "Later" for
 * that same version within the last day. A NEWER version clears the snooze —
 * "later" was an answer about the version they were shown.
 */
export function shouldShow(check: UpdateCheck | null, now = Date.now(), snooze = readSnooze()): boolean {
  // Too old to run, with or without a release it could install: always shown.
  if (check?.status === 'unsupported') return true;
  if (!check?.latest || check.status === 'current') return false;
  if (check.status === 'required') return true;
  return !(snooze && snooze.versionCode === check.latest.versionCode && now - snooze.at < SNOOZE_MS);
}

function readSnooze(): { versionCode: number; at: number } | null {
  try { return JSON.parse(localStorage.getItem(SNOOZE_KEY) || 'null'); } catch { return null; }
}

export function snooze(versionCode: number, now = Date.now()): void {
  try { localStorage.setItem(SNOOZE_KEY, JSON.stringify({ versionCode, at: now })); } catch { /* storage refused — it will simply ask again */ }
}

export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function percent(received: number, total: number): number {
  if (!total || total <= 0) return 0;
  return Math.max(0, Math.min(100, Math.floor((received / total) * 100)));
}
