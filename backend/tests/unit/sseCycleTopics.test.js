// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * Cycle topics on the public SSE stream.
 *
 * ── What this replaced ──────────────────────────────────────────────────────
 * `cycleSnapshotPublisher.flush()` sent every live cycle's pool snapshot to
 * EVERY public SSE client, because `sseManager` had only `broadcast`. That was
 * documented as acceptable on the grounds that SSE is the fallback transport
 * for clients whose WebSocket is blocked — but the user panel opens its
 * EventSource unconditionally (`SSEEventBridge` connects in its constructor,
 * with no "only if the socket failed" branch), so it was not serving a
 * minority. Every client was receiving each cycle's totals twice: once
 * room-scoped as `pool_update` over Socket.IO, once globally as `bet_placed`
 * over SSE. With three boards live that is three duplicated deliveries per
 * client per second, growing linearly with connections.
 *
 * ── The property that matters ───────────────────────────────────────────────
 * Delivery follows subscription, in both directions: a subscriber gets its own
 * cycle and nothing else, and a NON-subscriber gets nothing at all. The second
 * half is the one that saves the fan-out, and it is the one a "does the happy
 * path work" test would miss.
 */
import { EventEmitter } from 'events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import SSEManager from '../../domains/notification/sseManager.service.js';

class FakeResponse extends EventEmitter {
  constructor() {
    super();
    this.writableLength = 0;
    this.events = [];
  }

  write(payload) {
    // Keep only real events; the keep-alive comment frames are noise here.
    const match = /^event: (\S+)\ndata: (.*)\n\n$/s.exec(payload);
    if (match) this.events.push({ event: match[1], data: JSON.parse(match[2]) });
    return true;
  }

  end() { this.emit('close'); }
}

const managers = [];
const newManager = () => {
  const m = new SSEManager();
  managers.push(m);
  return m;
};

afterEach(() => {
  while (managers.length) managers.pop().destroy();
});

describe('subscribing a public SSE client to cycles', () => {
  it('delivers a cycle only to the clients watching it', () => {
    const m = newManager();
    const delhiWatcher = new FakeResponse();
    const otherWatcher = new FakeResponse();
    const unsubscribed = new FakeResponse();

    const a = m.addClient(delhiWatcher);
    const b = m.addClient(otherWatcher);
    m.addClient(unsubscribed);

    m.watchCycles(a, ['cycle_1']);
    m.watchCycles(b, ['cycle_2']);

    m.broadcastToCycle('cycle_1', 'bet_placed', { cycleId: 'cycle_1', newTotalDelhi: 500 });

    expect(delhiWatcher.events).toHaveLength(1);
    expect(delhiWatcher.events[0]).toEqual({
      event: 'bet_placed', data: { cycleId: 'cycle_1', newTotalDelhi: 500 },
    });
    expect(otherWatcher.events).toHaveLength(0);
    // The one that saves the fan-out: a client that asked for nothing gets
    // nothing, which is every client with a working WebSocket.
    expect(unsubscribed.events).toHaveLength(0);
  });

  it('still broadcasts non-cycle events to everyone', () => {
    // Scoping the pool stream must not scope `system_config`, `branding` or
    // `cycle_result` — those are global by nature and travel on `broadcast`.
    const m = newManager();
    const res = new FakeResponse();
    m.addClient(res);

    m.broadcast('system_config', { maintenanceMode: false });

    expect(res.events.map((e) => e.event)).toEqual(['system_config']);
  });

  it('replaces the subscription set rather than accumulating it', () => {
    // A client switching boards must stop receiving the old one. Adding without
    // leaving would make a long-lived connection accumulate every cycle it ever
    // watched — and each settled cycle it still holds is fan-out for a board
    // nobody is looking at.
    const m = newManager();
    const res = new FakeResponse();
    const id = m.addClient(res);

    m.watchCycles(id, ['cycle_1']);
    m.watchCycles(id, ['cycle_2']);

    expect(m.cyclesWatchedBy(id)).toEqual(['cycle_2']);
    m.broadcastToCycle('cycle_1', 'bet_placed', { cycleId: 'cycle_1' });
    expect(res.events).toHaveLength(0);

    m.broadcastToCycle('cycle_2', 'bet_placed', { cycleId: 'cycle_2' });
    expect(res.events).toHaveLength(1);
  });

  it('is idempotent, so a client may re-send the same set on every snapshot', () => {
    const m = newManager();
    const res = new FakeResponse();
    const id = m.addClient(res);

    m.watchCycles(id, ['a', 'b']);
    m.watchCycles(id, ['b', 'a']);

    expect(m.cyclesWatchedBy(id).sort()).toEqual(['a', 'b']);
    expect(m.cycleClients.get('a').size).toBe(1);
    expect(m.cycleClients.get('b').size).toBe(1);
  });

  it('ignores a subscription for a client that is not connected', () => {
    const m = newManager();
    expect(m.watchCycles(9999, ['cycle_1'])).toEqual([]);
    expect(m.cycleClients.size).toBe(0);
  });
});

