// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * The withdrawal hold under PostgreSQL authority, driving BOTH stores at once.
 *
 * ── What only this test can prove ───────────────────────────────────────────
 * Two suites already cover the pieces: merchantSettlementMirror.test.js proves
 * the gate and the mirror handoff against a real PostgreSQL, and
 * withdrawalHoldPgRouting.test.js proves the orchestration — which call happens
 * after which, and what compensates what. Both mock the store they are not
 * about.
 *
 * What neither can prove is that the two stores AGREE. The whole point of the
 * inversion is that Postgres decides and Mongo follows, and a claim about two
 * databases is not testable against one of them:
 *
 *   • that the settlement's pocket movement really lands on
 *     `Merchant.tokenBalance` and in `MerchantWalletLedger`, in rupees, keyed
 *     the way Mongo's own idempotency gate looks them up — which is what makes
 *     a fallback to Mongo safe rather than a double-apply waiting to happen;
 *   • that a race decided by a Postgres row lock leaves Mongo with ONE credited
 *     merchant and ONE completed order, not a partial write from each loser;
 *   • that Postgres wins when the two disagree, which is the definition of
 *     authority and cannot be observed from inside either store alone.
 *
 * ── Why authority is mocked rather than set by environment ──────────────────
 * merchant_settlement is not cutover-eligible: it depends on ORDERS, which is
 * still Mongo-authoritative, so `isPostgresAuthoritative` returns false for
 * every environment variable there is — by design, and correctly. Mocking the
 * resolver tests the CODE PATH the flip will one day take. It does not assert
 * that the flip has happened, and this test passing is not evidence that it
 * should.
 *
 * REQUIRES both MONGODB_URI (a replica set) and DATABASE_URL. Skips otherwise.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import '../../models/index.js';

// vi.hoisted, not a plain const: vi.mock is lifted above every import, and this
// file has STATIC imports (mongoose, models/index.js) that transitively reach
// moneyAuthority — so the factory can run while a plain `const` below is still
// in its temporal dead zone.
//
// The mock is deliberately blanket rather than per-path. merchant_settlement
// depends transitively on wallet and merchant_wallet, so "settlement on
// Postgres, player wallet on Mongo" is not a configuration production can ever
// reach; testing it would be testing a fiction. Everything on Postgres is the
// real end state, which is also why the fixture has to build the player's stake
// through the wallet authority instead of writing it onto the User document.
const authoritative = vi.hoisted(() => ({ value: true }));

vi.mock('../../postgres/moneyAuthority.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, isPostgresAuthoritative: () => authoritative.value };
});

const { pgConfigured, pgQuery, applySchema } = await import('../../postgres/pgClient.js');
const { getMerchantBalances } = await import('../../postgres/merchantWalletPg.js');
const {
  DIRECTIONS, SETTLEMENT_STATES, openSettlement, getSettlement,
  getSettlementHistory, reconcileSettlements,
} = await import('../../postgres/merchantSettlementPg.js');
const { creditWinnings, lockWithdrawal } = await import('../../domains/wallet/walletAuthority.service.js');
const { settleHold, reverseHold, settleDueHolds } = await import('../../domains/payment/withdrawalHold.service.js');

const hasPg = pgConfigured();
const describePg = hasPg ? describe : describe.skip;

const Merchant = () => mongoose.model('Merchant');
const User = () => mongoose.model('User');
const PaymentOrder = () => mongoose.model('PaymentOrder');
const Ledger = () => mongoose.model('MerchantWalletLedger');

let seq = 0;

/**
 * A withdrawal frozen exactly as merchant.routes leaves it on confirm: the
 * player's stake already locked since order creation, the order HELD, and the
 * merchant's tokens reserved in a pocket they cannot spend.
 *
 * The player's balance is built by CALLING THE WALLET AUTHORITY rather than by
 * writing the numbers onto the User document. That distinction cost a CI run:
 * seeding Mongo by hand leaves the Postgres wallet at zero, and under Postgres
 * authority `releaseWithdrawal` then refuses with "lockedBalance would go
 * negative: current=0" — a fixture that had never actually locked anything.
 * Driving the real credit and lock means the stake exists wherever authority
 * says it should, which is the only version of the fixture that stays correct
 * as paths flip.
 */
