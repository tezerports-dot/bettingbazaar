// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * A referral disbursal reserves its budget BEFORE it pays anyone (R6, F-040).
 *
 * It used to draw from the programme AFTER every credit had committed, and to
 * ignore the draw's refusal. Two overlapping runs, or a pause mid-run, paid the
 * players, had the draw refused, and left the programme recording less than it
 * had paid — so the ₹400 crore ceiling could be crossed without a trace.
 *
 * ── Why this one is a unit test ─────────────────────────────────────────────
 * The property is an ORDER: reserve, then pay, then give back the rest. The
 * two guards it relies on are database statements with their own tests
 * through a real database (`newDomains.test.js`: the draw cannot pass the
 * budget; the return cannot go below zero). A pg test of `disburse` itself
 * would pay the GLOBAL queue head — every other suite's queued earnings on the
 * shared database (trap 10) — so the repository is stubbed here and only the
 * sequence is asserted.
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
    users: { getUser: async (id) => ({ userId: id, status: 'ACTIVE' }) },
    identity: { getVerification: async () => ({ status: 'VERIFIED' }) },
    telegram: { getLinkByUserId: async () => ({ telegramUserId: '1' }) },
  },
}));

const { disburse } = await import('../../domains/referral/referral.service.js');

const earning = (n) => ({
  earningId: `e${n}`, earnerId: `u${n}`, sourceUserId: `s${n}`, level: 1, amountPaise: 2500, queuePosition: n,
});

beforeEach(() => {
  calls.length = 0;
  creditBonus.mockReset().mockImplementation(async (a) => { calls.push(['credit', a.userId]); return { ok: true }; });
  Object.assign(referrals, {
    getProgramme: async () => ({ active: true, budgetPaise: 1_000_000, disbursedPaise: 0 }),
    drawFromProgramme: vi.fn(async (_k, rupees) => { calls.push(['draw', rupees]); return { ok: true }; }),
    returnToProgramme: vi.fn(async (_k, rupees) => { calls.push(['return', rupees]); return { ok: true }; }),
    openBatch: async () => ({}),
    claimPayable: async () => [earning(1), earning(2)],
    spendFromBatch: async () => ({ ok: true }),
    markPaid: async () => ({ ok: true }),
    markBlocked: async () => ({ ok: true }),
    closeBatch: async () => ({}),
  });
});

describe('referral disbursal and the programme budget', () => {
  it('pays NOBODY when the budget cannot be reserved', async () => {
    referrals.drawFromProgramme.mockImplementation(async () => ({ ok: false, reason: 'BUDGET_EXHAUSTED_OR_INACTIVE' }));
    await expect(disburse({ poolPaise: 10_000, actorId: 'admin' })).rejects.toMatchObject({ status: 409 });
    expect(creditBonus).not.toHaveBeenCalled();
  });

  it('reserves the whole pool BEFORE the first credit, and gives back what it did not spend', async () => {
    const r = await disburse({ poolPaise: 10_000, actorId: 'admin' });
    expect(r.spentPaise).toBe(5_000);
    expect(calls[0]).toEqual(['draw', 100]);
    expect(calls.filter((c) => c[0] === 'credit')).toHaveLength(2);
    expect(calls.at(-1)).toEqual(['return', 50]);
  });

  it('gives back the unspent budget when the run fails partway', async () => {
    creditBonus.mockImplementationOnce(async () => { calls.push(['credit', 'u1']); return { ok: true }; })
      .mockImplementationOnce(async () => { throw new Error('wallet down'); });
    await expect(disburse({ poolPaise: 10_000, actorId: 'admin' })).rejects.toThrow('wallet down');
    expect(calls.at(-1)).toEqual(['return', 75]);
  });
});
