// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * OPTIONS on the admin API (owner, 2026-10-21): anyone not sending a real
 * preflight from a trusted origin gets a plain 404 with no method list and no
 * Allow or Access-Control-Allow-* header; a trusted origin's preflight is
 * answered as before; OPTIONS on a public path is unchanged. And every admin
 * route, every method, still refuses a request with no session. The stack is
 * mounted in server.js's order: the gate, then cors with the same shape.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import express from 'express';
import cors from 'cors';
import request from 'supertest';

const TRUSTED = 'https://admin.example.test';
let app; let routes = [];

beforeAll(async () => {
  process.env.PASETO_SECRET_KEY ||= 'a'.repeat(64);
  const { adminPreflightGate } = await import('../../config/network.config.js');
  const { CORS_SHAPE } = await import('../../config/security.config.js');
  const { default: adminRouter } = await import('../../routes/admin/index.js');
  const origin = (o, cb) => cb(null, !o || o === TRUSTED);
  app = express();
  app.use(express.json());
  app.use(adminPreflightGate(async (o) => o === TRUSTED));
  app.options('/{*splat}', cors({ origin, ...CORS_SHAPE }));
  app.use(cors({ origin, ...CORS_SHAPE }));
  app.get('/api/announcements', (_req, res) => res.json({ ok: true }));
  app.use('/api/admin', adminRouter);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ success: false }));
  (function walk(stack) {
    for (const layer of stack) {
      if (layer.route) {
        for (const m of Object.keys(layer.route.methods)) routes.push([m, layer.route.path]);
      } else if (layer.handle?.stack) walk(layer.handle.stack);
    }
  })(adminRouter.stack);
});

const noMethodList = (res) => {
  expect(res.headers.allow).toBeUndefined();
  expect(res.headers['access-control-allow-methods']).toBeUndefined();
  expect(res.text).not.toMatch(/GET|POST|PUT|DELETE|PATCH/);
};

describe('OPTIONS on /api/admin', () => {
  it('answers a bare OPTIONS with a plain 404 and no method list', async () => {
    const res = await request(app).options('/api/admin/users');
    expect(res.status).toBe(404);
    noMethodList(res);
  });

  it('answers a preflight from an untrusted origin the same way', async () => {
    const res = await request(app).options('/api/admin/users')
      .set('Origin', 'https://evil.example').set('Access-Control-Request-Method', 'GET');
    expect(res.status).toBe(404);
    noMethodList(res);
  });

  it('answers an Origin without a requested method the same way', async () => {
    const res = await request(app).options('/api/admin/users').set('Origin', TRUSTED);
    expect(res.status).toBe(404);
    noMethodList(res);
  });

  it('still answers a trusted origin\'s preflight', async () => {
    const res = await request(app).options('/api/admin/users')
      .set('Origin', TRUSTED).set('Access-Control-Request-Method', 'PUT')
      .set('Access-Control-Request-Headers', 'authorization,content-type');
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe(TRUSTED);
  });

  it('leaves OPTIONS on a public path unchanged', async () => {
    const res = await request(app).options('/api/announcements');
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-methods']).toMatch(/GET/);
  });
});

describe('every admin route, every method, needs a session', () => {
  it('refuses each one with no token', async () => {
    expect(routes.length).toBeGreaterThan(100);
    const open = [];
    for (const [method, path] of routes) {
      const url = `/api/admin${path.replace(/:(\w+)/g, 'x')}`;
      const res = await request(app)[method](url).send({});
      if (![401, 403].includes(res.status)) open.push(`${method.toUpperCase()} ${path} → ${res.status}`);
    }
    expect(open).toEqual([]);
  });
});
