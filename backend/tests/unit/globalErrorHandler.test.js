// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The global error handler answers an UNCLASSIFIED failure with nothing, and
 * keeps a decided refusal's own wording — the `respondError` rule (§2).
 *
 * It sent `err.message` for every error, and the stack in development, so any
 * route whose async handler threw past its catch (Express 5 forwards every one
 * here) gave the caller the server's internal text. Found 2026-10-01 sweeping
 * for the retry route's `err.status || 500` shape (§0.15).
 */
import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { errorHandler } from '../../middleware/errorHandler.js';

const appThrowing = (err) => {
  const app = express();
  app.use(express.json());
  app.get('/boom', async () => { throw err; });
  app.post('/json', (req, res) => res.json({ ok: true }));
  app.use(errorHandler);
  return app;
};

describe('global error handler', () => {
  it('answers an error with no status with nothing internal, and no stack', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await request(appThrowing(new Error('relation "secret_table" does not exist'))).get('/boom');
    spy.mockRestore();
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toMatch(/secret_table|relation|at /);
    expect(res.body.stack).toBeUndefined();
    expect(res.body.message).toBe('Something went wrong. Please try again.');
  });

  it("keeps a decided refusal's own status and wording", async () => {
    const res = await request(appThrowing(Object.assign(new Error('That code is not valid'), { status: 400 }))).get('/boom');
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('That code is not valid');
  });

  it('keeps a deliberate 503 a handler wrote (presence, not value, decides)', async () => {
    const res = await request(appThrowing(Object.assign(new Error('RAG retrieval not configured.'), { status: 503 }))).get('/boom');
    expect(res.status).toBe(503);
    expect(res.body.message).toBe('RAG retrieval not configured.');
  });

  it("passes a body-parser refusal through as the caller's mistake", async () => {
    const res = await request(appThrowing(new Error('x'))).post('/json')
      .set('Content-Type', 'application/json').send('{not json');
    expect(res.status).toBe(400);
  });
});
