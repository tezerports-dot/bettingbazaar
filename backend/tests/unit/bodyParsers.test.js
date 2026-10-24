// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Compressed request bodies are refused before a byte is decoded (owner,
 * 2026-10-24), through the parsers every route uses. Asked over real HTTP.
 */
import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { gzipSync, brotliCompressSync, deflateSync } from 'node:zlib';
import { jsonBody, rawBody } from '../../middleware/bodyParsers.js';

const appWith = (parser) => {
  const app = express();
  app.post('/x', parser, (req, res) => res.json({ got: req.body }));
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ type: err.type }));
  return app;
};
const body = JSON.stringify({ amount: 105 });

describe('a compressed request body', () => {
  for (const [encoding, pack] of [['br', brotliCompressSync], ['gzip', gzipSync], ['deflate', deflateSync]]) {
    it(`is refused 415 when sent ${encoding}, JSON and raw alike`, async () => {
      for (const parser of [jsonBody(), rawBody({ type: () => true })]) {
        const res = await request(appWith(parser)).post('/x')
          .set('Content-Type', 'application/json').set('Content-Encoding', encoding).send(pack(Buffer.from(body)));
        expect(res.status).toBe(415);
        expect(res.body.type).toBe('encoding.unsupported');
      }
    });
  }

  it('a plain body still goes through, as every panel sends it', async () => {
    const res = await request(appWith(jsonBody())).post('/x').set('Content-Type', 'application/json').send(body);
    expect(res.status).toBe(200);
    expect(res.body.got).toEqual({ amount: 105 });
    const id = await request(appWith(jsonBody())).post('/x')
      .set('Content-Type', 'application/json').set('Content-Encoding', 'identity').send(body);
    expect(id.status).toBe(200);
  });

  it('a caller cannot turn it back on', async () => {
    const res = await request(appWith(jsonBody({ inflate: true }))).post('/x')
      .set('Content-Type', 'application/json').set('Content-Encoding', 'gzip').send(gzipSync(Buffer.from(body)));
    expect(res.status).toBe(415);
  });
});
