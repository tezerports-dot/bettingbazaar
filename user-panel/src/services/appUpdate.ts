// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * services/appUpdate.ts — what "Update" means, which depends on what is running.
 *
 * `SystemGuard` (App.tsx) shows the update screen when the BUNDLED version is
 * below the admin's `minVersion`. On the web that is fixed by dropping the
 * service worker and reloading: the next load fetches the new bundle.
 *
 * In the Android APK the bundle is inside the package. A reload loads the SAME
 * old assets, compares the SAME old version, and shows the SAME screen — so a
 * player whose install an admin had just declared too old could not get out of
 * it from inside the app, and the only instruction on the screen was a button
 * that went round in a circle. The only thing that updates a native install is
 * a new APK, so there the button opens the download.
 *
 * `/api/download/android` 302s to whatever `androidUrl` the admin set, so the
 * link survives every release. It is opened with window.open: Capacitor serves
 * no second window, so the navigation reaches Bridge.launchIntent, which hands
 * any host other than the app's own to the system (an ACTION_VIEW intent) — the
 * browser downloads the file and the installer takes it from there.
 */
import { apiUrl } from './apiUrl';
import { isNativeShell } from './nativeLifecycle';

/** The native download path, resolved against the API origin. Exported for the test. */
export function androidDownloadUrl(): string {
  return apiUrl('/api/download/android');
}

export function startAppUpdate(): void {
  if (isNativeShell()) {
    window.open(androidDownloadUrl(), '_blank');
    return;
  }

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.getRegistrations().then((regs) => {
      for (const reg of regs) reg.unregister();
      window.location.reload();
    });
  } else {
    window.location.reload();
  }
}
