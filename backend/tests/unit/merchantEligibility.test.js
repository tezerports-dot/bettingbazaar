// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * Which merchant a deposit is routed to, and on whose balance.
 *
 * ── The defect this pins ────────────────────────────────────────────────────
 * `selectBestMerchant` filtered and ranked deposits on `Merchant.tokenBalance`
 * — a MongoDB document field — while every token movement goes through
 * `merchantWalletPgAuthority` to the `merchant_wallets` row. A deposit could
 * therefore be routed to a merchant who does not hold the tokens to serve it:
 * the order is accepted, the merchant cannot fund it, and the player waits on
 * someone who was never able to help them.
 *
 * The criterion cannot live in the Mongo query, because that query cannot see
 * the other store — so it moves after the fetch, and these cases are what stop
 * it drifting back.
 *
 * This path had NO tests at all before this file, on either the selection or
 * the balance question. That is worth stating plainly: it decides where a
 * player's money goes.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const db = vi.hoisted(() => ({ merchants: [], available: new Map(), systemConfig: {} }));

// One stub for every model the module reaches for. `getFundingLimits` reads
// SystemConfig for the concurrency defaults; the scoring path reads Merchant
// and counts PaymentOrder.
vi.mock('mongoose', () => ({
  default: {
    model: (name) => ({
      find: () => ({ lean: async () => (name === 'Merchant' ? db.merchants : []) }),
      findOne: () => ({ lean: async () => db.systemConfig }),
      // The selection returns a fresh read of the winner, so this is what the
      // assertions actually receive.
      findById: async (id) => db.merchants.find((m) => m._id === String(id)) ?? null,
      countDocuments: async () => 0,
      aggregate: async () => [],
    }),
  },
}));
vi.mock('../../postgres/merchantWalletPg.js', () => ({
  getAvailablePaiseFor: async () => db.available,
}));

const { selectBestMerchant } = await import('../../domains/merchant/merchantScoring.service.js');

/** A merchant that clears every non-balance gate. */
const merchant = (id, over = {}) => ({
  _id: id, name: id, isOnline: true, merchantApprovalStatus: 'APPROVED', status: 'ACTIVE',
  acceptedCurrencies: ['INR'], acceptsDeposits: true, acceptsWithdrawals: true,
  activeOrderCount: 0, maxConcurrentOrders: 5,
  activeDepositOrderCount: 0, activeWithdrawalOrderCount: 0,
  maxConcurrentDeposits: 5, maxConcurrentWithdrawals: 5,
  // Deliberately generous, and deliberately IGNORED — this is the number the
  // selection used to trust.
  tokenBalance: 1_000_000,
  successRate: 100, avgResponseTime: 1, totalOrdersCompleted: 10,
  ...over,
});

beforeEach(() => { db.merchants = []; db.available = new Map(); db.systemConfig = {}; });

describe('a deposit is routed on the Postgres balance', () => {
  it('does NOT pick a merchant whose tokens exist only on the Mongo document', async () => {
    // THE regression. `tokenBalance: 1,000,000` on the document, nothing in
    // `merchant_wallets`. Before the fix this merchant was selected and could
    // not fund a single rupee of the order.
    db.merchants = [merchant('m_paper')];
    db.available = new Map();               // no wallet row at all
    expect(await selectBestMerchant('DEPOSIT', 500)).toBeNull();
  });

  it('does not pick one whose wallet exists but cannot cover the order', async () => {
    db.merchants = [merchant('m_short')];
    db.available = new Map([['m_short', 10_000]]);   // ₹100 against a ₹500 order
    expect(await selectBestMerchant('DEPOSIT', 500)).toBeNull();
  });

  it('picks one whose Postgres balance covers it', async () => {
    db.merchants = [merchant('m_funded')];
    db.available = new Map([['m_funded', 100_000]]); // ₹1,000
    expect((await selectBestMerchant('DEPOSIT', 500))?._id).toBe('m_funded');
  });

  it('takes the boundary — exactly enough is enough', async () => {
    db.merchants = [merchant('m_exact')];
    db.available = new Map([['m_exact', 50_000]]);   // ₹500 against a ₹500 order
    expect((await selectBestMerchant('DEPOSIT', 500))?._id).toBe('m_exact');
  });

  it('ranks by the POSTGRES balance, not the document one', async () => {
    // `m_rich_on_paper` looks far larger on the document and is empty in the
    // store; ranking on the wrong number would put it first.
    db.merchants = [
      merchant('m_rich_on_paper', { tokenBalance: 9_000_000 }),
      merchant('m_actually_funded', { tokenBalance: 1 }),
    ];
    db.available = new Map([
      ['m_rich_on_paper', 60_000],      // ₹600
      ['m_actually_funded', 900_000],   // ₹9,000
    ]);
    expect((await selectBestMerchant('DEPOSIT', 500))?._id).toBe('m_actually_funded');
  });

  it('leaves WITHDRAWAL routing alone — it never had a balance gate', async () => {
    // A withdrawal takes tokens FROM the player and hands the merchant fiat, so
    // the merchant's token inventory is not the constraint. Applying the
    // deposit filter here would strand withdrawals behind an irrelevant test.
    db.merchants = [merchant('m_empty')];
    db.available = new Map();
    expect((await selectBestMerchant('WITHDRAWAL', 500))?._id).toBe('m_empty');
  });
});
