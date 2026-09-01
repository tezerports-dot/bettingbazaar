// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
// Integration test (real DB): the merchant deposit-completion paths, through
// the REAL HTTP routes. Phase X fixes X-1/X-2/X-3/X-9:
//   - a completed deposit funds the RESERVE wallet per the DepositPolicy
//     split (the live /confirm path used to credit everything to deposit and
//     never fund reserve — the reserve economy was dormant);
//   - the credit is idempotent (double-confirm / double-approve credits once);
//   - two concurrent approvals of the same order settle exactly once (X-9).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { fundedMerchant } from './_fixtures.js';
import request from 'supertest';
import express from 'express';
import { signToken } from '../../domains/identity/paseto.util.js';
import mongoose from 'mongoose';
import '../../models/index.js';
import merchantRoutes from '../../domains/merchant/merchant.routes.js';
import paymentRoutes from '../../domains/payment/payment.routes.js';

const app = express();
app.use(express.json());
app.use('/api/merchant', merchantRoutes); // mirror server.js
app.use('/api/payment', paymentRoutes);

const Merchant     = () => mongoose.model('Merchant');
const User         = () => mongoose.model('User');
const PaymentOrder = () => mongoose.model('PaymentOrder');

// PASETO (AQ-2): merchant PASETO carries { merchantId, isMerchant }; sign via the
// token authority so authenticateMerchant's Ed25519 verify accepts it (raw JWT → 401).
const merchantToken = (merchantId) =>
  `Bearer ${signToken({ isMerchant: true, merchantId: String(merchantId) })}`;

async function seed({ tokenBalance = 100000 } = {}) {
  const merchant = await fundedMerchant(Merchant().create({
    name: 'Depo M', username: 'depom' + Math.random().toString(16).slice(2, 8),
    mobile: '9' + Math.floor(100000000 + Math.random() * 899999999),
    status: 'ACTIVE', merchantApprovalStatus: 'APPROVED', tokenBalance,
  }));
  const user = await User().create({
    username: 'depuser' + Math.random().toString(16).slice(2, 8),
    mobile: '8' + Math.floor(100000000 + Math.random() * 899999999),
    depositBalance: 0, reserveBalance: 0, winningsBalance: 0,
  });
  // The pre-save hook computes depositAllocation/reserveAllocation from the
  // active DepositPolicy (90/10 fallback) — 1000 tokens → 900 / 100.
  const order = await PaymentOrder().create({
    orderId: 'DEP_' + Math.random().toString(16).slice(2),
    userId: user._id, merchantId: merchant._id,
    type: 'DEPOSIT', status: 'PAID',
    tokenAmount: 1000, fiatAmount: 1000, rateUsed: 1,
    utrNumber: '112233445566', proofScreenshot: 'data:image/png;base64,AAAA',
  });
  return { merchant, user, order };
}

