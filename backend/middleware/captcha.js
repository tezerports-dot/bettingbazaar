// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * middleware/captcha.js — bot-mitigation challenge on credential endpoints.
 *
 * Closes the second of the two gaps LAUNCH_READINESS §F called out. Rate
 * limiting was the only automated-abuse control, and it is the wrong shape for
 * the attack that matters: the login tiers count FAILURES per IP, so a
 * credential-stuffing run spread thin across thousands of residential addresses
 * never reaches any counter. Each IP tries three passwords and moves on. A
 * challenge prices the attempt itself rather than the failure.
 *
 * ── Provider ───────────────────────────────────────────────────────────────
 * Cloudflare Turnstile. Chosen over reCAPTCHA/hCaptcha because it is free at
 * any volume, needs no image puzzle in the common case (so it costs a real
 * player nothing), and sends no data to an ad network — which matters when the
 * form it protects is a gambling login.
 *
 * ── Dormant until configured ───────────────────────────────────────────────
 * With `TURNSTILE_SECRET_KEY` unset this is a pass-through, matching how every
 * other integration in this repo ships (S3, RAG, Kafka, the money DB). A
 * deployment that has not set up Turnstile behaves exactly as before rather
 * than locking everyone out of a login form that suddenly demands a token
 * nobody's browser is sending.
 *
 * ── Failure policy, stated because it is a real trade-off ──────────────────
 * Two different failures, two different answers:
 *
 *   Token missing / invalid / already used → 403. This is the attack case and
 *   it must fail closed. A replayed token is treated as invalid because
 *   Turnstile tokens are single-use by design.
 *
 *   Cloudflare unreachable or 5xx → ALLOW, and alert. Failing closed here would
 *   convert someone else's outage into a total login outage for every player,
 *   admin and merchant simultaneously — a worse and more likely event than the
 *   credential stuffing that happens to coincide with it. The per-IP and
 *   per-subnet limiters plus the surge breaker are still in front, so the
 *   fallback is the protection that existed before this middleware, not
 *   nothing.
 *
 * That asymmetry is deliberate: an attacker cannot induce the fail-open path,
 * because they do not control whether Cloudflare answers us.
 */
import { sendAlert } from '../services/alerting.service.js';

const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/** Bounded so a hung verifier cannot hold a login request open indefinitely. */
const VERIFY_TIMEOUT_MS = Number(process.env.TURNSTILE_TIMEOUT_MS || 4000);

export function captchaConfigured() {
  return !!String(process.env.TURNSTILE_SECRET_KEY || '').trim();
}

/**
 * Verify a Turnstile token with Cloudflare.
 *
 * @returns {Promise<{ok: boolean, reachable: boolean, codes?: string[]}>}
 *   `reachable: false` means we could not get an answer — the caller decides
 *   what to do, and this module's policy is to allow (see the header note).
 */
export async function verifyCaptchaToken(token, remoteIp) {
  const secret = String(process.env.TURNSTILE_SECRET_KEY || '').trim();
  if (!secret) return { ok: true, reachable: true };          // not configured
  if (!token)  return { ok: false, reachable: true, codes: ['missing-input-response'] };

  const body = new URLSearchParams({ secret, response: String(token) });
  // Cloudflare uses the IP only to score the challenge. Passing the value
  // Express resolved means it is the real client address when TRUST_PROXY is
  // configured, and the proxy's otherwise — never a client-supplied header.
  if (remoteIp) body.set('remoteip', String(remoteIp));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VERIFY_TIMEOUT_MS);
  try {
    const res = await fetch(VERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: controller.signal,
    });
    if (!res.ok) return { ok: false, reachable: false };
    const data = await res.json();
    return { ok: !!data.success, reachable: true, codes: data['error-codes'] || [] };
  } catch {
    // Timeout, DNS, TLS, connection reset — no verdict obtained.
    return { ok: false, reachable: false };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Express middleware. Reads the token from the body field Turnstile's widget
 * posts by default, with a header fallback for native clients that send JSON
 * bodies they would rather not reshape.
 *
 * @param {string} action label used in logs/alerts, e.g. 'login'
 */
export function requireCaptcha(action = 'form') {
  return async function captchaGate(req, res, next) {
    if (!captchaConfigured()) return next();

    const token = req.body?.['cf-turnstile-response']
      || req.body?.captchaToken
      || req.headers['x-captcha-token'];

    const verdict = await verifyCaptchaToken(token, req.ip);

    if (verdict.ok) return next();

    if (!verdict.reachable) {
      // Someone else's outage must not become a platform-wide login outage.
      console.warn(`[captcha] verifier unreachable — allowing ${action} without a challenge`);
      sendAlert('captcha-verifier-unreachable',
        'Turnstile could not be reached; captcha is temporarily not enforced', { action })
        .catch(() => {});
      return next();
    }

    return res.status(403).json({
      success: false,
      code: 'CAPTCHA_REQUIRED',
      message: 'Please complete the verification challenge and try again.',
    });
  };
}

export default requireCaptcha;
