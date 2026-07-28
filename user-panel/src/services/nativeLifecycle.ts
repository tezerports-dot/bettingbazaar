// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * services/nativeLifecycle.ts — keep realtime alive across Android's app lifecycle.
 *
 * ── The failure this prevents ──────────────────────────────────────────────
 * Android suspends a backgrounded app's network activity. When the player
 * switches away — to a UPI app to fund a deposit, which is a normal part of the
 * flow here — the socket is frozen. On resume it frequently still reports
 * `connected` over a WebSocket that is dead, and socket.io only notices when
 * the server's ping timeout elapses, tens of seconds later.
 *
 * In that window the cycle screen keeps rendering the pools, odds and timer it
 * had before, with nothing to indicate they are stale. On a betting screen
 * those are the numbers people commit money against, and a bet placed into a
 * cycle that has since closed is rejected by the backend — correct, but a
 * baffling experience.
 *
 * So every foreground transition rebuilds the socket rather than waiting for a
 * timeout to discover the obvious.
 *
 * ── Web is untouched ───────────────────────────────────────────────────────
 * Nothing registers outside the native shell. A browser tab does not get its
 * sockets frozen this way, and socket.io's own reconnection is adequate there.
 */

/** True only inside the Capacitor Android shell. */
export function isNativeShell(): boolean {
  return !!(window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } })
    .Capacitor?.isNativePlatform?.();
}

let registered = false;

/**
 * Rebuild the realtime connection whenever the app returns to the foreground.
 * Safe to call more than once — only the first call registers a listener.
 *
 * @param onForeground invoked on each resume; wire this to the backend's
 *                     reconnectRealtime().
 * @returns a teardown function, or null when nothing was registered.
 */
export async function registerNativeLifecycle(
  onForeground: () => void,
): Promise<(() => void) | null> {
  if (!isNativeShell() || registered) return null;
  registered = true;

  try {
    // Imported lazily so the web bundle never pulls in the native plugin.
    const { App } = await import('@capacitor/app');

    const handle = await App.addListener('appStateChange', ({ isActive }) => {
      if (isActive) onForeground();
    });

    return () => {
      handle.remove();
      registered = false;
    };
  } catch (error) {
    // A missing plugin must never stop the app from running — realtime simply
    // stays as reliable as it was before this existed.
    console.warn('[native] app lifecycle listener unavailable:', error);
    registered = false;
    return null;
  }
}
