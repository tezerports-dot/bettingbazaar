// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * POST /api/admin/payment-orders/:orderId/action — the admin override on a
 * player's money, over HTTP against a real database.
 *
 * ── Why this file exists ────────────────────────────────────────────────────
 * Two routes force-complete a deposit and they did not agree.
 *
 * `POST /api/payment/deposit/:orderId/confirm` (the merchant/admin path,
 * deleted 2026-10-01 — no screen called it) took the merchant side for the
 * whole amount, credited the player's deposit and reserve pockets separately,
 * and released the UTR. This admin route did none of that: it credited
 * `tokenAmount` in one lump, took nothing from the side that owed it and never
 * released the UTR — so an admin force-approval MINTED tokens, and the books
 * did not close.
 *
 * It also passed a SENTENCE where `creditDeposit` expects an order id. That
 * argument builds the idempotency key (`dep_complete_<orderId>`), so the two
 * routes wrote different keys for the same deposit and each could credit the
 * player once — the "unique tx_id idempotency gate" CLAUDE.md keeps was open.
 *
 * The reject path was worse. `creditWinnings` requires a deterministic txId as
 * its SIXTH argument and throws without one; this passed three. The throw lands
 * AFTER `cancelOrder` has already succeeded, so a rejected withdrawal left the
 * order CANCELLED with the player's money still debited and never returned.
 *
 * ── The side that owes a buy is the TEAM POOL (PROJECT_STATUS §3.10, 2c) ────
 * A buy reaches a member of a working team through team routing, and its
 * tokens are HELD in that team's pool from the moment it is assigned. The
 * approval spends that hold (`moveDepositMoney` → `teamPools.spendForBuy`):
 * the pool's `held` falls by the amount and the treasury moves it TEAM_FLOAT →
 * USER_FLOAT, keyed on the order. Both sides are asserted below — the player's
 * pockets, the pool, and the order's own treasury legs.
 *
 * ── Why not mocked ──────────────────────────────────────────────────────────
 * CLAUDE.md: do not mock the boundary that carries money. Every assertion below
 * reads the wallet, the pool and the treasury back out of PostgreSQL after a
 * real HTTP request through the real router, auth chain and wallet authority.
 * The orders themselves are made the way production makes them: written at
 * PENDING_QUEUE, offered through `tryAssignMerchant`, accepted, and marked paid
 * by the player's own service call (§32 S16).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pgConfigured, applySchema, closePg, pgQuery, withTransaction } from '#db/client.js';
// A fixture's tokens come from the platform's own holding, posted with the
// credit: the database refuses a wallet that gains tokens from nowhere.
import { fundWallet } from '#db/tests/_funding.js';
import { createOrderRecord, getOrderRecord } from '#db/repositories/orders.record.js';
import { transitionOrder } from '#db/repositories/orders.js';
import { getPool, spendForBuy } from '#db/repositories/teamPools.js';
import { setCashReady } from '#db/repositories/teamRouting.js';
import { getBalances } from '../../domains/wallet/walletAuthority.service.js';
import { moveDepositMoney } from '../../domains/payment/depositCredit.js';
import { tryAssignMerchant, markOrderPaid } from '../../domains/payment/paymentProcessing.service.js';
import { teamFixture, readyToPay } from '../teamFixture.js';
import { mountRouter, actor, merchantActor, as } from './_harness.js';

const describePg = pgConfigured() ? describe : describe.skip;

