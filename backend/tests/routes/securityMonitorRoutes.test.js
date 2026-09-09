// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * A refused request leaves a record, and the middleware that writes it is mounted.
 *
 * ── Why this file exists ────────────────────────────────────────────────────
 * `securityMonitor` was written, exported, and mounted NOWHERE. A burst of
 * failed admin logins therefore left no durable trace anywhere — the single
 * signal a credential-stuffing attempt against a money platform produces, and
 * nothing was recording it. No test failed, because no test looked.
 *
 * That is the same shape as the five dead admin buttons: a backend that works
 * and nothing calling it. So this asserts BOTH halves — that the middleware
 * records what it should, and that server.js actually mounts it. A behaviour
 * test alone would have passed for the whole time it was unreachable.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import express from 'express';
import request from 'supertest';
import { pgConfigured, applySchema, closePg } from '#db/client.js';
import { db } from '#db';
import { securityMonitor } from '../../middleware/security.js';

/**
 * Paths are unique per run.
 *
 * `audit_log` is permanent, so a row this suite wrote on an earlier run shares
 * any fixed path and `find` returns THAT one. A mutation check caught it the
 * embarrassing way round: the mutated build passed and the restored build
 * failed, because the row being read was the mutant's.
 */
const RUN = Math.random().toString(36).slice(2, 8);

const describePg = pgConfigured() ? describe : describe.skip;

describePg('the security monitor', () => {
  let app;

  beforeAll(async () => {
    await applySchema();
    app = express();
    app.use(express.json());
    app.use(securityMonitor);
    app.post('/admin/login', (req, res) => res.status(401).json({ success: false }));
    app.get(`/forbidden-${RUN}`, (_req, res) => res.status(403).json({ success: false }));
    // A refusal OUTSIDE the auth paths that nonetheless carries a mobile in the
    // body — the only shape that can tell the path condition from a body that
    // simply had no mobile in it.
    app.post(`/api/payment/withdraw-${RUN}`, (_req, res) => res.status(403).json({ success: false }));
    app.get('/missing',      (_req, res) => res.status(404).json({ success: false }));
    app.get('/fine',         (_req, res) => res.json({ success: true, payload: 'unchanged' }));
  }, 60_000);

  afterAll(async () => { await closePg(); });

  const recorded = async () => {
    const { entries } = await db.audit.search({ action: 'SECURITY_VIOLATION_ATTEMPT', limit: 200 });
    return entries;
  };

  /**
   * Poll until `predicate` holds, or give up.
   *
   * The audit write is deliberately NOT awaited — the monitor observes a
   * response, and blocking one on a database round trip would make an audit
   * hiccup into a latency problem on every refused request. So the row lands
   * shortly after the response, and a test that reads immediately races it.
   */
  const eventually = async (predicate, what) => {
    for (let i = 0; i < 40; i += 1) {
      const rows = await recorded();
      const hit = predicate(rows);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`timed out waiting for: ${what}`);
  };

  it('is mounted in server.js, not merely exported', () => {
    // The half a behaviour test can never prove. It was exported and unmounted
    // for its entire existence and every other check stayed green.
    const server = readFileSync(new URL('../../server.js', import.meta.url), 'utf8');
    expect(server).toMatch(/app\.use\(securityMonitor\)/);
    expect(server).toMatch(/securityMonitor\s*\}?\s*from '\.\/middleware\/security\.js'|securityMonitor.*from '\.\/middleware\/security\.js'/);
  });

  it('records a refused admin login, with the mobile that was tried', async () => {
    const mobile = `9${Date.now().toString().slice(-9)}`;
    await request(app).post('/admin/login').send({ mobile, password: 'wrong' }).expect(401);

    const hit = await eventually(
      (rows) => rows.find((e) => e.details?.mobile === mobile),
      'the audit row for the refused login');
    // As a FIELD, so a reviewer can filter on the mobile a burst was aimed at
    // rather than pattern-matching it out of prose.
    expect(hit.details.statusCode).toBe(401);
    expect(hit.details.path).toBe('/admin/login');
    expect(hit.adminId).toBe('SYSTEM_WATCHDOG');
  });

  it('records a 403 as well as a 401', async () => {
    const before = (await recorded()).length;
    await request(app).get(`/forbidden-${RUN}`).expect(403);
    await eventually((rows) => rows.length > before, 'an audit row for the 403');
  });

  it('does not record a 404 or a success', async () => {
    // Every miss and every healthy response would drown the signal it exists to
    // surface — and on a busy platform that is a row per request.
    const before = (await recorded()).length;
    await request(app).get('/missing').expect(404);
    await request(app).get('/fine').expect(200);
    // Long enough that a row WOULD have landed: the cases above need ~1 poll.
    await new Promise((r) => setTimeout(r, 300));
    expect((await recorded()).length).toBe(before);
  });

  it('passes the response through untouched', async () => {
    // It wraps res.json on every request. Observing must not become
    // intercepting: a body it failed to forward would break the whole API.
    const res = await request(app).get('/fine').expect(200);
    expect(res.body).toEqual({ success: true, payload: 'unchanged' });
  });

  it('carries no mobile for a refusal outside the auth paths', async () => {
    // req.body on an arbitrary route is arbitrary user input. Recording a
    // `mobile` from it would copy unvalidated content into the audit trail on
    // every refused request, from any endpoint, whatever the caller put there.
    const planted = `PLANTED-${Date.now()}`;
    await request(app).post(`/api/payment/withdraw-${RUN}`).send({ mobile: planted }).expect(403);

    const hit = await eventually(
      (rows) => rows.find((e) => e.details?.path === `/api/payment/withdraw-${RUN}`),
      'the audit row for the refused withdrawal');
    expect(hit.details.mobile ?? null).toBeNull();
    // And it is nowhere else in the row either.
    expect(JSON.stringify(hit.details)).not.toContain(planted);
  });
});
