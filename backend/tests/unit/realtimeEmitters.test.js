import { afterEach, describe, expect, it, vi } from 'vitest';
import { emitPayoutSuccessBatch } from '../../domains/notification/realtimeEmitters.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('emitPayoutSuccessBatch', () => {
  it('fans out personalized payout updates in chunks', async () => {
    const emit = vi.fn();
    const to = vi.fn(() => ({ emit }));
    const payouts = Array.from({ length: 3 }, (_, i) => ({ userId: `u${i}`, payout: 20 + i, betAmount: 10 }));
    const balanceMap = {
      u0: { depositBalance: 1, winningsBalance: 2, lockedBalance: 0 },
      u1: { depositBalance: 3, winningsBalance: 4, lockedBalance: 0 },
      u2: { depositBalance: 5, winningsBalance: 6, lockedBalance: 0 },
    };

    const setImmediateSpy = vi.spyOn(globalThis, 'setImmediate');

    const sent = await emitPayoutSuccessBatch({ io: { to }, payouts, balanceMap, cycleId: 'c1', winner: 'DELHI', batchSize: 2 });

    expect(sent).toBe(3);
    expect(to).toHaveBeenCalledTimes(3);
    expect(setImmediateSpy).toHaveBeenCalledTimes(1);
    expect(to).toHaveBeenNthCalledWith(1, 'user-u0');
    expect(emit).toHaveBeenCalledWith('payout_success', expect.objectContaining({
      type: 'PAYOUT_SUCCESS',
      cycleId: 'c1',
      winner: 'DELHI',
      amount: 20,
      walletBalance: 3,
    }));
  });
});
