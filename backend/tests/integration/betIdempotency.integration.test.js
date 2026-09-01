// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
// Integration test (real Mongo): server-enforced bet idempotency (M-2).
//
// The unit/pg layer already proves the PRIMITIVE is idempotent on its key
// (tests/postgres/betPg.test.js: "a replayed request debits NOTHING further").
// This suite proves the ROUTE honours that end to end — a redelivered
// POST /api/bet/place produces at most ONE bet, ONE debit, ONE Transaction row
// and ONE pool increment, no matter how the delivery arrives:
//
//   • sequential retry (the flaky-mobile case, caught by the fast gate)
//   • a genuinely separate bet (different key) is NOT collapsed
//   • a missing key is refused (the server cannot invent one safely)
//   • a concurrent burst of the same key still moves money exactly once
//
// Runs on the default (Mongo) money authority, which is where the transactional
// stake primitive and the deterministic bet _id do the work; the Postgres path
// gets the same guarantee from betPg's single-transaction placement.
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import express from 'express';
import mongoose from 'mongoose';
import { signToken } from '../../domains/identity/paseto.util.js';
import { User, Cycle, Bet } from '../../models/index.js';
import { bettable, funded } from './_fixtures.js';
import betRoutes from '../../domains/markets/bet.routes.js';

const app = express();
app.use(express.json());
app.use('/api/bet', betRoutes);

const authFor = (user) => `Bearer ${signToken({ userId: user._id })}`;

let seq = 0;
async function freshUserAndCycle() {
  const user = await funded(User.create({
    username: `idem_${seq}`, mobile: `92000000${seq++}`.slice(0, 12),
    kycStatus: 'APPROVED',
    depositBalance: 100, winningsBalance: 0, reserveBalance: 10,
  }));
  const cycle = await bettable(Cycle.create({
    cycleId: `idem_cycle_${Date.now()}_${seq}`, type: '30_MIN',
    startTime: Date.now() - 60_000, endTime: Date.now() + 300_000,
    status: 'OPEN',
  }));
  return { user, cycle };
}

const place = (user, cycle, key, extra = {}) => {
  const r = request(app).post('/api/bet/place').set('Authorization', authFor(user));
  if (key) r.set('Idempotency-Key', key);
  return r.send({ cycleId: cycle.cycleId, side: 'DELHI', amount: 10, type: '30_MIN', ...extra });
};

describe('server-enforced bet idempotency (M-2), through the real route', () => {
  it('a redelivered request with the SAME key places exactly one bet', async () => {
    const { user, cycle } = await freshUserAndCycle();
    const key = 'idem-seq-key-0001';

    const first = await place(user, cycle, key);
    expect(first.status).toBe(200);
    expect(first.body.success).toBe(true);

    // The retry: identical request, identical key.
    const replay = await place(user, cycle, key);
    expect(replay.status).toBe(200);
    expect(replay.body.success).toBe(true);
    expect(replay.body.idempotent).toBe(true);
    // Same bet id both times — not a second bet wearing a new id.
    expect(String(replay.body.bet.id)).toBe(String(first.body.bet.id));

    // Exactly one of everything the bet touches.
    expect(await Bet.countDocuments({ userId: user._id })).toBe(1);
    expect(await mongoose.model('Transaction').countDocuments({ userId: user._id, type: 'BET_PLACED' })).toBe(1);

    // Debited once: 9.90 deposit + 0.10 reserve → 10 locked (1% reserve share).
    const after = await User.findById(user._id).lean();
    expect(after.depositBalance).toBeCloseTo(90.1, 9);
    expect(after.reserveBalance).toBeCloseTo(9.9, 9);
    expect(after.lockedBalance).toBeCloseTo(10, 9);

    // Pool counted once, not twice (stored-pool path under NODE_ENV=test).
    const c = await Cycle.findOne({ cycleId: cycle.cycleId }).lean();
    expect(c.realDelhi).toBeCloseTo(10, 9);
  });

  it('a DIFFERENT key is a genuinely new bet — retries are not collapsed by payload', async () => {
    const { user, cycle } = await freshUserAndCycle();

    const a = await place(user, cycle, 'idem-diff-key-A');
    const b = await place(user, cycle, 'idem-diff-key-B');
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(b.body.idempotent).toBeUndefined();
    expect(String(a.body.bet.id)).not.toBe(String(b.body.bet.id));

    expect(await Bet.countDocuments({ userId: user._id })).toBe(2);
    const after = await User.findById(user._id).lean();
    expect(after.depositBalance).toBeCloseTo(80.2, 9);   // debited twice (2 × 9.90)
    expect(after.lockedBalance).toBeCloseTo(20, 9);
  });

  it('refuses a money request that carries no Idempotency-Key', async () => {
    const { user, cycle } = await freshUserAndCycle();
    const res = await place(user, cycle, null);
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toMatch(/Idempotency-Key/i);
    expect(await Bet.countDocuments({ userId: user._id })).toBe(0);
    const after = await User.findById(user._id).lean();
    expect(after.depositBalance).toBe(100);   // nothing moved
  });

  it('a concurrent burst of the SAME key still moves money exactly once', async () => {
    const { user, cycle } = await freshUserAndCycle();
    const key = 'idem-burst-key-0001';

    const results = await Promise.all(
      Array.from({ length: 5 }, () => place(user, cycle, key)),
    );
    // Every delivery answers success (one placed it, the rest replay it).
    for (const r of results) expect(r.status).toBe(200);

    // The gate held under contention: one bet, one debit.
    expect(await Bet.countDocuments({ userId: user._id })).toBe(1);
    const after = await User.findById(user._id).lean();
    expect(after.depositBalance).toBeCloseTo(90.1, 9);
    expect(after.lockedBalance).toBeCloseTo(10, 9);
  });
});