describePg('admin force-action on a payment order', () => {
  let app;
  const teams = teamFixture();
  const made = [];

  beforeAll(async () => {
    await applySchema();
    const mod = await import('../../domains/payment/paymentOrder.routes.js');
    app = mountRouter(mod.default);
  }, 60_000);

  afterAll(async () => {
    // Trap 10: this run's orders, then its teams. The transitions table is
    // append-only, so its rows go with replication triggers off — in ONE
    // transaction, so the setting cannot leak onto a pooled connection.
    await withTransaction(async (c) => {
      await c.query('SET LOCAL session_replication_role = replica');
      await c.query('DELETE FROM order_transitions WHERE order_id = ANY($1)', [made]);
      await c.query('DELETE FROM order_states WHERE order_id = ANY($1)', [made]);
    });
    await teams.cleanup();
    await closePg();
  });

  const admin = () => actor({ isAdmin: true });
  let seq = 0;
  const oid = (p) => { const id = `${p}-${Date.now().toString(36)}-${seq += 1}`; made.push(id); return id; };

  /** What the treasury moved for ONE order, account → paise. Both sides, per order. */
  const legsFor = async (orderId) => {
    const { rows } = await pgQuery(
      `SELECT account, SUM(amount_paise)::bigint AS paise FROM treasury_entries
        WHERE ref_id = $1 GROUP BY account`, [orderId]);
    return Object.fromEntries(rows.map((r) => [r.account, Number(r.paise)]));
  };

  /**
   * A PAID deposit with a real 60/40 split, served by a member of a working
   * CASH team (≤ 10,000 tokens is the CASH rail) whose pool HOLDS it — the
   * state the player's mark-paid leaves a buy in, reached the way production
   * reaches it.
   */
  const paidDeposit = async ({ tokenAmount = 1000, deposit = 600, reserve = 400 } = {}) => {
    const player = await actor({});
    const merchant = await merchantActor({});
    const team = await teams.workingTeam({ rail: 'CASH', poolTokens: 10_000, include: [merchant.merchantId] });
    // A CASH buy goes only to a member who has said they are at the machine.
    expect(await setCashReady(merchant.merchantId, true)).toEqual({ ok: true, ready: true });
    const orderId = oid('dep');
    const order = await createOrderRecord({
      orderId, userId: player.userId, type: 'DEPOSIT',
      tokenAmountRupees: tokenAmount, fiatAmountRupees: tokenAmount,
      currency: 'INR', rateUsed: 1, merchantProfit: 0,
      depositAllocation: deposit, reserveAllocation: reserve,
    });
    expect(await tryAssignMerchant(order), 'team routing did not take the buy').toBe(true);
    const assigned = await getOrderRecord(orderId);
    expect(assigned).toMatchObject({ merchantId: merchant.merchantId, teamId: team.teamId, poolHeldPaise: tokenAmount * 100 });
    expect((await transitionOrder(orderId, 'PROCESSING', { set: { processingAt: new Date() } })).ok).toBe(true);
    await readyToPay(orderId);
    await markOrderPaid(player.userId, orderId, `UTRPOA${Date.now()}${seq}`);
    expect((await getOrderRecord(orderId)).status).toBe('PAID');
    return { player, merchant, team, orderId };
  };

  it('takes from the team pool exactly what it credits the player', async () => {
    // The conservation property. An approval that credits without taking from
    // the side that owes it is token creation, and nothing downstream would
    // ever notice it.
    const { player, team, orderId } = await paidDeposit({ tokenAmount: 1000, deposit: 600, reserve: 400 });
    const poolBefore = await getPool(team.teamId);
    const before = await getBalances(player.userId);

    const res = await as(app, await admin())
      .post(`/payment-orders/${orderId}/action`).send({ action: 'APPROVE' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const poolAfter = await getPool(team.teamId);
    const after = await getBalances(player.userId);
    const credited = (Number(after.depositBalance) - Number(before.depositBalance))
                   + (Number(after.reserveBalance || 0) - Number(before.reserveBalance || 0));

    expect(credited).toBe(1000);
    // The pool parts with the HOLD — the tokens the assignment set aside —
    // and nothing from what it still has free.
    expect(poolBefore.heldPaise - poolAfter.heldPaise).toBe(100_000);
    expect(poolAfter.availablePaise).toBe(poolBefore.availablePaise);
    // …and the books say the same, for this order alone.
    expect(await legsFor(orderId)).toEqual({ TEAM_FLOAT: -100_000, USER_FLOAT: 100_000 });
    expect(await getOrderRecord(orderId)).toMatchObject({ status: 'COMPLETED', poolHeldPaise: 0 });
  });

  it('honours the deposit/reserve split instead of crediting one lump', async () => {
    // The reserve share is not the player's to spend. Crediting the whole
    // tokenAmount to depositBalance puts it in the spendable pocket.
    const { player, orderId } = await paidDeposit({ tokenAmount: 1000, deposit: 600, reserve: 400 });
    const before = await getBalances(player.userId);

    await as(app, await admin()).post(`/payment-orders/${orderId}/action`).send({ action: 'APPROVE' });

    const after = await getBalances(player.userId);
    expect(Number(after.depositBalance) - Number(before.depositBalance)).toBe(600);
    expect(Number(after.reserveBalance || 0) - Number(before.reserveBalance || 0)).toBe(400);
  });

  it('shares one idempotency key with the member confirm path', async () => {
    // The two routes must not be able to credit the same deposit twice. The key
    // is derived from the order id; a sentence in that argument makes a second,
    // non-colliding key. Crediting through the wallet authority directly with
    // the order id is exactly what the member's confirm does.
    const { player, team, orderId } = await paidDeposit({ tokenAmount: 1000, deposit: 1000, reserve: 0 });
    const before = await getBalances(player.userId);

    await as(app, await admin()).post(`/payment-orders/${orderId}/action`).send({ action: 'APPROVE' });
    const afterAdmin = await getBalances(player.userId);
    expect(Number(afterAdmin.depositBalance) - Number(before.depositBalance)).toBe(1000);
    const poolAfterAdmin = await getPool(team.teamId);

    // The confirm path's own two movements, replayed. Both must be no-ops: the
    // pool's spend is keyed on the order as the player's credit is.
    // One movement now, not two: the credit is INSIDE the spend's transaction
    // (owner, 2026-10-07), so replaying the spend replays both halves.
    expect(await spendForBuy(orderId)).toEqual({ ok: true, alreadyTaken: true });
    const afterBoth = await getBalances(player.userId);
    expect(Number(afterBoth.depositBalance)).toBe(Number(afterAdmin.depositBalance));
    expect(await getPool(team.teamId)).toEqual(poolAfterAdmin);
    expect(await legsFor(orderId)).toEqual({ TEAM_FLOAT: -100_000, USER_FLOAT: 100_000 });
  });

  it('refuses to approve a buy no team has taken, and moves nothing', async () => {
    // Refusing is the ordinary case, and it must refuse BEFORE the order
    // advances. A buy still waiting in the queue holds nothing in any pool —
    // there is no side to take it from — so approving it would credit a player
    // out of thin air. The order is exactly what `createDepositOrder` writes
    // when no member is free.
    const player = await actor({});
    const orderId = oid('dep-queued');
    await createOrderRecord({
      orderId, userId: player.userId, type: 'DEPOSIT',
      tokenAmountRupees: 5000, fiatAmountRupees: 5000,
      currency: 'INR', rateUsed: 1, merchantProfit: 0,
      depositAllocation: 5000, reserveAllocation: 0,
    });
    const before = await getBalances(player.userId);

    const res = await as(app, await admin())
      .post(`/payment-orders/${orderId}/action`).send({ action: 'APPROVE' });

    expect(res.status).toBe(409);
    // The refusal says why, in the admin's terms: a queued buy is not an
    // order an approval can complete (asked before any money is touched).
    expect(res.body.message).toMatch(/Cannot APPROVE an order that is PENDING_QUEUE/);
    const after = await getBalances(player.userId);
    expect(Number(after.depositBalance)).toBe(Number(before.depositBalance));
    expect((await getOrderRecord(orderId)).status).toBe('PENDING_QUEUE');
    expect(await legsFor(orderId)).toEqual({});
  });

  it('refuses to approve a buy a member rejected, before any money moves', async () => {
    // Security review, 2026-10-03: the money moved FIRST and the transition
    // refused second, so approving a REJECTED buy credited the player, spent
    // the team's hold and then answered 409 — tokens delivered on an order
    // that still read REJECTED. The state is asked before the spend now, and
    // again by the spend under the order's lock.
    const { player, team, orderId } = await paidDeposit({ tokenAmount: 1000, deposit: 1000, reserve: 0 });
    expect((await transitionOrder(orderId, 'REJECTED', { actor: 'test' })).ok).toBe(true);
    const poolBefore = await getPool(team.teamId);
    const before = await getBalances(player.userId);

    const res = await as(app, await admin())
      .post(`/payment-orders/${orderId}/action`).send({ action: 'APPROVE' });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.message).toMatch(/Cannot APPROVE an order that is REJECTED/);
    const after = await getBalances(player.userId);
    expect(Number(after.depositBalance)).toBe(Number(before.depositBalance));
    expect(await getPool(team.teamId)).toEqual(poolBefore);
    expect(await legsFor(orderId)).toEqual({});
    expect(await getOrderRecord(orderId)).toMatchObject({ status: 'REJECTED', poolHeldPaise: 100_000 });
  });

  it('a confirm that read the buy as PAID pays nothing once a reject has landed', async () => {
    // The race itself, at the one function every completing route calls: the
    // member's confirm read PAID, a reject (or expiry, or dispute) committed,
    // and only then did the money move. The spend asks the state again under
    // the order's lock.
    const { player, team, orderId } = await paidDeposit({ tokenAmount: 1000, deposit: 1000, reserve: 0 });
    const readAsPaid = await getOrderRecord(orderId);
    expect((await transitionOrder(orderId, 'REJECTED', { actor: 'test' })).ok).toBe(true);
    const poolBefore = await getPool(team.teamId);
    const before = await getBalances(player.userId);

    const moved = await moveDepositMoney(readAsPaid, {
      releaseUTR: async () => {}, requireState: 'PAID',
    });

    expect(moved).toMatchObject({ ok: false, reason: 'order_state' });
    expect(Number((await getBalances(player.userId)).depositBalance)).toBe(Number(before.depositBalance));
    expect(await getPool(team.teamId)).toEqual(poolBefore);
    expect(await legsFor(orderId)).toEqual({});
  });

  it('a REJECT on a disputed buy still works: the refusal is about paid-out tokens only', async () => {
    // The opposite behaviour (§37 step 6). Nothing was paid out on a buy the
    // player disputes, so the admin may still decide it either way.
    const { orderId } = await paidDeposit({ tokenAmount: 1000, deposit: 1000, reserve: 0 });
    expect((await transitionOrder(orderId, 'DISPUTED', { actor: 'test' })).ok).toBe(true);

    const res = await as(app, await admin())
      .post(`/payment-orders/${orderId}/action`).send({ action: 'REJECT', reason: 'no payment arrived' });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await getOrderRecord(orderId)).status).toBe('CANCELLED');
    expect(await legsFor(orderId)).toEqual({});
  });

  it('returns the money when a withdrawal is rejected', async () => {
    // The player's winnings were already debited when the withdrawal was
    // admitted. Cancelling without refunding is money taken and not returned,
    // and the old code THREW on the refund after the cancel had committed.
    const player = await actor({});
    const orderId = oid('wd');
    // Fund winnings the way the platform does, then debit as admission would.
    // 1,000 tokens: a cash payout is a denomination (`createWithdrawalOrder`
    // refuses 2,000 by name), so that is the amount a real queued sell carries.
    const { debitWinningsForWithdrawal } = await import('../../domains/wallet/walletAuthority.service.js');
    // Seeded out of the platform's holding, NOT against this order's id: the
    // seed's own treasury legs would otherwise read as legs of the order.
    await fundWallet(player.userId, 1000_00, `rt_seed_${orderId}`, 'winningsBalance');
    await debitWinningsForWithdrawal(player.userId, 1000, orderId);

    const afterDebit = await getBalances(player.userId);
    await createOrderRecord({
      orderId, userId: player.userId, type: 'WITHDRAWAL',
      tokenAmountRupees: 1000, fiatAmountRupees: 1000, state: 'PENDING_QUEUE',
      // As `createWithdrawalOrder` writes every withdrawal: the stake is locked.
      escrowLocked: true, escrowStatus: 'LOCKED', escrowAmount: 1000,
    });

    const res = await as(app, await admin())
      .post(`/payment-orders/${orderId}/action`).send({ action: 'REJECT', reason: 'bad bank details' });

    expect(res.status).toBe(200);
    const after = await getBalances(player.userId);
    expect(Number(after.winningsBalance) - Number(afterDebit.winningsBalance)).toBe(1000);
    // …and it comes back OUT OF THE LOCK. Admission moved it winnings → locked,
    // so returning it is locked → winnings. A credit to winnings alone leaves the
    // same 1,000 in both pockets: the wallet reads 2,000 from a 1,000 seed and
    // the token total no longer adds up. This assertion was missing, which is how
    // the refund could credit winnings and never touch the lock.
    expect(Number(after.lockedBalance)).toBe(Number(afterDebit.lockedBalance) - 1000);
    expect((await getOrderRecord(orderId)).status).toBe('CANCELLED');
    // A sell that never settled put nothing in any pool, so nothing comes out.
    expect(await legsFor(orderId)).toEqual({});
  });

  it('keys the refund on the order id, so a replay cannot double it', async () => {
    // The `exactly once` case below passes for a weaker reason: the transition
    // refuses the second reject before the refund is reached. The KEY is what
    // protects the repair case — a refund that fails after the cancel has
    // committed must be replayable without paying twice — so assert it
    // directly. `wallet_ledger.tx_id` is UNIQUE, which is what makes the key
    // the gate rather than a label.
    const player = await actor({});
    const orderId = oid('wd-key');
    const { debitWinningsForWithdrawal } = await import('../../domains/wallet/walletAuthority.service.js');
    await fundWallet(player.userId, 1000_00, `rt_seed_${orderId}`, 'winningsBalance');
    await debitWinningsForWithdrawal(player.userId, 1000, orderId);
    await createOrderRecord({
      orderId, userId: player.userId, type: 'WITHDRAWAL',
      tokenAmountRupees: 1000, fiatAmountRupees: 1000, state: 'PENDING_QUEUE',
      // As `createWithdrawalOrder` writes every withdrawal: the stake is locked.
      escrowLocked: true, escrowStatus: 'LOCKED', escrowAmount: 1000,
    });

    await as(app, await admin()).post(`/payment-orders/${orderId}/action`).send({ action: 'REJECT' });

    // The ONE refund key every path returns a withdrawal's stake on —
    // `refundWithdrawal`'s `refund_<id>`, shared with the player's own cancel
    // and the expiry sweep. This route used its own (`wd_refund_`) on a credit
    // that never left the lock, so the ledger could not have told the two
    // refunds of one withdrawal apart (F-027).
    const { rows } = await pgQuery(
      'SELECT tx_id, ref_id FROM wallet_ledger WHERE tx_id = $1', [`refund_${orderId}`]);
    expect(rows).toHaveLength(1);
    // And the ledger row points back at the order, not at a sentence.
    expect(rows[0].ref_id).toBe(orderId);

    // The repair replay: the same refund, again, on the same key. A no-op.
    const { refundWithdrawal } = await import('../../domains/wallet/walletAuthority.service.js');
    const before = await getBalances(player.userId);
    await refundWithdrawal(player.userId, 1000, orderId);
    const after = await getBalances(player.userId);
    expect(Number(after.winningsBalance)).toBe(Number(before.winningsBalance));
    expect(Number(after.lockedBalance)).toBe(Number(before.lockedBalance));
  });

  it('refunds a rejected withdrawal exactly once', async () => {
    const player = await actor({});
    const orderId = oid('wd-twice');
    const { debitWinningsForWithdrawal } = await import('../../domains/wallet/walletAuthority.service.js');
    await fundWallet(player.userId, 1000_00, `rt_seed_${orderId}`, 'winningsBalance');
    await debitWinningsForWithdrawal(player.userId, 1000, orderId);
    await createOrderRecord({
      orderId, userId: player.userId, type: 'WITHDRAWAL',
      tokenAmountRupees: 1000, fiatAmountRupees: 1000, state: 'PENDING_QUEUE',
      // As `createWithdrawalOrder` writes every withdrawal: the stake is locked.
      escrowLocked: true, escrowStatus: 'LOCKED', escrowAmount: 1000,
    });

    await as(app, await admin()).post(`/payment-orders/${orderId}/action`).send({ action: 'REJECT' });
    const once = await getBalances(player.userId);
    // A second reject is refused by the transition, and must not refund again.
    await as(app, await admin()).post(`/payment-orders/${orderId}/action`).send({ action: 'REJECT' });
    const twice = await getBalances(player.userId);
    expect(Number(twice.winningsBalance)).toBe(Number(once.winningsBalance));
  });
});
