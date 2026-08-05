// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * withdrawalHold under PostgreSQL authority — the state inversion.
 *
 * ── What changed, and why it needed its own suite ───────────────────────────
 * The Mongo path's concurrency gate is a `findOneAndUpdate` filtered on
 * `merchantCreditStatus: 'HELD'`: Mongo decides who settles, and Postgres is
 * told afterwards. That is authority in name only, and it recreates the
 * stranding window the hold exists to close — once an order has left HELD the
 * sweeper cannot retry it, so a failure after that point needs a human.
 *
 * On Postgres the gate is the settlement's own RESERVED→SETTLED gate, and Mongo
 * is written afterwards as a MIRROR. Everything below is a consequence of that
 * one move:
 *
 *   • the ORDER of operations reverses, so a failed player-side release has to
 *     be COMPENSATED (SETTLED→REVERSED) rather than avoided by sequencing;
 *   • Mongo's status stops being consulted as a gate, and becomes eligibility —
 *     the one question it still answers is "may a settlement be opened at all?";
 *   • a lagging mirror becomes self-healing instead of a permanent strand,
 *     because the sweeper's query is the thing the mirror repairs.
 *
 * ── Why mocked, when the sibling suite uses a real database ─────────────────
 * merchantSettlementMirror.test.js proves the gate against real Postgres —
 * real locks, real UNIQUE collisions, 100 racing completions. What is left to
 * prove here is ORCHESTRATION: which call happens after which, what compensates
 * what, and what is never called at all. Those are assertions about ordering
 * and absence, and a real database makes them harder to state without making
 * them stronger. The two suites are deliberately complementary; neither is a
 * substitute for the integration test that drives both stores at once.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const authoritative = { value: true };
const calls = [];
const record = (name, result) => (...args) => { calls.push(name); return result?.(...args); };

// ── The order store ──────────────────────────────────────────────────────────
const ORDER = {
  _id: { toString: () => 'order1' },
  orderId: 'BB-WD-1',
  userId: { toString: () => 'user1' },
  merchantId: 'merchant1',
  tokenAmount: 500,
  type: 'WITHDRAWAL',
  merchantCreditStatus: 'HELD',
};
const store = { order: { ...ORDER }, mongoGateWins: true };

const PaymentOrder = {
  findById: vi.fn(() => ({ select: () => ({ lean: async () => store.order }) })),
  findOneAndUpdate: vi.fn(async () => {
    calls.push('mongo:gate');
    if (!store.mongoGateWins || store.order?.merchantCreditStatus !== 'HELD') return null;
    return store.order;
  }),
  updateOne: vi.fn(record('mongo:updateOne', async () => ({ modifiedCount: 1 }))),
  find: vi.fn(() => ({ select: () => ({ limit: () => ({ lean: async () => [] }) }) })),
};

vi.mock('mongoose', () => ({ default: { model: () => PaymentOrder } }));

vi.mock('../../postgres/moneyAuthority.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, isPostgresAuthoritative: () => authoritative.value };
});

// ── The money paths ──────────────────────────────────────────────────────────
const releaseWithdrawal = vi.fn(record('release', async () => ({ ok: true })));
const refundWithdrawal = vi.fn(record('refund', async () => ({ ok: true })));
vi.mock('../../domains/wallet/walletAuthority.service.js', () => ({
  releaseWithdrawal: (...a) => releaseWithdrawal(...a),
  refundWithdrawal: (...a) => refundWithdrawal(...a),
}));

const creditMerchantTokens = vi.fn(record('creditMerchant', async () => ({ merchant: {} })));
vi.mock('../../domains/merchant/merchantWallet.service.js', () => ({
  creditMerchantTokens: (...a) => creditMerchantTokens(...a),
}));

// ── The settlement state machine ─────────────────────────────────────────────
const pg = {
  settlement: null,
  open:     { ok: true, idempotent: false, settlement: { state: 'RESERVED', direction: 'WITHDRAWAL', updatedAt: new Date(1) } },
  complete: { ok: true, idempotent: false, settlement: { state: 'SETTLED',   direction: 'WITHDRAWAL', updatedAt: new Date(2) } },
  cancel:   { ok: true, idempotent: false, settlement: { state: 'CANCELLED', direction: 'WITHDRAWAL', updatedAt: new Date(3) } },
  reverse:  { ok: true, idempotent: false, settlement: { state: 'REVERSED',  direction: 'WITHDRAWAL', updatedAt: new Date(4) } },
};
const getSettlement       = vi.fn(async () => pg.settlement);
const openSettlement      = vi.fn(record('pg:open',     async () => pg.open));
const completeSettlement  = vi.fn(record('pg:complete', async () => pg.complete));
const cancelSettlement    = vi.fn(record('pg:cancel',   async () => pg.cancel));
const reverseSettlement   = vi.fn(record('pg:reverse',  async () => pg.reverse));

