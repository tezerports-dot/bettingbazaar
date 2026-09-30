// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * services/appUpdate.ts — the WEB bundle's version gate.
 *
 * `SystemGuard` (App.tsx) shows "Update Available" when the running bundle is
 * older than the admin's `minVersion`. On the web that is fixed by dropping the
 * service worker and reloading: the next load fetches the new bundle.
 *
 * It does not apply inside the Android app, and must not. The APK's bundle is
 * in the package, so a reload runs the same old assets, compares the same old
 * version and shows the same screen — a loop with no exit. The APK is updated
 * by installing a newer APK, which NativeUpdateGate does from the releases an
 * admin publishes on the Android App page. One mechanism per install type, so
 * there is never a question of which one is in charge (§2).
 */

/** Whether the web gate should block. Never inside the native shell. */
export function webBundleOutdated(
  appVersion: string,
  minVersion: string,
  native: boolean,
  compare: (a: string, b: string) => number,
): boolean {
  if (native) return false;
  if (!appVersion || appVersion === '0.0.0') return false;   // an unversioned dev build
  return compare(appVersion, minVersion) < 0;
}

export function startAppUpdate(): void {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.getRegistrations().then((regs) => {
      for (const reg of regs) reg.unregister();
      window.location.reload();
    });
  } else {
    window.location.reload();
  }
}