describe('the registry does not leak', () => {
  it('drops a disconnected client from every topic it held', () => {
    // Without this, a Set — and the response object it pins — outlives the
    // request forever: nothing writes to a settled cycle's topic again, so the
    // dead entry is never noticed by the write path's own cleanup.
    const m = newManager();
    const res = new FakeResponse();
    const id = m.addClient(res);
    m.watchCycles(id, ['cycle_1', 'cycle_2']);
    expect(m.cycleClients.size).toBe(2);

    res.emit('close');

    expect(m.clients.has(id)).toBe(false);
    expect(m.cycleClients.size).toBe(0);
    expect(m.clientCycles.size).toBe(0);
  });

  it('removes a topic once its last watcher leaves', () => {
    const m = newManager();
    const first = new FakeResponse();
    const second = new FakeResponse();
    const a = m.addClient(first);
    const b = m.addClient(second);
    m.watchCycles(a, ['shared']);
    m.watchCycles(b, ['shared']);

    first.emit('close');
    expect(m.cycleClients.get('shared').size).toBe(1);

    second.emit('close');
    expect(m.cycleClients.has('shared')).toBe(false);
  });

  it('reports topics and subscriptions in the stats endpoint', () => {
    const m = newManager();
    const id = m.addClient(new FakeResponse());
    m.watchCycles(id, ['a', 'b']);

    const stats = m.getStats();
    expect(stats.cycleTopics).toBe(2);
    expect(stats.cycleSubscriptions).toBe(2);
  });
});

describe('the public endpoint is not trusted with how much it can allocate', () => {
  it('caps how many cycles one client may watch', () => {
    // /api/sse/events is public and unauthenticated. Three cycle types are live
    // at once, so anything past a handful is not a client — and each id is a
    // Map key holding a Set.
    const m = newManager();
    const id = m.addClient(new FakeResponse());

    const applied = m.watchCycles(id, Array.from({ length: 500 }, (_, i) => `c${i}`));

    expect(applied.length).toBe(8);
    expect(m.cycleClients.size).toBe(8);
  });

  it('refuses an absurdly long cycle id and empty entries', () => {
    const m = newManager();
    const id = m.addClient(new FakeResponse());

    m.watchCycles(id, ['x'.repeat(65), '', '   ', 'ok_cycle']);

    expect(m.cyclesWatchedBy(id)).toEqual(['ok_cycle']);
  });
});

describe('the Redis bridge carries cycle topics across instances', () => {
  it('publishes a cycle fan-out and applies one that arrives', () => {
    // SSE connections are pinned to one instance but a bet can land on any, so
    // a topic that only fanned out locally would freeze the pools of every
    // client not on the instance that took the bet.
    const m = newManager();
    const pub = { publish: vi.fn() };
    const sub = { subscribe: vi.fn().mockResolvedValue(undefined), on: vi.fn() };
    m.attachRedis(pub, sub);

    m.broadcastToCycle('cycle_1', 'bet_placed', { cycleId: 'cycle_1' });

    expect(pub.publish).toHaveBeenCalledTimes(1);
    const [, raw] = pub.publish.mock.calls[0];
    const msg = JSON.parse(raw);
    expect(msg.kind).toBe('broadcastToCycle');
    expect(msg.args).toEqual(['cycle_1', 'bet_placed', { cycleId: 'cycle_1' }]);

    // And the receiving end knows what to do with it.
    const remote = newManager();
    const res = new FakeResponse();
    const id = remote.addClient(res);
    remote.watchCycles(id, ['cycle_1']);
    remote._dispatchLocal({ kind: msg.kind, args: msg.args });

    expect(res.events).toEqual([{ event: 'bet_placed', data: { cycleId: 'cycle_1' } }]);
  });
});