vi.mock('../../postgres/merchantSettlementPg.js', () => ({
  DIRECTIONS: { DEPOSIT: 'DEPOSIT', WITHDRAWAL: 'WITHDRAWAL' },
  getSettlement:      (...a) => getSettlement(...a),
  openSettlement:     (...a) => openSettlement(...a),
  completeSettlement: (...a) => completeSettlement(...a),
  cancelSettlement:   (...a) => cancelSettlement(...a),
  reverseSettlement:  (...a) => reverseSettlement(...a),
}));

const reverseMirrorMerchantSettlement = vi.fn(record('mirror', async () => {}));
vi.mock('../../postgres/reverseMirror.js', () => ({
  reverseMirrorMerchantSettlement: (...a) => reverseMirrorMerchantSettlement(...a),
}));

const sendAlert = vi.fn(async () => {});
vi.mock('../../services/alerting.service.js', () => ({ sendAlert: (...a) => sendAlert(...a) }));
vi.mock('../../domains/notification/realtimeEmitters.js', () => ({
  emitOrderUpdate: vi.fn(), emitAdminUpdate: vi.fn(),
}));

const { settleHold, reverseHold } = await import('../../domains/payment/withdrawalHold.service.js');

const mirrored = () => reverseMirrorMerchantSettlement.mock.calls.map(([row]) => row);

