// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The cross-panel end-to-end driver's harness.
 *
 * ── What this is for, and why it is not a route test ────────────────────────
 * `backend/tests/routes/**` mount one router with supertest. That proves a
 * handler works and, as §28 says, can never prove anything CALLS it — and it
 * skips every piece of the real stack in front of the router: the rate
 * limiters, the CSP, `authenticate`, the surge breakers, the SPA catch-alls.
 *
 * This drives the WHOLE server over real HTTP as three different actors, and
 * consults the database directly for the facts no panel shows — escrow holds,
 * ledger rows, what a trigger refuses. Every defect it has found was invisible
 * to the tiers above it: a rate limiter that charged a player for the refusal
 * that taught them the rule, a merchant balance never emitted, a second
 * dispute route with no cooling-off period.
 */
import { signToken } from '../../domains/identity/paseto.util.js';

export const BASE = process.env.BB_BASE ?? 'http://127.0.0.1:8080';
const RUN = Math.random().toString(36).slice(2, 8);
export const rid = (p) => `e2e-${p}-${RUN}-${(rid.n = (rid.n ?? 0) + 1)}`;
export const RUNID = RUN;

const rows = [];
export function record(area, actor, action, expected, got, verdict, note = '') {
  rows.push({ area, actor, action, expected, got, verdict, note });
  const mark = { PASS: '  ok', FAIL: 'FAIL', NOTE: 'note' }[verdict] ?? verdict;
  console.log(`${mark}  [${area}] ${actor}: ${action}\n        expected: ${expected}\n        got     : ${got}${note ? `\n        note    : ${note}` : ''}`);
}
export const check = (area, actor, action, expected, got, ok, note) =>
  record(area, actor, action, expected, got, ok ? 'PASS' : 'FAIL', note);
export const note = (area, actor, action, expected, got, n) =>
  record(area, actor, action, expected, got, 'NOTE', n);

export function summary() {
  const f = rows.filter(r => r.verdict === 'FAIL');
  const n = rows.filter(r => r.verdict === 'NOTE');
  console.log(`\n${'═'.repeat(78)}`);
  console.log(`TOTAL ${rows.length}   PASS ${rows.length - f.length - n.length}   FAIL ${f.length}   NOTE ${n.length}`);
  if (f.length) {
    console.log(`\n── FAILURES ──`);
    for (const r of f) console.log(`   [${r.area}] ${r.actor}: ${r.action}\n      expected ${r.expected}\n      got      ${r.got}${r.note ? `\n      ${r.note}` : ''}`);
  }
  if (n.length) {
    console.log(`\n── NOTES ──`);
    for (const r of n) console.log(`   [${r.area}] ${r.actor}: ${r.action} — ${r.note}`);
  }
  return { total: rows.length, failed: f.length, noted: n.length, rows };
}

// ── Tokens are minted, not obtained through the login screen ────────────────
// Login is behind Cloudflare Turnstile and there is no secret key for this
// environment. Minting the SAME payload the login routes mint exercises every
// route, guard and middleware after authentication — which is where the
// behaviour under test lives — without pretending the captcha was solved.
export const playerToken   = (u) => signToken({ userId: u.userId, mobile: u.mobile, role: 'user', isAdmin: false, isSubAdmin: false, amr: ['pwd'], permissions: {} });
export const merchantToken = (m) => signToken({ merchantId: m._id ?? m.merchantId, userId: m.userId ?? m._id ?? m.merchantId, mobile: m.mobile, isMerchant: true, isAdmin: false });
export const adminToken    = (u) => signToken({ userId: u.userId, mobile: u.mobile, role: 'admin', isAdmin: true, isSubAdmin: false, isQueueManager: true, amr: ['pwd', 'otp'], permissions: {} });

/**
 * One request, as one of the three actors.
 *
 * ── `headers`, and why a harness that cannot send one is blind ────────────
 * §32 S26 is the gap between "a button calls a route" and "the route accepts
 * the call": `POST /admin/merchants/:id/deduct` requires an `Idempotency-Key`
 * and answers 400 without one, and the admin panel's button had never once
 * worked. A harness with no way to send a header cannot exercise either side
 * of that — it can only ever confirm the 400.
 */
export async function api(token, method, path, body, headers = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { _raw: text.slice(0, 300) }; }
  return { status: res.status, body: json };
}
export const GET = (t, p, h) => api(t, 'GET', p, undefined, h);
export const POST = (t, p, b, h) => api(t, 'POST', p, b ?? {}, h);
export const PUT = (t, p, b, h) => api(t, 'PUT', p, b ?? {}, h);
export const DEL = (t, p, h) => api(t, 'DELETE', p, undefined, h);

/** A fresh idempotency key, for the routes that require one and mean it. */
export const idemKey = () => ({ 'Idempotency-Key': `e2e-${RUN}-${Math.random().toString(36).slice(2, 12)}` });
