// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  emitPayoutSuccessBatch, emitToPlayer, emitOrderUpdate, sseBalancePush,
} from '../../domains/notification/realtimeEmitters.js';

const saved = { sseManager: global.sseManager, io: global.io };
afterEach(() => {
  vi.restoreAllMocks();
  global.sseManager = saved.sseManager;
  global.io = saved.io;
});

/** A player's channel, as `sseManager.sendToUser` addresses it. */
function stream() {
  const sent = [];
  global.sseManager = { sendToUser: vi.fn((uid, event, data) => sent.push({ uid, event, data })) };
  return sent;
}

describe('emitPayoutSuccessBatch', () => {
  it("fans out personalized payout updates in chunks, down each winner's own stream", async () => {
    const sent = stream();
    const payouts = Array.from({ length: 3 }, (_, i) => ({ userId: `u${i}`, payout: 20 + i, betAmount: 10 }));
    const balanceMap = {
      u0: { depositBalance: 1, winningsBalance: 2, lockedBalance: 0 },
      u1: { depositBalance: 3, winningsBalance: 4, lockedBalance: 0 },
      u2: { depositBalance: 5, winningsBalance: 6, lockedBalance: 0 },
    };

    const setImmediateSpy = vi.spyOn(globalThis, 'setImmediate');

    const count = await emitPayoutSuccessBatch({ payouts, balanceMap, cycleId: 'c1', winner: 'DELHI', batchSize: 2 });

    expect(count).toBe(3);
    expect(sent.map((s) => s.uid)).toEqual(['u0', 'u1', 'u2']);
    expect(setImmediateSpy).toHaveBeenCalledTimes(1);
    expect(sent[0].event).toBe('payout_success');
    expect(sent[0].data).toEqual(expect.objectContaining({
      type: 'PAYOUT_SUCCESS', cycleId: 'c1', winner: 'DELHI', amount: 20, walletBalance: 3,
    }));
  });

  it('does not depend on a socket server being present (the scheduler role)', async () => {
    const sent = stream();
    global.io = undefined;
    await emitPayoutSuccessBatch({
      payouts: [{ userId: 'u9', payout: 5, betAmount: 3 }],
      balanceMap: { u9: { depositBalance: 0, winningsBalance: 5 } }, cycleId: 'c2', winner: 'BOMBAY',
    });
    expect(sent).toHaveLength(1);
  });
});

describe('one player, one name per change (§12)', () => {
  it('an order change reaches the player as order_update, with what happened in `event`', () => {
    const sent = stream();
    emitOrderUpdate('u1', 'order_paid', { orderId: 'o1' });
    expect(sent).toEqual([{ uid: 'u1', event: 'order_update',
      data: { type: 'ORDER_UPDATE', event: 'order_paid', orderId: 'o1' } }]);
  });

  it('a wallet movement reaches the player as user_balance_update, leaving out what it did not report', () => {
    const sent = stream();
    sseBalancePush('u1', { depositBalance: 10.004, winningsBalance: 2 });
    expect(sent[0].event).toBe('user_balance_update');
    expect(sent[0].data).toEqual(expect.objectContaining({ depositBalance: 10, winningsBalance: 2, walletBalance: 12 }));
    expect(sent[0].data).not.toHaveProperty('lockedBalance');
  });

  it('never throws into the caller when the stream manager does', () => {
    global.sseManager = { sendToUser: () => { throw new Error('down'); } };
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() => emitToPlayer('u1', 'user_update', {})).not.toThrow();
  });
});
