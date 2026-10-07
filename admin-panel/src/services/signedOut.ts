// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * ── Why the panel signed the operator out, said on the sign-in screen ──────
 * A session the server refuses (401 "Your password was changed. Please sign in
 * again.", 403 "Account blocked", "This account has been closed. Contact
 * support.") is cleared and the panel reloads at its sign-in form. That form
 * said nothing: the operator was shown "Choose your role to continue", typed
 * their password, and only then read the reason, or never did (§32 S48, S14).
 *
 * The shape the merchant panel fixed in Step 2g, mirrored: the server's own
 * words are kept in sessionStorage across that one reload, read once by
 * `Login.tsx`, and announced there (`role="alert"`, S44).
 *
 * Its own module, not `api.ts`: the HTTP client's interceptor ends a refused
 * session and the store (`auth.ts`) ends one too, and the store already
 * imports the client. Suites that stub `services/api` wholesale keep this.
 */
const SIGNED_OUT_REASON_KEY = 'adminSignedOutReason';

// Read once per page load, then remembered for it: React's StrictMode runs a
// state initialiser twice, and the second read must not find it already gone.
let signedOutReasonRead = false;
let signedOutReasonValue: string | null = null;

const keepSignedOutReason = (reason?: string | null): void => {
  // Whatever this page load already showed is over: a Log out after a
  // re-sign-in must not show the previous reason again.
  signedOutReasonRead = true;
  signedOutReasonValue = null;
  const said = String(reason ?? '').trim().slice(0, 300);
  if (!said) return;
  try { sessionStorage.setItem(SIGNED_OUT_REASON_KEY, said); } catch { /* blocked storage: the form still renders */ }
};

/** Why the last page load signed this operator out, in the server's words; once. */
export const signedOutReason = (): string | null => {
  if (signedOutReasonRead) return signedOutReasonValue;
  signedOutReasonRead = true;
  try {
    signedOutReasonValue = sessionStorage.getItem(SIGNED_OUT_REASON_KEY);
    sessionStorage.removeItem(SIGNED_OUT_REASON_KEY);
  } catch { signedOutReasonValue = null; }
  return signedOutReasonValue;
};

/** A plain sign-out: no reason, and none left over from earlier. */
export const forgetSignedOutReason = (): void => keepSignedOutReason(null);

/**
 * The server's own refusal, and only that: a JSON body saying `success: false`.
 * A 403 page from a proxy or CDN arrives as text and would otherwise be shown
 * as "You were signed out: <html>…".
 */
export const serverRefusal = (body: unknown): string | null => {
  const b = body as { success?: unknown; message?: unknown } | null;
  return b && typeof b === 'object' && b.success === false && typeof b.message === 'string' ? b.message : null;
};

/**
 * End a session the SERVER refused, and reload at this panel's own sign-in form.
 *
 * `BASE_URL` (vite `base`, `/admin/`), not `/`: this panel is served under
 * `/admin/`, and `/` is the PLAYER app (Caddyfile). The redirect this replaces
 * was `'/#/login'`, which the dev server bounced back to `/admin/` and
 * production served as the player app. A URL with no fragment is a full load,
 * so nothing of the refused session survives in memory; the route table then
 * lands on `#/login`, where the reason is read.
 */
export const endRefusedSession = (reason?: string | null): void => {
  localStorage.removeItem('admin-auth');
  keepSignedOutReason(reason);
  window.location.href = import.meta.env.BASE_URL;
};
