// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * A blocked address cannot open a socket either.
 *
 * socket.io answers its upgrade before Express runs, so the HTTP middleware
 * never sees it. `allowRequest` used to check only the runtime role, and an
 * address refused 403 on every route still connected, received every
 * broadcast, and could request database reads on demand (measured 2026-10-01).
 *
 * This drives a REAL socket.io server's admission with real websocket
 * upgrades, behind the same trust-proxy setting production runs with
 * (TRUST_PROXY=1), so the address being judged is the one Express would judge.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import express from 'express';
import { Server } from 'socket.io';
import WebSocket from 'ws';

const { liveBlocks } = vi.hoisted(() => ({ liveBlocks: vi.fn() }));
vi.mock('#db', () => ({ db: { ipBlocks: { liveBlocks } } }));

/** Open a socket.io websocket upgrade as `ip` (via the balancer's header). Resolves 'open' or the refusal. */
const upgrade = (port, ip) => new Promise((resolve) => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/socket.io/?EIO=4&transport=websocket`, {
    headers: { 'X-Forwarded-For': ip },
  });
  ws.on('open', () => { ws.close(); resolve('open'); });
  ws.on('unexpected-response', (_req, res) => { resolve(`refused ${res.statusCode}`); });
  ws.on('error', (e) => resolve(`error ${e.message}`));
});

describe('the socket.io upgrade honours the IP deny-list', () => {
  const servers = [];
  const serve = async (acceptsRealtime) => {
    const { realtimeAdmission } = await import('../../middleware/ipBlocklist.js');
    const app = express();
    app.set('trust proxy', 1);
    const server = http.createServer(app);
    const io = new Server(server, { allowRequest: realtimeAdmission(app, acceptsRealtime), transports: ['websocket'] });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    servers.push({ server, io });
    return server.address().port;
  };

  beforeAll(async () => {
    liveBlocks.mockResolvedValue([{ network: '198.51.100.0/24' }]);
    const { refreshIpBlocklistNow } = await import('../../middleware/ipBlocklist.js');
    await refreshIpBlocklistNow();
  });

  afterAll(async () => {
    for (const { io, server } of servers) {
      io.close();
      await new Promise((r) => server.close(() => r()));
    }
  });

  it('refuses the upgrade from a blocked range and admits a bystander', async () => {
    const port = await serve(true);
    expect(await upgrade(port, '198.51.100.7')).toMatch(/^refused/);
    expect(await upgrade(port, '203.0.113.9')).toBe('open');
  });

  it('still refuses every upgrade on an instance that does not serve realtime', async () => {
    const port = await serve(false);
    expect(await upgrade(port, '203.0.113.9')).toMatch(/^refused/);
  });
});
