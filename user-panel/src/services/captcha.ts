// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * services/captcha.ts — obtain a Cloudflare Turnstile token for a form submit.
 *
 * Pairs with `backend/middleware/captcha.js`. Both halves are dormant until
 * their key is set: with `VITE_TURNSTILE_SITE_KEY` unset this resolves `null`,
 * the request goes out without a token, and the server — which is equally
 * unconfigured — passes it through. Configuring only one side is the
 * misconfiguration worth knowing about: server-only rejects every login,
 * client-only sends a token nobody checks.
 *
 * ── Invisible by default ───────────────────────────────────────────────────
 * Rendered in `execute` mode rather than as a visible checkbox, so a real
 * player normally sees nothing at all — the challenge resolves from browser
 * signals. Only a genuinely suspicious client is shown an interaction. That is
 * the whole reason for choosing Turnstile over reCAPTCHA here: the anti-abuse
 * control should cost an honest user zero taps on a betting form.
 *
 * ── Tokens are single-use ──────────────────────────────────────────────────
 * Cloudflare invalidates a token once redeemed, so one is fetched per submit
 * rather than once per page. A cached token would work for the first login
 * attempt and mysteriously 403 every retry after a wrong password — which is
 * exactly when a user retries most.
 */

interface TurnstileApi {
  render: (el: HTMLElement, opts: Record<string, unknown>) => string;
  execute: (widgetId: string) => void;
  remove: (widgetId: string) => void;
}

function turnstile(): TurnstileApi | null {
  return (window as unknown as { turnstile?: TurnstileApi }).turnstile ?? null;
}

function siteKey(): string {
  return String((import.meta as any).env?.VITE_TURNSTILE_SITE_KEY || '').trim();
}

export function captchaEnabled(): boolean {
  return !!siteKey();
}

let scriptPromise: Promise<void> | null = null;

/** Load the Turnstile script once, on first use — never on page load. */
function loadScript(): Promise<void> {
  if (turnstile()) return Promise.resolve();
  if (scriptPromise) return scriptPromise;

  scriptPromise = new Promise<void>((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    s.async = true;
    s.defer = true;
    s.onload = () => resolve();
    s.onerror = () => { scriptPromise = null; reject(new Error('turnstile script failed')); };
    document.head.appendChild(s);
  });
  return scriptPromise;
}

/**
 * Get a fresh token for one submission.
 *
 * Resolves `null` — never rejects — when captcha is disabled or Cloudflare
 * cannot be reached. The caller submits without a token and the server decides:
 * it allows the request when its own verifier is unreachable, and refuses when
 * a token was required and genuinely invalid. Throwing here instead would let a
 * Cloudflare outage block the login form on the client, before the server ever
 * gets the chance to apply that policy.
 *
 * @param timeoutMs give up and submit without a token after this long.
 */
export async function getCaptchaToken(timeoutMs = 8000): Promise<string | null> {
  const key = siteKey();
  if (!key) return null;

  // Typed explicitly: TS narrows `container` to `never` in the catch block
  // otherwise, because every assignment happens inside the try.
  let container: HTMLElement | undefined;
  let widgetId: string | null = null;

  try {
    await loadScript();
    const api = turnstile();
    if (!api) return null;

    return await new Promise<string | null>((resolve) => {
      const done = (v: string | null) => {
        clearTimeout(timer);
        try { if (widgetId) api.remove(widgetId); } catch { /* already gone */ }
        container?.remove();
        resolve(v);
      };
      const timer = setTimeout(() => done(null), timeoutMs);

      container = document.createElement('div');
      container.style.display = 'none';
      document.body.appendChild(container);

      widgetId = api.render(container, {
        sitekey: key,
        execution: 'execute',   // invisible unless the client looks suspicious
        callback: (token: string) => done(token),
        'error-callback': () => done(null),
        'timeout-callback': () => done(null),
      });
      api.execute(widgetId);
    });
  } catch {
    container?.remove();
    return null;
  }
}

export default getCaptchaToken;
