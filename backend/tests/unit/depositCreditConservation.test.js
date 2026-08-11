// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * A deposit must move tokens, never create them.
 *
 * docs/NEXT_SESSION_HANDOFF.md §4 recorded that the three sites crediting a
 * confirmed deposit read `depositAllocation` three different ways — `??`, `||`
 * and no fallback at all — and flagged the `||` as wrong under a
 * `reserveAllocationPercent: 100` policy, where `depositAllocation` is 0. It
 * also said, correctly, that none of it had been tested.
 *
 * Testing it found something larger, and in the ordinary case rather than the
 * edge one. The reader is not the defect; the PAIRING is. Two of the three
 * routes debit the merchant `order.tokenAmount` and credit the user
 * `depositAllocation + reserveAllocation` — the same number, so the deposit
 * conserves. The third debits the merchant `depositAllocation` and credits the
 * user `depositAllocation + reserveAllocation`, so on EVERY deposit with a
 * non-zero reserve share it credits more than it debits.
 *
 * These tests drive the real route handlers, pulled out of the Express router,
 * with the wallet and merchant services stubbed so the amounts each one is
 * ASKED for are observable. The invariant asserted is the one the platform's
 * closing check depends on: tokens debited from the merchant == tokens credited
 * to the user.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const calls = vi.hoisted(() => ({ debit: [], deposit: [], reserve: [], merchantCredit: [] }));
const order = vi.hoisted(() => ({ value: null }));

vi.mock('mongoose', () => {
  const models = {
    PaymentOrder: {
      findOne: async () => order.value,
      findById: async () => order.value,
    },
    Transaction: { create: async () => [{}] },
    User: { findById: async () => ({ _id: 'u1' }) },
    Merchant: { findById: async () => ({ _id: 'm1' }) },
  };
  return {
    default: {
      model: (n) => models[n] ?? { findOne: async () => null, create: async () => [{}], findById: async () => null },
      startSession: async () => { throw new Error('standalone'); },
      Types: { ObjectId: class { constructor(v) { this.v = v; } toString() { return String(this.v); } } },
    },
  };
});

vi.mock('../../domains/wallet/walletAuthority.service.js', () => ({
  creditDeposit: async (userId, amount) => { calls.deposit.push(amount); },
  creditReserve: async (userId, amount) => { calls.reserve.push(amount); },
}));

vi.mock('../../domains/merchant/merchantWallet.service.js', () => ({
  debitMerchantTokens: async ({ amount }) => { calls.debit.push(amount); return { merchant: { _id: 'm1' } }; },
  creditMerchantTokens: async ({ amount }) => { calls.merchantCredit.push(amount); return { merchant: { _id: 'm1' } }; },
}));

vi.mock('../../domains/payment/orderLifecycle.service.js', () => ({
  completeOrder: async () => ({ ok: true, idempotent: false, order: order.value }),
  disputeOrder: async () => ({ ok: true }),
}));

vi.mock('../../domains/identity/auth.middleware.js', () => ({
  authenticate: (req, res, next) => next(),
  requireApprovedKyc: (req, res, next) => next(),
}));
vi.mock('../../domains/identity/jwt.util.js', () => ({ tryVerifyJwt: () => null }));
vi.mock('../../middleware/merchantAuth.js', () => ({ merchantAuth: (req, res, next) => next() }));
vi.mock('../../middleware/security.js', () => ({ withdrawalLimiter: (req, res, next) => next() }));
vi.mock('../../middleware/ipDefense.js', () => ({
  createSubnetLimiter: () => (req, res, next) => next(),
  globalSurgeBreaker: () => (req, res, next) => next(),
}));
vi.mock('../../domains/payment/paymentProcessing.service.js', () => ({
  markOrderPaid: async () => ({ ok: true }), cancelOrder: async () => ({ ok: true }),
}));
vi.mock('../../domains/funding/fundingAuthority.service.js', () => ({
  requestDeposit: async () => ({ ok: true }), requestWithdrawal: async () => ({ ok: true }),
}));
vi.mock('../../middleware/utrValidation.js', () => ({ releaseUTR: async () => {} }));
vi.mock('../../domains/notification/realtimeEmitters.js', () => ({
  emitWalletUpdate: async () => {}, emitAdminUpdate: async () => {}, emitOrderUpdate: async () => {},
}));

const paymentRouter = (await import('../../domains/payment/payment.routes.js')).default;