describe('merchant deposit completion funds reserve (Phase X)', () => {
  it('APPROVE path: funds deposit AND reserve per the order split, debits merchant once', async () => {
    const { merchant, user, order } = await seed();
    // Sanity: the pre-save hook actually produced a split that conserves.
    expect(order.depositAllocation + order.reserveAllocation).toBe(order.tokenAmount);
    expect(order.reserveAllocation).toBeGreaterThan(0);

    const res = await request(app)
      .post(`/api/merchant/orders/${order._id}/approve`)
      .set('Authorization', merchantToken(merchant._id))
      .send({});
    expect(res.status).toBe(200);

    const u = await User().findById(user._id).lean();
    expect(u.depositBalance).toBe(order.depositAllocation); // 900
    expect(u.reserveBalance).toBe(order.reserveAllocation); // 100 — the fix
    const m = await Merchant().findById(merchant._id).lean();
    expect(m.tokenBalance).toBe(100000 - order.tokenAmount); // debited once
    const o = await PaymentOrder().findById(order._id).lean();
    expect(o.status).toBe('COMPLETED');
  });

  it('APPROVE path is idempotent — a second approve is refused, credits once', async () => {
    const { merchant, user, order } = await seed();
    await request(app).post(`/api/merchant/orders/${order._id}/approve`)
      .set('Authorization', merchantToken(merchant._id)).send({});
    const second = await request(app).post(`/api/merchant/orders/${order._id}/approve`)
      .set('Authorization', merchantToken(merchant._id)).send({});
    expect(second.status).toBe(409); // already COMPLETED

    const u = await User().findById(user._id).lean();
    expect(u.depositBalance).toBe(order.depositAllocation); // not doubled
    expect(u.reserveBalance).toBe(order.reserveAllocation);
    const m = await Merchant().findById(merchant._id).lean();
    expect(m.tokenBalance).toBe(100000 - order.tokenAmount);
  });

  it('CONFIRM path (the live one): now funds reserve too, not just deposit', async () => {
    const { merchant, user, order } = await seed();
    const res = await request(app)
      .post(`/api/merchant/confirm/${order._id}`)
      .set('Authorization', merchantToken(merchant._id))
      .send({ utrNumber: '112233445566', proof: 'data:image/png;base64,AAAA' });
    expect(res.status).toBe(200);

    const u = await User().findById(user._id).lean();
    expect(u.depositBalance).toBe(order.depositAllocation); // 900
    expect(u.reserveBalance).toBe(order.reserveAllocation); // 100 — was 0 before the fix
    expect(u.depositBalance + u.reserveBalance).toBe(order.tokenAmount);
  });

  // ── The third route, and the one that did not conserve ────────────────────
  //
  // payment.routes.js POST /deposit/:orderId/confirm debited the merchant
  // `depositAllocation || tokenAmount` and credited the user
  // `depositAllocation + reserveAllocation`. Under the default 90/10 policy
  // that is 900 out of the merchant and 1000 into the user — 100 tokens per
  // ₹1000 deposit appearing from nowhere, on the live path, breaking the
  // closing invariant every conservation check is built on.
  //
  // The unit test drives the handler with the services stubbed; this one runs
  // it against real balances, which is what makes the arithmetic above a
  // measurement rather than a reading.
  it('PAYMENT CONFIRM path: debits the merchant exactly what it credits the user', async () => {
    const { merchant, user, order } = await seed();
    expect(order.reserveAllocation).toBeGreaterThan(0); // otherwise this proves nothing

    const res = await request(app)
      .post(`/api/payment/deposit/${order.orderId}/confirm`)
      .set('Authorization', merchantToken(merchant._id))
      .send({});
    expect(res.status).toBe(200);

    const u = await User().findById(user._id).lean();
    const m = await Merchant().findById(merchant._id).lean();

    const credited = u.depositBalance + u.reserveBalance;
    const debited  = 100000 - m.tokenBalance;

    expect(u.depositBalance).toBe(order.depositAllocation);
    expect(u.reserveBalance).toBe(order.reserveAllocation);
    expect(credited).toBe(order.tokenAmount);
    // The assertion the bug failed: tokens are MOVED, never created.
    expect(debited).toBe(credited);
  });

  it('PAYMENT CONFIRM path conserves for an order with no recorded split', async () => {
    // An order predating the split fields reads 0/0 through a hydrated
    // document. Crediting that literally would debit the merchant in full and
    // credit the user nothing — burning tokens rather than creating them, which
    // is the same invariant broken in the other direction.
    const { merchant, user, order } = await seed();
    await PaymentOrder().updateOne(
      { _id: order._id }, { $set: { depositAllocation: 0, reserveAllocation: 0 } },
    );

    const res = await request(app)
      .post(`/api/payment/deposit/${order.orderId}/confirm`)
      .set('Authorization', merchantToken(merchant._id))
      .send({});
    expect(res.status).toBe(200);

    const u = await User().findById(user._id).lean();
    const m = await Merchant().findById(merchant._id).lean();

    expect(u.depositBalance + u.reserveBalance).toBe(order.tokenAmount);
    expect(100000 - m.tokenBalance).toBe(order.tokenAmount);
  });

  it('X-9: two concurrent approvals settle exactly once (no double-credit)', async () => {
    const { merchant, user, order } = await seed();
    const fire = () => request(app).post(`/api/merchant/orders/${order._id}/approve`)
      .set('Authorization', merchantToken(merchant._id)).send({});
    const [a, b] = await Promise.all([fire(), fire()]);

    const statuses = [a.status, b.status].sort();
    expect(statuses[0]).toBe(200);           // exactly one winner
    expect(statuses[1]).toBeGreaterThanOrEqual(400); // the loser is rejected

    const u = await User().findById(user._id).lean();
    expect(u.depositBalance).toBe(order.depositAllocation); // credited once
    expect(u.reserveBalance).toBe(order.reserveAllocation);
    const m = await Merchant().findById(merchant._id).lean();
    expect(m.tokenBalance).toBe(100000 - order.tokenAmount); // debited once
  });
});
