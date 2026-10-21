// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * services/chunkRecovery.ts — a page opened before a deploy keeps working after it.
 *
 * Every build names its chunks by content (`ReferralPage-<hash>.js`), and a
 * deploy replaces them. A page that was already open, or whose old shell the
 * service worker served, still holds the OLD names: its first tap on a lazy
 * page (Refer & Earn, Wallet, Casino…) asks for a file the server no longer
 * has, and React shows "Failed to fetch dynamically imported module" (the
 * admin's error log, 2026-10-20). The cure is the new build: reload once, and
 * the page comes back with the names that exist.
 *
 * Once per RELOAD_GUARD_MS, so a chunk that is genuinely missing (a broken
 * deploy) reaches the error screen instead of reloading for ever. Storage may
 * be absent (a private window): then the reload still happens, just unguarded
 * past the first try, which the error boundary then catches.
 */

const KEY = 'bb_chunk_reload_at';
/** A second stale chunk within this long is a broken deploy, not an old page. */
export const RELOAD_GUARD_MS = 30_000;

/** Whether `err` is a lazy chunk that could not be fetched, in any browser's words. */
export function isStaleChunkError(err: unknown): boolean {
  const m = String((err as { message?: unknown })?.message ?? err ?? '');
  return /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Unable to preload CSS|ChunkLoadError|Loading chunk [\w-]+ failed/i.test(m);
}

/** Reload for the new build unless one was just tried. True when a reload was started. */
export function reloadForNewBuild(): boolean {
  let last = 0;
  try { last = Number(sessionStorage.getItem(KEY)) || 0; } catch { /* no storage: unguarded */ }
  if (Date.now() - last < RELOAD_GUARD_MS) return false;
  try { sessionStorage.setItem(KEY, String(Date.now())); } catch { /* reload anyway */ }
  window.location.reload();
  return true;
}

/**
 * A lazy page's loader that reloads for the new build when its chunk is gone.
 * While the reload happens it never settles, so no error screen flashes first.
 */
export function recoveringLoader<T>(load: () => Promise<T>): () => Promise<T> {
  return () => load().catch((err: unknown) => {
    if (isStaleChunkError(err) && reloadForNewBuild()) return new Promise<T>(() => {});
    throw err;
  });
}

/**
 * Vite's own signal that a chunk it preloads failed (`vite:preloadError`):
 * the same old-page case, caught before the import even runs.
 */
export function installChunkRecovery(): void {
  window.addEventListener('vite:preloadError', (e) => {
    if (reloadForNewBuild()) e.preventDefault();
  });
}
