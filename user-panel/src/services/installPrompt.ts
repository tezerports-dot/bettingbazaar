// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * services/installPrompt.ts — "Install app": the browser's own install prompt
 * for this PWA, kept from the moment the browser offers it.
 *
 * Chrome and Edge (Android and desktop) fire `beforeinstallprompt` once, early,
 * and only a page that kept the event can show the prompt later, from a tap.
 * So the listener is installed at startup (`index.tsx`), before any screen
 * mounts, and the screens ask `installState()`.
 *
 * Safari (iPhone, iPad) has no such event: a web app is installed from the
 * Share menu, "Add to Home Screen". There the button explains that instead.
 * In the Android app, or once installed (`display-mode: standalone`), there is
 * nothing to install and no button is offered.
 */
import { isNativeShell } from './nativeLifecycle';

/** The slice of the `beforeinstallprompt` event this uses. */
interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

let deferred: InstallPromptEvent | null = null;
let installed = false;
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((fn) => fn());

/** Keep the browser's install prompt for a later tap. Called once at startup. */
export function listenForInstallPrompt(): void {
  if (typeof window === 'undefined') return;
  window.addEventListener('beforeinstallprompt', (e) => {
    // Stops the browser's own mini-infobar; the button shows the prompt instead.
    e.preventDefault();
    deferred = e as InstallPromptEvent;
    changed();
  });
  window.addEventListener('appinstalled', () => { deferred = null; installed = true; changed(); });
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

/**
 * What an "Install app" button can do here:
 *   prompt  the browser kept its install prompt: a tap shows it.
 *   ios     Safari: explain Share › Add to Home Screen.
 *   none    already installed, the Android app, or a browser that offers no
 *           install at all: no button.
 */
export type InstallState = 'prompt' | 'ios' | 'none';

export function installState(): InstallState {
  if (installed || isNativeShell() || standalone()) return 'none';
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
  return outcome === 'accepted';
}

/** Re-render when the answer to `installState()` may have changed. */
export function onInstallStateChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