async function heldWithdrawal({ tokens = 500, holdUntil = new Date(Date.now() - 1000), reserve = true } = {}) {
  const n = ++seq;
  const owner = await User().create({
    username: `holdmo${n}`, mobile: `91000${String(n).padStart(5, '0')}`,
  });
  const merchant = await Merchant().create({
    name: `Hold M${n}`, username: `holdm${n}`, mobile: `92000${String(n).padStart(5, '0')}`,
    // `userId` is UNIQUE on the Merchant schema, so leaving it unset makes
    // every merchant after the first collide on null.
    userId: owner._id, tokenBalance: 0,
  });
  const user = await User().create({
    username: `holdu${n}`, mobile: `93000${String(n).padStart(5, '0')}`,
  });
  const order = await PaymentOrder().create({
    orderId: `BB-WD-${n}-${Date.now()}`, userId: user._id, merchantId: merchant._id,
    type: 'WITHDRAWAL', tokenAmount: tokens, fiatAmount: tokens, rateUsed: 1,
    status: 'PAID', merchantCreditStatus: 'HELD', merchantCreditHoldUntil: holdUntil,
    escrowLocked: true,
  });

  await creditWinnings(user._id.toString(), tokens, 'test seed', 'Bet', `seed_${n}`, `seed_win_${n}`);
  await lockWithdrawal(user._id.toString(), tokens, order._id.toString());

  if (reserve) {
    const opened = await openSettlement({
      settlementId: `ms_${order._id}`, merchantId: merchant._id.toString(),
      orderId: order._id.toString(), direction: DIRECTIONS.WITHDRAWAL,
      amountPaise: tokens * 100, reason: 'held pending settlement',
    });
    expect(opened.ok).toBe(true);
  }
  return { merchant, user, order };
}

/** The player's balances from whichever store currently owns them. */
async function playerBalances(userId) {
  const { getBalances } = await import('../../domains/wallet/walletAuthority.service.js');
  return getBalances(userId.toString());
}

const freshOrder = (id) => PaymentOrder().findById(id).lean();
const freshMerchant = (id) => Merchant().findById(id).lean();

