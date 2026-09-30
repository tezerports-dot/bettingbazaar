// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * An expired session is not a failed login attempt.
 *
 * ── What was measured, on a running server ─────────────────────────────────
 * `authLimiter` is the brute-force guard: four FAILED attempts per thirty
 * minutes, keyed by IP, answering "Too many failed login attempts." It is
 * mounted on `/api/v1/auth`, which holds `/me`, `/logout` and `/health` — and
 * NOT ONE of them checks a credential.
 *
 *     four unauthenticated GET /me  →  /me, /logout AND /health all 429,
 *                                      from that IP, for thirty minutes
 *     POST /api/admin/login         →  401, unaffected (its own limiter)
 *     POST /api/merchant/auth/login →  400, unaffected (its own limiter)
 *
 * So it stopped no brute force. What it did was lock a user whose token had
 * just expired — which is what a panel discovers on an ordinary page load, by
 * calling /me — out of reading their profile and OUT OF LOGGING OUT for half an
 * hour, while telling them they had made login attempts they never made. §32
 * S13 (a refusal that costs the user their next attempt) and S14 (a message the
 * reader cannot act on), on an IP-keyed counter, so one person on a shared
 * connection does it to everyone behind it.
 *
 * ── What this suite pins, in BOTH directions ──────────────────────────────
 * The bound is unchanged — still four, still thirty minutes — so the test that
 * matters most is the second one: a failure that is NOT a session check still
 * counts, and still trips the limiter at four. A fix that simply stopped
 * counting would pass the first test and quietly remove the guard.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { authLimiter } from '../../middleware/security.js';

/**
 * A stand-in for `/api/v1/auth`, mounted exactly as server.js mounts it.
 *
 * `/me` and `/logout` answer 401 with no credential, the way the real ones do;
 * `/guess` answers 401 as a credential route would, and is the control: it is
 * NOT in `SESSION_PATHS`, so its failures must still be counted.
 */
function app() {
  const a = express();
  a.set('trust proxy', true);
  a.use('/api/v1/auth', authLimiter, (req, res) => {
    if (req.path === '/health') return res.json({ ok: true });
    return res.status(401).json({ success: false, message: 'Not authenticated' });
  });
  return a;
}

/**
 * A fresh IP per test.
 *
 * The limiter is keyed by IP and its store is shared across this process, so
 * two tests on one address would inherit each other's counter — the shared-state
 * trap of trap 10, in a limiter instead of a table. Each test gets its own.
 */
let n = 0;
const freshIp = () => `203.0.113.${(n = (n + 1) % 250) + 1}`;

describe('the auth limiter and an expired session', () => {
  let server, ip;
  beforeEach(() => { server = app(); ip = freshIp(); });

  const get = (path) => request(server).get(path).set('X-Forwarded-For', ip);

  it('does not lock a user out of /logout after their token expires', async () => {
    // Four page loads with a dead token — the old behaviour spent the whole
    // budget here and 429'd everything after.
    for (let i = 0; i < 4; i++) {
      expect((await get('/api/v1/auth/me')).status).toBe(401);
    }
    // The one that mattered: they can still end their own session.
    expect((await request(server).post('/api/v1/auth/logout').set('X-Forwarded-For', ip)).status)
      .toBe(401);              // unauthenticated, but ANSWERED — not 429
    expect((await get('/api/v1/auth/health')).status).toBe(200);
    expect((await get('/api/v1/auth/me')).status).toBe(401);
  });

  /**
   * The direction that keeps the guard real. Without this, "stop counting"
   * would look like a fix and be a removal.
   */
  it('STILL trips at four on a path that checks a credential', async () => {
    const seen = [];
    for (let i = 0; i < 6; i++) {
      seen.push((await get('/api/v1/auth/guess')).status);
    }
    // Four counted failures, then the door closes.
    expect(seen.slice(0, 4)).toEqual([401, 401, 401, 401]);
    expect(seen[4]).toBe(429);
    expect(seen[5]).toBe(429);
  });

  it('once tripped by a credential path, it refuses the session paths too', async () => {
    for (let i = 0; i < 5; i++) await get('/api/v1/auth/guess');
    // The limiter is per IP, not per path — which is correct for a brute-force
    // guard, and is exactly why what counts TOWARD it has to be right.
    expect((await get('/api/v1/auth/me')).status).toBe(429);
  });

  it('answers a refused caller with the wording the limiter owns', async () => {
    for (let i = 0; i < 5; i++) await get('/api/v1/auth/guess');
    const res = await get('/api/v1/auth/guess');
    expect(res.status).toBe(429);
    expect(res.body.message).toMatch(/too many failed login attempts/i);
    expect(res.body.retryAfter).toBe(1800);
  });

  it('never counts a successful session check', async () => {
    // /health answers 200 and must cost nothing, whatever else is happening.
    for (let i = 0; i < 20; i++) {
      expect((await get('/api/v1/auth/health')).status).toBe(200);
    }
    expect((await get('/api/v1/auth/me')).status).toBe(401);
  });
});
