// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * startup/realtimeBridge.js — cross-instance real-time delivery (Phase X).
 *
 * THE keystone for horizontal scale. Real-time connections (socket.io + SSE)
 * are pinned to ONE backend instance, but the events that drive them
 * (bet_placed, cycle_result, order_update, balance_update, admin/merchant
 * feeds) can be produced on ANY instance. This wires two Redis pub/sub relays
 * so a fan-out on one instance reaches clients on all instances:
 *
 *   - socket.io: the official @socket.io/redis-adapter — io.emit / io.to(room)
 *     .emit now propagate to every node.
 *   - SSE: the SSEManager's own lightweight relay (attachRedis) — broadcast /
 *     sendToUser / sendToMerchant / broadcastToAdmins now propagate too.
 *
 * GRACEFUL DEGRADATION: with no REDIS_URL (single instance, dev, CI-unit,
 * sandbox) this is a no-op and real-time stays purely local — identical to
 * before. A Redis failure at startup logs and falls back to single-instance
 * rather than breaking real-time.
 *
 * Uses three ioredis connections: one shared publisher + one dedicated
 * subscriber for each relay (a subscribe-mode connection can't be shared).
 */
import Redis from 'ioredis';
import { createAdapter } from '@socket.io/redis-adapter';

let clients = []; // held for shutdown

export function initRealtimeBridge(io, sseManager) {
  if (!process.env.REDIS_URL) {
    console.log('📡 Real-time: single-instance (no REDIS_URL) — no cross-instance bridge.');
    return { active: false, reason: 'no REDIS_URL' };
  }

  try {
    const opts = { protocol: 2, maxRetriesPerRequest: null, enableReadyCheck: true }; // protocol:2 = RESP2 (ioredis 6; see redisConnect.js)
    const pub      = new Redis(process.env.REDIS_URL, opts);
    const subSocket = new Redis(process.env.REDIS_URL, opts);
    const subSSE    = new Redis(process.env.REDIS_URL, opts);
    clients = [pub, subSocket, subSSE];

    // Never let a real-time Redis hiccup crash the process.
    for (const c of clients) c.on('error', (e) => console.warn('[realtime-bridge] redis error:', e.message));

    // socket.io fan-out across instances (rooms, io.emit, io.to().emit).
    io.adapter(createAdapter(pub, subSocket));

    // SSE fan-out across instances (shares the publisher; own subscriber).
    if (sseManager && typeof sseManager.attachRedis === 'function') {
      sseManager.attachRedis(pub, subSSE);
    }

    console.log('📡 Real-time: multi-instance bridge ACTIVE (socket.io + SSE over Redis).');
    return { active: true };
  } catch (e) {
    console.warn('📡 Real-time bridge init failed — falling back to single-instance:', e.message);
    return { active: false, reason: e.message };
  }
}

export async function closeRealtimeBridge() {
  await Promise.allSettled(clients.map((c) => c.quit()));
  clients = [];
}
