// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Every failure on the merchant panel, for the admin's error log (owner,
 * 2026-10-20; the server decides category and severity from `kind`:
 * backend/server.js `/api/internal/error-report`, database/repositories/errorLog.js).
 *
 *   crash    a screen the ErrorBoundary caught
 *   error    an uncaught script error
 *   promise  a promise nobody handled
 *
 * A page load sends each distinct error once and at most `MAX_REPORTS` in all.
 */
import { reportPanelError } from './api';

export type ErrorKind = 'crash' | 'error' | 'promise';

const MAX_REPORTS = 20;
const sent = new Set<string>();
const IGNORED = /ResizeObserver loop|^Script error\.?$|Non-Error promise rejection captured/i;

const messageOf = (err: unknown): string => {
  if (err instanceof Error) return err.message || err.name;
  if (typeof err === 'string') return err;
  try { return JSON.stringify(err) ?? String(err); } catch { return String(err); }
};

/** A chunk of the panel that failed to load: the page is older than the deploy. */
export const isStaleBuildError = (err: unknown): boolean =>
  /dynamically imported module|Loading chunk|Importing a module script failed|error loading dynamically/i.test(messageOf(err));

export function reportError(kind: ErrorKind, err: unknown, component?: string | null): void {
  try {
    const message = messageOf(err).slice(0, 2000);
    if (!message || IGNORED.test(message)) return;
    const key = `${kind}|${message}`;
    if (sent.has(key) || sent.size >= MAX_REPORTS) return;
    sent.add(key);
    reportPanelError({
      kind, message,
      stack: err instanceof Error ? err.stack : undefined,
      component: component ?? undefined,
      url: window.location.href,
    });
  } catch { /* reporting never breaks the panel */ }
}

/** Reload once (at most once a minute) into the new build after a deploy. */
export function reloadForNewBuild(): boolean {
  try {
    const KEY = 'bb_stale_reload_at';
    const last = Number(sessionStorage.getItem(KEY) || 0);
    if (Date.now() - last < 60_000) return false;
    sessionStorage.setItem(KEY, String(Date.now()));
    window.location.reload();
    return true;
  } catch { return false; }
}

let installed = false;
/** Listen for uncaught errors and unhandled promises. Once, at boot. */
export function installErrorReporter(): void {
  if (installed) return;
  installed = true;
  window.addEventListener('error', (e) => {
    const err = e.error ?? e.message;
    if (isStaleBuildError(err) && reloadForNewBuild()) return;
    reportError('error', err);
  });
  window.addEventListener('unhandledrejection', (e) => {
    if (isStaleBuildError(e.reason) && reloadForNewBuild()) return;
    reportError('promise', e.reason);
  });
}