beforeEach(() => {
  vi.clearAllMocks();
  calls.length = 0;
  authoritative.value = true;
  store.order = { ...ORDER };
  store.mongoGateWins = true;
  pg.settlement = null;
  pg.open     = { ok: true, idempotent: false, settlement: { state: 'RESERVED',  direction: 'WITHDRAWAL', updatedAt: new Date(1) } };
  pg.complete = { ok: true, idempotent: false, settlement: { state: 'SETTLED',   direction: 'WITHDRAWAL', updatedAt: new Date(2) } };
  pg.cancel   = { ok: true, idempotent: false, settlement: { state: 'CANCELLED', direction: 'WITHDRAWAL', updatedAt: new Date(3) } };
  pg.reverse  = { ok: true, idempotent: false, settlement: { state: 'REVERSED',  direction: 'WITHDRAWAL', updatedAt: new Date(4) } };
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('settleHold under PostgreSQL authority', () => {
  it('gates on the settlement, not on Mongo, and releases the player afterwards', async () => {
    pg.settlement = { settlementId: 'ms_order1', state: 'RESERVED' };

    expect(await settleHold('order1')).toBe(true);

    // The whole inversion in one assertion: Postgres decides FIRST, and the
    // Mongo write is downstream of a decision that is already final. The Mongo
    // path's findOneAndUpdate gate must not run at all.
    expect(calls).toEqual(['pg:complete', 'release', 'mirror']);
    expect(PaymentOrder.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('never credits the merchant separately — the settlement IS the credit', async () => {
    pg.settlement = { settlementId: 'ms_order1', state: 'RESERVED' };
    await settleHold('order1');

    // On Mongo the merchant is credited by a second, independent call. Here the
    // RESERVED→SETTLED transition moves settlement→available inside the same
    // transaction as the state change. Calling creditMerchantTokens as well
    // would pay the merchant TWICE for one withdrawal — and it would not even
    // be caught by an idempotency key, because the two paths key differently.
    expect(creditMerchantTokens).not.toHaveBeenCalled();
  });

  it('opens the settlement lazily for an order held BEFORE the flip', async () => {
    pg.settlement = null; // nothing was opened; merchant.routes only opens under PG authority

    expect(await settleHold('order1')).toBe(true);
    expect(calls).toEqual(['pg:open', 'pg:complete', 'release', 'mirror']);
    expect(openSettlement).toHaveBeenCalledWith(expect.objectContaining({
      settlementId: 'ms_order1', merchantId: 'merchant1', direction: 'WITHDRAWAL',
      amountPaise: 50_000, // 500 rupees, crossed into integer paise at the boundary
    }));
  });

  it('refuses to open a settlement for an order that is no longer held', async () => {
    pg.settlement = null;
    store.order.merchantCreditStatus = 'RELEASED';

    expect(await settleHold('order1')).toBe(false);
    // The one question Mongo's status still answers. Without it, a stray sweep
    // would open a brand-new reservation against an order settled long ago
    // under the Mongo path — creating a liability out of nothing.
    expect(calls).toEqual([]);
  });

  it('leaves the order held when the reservation itself cannot be made', async () => {
    pg.settlement = null;
    pg.open = { ok: false, reason: 'insufficient' };

    expect(await settleHold('order1')).toBe(false);
    // Nothing released, nothing mirrored: the next sweep retries from exactly
    // the same place. Failing forward here is what created the original strand.
    expect(calls).toEqual(['pg:open']);
  });

  it('returns false without settling when a dispute already cancelled it', async () => {
    pg.settlement = { settlementId: 'ms_order1', state: 'CANCELLED', direction: 'WITHDRAWAL', updatedAt: new Date(9) };
    pg.complete = { ok: false, reason: 'invalid_transition', state: 'CANCELLED' };

    expect(await settleHold('order1')).toBe(false);
    expect(releaseWithdrawal).not.toHaveBeenCalled();
  });

  // ── Self-healing: the sweeper's query is what the mirror repairs ───────────
  describe('a lagging mirror repairs itself instead of stranding the order', () => {
    it('re-mirrors when the settlement was already SETTLED', async () => {
      pg.settlement = { settlementId: 'ms_order1', state: 'SETTLED' };
      pg.complete = { ok: true, idempotent: true, settlement: { state: 'SETTLED', direction: 'WITHDRAWAL', updatedAt: new Date(7) } };

      expect(await settleHold('order1')).toBe(false);
      // Reaching this branch AT ALL means Mongo still shows the order held —
      // a caught-up Mongo would not have offered it to the sweep. So the mirror
      // is the thing that failed, and re-running it is what removes the order
      // from a queue it would otherwise sit in forever.
      expect(mirrored()).toEqual([{
        order_id: 'order1', direction: 'WITHDRAWAL', state: 'SETTLED', updated_at: new Date(7),
      }]);
    });

    it('re-mirrors the REAL state when the transition was refused', async () => {
      pg.settlement = { settlementId: 'ms_order1', state: 'CANCELLED', direction: 'WITHDRAWAL', updatedAt: new Date(8) };
      pg.complete = { ok: false, reason: 'invalid_transition', state: 'CANCELLED' };

      expect(await settleHold('order1')).toBe(false);
      // A refusal carries no settlement, so the actual state is read back and
      // mirrored. Without this the order stays HELD in Mongo, is re-offered on
      // every pass, and is refused every time — a loop with no exit and no alarm.
      expect(mirrored()).toEqual([{
        order_id: 'order1', direction: 'WITHDRAWAL', state: 'CANCELLED', updated_at: new Date(8),
      }]);
    });
  });

  // ── Compensation: the price of putting the gate first ─────────────────────
  describe('a failed player release is compensated, not swallowed', () => {
    beforeEach(() => { pg.settlement = { settlementId: 'ms_order1', state: 'RESERVED' }; });

    it('reverses the settlement and rethrows', async () => {
      releaseWithdrawal.mockImplementationOnce(async () => { calls.push('release'); throw new Error('wallet down'); });

      await expect(settleHold('order1')).rejects.toThrow('wallet down');

      // SETTLED→REVERSED is a recorded movement, not an undo: it posts entries,
      // it is allowed to drive the merchant negative (they may have spent the
      // tokens in the window), and it leaves the books consistent with a player
      // who still holds their stake.
      expect(calls).toEqual(['pg:complete', 'release', 'pg:reverse', 'mirror']);
      expect(mirrored()[0]).toMatchObject({ state: 'REVERSED' });
    });

    it('tells the alert whether the compensation landed', async () => {
      releaseWithdrawal.mockImplementationOnce(async () => { throw new Error('wallet down'); });

      await expect(settleHold('order1')).rejects.toThrow('wallet down');
      expect(sendAlert).toHaveBeenCalledWith(
        'withdrawal-hold-release-failed', expect.any(String),
        expect.objectContaining({ settlementReversed: true }),
      );
    });

    it('escalates loudly when the compensation ALSO fails', async () => {
      releaseWithdrawal.mockImplementationOnce(async () => { throw new Error('wallet down'); });
      reverseSettlement.mockImplementationOnce(async () => { throw new Error('pg down'); });

      await expect(settleHold('order1')).rejects.toThrow('wallet down');
      // This is the only genuinely unsafe state the path can reach — merchant
      // credited for a stake the player never gave up — so it must be
      // distinguishable in the alert, not folded into the generic failure.
      expect(sendAlert).toHaveBeenCalledWith(
        'withdrawal-hold-release-failed', expect.any(String),
        expect.objectContaining({ settlementReversed: false, reversalError: 'pg down' }),
      );
      expect(mirrored()).toEqual([]);
    });
  });
});

describe('reverseHold under PostgreSQL authority', () => {
  it('gates on the settlement and refunds the player after the mirror', async () => {
    pg.settlement = { settlementId: 'ms_order1', state: 'RESERVED' };

    expect(await reverseHold('order1', { reason: 'not received', by: 'admin1' })).toBe(true);

    // Mirror BEFORE refund — the opposite of settleHold, deliberately. The
    // refund is idempotent so a retry is free; an order left HELD is not,
    // because the next sweep would meet a settlement already CANCELLED, be
    // refused, and hand it straight back forever.
    expect(calls).toEqual(['pg:cancel', 'mirror', 'mongo:updateOne', 'refund']);
    expect(PaymentOrder.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('refuses once the sweep has already settled', async () => {
    pg.settlement = { settlementId: 'ms_order1', state: 'SETTLED' };
    pg.cancel = { ok: false, reason: 'invalid_transition', state: 'SETTLED' };

    expect(await reverseHold('order1')).toBe(false);
    // After settlement a dispute is a clawback decision for an admin. Refunding
    // here would pay the player twice — the merchant has already been credited.
    expect(refundWithdrawal).not.toHaveBeenCalled();
  });

  it('does not report a reversal it did not perform', async () => {
    pg.settlement = { settlementId: 'ms_order1', state: 'CANCELLED' };
    pg.cancel = { ok: true, idempotent: true, settlement: { state: 'CANCELLED', direction: 'WITHDRAWAL', updatedAt: new Date(3) } };

    expect(await reverseHold('order1')).toBe(false);
    expect(refundWithdrawal).not.toHaveBeenCalled();
  });

  it('alerts rather than failing silently when the refund does not land', async () => {
    pg.settlement = { settlementId: 'ms_order1', state: 'RESERVED' };
    refundWithdrawal.mockImplementationOnce(async () => { throw new Error('wallet down'); });

    await expect(reverseHold('order1')).rejects.toThrow('wallet down');
    expect(sendAlert).toHaveBeenCalledWith(
      'withdrawal-hold-refund-failed', expect.any(String), expect.objectContaining({ orderId: 'order1' }),
    );
  });

  it('falls back to Mongo\'s gate for an order held before the flip', async () => {
    pg.settlement = null; // no settlement exists to gate on

    expect(await reverseHold('order1')).toBe(true);
    // There is nothing for the state machine to refuse, so the only gate that
    // exists is Mongo's — using it is correct here, and is exactly why the
    // "no settlement" case is separated from the rest.
    expect(calls).toEqual(['mongo:gate', 'refund', 'pg:cancel']);
  });
});

describe('MongoDB authority is untouched', () => {
  beforeEach(() => { authoritative.value = false; });

  it('settleHold still gates on findOneAndUpdate and credits the merchant separately', async () => {
    expect(await settleHold('order1')).toBe(true);
    expect(calls).toEqual(['mongo:gate', 'release', 'creditMerchant']);
    expect(completeSettlement).not.toHaveBeenCalled();
  });

  it('settleHold returns false when the Mongo gate is lost', async () => {
    store.mongoGateWins = false;
    expect(await settleHold('order1')).toBe(false);
    expect(releaseWithdrawal).not.toHaveBeenCalled();
  });

  it('reverseHold still gates on findOneAndUpdate', async () => {
    expect(await reverseHold('order1')).toBe(true);
    expect(calls).toEqual(['mongo:gate', 'refund']);
    expect(cancelSettlement).not.toHaveBeenCalled();
  });
});
