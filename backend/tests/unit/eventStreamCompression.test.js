// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The live streams are gzipped per connection and flushed per event
 * (`middleware/eventStreamCompression.js`). Asked the way a browser asks —
 * with `Accept-Encoding` — because the request without it is the one case that
 * always worked (S37): an unflushed compressor delivers a gzip header and
 * nothing else, and the stream looks exactly like one with nothing to say.
 */
import http from 'node:http';
import zlib from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import compression from 'compression';
import { eventStreamCompression, isEventStream } from '../../middleware/eventStreamCompression.js';
import { initSSEResponse } from '../../routes/sse.routes.js';
import SSEManager from '../../domains/notification/sseManager.service.js';

let server = null;
let manager = null;
afterEach(async () => {
  manager?.destroy();
  manager = null;
  if (server) await new Promise((r) => { server.closeAllConnections(); server.close(r); });
  server = null;
});

/** The middleware exactly as server.js mounts it, around one real stream. */
async function serve() {
  manager = new SSEManager();
  const app = express();
  app.use(compression({ filter: (req, res) => !isEventStream(res) && compression.filter(req, res) }));
  app.use('/api/sse', eventStreamCompression);
  app.get('/api/sse/events', (_req, res) => {
    initSSEResponse(res);
    manager.addClient(res);
  });
  app.get('/api/sse/refused', (_req, res) => res.status(401).json({ success: false }));
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  return `http://127.0.0.1:${server.address().port}`;
}

/** Open a stream; resolve with the response and a reader of its decoded text so far. */
function open(url, acceptEncoding) {
  return new Promise((resolve, reject) => {
    const headers = acceptEncoding ? { 'Accept-Encoding': acceptEncoding } : {};
    http.get(url, { headers }, (res) => {
      const encoding = res.headers['content-encoding'];
      const body = encoding === 'gzip' ? res.pipe(zlib.createGunzip()) : res;
      let text = '';
      let wire = 0;
      res.on('data', (c) => { wire += c.length; });
      body.on('data', (c) => { text += c; });
      resolve({ res, encoding, text: () => text, wire: () => wire });
    }).on('error', reject);
  });
}

async function until(check, ms = 1000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return check();
}

describe('event stream compression', () => {
  it('answers a browser gzip, never brotli, and delivers every event as it is sent', async () => {
    const base = await serve();
    const s = await open(`${base}/api/sse/events`, 'gzip, deflate, br, zstd');
    expect(s.encoding).toBe('gzip');
    expect(await until(() => s.text().includes('retry: 3000'))).toBe(true);

    manager.broadcast('cycle_phase', { v: 2, c: 'X1', p: 1 });
    expect(await until(() => s.text().includes('event: cycle_phase\ndata: {"v":2,"c":"X1","p":1}\n\n'))).toBe(true);

    // The second one too: a flush after the first write only is not enough.
    manager.broadcast('cycle_phase', { v: 2, c: 'X1', p: 2 });
    expect(await until(() => s.text().includes('"p":2'))).toBe(true);
  });

  it('keeps one compressor per connection, so a repeated shape costs little', async () => {
    const base = await serve();
    const s = await open(`${base}/api/sse/events`, 'gzip');
    expect(await until(() => s.text().includes('retry: 3000'))).toBe(true);
    const event = (i) => ({ v: 2, t: 1, c: `1MIN_V_17916507${i}`, k: '1MIN', a: 'V', p: i % 4, ts: 1791650740000 + i });
    manager.broadcast('cycle_phase', event(0));
    expect(await until(() => s.text().includes('"p":0,'))).toBe(true);
    const before = { wire: s.wire(), text: s.text().length };
    for (let i = 1; i <= 20; i++) manager.broadcast('cycle_phase', event(i));
    expect(await until(() => s.text().includes('"ts":1791650740020'))).toBe(true);
    // A full flush per event (`res.flush()`) forgets the shape each time and
    // lands near half the plain size; a shared context lands far below it.
    expect(s.wire() - before.wire).toBeLessThan((s.text().length - before.text) / 4);
  });

  it('sends the stream plain to a client that does not accept gzip', async () => {
    const base = await serve();
    for (const accept of [undefined, 'br', 'gzip;q=0, br']) {
      const s = await open(`${base}/api/sse/events`, accept);
      expect(s.encoding, String(accept)).toBeUndefined();
      manager.broadcast('cycle_phase', { p: 3 });
      expect(await until(() => s.text().includes('"p":3')), String(accept)).toBe(true);
      s.res.destroy();
    }
  });

  it('leaves a refusal on the stream path as ordinary JSON', async () => {
    const base = await serve();
    const s = await open(`${base}/api/sse/refused`, 'gzip');
    expect(s.res.statusCode).toBe(401);
    expect(s.encoding).toBeUndefined();
    expect(await until(() => s.text() === '{"success":false}')).toBe(true);
  });
});
