// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
// Integration test (real Redis, CI service container): the SSE cross-instance
// bridge (Phase X). Two SSEManager objects sharing one Redis simulate two
// backend instances. Property under test: a fan-out produced on instance A
// reaches SSE clients connected to instance B — the horizontal-scale keystone
// the old per-process manager couldn't do. Skipped without REDIS_URL.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Redis from 'ioredis';
import SSEManager from '../../domains/notification/sseManager.service.js';

const suite = process.env.REDIS_URL ? describe : describe.skip;

// A fake SSE client: an object with a .write() that records payloads and an
// .on('close') that never fires. Mirrors what Express res gives the manager.
function fakeClient() {
  const events = [];
  return {
    events,
    write(chunk) { events.push(chunk); },
    on() { /* no close in the test */ },
    // Parse the "event: X\ndata: {...}" frames this client received.
    received() {
      return events
        .filter((c) => c.startsWith('event:'))
        .map((c) => {
          const ev = c.match(/^event: (.+)$/m)[1];
          const data = JSON.parse(c.match(/^data: (.+)$/m)[1]);
          return { ev, data };
        });
    },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

suite('SSE Redis bridge (cross-instance fan-out)', () => {
  let A, B, redisClients;

  beforeEach(async () => {
    const mk = () => new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: null });
    // Unique channel per test so parallel/rerun files don't cross-talk. Both
    // managers must use the SAME channel to talk — patch it before attach.
    const channel = 'bb:sse:test:' + Math.random().toString(16).slice(2);
    A = new SSEManager(); B = new SSEManager();
    A._channel = channel; B._channel = channel;
    const [pA, sA, pB, sB] = [mk(), mk(), mk(), mk()];
    redisClients = [pA, sA, pB, sB];
    A.attachRedis(pA, sA);
    B.attachRedis(pB, sB);
    await sleep(150); // let SUBSCRIBE settle on both
  });

  afterEach(async () => {
    A.destroy(); B.destroy();
    await Promise.allSettled(redisClients.map((c) => c.quit()));
  });

  it('a public broadcast on A reaches a public client on B', async () => {
    const onB = fakeClient();
    B.addClient(onB);
    A.broadcast('cycle_result', { winner: 'DELHI', cycleId: 'c1' });
    await sleep(150);
    const got = onB.received();
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ ev: 'cycle_result', data: { winner: 'DELHI', cycleId: 'c1' } });
  });

  it('sendToUser on A reaches that user\'s client on B, and no one else', async () => {
    const u1onB = fakeClient();
    const u2onB = fakeClient();
    B.addUserClient('user-1', u1onB);
    B.addUserClient('user-2', u2onB);
    A.sendToUser('user-1', 'balance_update', { depositBalance: 99 });
    await sleep(150);
    expect(u1onB.received()).toHaveLength(1);
    expect(u1onB.received()[0].data).toMatchObject({ depositBalance: 99 });
    expect(u2onB.received()).toHaveLength(0); // targeted, not leaked
  });

  it('does NOT double-deliver to a client on the ORIGIN instance', async () => {
    // A client on A, and A broadcasts: it should receive exactly once (local
    // delivery), NOT again from its own Redis echo (origin dedup).
    const onA = fakeClient();
    A.addClient(onA);
    A.broadcast('bet_placed', { cycleId: 'c9' });
    await sleep(150);
    expect(onA.received()).toHaveLength(1); // once, not twice
  });

  it('merchant + admin fan-outs cross instances', async () => {
    const mOnB = fakeClient();
    const admOnB = fakeClient();
    B.addMerchantClient('m1', mOnB);
    B.addAdminClient(admOnB);
    A.sendToMerchant('m1', 'new_order', { orderId: 'o1' });
    A.broadcastToAdmins('queue_order_update', { orderId: 'o1' });
    await sleep(150);
    expect(mOnB.received()[0]).toMatchObject({ ev: 'new_order', data: { orderId: 'o1' } });
    expect(admOnB.received()[0]).toMatchObject({ ev: 'queue_order_update', data: { orderId: 'o1' } });
  });
});
