// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * services/installPrompt.ts — "Install app" for the merchant panel (owner,
 * 2026-10-21: shown in the browser only, never inside the installed app).
 * The panel's own copy of the player app's (`user-panel/src/services/
 * installPrompt.ts`; §15: no panel imports another's `src/`).
 *
 * Chrome and Edge (Android and desktop) fire `beforeinstallprompt` once,
 * early, and only a page that kept the event can show the prompt later from a
 * tap, so the listener is installed at startup (`main.tsx`). Safari (iPhone,
 * iPad) has no such event: the button explains Share › Add to Home Screen.
 * Once installed (`display-mode: standalone`) no button is offered.
 */

/** The slice of the `beforeinstallprompt` event this uses. */
interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

let deferred: InstallPromptEvent | null = null;
let installed = false;
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((fn) => fn());

/** Keep the browser's install prompt for a later tap, and register the worker that makes the panel installable. */
export function listenForInstallPrompt(): void {
  if (typeof window === 'undefined') return;
  window.addEventListener('beforeinstallprompt', (e) => {
    // Stops the browser's own mini-infobar; the button shows the prompt instead.
    e.preventDefault();
    deferred = e as InstallPromptEvent;
    changed();
  });
  window.addEventListener('appinstalled', () => { deferred = null; installed = true; changed(); });
  if (import.meta.env.PROD && 'serviceWorker' in navigator) {
    navigator.serviceWorker.register('/merchant/sw.js', { scope: '/merchant/' }).catch(() => { /* no install offer; the panel works as before */ });
  }
}

function standalone(): boolean {
  if (typeof window === 'undefined') return false;
  const iosStandalone = (navigator as unknown as { standalone?: boolean }).standalone === true;
  return iosStandalone || Boolean(window.matchMedia?.('(display-mode: standalone)').matches);
}

function appleMobile(): boolean {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  // iPadOS reports itself as a Mac; a touch screen tells them apart.
  return /iPhone|iPad|iPod/i.test(ua) || (/Macintosh/i.test(ua) && (navigator.maxTouchPoints || 0) > 1);
}

/** prompt: a tap shows the browser's prompt · ios: explain Safari · none: installed, or nothing to offer. */
export type InstallState = 'prompt' | 'ios' | 'none';

export function installState(): InstallState {
  if (installed || standalone()) return 'none';
  if (deferred) return 'prompt';
  return appleMobile() ? 'ios' : 'none';
}

/** Show the browser's install prompt. Resolves whether the person accepted. */
export async function promptInstall(): Promise<boolean> {
  const e = deferred;
  if (!e) return false;
  // A kept prompt can be shown once; the browser offers a new one if declined.
  deferred = null;
  changed();
  await e.prompt();
  const { outcome } = await e.userChoice;
  if (outcome === 'accepted') { installed = true; changed(); }
  return outcome === 'accepted';
}

/** Re-render when the answer to `installState()` may have changed. Returns the unsubscribe. */
export function onInstallStateChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
