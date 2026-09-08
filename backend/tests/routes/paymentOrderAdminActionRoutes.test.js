// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * POST /api/admin/payment-orders/:orderId/action — the admin override on a
 * player's money, over HTTP against a real database.
 *
 * ── Why this file exists ────────────────────────────────────────────────────
 * Two routes force-complete a deposit and they did not agree.
 *
 * `POST /api/payment/deposit/:orderId/confirm` (the merchant/admin path) debits
 * the merchant for the whole amount, credits the player's deposit and reserve
 * pockets separately, and releases the UTR. This admin route did none of that:
 * it credited `tokenAmount` in one lump, never debited the merchant, and never
 * released the UTR — so an admin force-approval MINTED tokens. The merchant
 * kept their float, the player got tokens, and the books did not close.
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
 * ── Why not mocked ──────────────────────────────────────────────────────────
 * CLAUDE.md: do not mock the boundary that carries money. Every assertion below
 * reads the wallet and the merchant float back out of PostgreSQL after a real
 * HTTP request through the real router, auth chain and wallet authority.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pgConfigured, applySchema, closePg, pgQuery } from '#db/client.js';
import { createOrderRecord, getOrderRecord } from '#db/repositories/orders.record.js';
import { getBalances, creditDeposit } from '../../domains/wallet/walletAuthority.service.js';
import { getMerchantTokenBalance } from '../../domains/merchant/merchantWallet.service.js';
import { mountRouter, actor, merchantActor, as } from './_harness.js';

const describePg = pgConfigured() ? describe : describe.skip;