/** The LAST handler registered for a route — the one after the middleware. */
function handlerFor(router, method, path) {
  for (const layer of router.stack) {
    if (layer.route?.path === path && layer.route.methods[method]) {
      const stack = layer.route.stack;
      return stack[stack.length - 1].handle;
    }
  }
  throw new Error(`no ${method.toUpperCase()} ${path} in this router`);
}

function fakeRes() {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

const makeOrder = (over = {}) => ({
  _id: { toString: () => 'o1' },
  orderId: 'ORD1',
  userId: 'u1',
  merchantId: 'm1',
  type: 'DEPOSIT',
  status: 'PAID',
  tokenAmount: 1000,
  depositAllocation: 900,
  reserveAllocation: 100,
  toObject() { return { ...this }; },
  ...over,
});

const totalCredited = () =>
  calls.deposit.reduce((a, b) => a + b, 0) + calls.reserve.reduce((a, b) => a + b, 0);
const totalDebited = () => calls.debit.reduce((a, b) => a + b, 0);

beforeEach(() => {
  calls.debit.length = 0; calls.deposit.length = 0;
  calls.reserve.length = 0; calls.merchantCredit.length = 0;
});

describe('POST /deposit/:orderId/confirm — tokens moved, not minted', () => {
  const run = async (o) => {
    order.value = o;
    const handler = handlerFor(paymentRouter, 'post', '/deposit/:orderId/confirm');
    const res = fakeRes();
    await handler({ params: { orderId: 'o1' }, body: {}, user: { _id: 'u1' }, merchantId: 'm1', headers: {}, cookies: {} }, res);
    return res;
  };

  it('debits the merchant exactly what it credits the user (90/10 policy)', async () => {
    await run(makeOrder());

    // The user receives the whole token amount, split across two pockets…
    expect(totalCredited()).toBe(1000);
    // …so the merchant must part with the whole token amount.
    expect(totalDebited()).toBe(totalCredited());
  });

  it('conserves under a reserve-heavy policy too', async () => {
    // 50/50. Nothing about the split should change how much leaves the merchant.
    await run(makeOrder({ depositAllocation: 500, reserveAllocation: 500 }));

    expect(totalCredited()).toBe(1000);
    expect(totalDebited()).toBe(totalCredited());
  });

  it('conserves when the whole deposit goes to reserve', async () => {
    // reserveAllocationPercent: 100 is a legal policy — depositPolicy.service.js
    // validates only that the two percentages sum to 100 — and it makes
    // `depositAllocation` exactly 0. This is the case handoff §4 flagged: a
    // reader using `||` treats that 0 as absent and substitutes tokenAmount.
    await run(makeOrder({ depositAllocation: 0, reserveAllocation: 1000 }));

    expect(calls.deposit.filter((a) => a > 0)).toEqual([]);
    expect(totalCredited()).toBe(1000);
    expect(totalDebited()).toBe(totalCredited());
  });

  it('conserves when there is no reserve share at all', async () => {
    await run(makeOrder({ depositAllocation: 1000, reserveAllocation: 0 }));

    expect(totalCredited()).toBe(1000);
    expect(totalDebited()).toBe(1000);
  });

  it('conserves for an order with NO recorded split — read hydrated (0/0)', async () => {
    // An order predating the split fields. The merchant is debited the full
    // amount either way, so a fallback that credited nothing would BURN tokens
    // — the same invariant broken in the opposite direction from the bug this
    // file was written for, and just as invisible without this assertion.
    await run(makeOrder({ depositAllocation: 0, reserveAllocation: 0 }));

    expect(totalCredited()).toBe(1000);
    expect(totalDebited()).toBe(totalCredited());
  });

  it('conserves for the same order read LEAN — fields absent entirely', async () => {
    const o = makeOrder();
    delete o.depositAllocation;
    delete o.reserveAllocation;
    await run(o);

    expect(totalCredited()).toBe(1000);
    expect(totalDebited()).toBe(totalCredited());
  });

  it('conserves even when the recorded split does not add up', async () => {
    // A corrupt order. Crediting 900 of a 1000-token deposit while debiting
    // 1000 loses 100 tokens with nothing recording where they went.
    await run(makeOrder({ depositAllocation: 900, reserveAllocation: 0 }));

    expect(totalCredited()).toBe(1000);
    expect(totalDebited()).toBe(totalCredited());
  });
});