describePg('withdrawal hold — PostgreSQL authority, both stores', () => {
  beforeEach(async () => {
    await applySchema();
    authoritative.value = true;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  // ── The happy path, checked in BOTH stores ────────────────────────────────
  it('settles in Postgres and lands the same facts in Mongo', async () => {
    const { merchant, user, order } = await heldWithdrawal({ tokens: 500 });

    // Before: the platform OWES the merchant, and they cannot spend it. This is
    // the state Mongo cannot express at all — there, the tokens simply do not
    // exist during the hold, so nothing shows the liability.
    expect(await getMerchantBalances(merchant._id.toString()))
      .toMatchObject({ available: 0, settlement: 50_000, liability: 50_000 });

    expect(await settleHold(order._id)).toBe(true);

    // Postgres: settled, and the tokens are now spendable.
    expect((await getSettlement(`ms_${order._id}`)).state).toBe(SETTLEMENT_STATES.SETTLED);
    expect(await getMerchantBalances(merchant._id.toString()))
      .toMatchObject({ available: 50_000, settlement: 0, liability: 0 });

    // Mongo: the same movement, in rupees, on the single field it has.
    expect((await freshMerchant(merchant._id)).tokenBalance).toBe(500);

    // …and the LEDGER rows, which are the part that makes a fallback safe.
    // Mongo's idempotency gate is MerchantWalletLedger.findOne({ txId }); with
    // no row there, the first retry after a fallback credits the merchant a
    // second time. A multi-leg movement is keyed `<txId>:<pocket>` in Postgres,
    // so every row must also carry the logical `movementId` the gate matches.
    const rows = await Ledger().find({ merchantId: merchant._id.toString() }).lean();
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows.every((r) => r.movementId)).toBe(true);

    // The order, mirrored — including completedAt, which the sweeper's own
    // query and every downstream report read.
    const o = await freshOrder(order._id);
    expect(o).toMatchObject({ status: 'COMPLETED', merchantCreditStatus: 'RELEASED', escrowLocked: false });
    expect(o.completedAt).toBeInstanceOf(Date);

    // The player's stake was consumed, not merely unlocked.
    expect(await playerBalances(user._id)).toMatchObject({ lockedBalance: 0, winningsBalance: 0 });

    expect(await reconcileSettlements(merchant._id.toString())).toMatchObject({ ok: true });
  });

  // ── The race the gate exists for ──────────────────────────────────────────
  it('20 concurrent sweeps settle exactly once, in both stores', async () => {
    const { merchant, order } = await heldWithdrawal({ tokens: 500 });

    const results = await Promise.all(Array.from({ length: 20 }, () => settleHold(order._id)));

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await getMerchantBalances(merchant._id.toString())).toMatchObject({ available: 50_000 });
    // The assertion that would fail if the losers wrote anything: 500, never
    // 1000, and never 10_000.
    expect((await freshMerchant(merchant._id)).tokenBalance).toBe(500);
    // One reservation (1 leg) plus one completion (2 legs, settlement→available).
    // 20 callers, 3 rows: the losers wrote nothing at all.
    expect(await Ledger().countDocuments({ merchantId: merchant._id.toString() })).toBe(3);
    // And the state machine advanced exactly once, not twenty times.
    expect(await getSettlementHistory(`ms_${order._id}`)).toHaveLength(2);
  });

  it('a dispute and a sweep racing the same order produce exactly one outcome', async () => {
    const { merchant, user, order } = await heldWithdrawal({ tokens: 500 });

    const [settled, reversed] = await Promise.all([
      settleHold(order._id),
      reverseHold(order._id, { reason: 'not received' }),
    ]);

    // Exactly one, whichever wins — the point is that they cannot both.
    expect([settled, reversed].filter(Boolean)).toHaveLength(1);

    const s = await getSettlement(`ms_${order._id}`);
    const o = await freshOrder(order._id);
    const m = await freshMerchant(merchant._id);
    const u = await playerBalances(user._id);

    if (settled) {
      expect(s.state).toBe(SETTLEMENT_STATES.SETTLED);
      expect(o.merchantCreditStatus).toBe('RELEASED');
      expect(m.tokenBalance).toBe(500);
      expect(u.winningsBalance).toBe(0); // stake consumed
    } else {
      expect(s.state).toBe(SETTLEMENT_STATES.CANCELLED);
      expect(o.merchantCreditStatus).toBe('REVERSED');
      expect(m.tokenBalance).toBe(0);   // never credited
      expect(u.winningsBalance).toBe(500); // stake returned
    }
    expect(u.lockedBalance).toBe(0);
  });

  // ── Authority: what happens when the two stores disagree ──────────────────
  it('Postgres decides even when Mongo says the order already settled', async () => {
    const { merchant, order } = await heldWithdrawal({ tokens: 500 });

    // A mirror that dropped its write, or a fallback that rolled Mongo forward
    // by hand. Under the OLD design this order was unreachable forever: the
    // findOneAndUpdate gate filtered on HELD and would never match again.
    await PaymentOrder().updateOne({ _id: order._id }, {
      $set: { merchantCreditStatus: 'RELEASED', status: 'COMPLETED' },
    });

    // The settlement is still RESERVED, so the settlement still decides.
    expect(await settleHold(order._id)).toBe(true);
    expect((await getSettlement(`ms_${order._id}`)).state).toBe(SETTLEMENT_STATES.SETTLED);
    expect((await freshMerchant(merchant._id)).tokenBalance).toBe(500);
  });

  it('repairs a lagging mirror rather than re-offering the order forever', async () => {
    const { merchant, order } = await heldWithdrawal({ tokens: 500 });
    expect(await settleHold(order._id)).toBe(true);

    // Simulate the mirror having failed: Postgres is SETTLED, Mongo still HELD,
    // so the sweep keeps finding this order. Nothing in the old design ever
    // took it out of that queue.
    await PaymentOrder().updateOne({ _id: order._id }, {
      $set: { merchantCreditStatus: 'HELD', status: 'PAID' },
    });

    expect(await settleDueHolds()).toBe(0); // nothing NEWLY settled…
    const o = await freshOrder(order._id);   // …but the state was repaired
    expect(o.merchantCreditStatus).toBe('RELEASED');
    expect(o.status).toBe('COMPLETED');
    // And the repair did not pay anyone a second time.
    expect((await freshMerchant(merchant._id)).tokenBalance).toBe(500);
  });

  it('opens lazily for an order that was held before the flip', async () => {
    const { merchant, order } = await heldWithdrawal({ tokens: 500, reserve: false });
    // No settlement row: merchant.routes only opens one under Postgres
    // authority, so every order already in the hold queue at flip time is here.
    expect(await getSettlement(`ms_${order._id}`)).toBeNull();

    expect(await settleHold(order._id)).toBe(true);
    expect((await getSettlement(`ms_${order._id}`)).state).toBe(SETTLEMENT_STATES.SETTLED);
    expect((await freshMerchant(merchant._id)).tokenBalance).toBe(500);
  });

  it('will not conjure a settlement for an order that already left the hold', async () => {
    const { merchant, order } = await heldWithdrawal({ tokens: 500, reserve: false });
    await PaymentOrder().updateOne({ _id: order._id }, { $set: { merchantCreditStatus: 'RELEASED' } });

    expect(await settleHold(order._id)).toBe(false);
    expect(await getSettlement(`ms_${order._id}`)).toBeNull();
    expect((await freshMerchant(merchant._id)).tokenBalance).toBe(0);
  });

  // ── Compensation ──────────────────────────────────────────────────────────
  it('reverses the settlement when the player stake cannot be released', async () => {
    const { merchant, user, order } = await heldWithdrawal({ tokens: 500 });
    // The stake is gone from under the settlement — an inconsistency the
    // release will refuse. Ordering the gate first makes this reachable, so it
    // has to be compensated rather than sequenced away.
    //
    // Corrupted in POSTGRES, because that is where authority puts the stake in
    // this configuration. Zeroing the Mongo document instead would leave the
    // release perfectly happy and prove nothing.
    await pgQuery(
      `UPDATE wallets SET locked_paise = 0, locked_winnings_paise = 0 WHERE user_id = $1`,
      [user._id.toString()], 'test_corrupt_lock',
    );

    await expect(settleHold(order._id)).rejects.toThrow();

    const s = await getSettlement(`ms_${order._id}`);
    expect(s.state).toBe(SETTLEMENT_STATES.REVERSED);
    // Reversal is a MOVEMENT, so the tokens are back out of `available` and the
    // history says why — rather than a silent undo that leaves the merchant
    // credited for a stake the player still holds.
    expect(await getMerchantBalances(merchant._id.toString())).toMatchObject({ available: 0 });
    expect((await freshMerchant(merchant._id)).tokenBalance).toBe(0);
    expect((await freshOrder(order._id)).merchantCreditStatus).toBe('REVERSED');
  });

  // ── The sweeper, and the pool ─────────────────────────────────────────────
  it('sweeps 30 due holds without exhausting the connection pool', async () => {
    const seeded = [];
    for (let i = 0; i < 30; i++) seeded.push(await heldWithdrawal({ tokens: 100 }));

    const settled = await settleDueHolds({ limit: 100 });
    expect(settled).toBe(30);

    for (const { merchant, order } of seeded) {
      expect((await freshMerchant(merchant._id)).tokenBalance).toBe(100);
      expect((await freshOrder(order._id)).merchantCreditStatus).toBe('RELEASED');
    }
    // Every settlement explained by its pockets — the reconciliation hook, run
    // over the whole batch rather than one fixture.
    const { rows } = await pgQuery(
      `SELECT COUNT(*) AS stuck FROM merchant_settlements WHERE state = 'RESERVED'`);
    expect(Number(rows[0].stuck)).toBe(0);
  });

  it('leaves the Mongo path exactly as it was', async () => {
    authoritative.value = false;
    const { merchant, user, order } = await heldWithdrawal({ tokens: 500, reserve: false });

    expect(await settleHold(order._id)).toBe(true);
    expect((await freshMerchant(merchant._id)).tokenBalance).toBe(500);
    expect((await freshOrder(order._id)).merchantCreditStatus).toBe('RELEASED');
    expect(await playerBalances(user._id)).toMatchObject({ lockedBalance: 0, winningsBalance: 0 });

    // A merchant_settlements row DOES exist here, and it is not a contradiction:
    // dualWrite.mirrorMerchantSettlement derives one from every PaymentOrder
    // save while Mongo is authoritative. What must be true is that it is a
    // PROJECTION and not an authority.
    //
    // Two things say so. The state machine never ran, so there is no transition
    // history — the forward mirror writes STATE ONLY. And the committed pockets
    // are untouched: `available` is not asserted because mirrorMerchantBalance
    // legitimately projects Mongo's single number onto it, but `reserved` and
    // `settlement` are written by nothing except the state machine.
    expect(await getSettlementHistory(`ms_${order._id}`)).toEqual([]);
    expect(await getMerchantBalances(merchant._id.toString()))
      .toMatchObject({ reserved: 0, settlement: 0 });
  });
});