describePg('admin force-action on a payment order', () => {
  let app;

  beforeAll(async () => {
    await applySchema();
    const mod = await import('../../domains/payment/paymentOrder.routes.js');
    app = mountRouter(mod.default);
  }, 60_000);

  afterAll(async () => { await closePg(); });

  const admin = () => actor({ isAdmin: true });
  let seq = 0;
  const oid = (p) => `${p}-${Date.now().toString(36)}-${seq += 1}`;

  /** A PAID deposit assigned to a funded merchant, with a real 60/40 split. */
  const paidDeposit = async ({ tokenAmount = 1000, deposit = 600, reserve = 400 } = {}) => {
    const player = await actor({});
    const merchant = await merchantActor({ tokensRupees: 50_000 });
    const orderId = oid('dep');
    await createOrderRecord({
      orderId, userId: player.userId, type: 'DEPOSIT',
      tokenAmountRupees: tokenAmount, fiatAmountRupees: tokenAmount,
      state: 'PAID', merchantId: merchant.merchantId,
      depositAllocation: deposit, reserveAllocation: reserve,
    });
    return { player, merchant, orderId };
  };

  it('debits the merchant for exactly what it credits the player', async () => {
    // The conservation property. An approval that credits without debiting is
    // token creation, and nothing downstream would ever notice it.
    const { player, merchant, orderId } = await paidDeposit({ tokenAmount: 1000, deposit: 600, reserve: 400 });
    const beforeFloat = Number(await getMerchantTokenBalance(merchant.merchantId));
    const before = await getBalances(player.userId);

    const res = await as(app, await admin())
      .post(`/payment-orders/${orderId}/action`).send({ action: 'APPROVE' });
    expect(res.status).toBe(200);

    const afterFloat = Number(await getMerchantTokenBalance(merchant.merchantId));
    const after = await getBalances(player.userId);
    const credited = (Number(after.depositBalance) - Number(before.depositBalance))
                   + (Number(after.reserveBalance || 0) - Number(before.reserveBalance || 0));

    expect(credited).toBe(1000);
    expect(beforeFloat - afterFloat).toBe(1000);
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

  it('shares one idempotency key with the merchant confirm path', async () => {
    // The two routes must not be able to credit the same deposit twice. The key
    // is derived from the order id; a sentence in that argument makes a second,
    // non-colliding key. Crediting through the wallet authority directly with
    // the order id is exactly what the merchant path does.
    const { player, orderId } = await paidDeposit({ tokenAmount: 1000, deposit: 1000, reserve: 0 });
    const before = await getBalances(player.userId);

    await as(app, await admin()).post(`/payment-orders/${orderId}/action`).send({ action: 'APPROVE' });
    const afterAdmin = await getBalances(player.userId);
    expect(Number(afterAdmin.depositBalance) - Number(before.depositBalance)).toBe(1000);

    // The merchant path's own credit, replayed. It must be a no-op.
    await creditDeposit(player.userId, 1000, orderId);
    const afterBoth = await getBalances(player.userId);
    expect(Number(afterBoth.depositBalance)).toBe(Number(afterAdmin.depositBalance));
  });

  it('refuses to approve when the merchant cannot cover it, and moves nothing', async () => {
    // Refusing is the ordinary case, and it must refuse BEFORE the order
    // advances — an order that reads COMPLETED against a float that could not
    // pay it is unrecoverable bookkeeping.
    const player = await actor({});
    const merchant = await merchantActor({ tokensRupees: 100 });
    const orderId = oid('dep-poor');
    await createOrderRecord({
      orderId, userId: player.userId, type: 'DEPOSIT',
      tokenAmountRupees: 5000, fiatAmountRupees: 5000,
      state: 'PAID', merchantId: merchant.merchantId,
      depositAllocation: 5000, reserveAllocation: 0,
    });
    const before = await getBalances(player.userId);

    const res = await as(app, await admin())
      .post(`/payment-orders/${orderId}/action`).send({ action: 'APPROVE' });

    expect(res.status).toBe(400);
    const after = await getBalances(player.userId);
    expect(Number(after.depositBalance)).toBe(Number(before.depositBalance));
    expect((await getOrderRecord(orderId)).status).not.toBe('COMPLETED');
    expect(Number(await getMerchantTokenBalance(merchant.merchantId))).toBe(100);
  });

  it('returns the money when a withdrawal is rejected', async () => {
    // The player's winnings were already debited when the withdrawal was
    // admitted. Cancelling without refunding is money taken and not returned,
    // and the old code THREW on the refund after the cancel had committed.
    const player = await actor({});
    const orderId = oid('wd');
    // Fund winnings the way the platform does, then debit as admission would.
    const { debitWinningsForWithdrawal } = await import('../../domains/wallet/walletAuthority.service.js');
    const { creditWinnings } = await import('../../domains/wallet/walletAuthority.service.js');
    await creditWinnings(player.userId, 2000, 'route test seed', 'Test', orderId, `rt_seed_${orderId}`);
    await debitWinningsForWithdrawal(player.userId, 2000, orderId);

    const afterDebit = await getBalances(player.userId);
    await createOrderRecord({
      orderId, userId: player.userId, type: 'WITHDRAWAL',
      tokenAmountRupees: 2000, fiatAmountRupees: 2000, state: 'PENDING_QUEUE',
    });

    const res = await as(app, await admin())
      .post(`/payment-orders/${orderId}/action`).send({ action: 'REJECT', reason: 'bad bank details' });

    expect(res.status).toBe(200);
    const after = await getBalances(player.userId);
    expect(Number(after.winningsBalance) - Number(afterDebit.winningsBalance)).toBe(2000);
    expect((await getOrderRecord(orderId)).status).toBe('CANCELLED');
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
    const { debitWinningsForWithdrawal, creditWinnings } = await import('../../domains/wallet/walletAuthority.service.js');
    await creditWinnings(player.userId, 2000, 'route test seed', 'Test', orderId, `rt_seed_${orderId}`);
    await debitWinningsForWithdrawal(player.userId, 2000, orderId);
    await createOrderRecord({
      orderId, userId: player.userId, type: 'WITHDRAWAL',
      tokenAmountRupees: 2000, fiatAmountRupees: 2000, state: 'PENDING_QUEUE',
    });

    await as(app, await admin()).post(`/payment-orders/${orderId}/action`).send({ action: 'REJECT' });

    const { rows } = await pgQuery(
      'SELECT tx_id, ref_id FROM wallet_ledger WHERE tx_id = $1', [`wd_refund_${orderId}`]);
    expect(rows).toHaveLength(1);
    // And the ledger row points back at the order, not at a sentence.
    expect(rows[0].ref_id).toBe(orderId);

    // The repair replay: the same credit, again, on the same key. A no-op.
    const before = await getBalances(player.userId);
    await creditWinnings(player.userId, 2000, 'replay', 'PaymentOrder', orderId, `wd_refund_${orderId}`);
    const after = await getBalances(player.userId);
    expect(Number(after.winningsBalance)).toBe(Number(before.winningsBalance));
  });

  it('refunds a rejected withdrawal exactly once', async () => {
    const player = await actor({});
    const orderId = oid('wd-twice');
    const { debitWinningsForWithdrawal, creditWinnings } = await import('../../domains/wallet/walletAuthority.service.js');
    await creditWinnings(player.userId, 2000, 'route test seed', 'Test', orderId, `rt_seed_${orderId}`);
    await debitWinningsForWithdrawal(player.userId, 2000, orderId);
    await createOrderRecord({
      orderId, userId: player.userId, type: 'WITHDRAWAL',
      tokenAmountRupees: 2000, fiatAmountRupees: 2000, state: 'PENDING_QUEUE',
    });

    await as(app, await admin()).post(`/payment-orders/${orderId}/action`).send({ action: 'REJECT' });
    const once = await getBalances(player.userId);
    // A second reject is refused by the transition, and must not refund again.
    await as(app, await admin()).post(`/payment-orders/${orderId}/action`).send({ action: 'REJECT' });
    const twice = await getBalances(player.userId);
    expect(Number(twice.winningsBalance)).toBe(Number(once.winningsBalance));
  });
});
