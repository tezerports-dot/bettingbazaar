// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * GET /api/admin/cycles/phases: the real and phantom split of a round still
 * taking bets reaches full admins only (owner, 2026-10-15). Staff holding
 * canViewAnalytics see the totals, and the split once betting has closed.
 */
import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

let viewer = null;
const NOW = Date.now();

vi.mock('#db', () => ({
  db: {
    markets: {
      activeCyclesWithPools: async () => [
        // Open: ends in 10 minutes, well before any phase boundary.
        { cycleId: 'OPEN1', type: 'b1', audience: 'VIP', status: 'OPEN',
          startTime: new Date(NOW - 60_000), endTime: new Date(NOW + 600_000),
          totalDelhi: 300, totalBombay: 200, realDelhi: 100, realBombay: 150, phantomDelhi: 200, phantomBombay: 50 },
        // Closed: inside the last 5 seconds, after betting closed.
        { cycleId: 'CLOSED1', type: 'b1', audience: 'VIP', status: 'OPEN',
          startTime: new Date(NOW - 600_000), endTime: new Date(NOW + 5_000),
          totalDelhi: 300, totalBombay: 300, realDelhi: 120, realBombay: 80, phantomDelhi: 180, phantomBombay: 220 },
      ],
    },
  },
}));
vi.mock('#db/repositories/settlements.js', () => ({}));
vi.mock('../../services/alerting.service.js', () => ({ sendAlert: vi.fn() }));
vi.mock('../../domains/notification/realtimeEmitters.js', () => ({ emitCyclePhase: vi.fn(), emitCycleResult: vi.fn() }));
vi.mock('../../domains/markets/roundResult.service.js', () => ({ announceRoundResults: vi.fn() }));
vi.mock('../../domains/markets/cycleTypes.js', () => ({
  allBoards: async () => [{ key: 'b1', phases: { mergeBeforeEndSec: 60, equalizerBeforeEndSec: 30, closeBeforeEndSec: 10 } }],
}));
vi.mock('../../routes/admin/_adminShared.js', async () => {
  const { default: ex } = await import('express');
  return {
    express: ex,
    authenticate: (req, _res, next) => { req.user = viewer; next(); },
    hasPermission: () => (_req, _res, next) => next(),
  };
});

const { default: router } = await import('../../routes/admin/cycles.admin.routes.js');
const app = express().use('/api/admin', router);

async function phasesAs(user) {
  viewer = user;
  const res = await request(app).get('/api/admin/cycles/phases');
  expect(res.status).toBe(200);
  return Object.fromEntries(res.body.cycles.map((c) => [c.cycleId, c]));
}

const ANALYST = { userId: 's1', isSubAdmin: true, permissions: { canViewAnalytics: true, canManageCycles: true } };
const FULL_ADMIN = { userId: 'a1', isAdmin: true };

describe('the live split is the main admin\'s alone', () => {
  it('a sub-admin with analytics and cycle rights gets totals only while betting is open', async () => {
    const { OPEN1 } = await phasesAs(ANALYST);
    expect(OPEN1.splitHidden).toBe(true);
    expect(OPEN1.pools).toEqual({
      totalDelhi: 300, totalBombay: 200, realDelhi: null, realBombay: null, phantomDelhi: null, phantomBombay: null,
    });
  });

  it('the same sub-admin sees the split once betting has closed', async () => {
    const { CLOSED1 } = await phasesAs(ANALYST);
    expect(CLOSED1.currentPhase).toBe('CLOSED');
    expect(CLOSED1.splitHidden).toBe(false);
    expect(CLOSED1.pools.realDelhi).toBe(120);
  });

  it('a full admin sees the split of an open round', async () => {
    const { OPEN1 } = await phasesAs(FULL_ADMIN);
    expect(OPEN1.splitHidden).toBe(false);
    expect(OPEN1.pools).toMatchObject({ realDelhi: 100, realBombay: 150, phantomDelhi: 200, phantomBombay: 50 });
  });

  it('a blocked full admin does not', async () => {
    const { OPEN1 } = await phasesAs({ ...FULL_ADMIN, isBlocked: true });
    expect(OPEN1.splitHidden).toBe(true);
  });
});
