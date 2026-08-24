// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * Integration test (real Mongo): a withdrawal request is a PAYABLE INSTRUMENT
 * and may never exist without the funds behind it.
 *
 * ── The loss this prevents ──────────────────────────────────────────────────
 * Payouts here are MANUAL: an operator reads the pending queue and sends real
 * money by hand, then marks the request approved. So the dangerous state is not
 * a wrong balance — the ledger guards catch those — it is a request row that
 * LOOKS payable but has no reservation behind it. The operator cannot tell the
 * difference, wires the cash, and only then does the approve click fail.
 *
 * The route used to create the PENDING row and lock the funds afterwards. A
 * player firing several withdrawals at once could reserve only once, so every
 * other attempt left exactly that orphan. These tests pin the corrected order:
 * reserve first, and let the database — not a read-then-write — enforce one
 * open payout per player.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import express from 'express';
import { signToken } from '../../domains/identity/paseto.util.js';
import { User, WithdrawalRequest } from '../../models/index.js';
import userRoutes from '../../domains/user/user.routes.js';

const app = express();
app.use(express.json());
app.use('/api', userRoutes);

// The single-open-payout rule is a PARTIAL UNIQUE INDEX, so it only constrains
// anything once the index exists. Mongoose builds indexes in the background on
// first use, which is a race against the concurrency test below — build them
// explicitly so the test proves the constraint rather than the timing. The
// global beforeEach clears documents, not indexes, so once is enough.
beforeAll(async () => {
  await WithdrawalRequest.syncIndexes();
});

const authFor = (user) => `Bearer ${signToken({ userId: user._id })}`;

let seq = 0;
async function player({ winnings }) {
  return User.create({
    username: `wd_${seq}`, mobile: `93000000${seq++}`.slice(0, 12),
    kycStatus: 'APPROVED',
    depositBalance: 0, winningsBalance: winnings, reserveBalance: 0,
  });
}

const withdraw = (user, amount) =>
  request(app).post('/api/v1/user/withdraw')
    .set('Authorization', authFor(user))
    .send({ amount, method: 'UPI', upiId: 'player@upi' });

describe('withdrawal requests are never payable without reserved funds', () => {
  it('reserves the money before the payable record exists', async () => {
    const user = await player({ winnings: 1000 });

    const res = await withdraw(user, 1000);
    expect(res.status).toBe(200);

    const wr = await WithdrawalRequest.findOne({ userId: user._id }).lean();
    expect(wr).toBeTruthy();
    expect(wr.status).toBe('PENDING');
    // The request names the reservation that funds it.
    expect(wr.reservationTxId).toBe(`wd_lock_${wr._id}`);

    // The money is out of the withdrawable balance and held.
    const after = await User.findById(user._id).lean();
    expect(after.winningsBalance).toBe(0);
    expect(after.lockedBalance).toBe(1000);
  });

  it('a concurrent burst produces ONE payable request, not one per attempt', async () => {
    // The original exploit: 5 concurrent withdrawals of the whole balance. Only
    // one can reserve; the rest used to survive as unfunded payable rows worth
    // 4x the player's balance in manual payouts.
    const user = await player({ winnings: 1000 });

    const results = await Promise.all([1, 2, 3, 4, 5].map(() => withdraw(user, 1000)));
    const accepted = results.filter((r) => r.status === 200);
    expect(accepted).toHaveLength(1);

    const rows = await WithdrawalRequest.find({ userId: user._id }).lean();
    expect(rows).toHaveLength(1);
    expect(rows[0].reservationTxId).toBeTruthy();

    // Exactly one reservation: nothing minted, nothing stranded.
    const after = await User.findById(user._id).lean();
    expect(after.winningsBalance).toBe(0);
    expect(after.lockedBalance).toBe(1000);
  });

  it('leaves NO payable record when the balance cannot cover the request', async () => {
    // 900 clears the ₹500 minimum but exceeds the ₹400 balance.
    const user = await player({ winnings: 400 });

    const res = await withdraw(user, 900);
    expect(res.status).toBe(400);

    expect(await WithdrawalRequest.countDocuments({ userId: user._id })).toBe(0);
    const after = await User.findById(user._id).lean();
    expect(after.winningsBalance).toBe(400);   // untouched
    expect(after.lockedBalance || 0).toBe(0);
  });

  it('refuses a second request while one is still open', async () => {
    const user = await player({ winnings: 2000 });
    const first = await withdraw(user, 500);
    expect(first.status).toBe(200);

    const second = await withdraw(user, 500);
    expect(second.status).toBe(400);
    expect(second.body.message).toMatch(/pending withdrawal/i);

    expect(await WithdrawalRequest.countDocuments({ userId: user._id })).toBe(1);
    // Only the first reservation was taken.
    const after = await User.findById(user._id).lean();
    expect(after.lockedBalance).toBe(500);
    expect(after.winningsBalance).toBe(1500);
  });
});
