// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * A player may back both sides of a round (owner, 2026-10-10). The winner
 * notice drops a user only when their WINNING bets were all refused; a refused
 * LOSING bet on the other side must not hide a win that was paid.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const emitted = vi.hoisted(() => ({ batches: [] }));
vi.mock('#db', () => ({ db: {} }));
vi.mock('#db/repositories/settlements.js', () => ({}));
vi.mock('../../domains/notification/realtimeEmitters.js', () => ({
  emitPayoutSuccessBatch: vi.fn(async (args) => { emitted.batches.push(args); }),
}));
vi.mock('../../domains/wallet/walletAuthority.service.js', () => ({ getBalances: vi.fn(async () => ({ total: 1 })) }));
vi.mock('../../services/alerting.service.js', () => ({ sendAlert: vi.fn() }));
vi.mock('../../domains/notification/staffEventAreas.js', () => ({ emitToStaff: vi.fn() }));

const { default: GameEngine } = await import('../../domains/markets/gameEngine.js');

const engine = () => Object.assign(Object.create(GameEngine.prototype), { io: {} });
const cycle = { cycleId: 'C1', winner: 'DELHI' };
const paid = [{ userId: 'u1', payout: 190, betAmount: 100 }];

beforeEach(() => { emitted.batches.length = 0; });

describe('notifyWinners with both sides backed', () => {
  it('still tells a winner whose refused bet was on the LOSING side', async () => {
    await engine().notifyWinners(cycle, paid, new Map([['u1', 1]]),
      [{ betId: 'b2', userId: 'u1', outcome: 'LOST', reason: 'x' }]);
    expect(emitted.batches).toHaveLength(1);
    expect(emitted.batches[0].payouts.map((p) => p.userId)).toEqual(['u1']);
  });

  it('drops a user whose every WINNING bet was refused (opposite behaviour)', async () => {
    await engine().notifyWinners(cycle, paid, new Map([['u1', 1]]),
      [{ betId: 'b1', userId: 'u1', outcome: 'WON', reason: 'x' }]);
    expect(emitted.batches).toHaveLength(0);
  });
});
