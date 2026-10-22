// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Referral bonuses pay themselves (owner, 2026-10-20): the `referral-autopay`
 * cron pays the whole queue, in joining order, with no programme budget and
 * no on/off switch, out of the platform's token holding.
 *
 * ── Why this one is a unit test ─────────────────────────────────────────────
 * A pg test of `disburse` would pay the GLOBAL queue head — every other
 * suite's queued earnings on the shared database (trap 10) — so the
 * repository is stubbed here and only the sequence is asserted. The pool
 * ceiling it relies on (`spendFromBatch`) has its own test through a real
 * database (`newDomains.test.js`).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const calls = [];
// The reward is paid into the GENERAL balance (`db.promo`, owner 2026-10-08).
const { referrals, creditBonus } = vi.hoisted(() => ({
  referrals: {},
  creditBonus: vi.fn(),
}));
vi.mock('#db', () => ({
  db: {
    referrals,
    promo: { creditReferralBonus: creditBonus },
    users: { getUser: async (id) => ({ userId: id, status: id === 'u-blocked' ? 'BLOCKED' : 'ACTIVE' }) },
    telegram: { getLinkByUserId: async () => ({ telegramUserId: '1' }) },
  },
}));

const { disburse, payReferralQueue } = await import('../../domains/referral/referral.service.js');

const earning = (n, earnerId = `u${n}`) => ({
  earningId: `e${n}`, earnerId, sourceUserId: `s${n}`, level: 1, amountPaise: 10_000, queuePosition: n,
});

let queue;
let pool;
beforeEach(() => {
  calls.length = 0;
  queue = [earning(1), earning(2)];
  pool = { spent: 0, size: 0 };
  creditBonus.mockReset().mockImplementation(async (a) => { calls.push(['credit', a.userId, a.amountPaise]); return { ok: true }; });
  Object.assign(referrals, {
    queueSummary: async () => ({ queuedPaise: queue.reduce((t, e) => t + e.amountPaise, 0), queuedCount: queue.length }),
    openBatch: async ({ poolRupees, actorId }) => { pool = { spent: 0, size: poolRupees * 100 }; calls.push(['open', poolRupees, actorId]); return {}; },
    claimPayable: async () => queue,
    spendFromBatch: async (_b, rupees) => {
      if (pool.spent + rupees * 100 > pool.size) return { ok: false };
      pool.spent += rupees * 100; return { ok: true };
    },
    markPaid: async () => ({ ok: true }),
    markBlocked: async (id) => { calls.push(['blocked', id]); return { ok: true }; },
    closeBatch: async () => ({}),
  });
});

describe('referral bonuses pay themselves', () => {
  it('pays the whole queue in joining order, with no budget to reserve or switch to turn on', async () => {
    const r = await payReferralQueue();
    expect(calls[0]).toEqual(['open', 200, null]);
    expect(calls.filter((c) => c[0] === 'credit').map((c) => c[1])).toEqual(['u1', 'u2']);
    expect(r.spentPaise).toBe(20_000);
    expect(r.unspentPaise).toBe(0);
  });

  it('does nothing when nothing is queued', async () => {
    queue = [];
    expect(await payReferralQueue()).toBeNull();
    expect(creditBonus).not.toHaveBeenCalled();
  });

  it('steps over an ineligible referrer without spending their share, and pays the next', async () => {
    queue = [earning(1, 'u-blocked'), earning(2)];
    const r = await payReferralQueue();
    expect(calls).toContainEqual(['blocked', 'e1']);
    expect(calls.filter((c) => c[0] === 'credit').map((c) => c[1])).toEqual(['u2']);
    expect(r.blocked).toBe(1);
  });

  it('an admin\'s "Pay now" pays only up to its amount, never splitting a reward', async () => {
    const r = await disburse({ poolPaise: 15_000, actorId: 'admin' });
    expect(calls.filter((c) => c[0] === 'credit')).toHaveLength(1);
    expect(r.unspentPaise).toBe(5_000);
  });

  it('a failed credit fails the run (the batch records it), without paying past it', async () => {
    creditBonus.mockImplementationOnce(async () => { throw new Error('supply exhausted'); });
    await expect(payReferralQueue()).rejects.toThrow('supply exhausted');
    expect(creditBonus).toHaveBeenCalledTimes(1);
  });
});
