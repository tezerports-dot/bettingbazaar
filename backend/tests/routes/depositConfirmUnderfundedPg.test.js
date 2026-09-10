// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * What happens when a merchant confirms a deposit they cannot fund — on the
 * route merchants ACTUALLY USE.
 *
 * ── Why this file exists ────────────────────────────────────────────────────
 * There are two deposit-confirm implementations (F-017). All sixteen
 * real-database money assertions — conservation, the split, idempotency, a
 * four-way confirm race — are on `POST /api/payment/deposit/:orderId/confirm`,
 * which is on `check:ui-coverage --unused`: no screen calls it. The route the
 * merchant panel calls, `POST /api/merchant/confirm/:id`, reimplements the
 * sequence inline and had authorization and validation tests only.
 *
 * These tests are about the ORDERING difference between the two, because that
 * is where the two implementations disagree about something that matters:
 *
 *   moveDepositMoney (the unreachable route, and the admin override)
 *     money FIRST, then the caller sets the status. Its own header says why:
 *     "a crash between them leaves a PAID order whose next confirm replays
 *     these movements as no-ops, never a COMPLETED order that paid nobody."
 *
 *   POST /api/merchant/confirm/:id
 *     `completeOrder` FIRST — "THE TRANSITION IS THE GATE, and it runs before
 *     the money" — then the merchant debit, which can refuse.
 *
 * The second ordering is exactly the shape CLAUDE.md §21 records having shipped
 * three times: a write that follows a commit and is allowed to fail, leaving
 * the order in a state whose facts never arrived.
 *
 * Asserted against a real database because §1 forbids mocking the boundary that
 * carries money, and because what is in question is what the ROW says after a
 * refusal — which no stub can answer.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pgConfigured, applySchema, closePg } from '#db/client.js';
import { getBalancesPaise } from '#db/repositories/wallets.core.js';
import { createOrderRecord, getOrderRecord } from '#db/repositories/orders.record.js';
import { getMerchantTokenBalance } from '../../domains/merchant/merchantWallet.service.js';
import { mountRouter, actor, merchantActor, as } from './_harness.js';

const describePg = pgConfigured() ? describe : describe.skip;

describePg('a merchant confirms a deposit they cannot fund', () => {
  let app;
  const RUN = Math.random().toString(36).slice(2, 8);
  let seq = 0;

  beforeAll(async () => {
    await applySchema();
    const mod = await import('../../domains/merchant/merchant.routes.js');
    app = mountRouter(mod.default);
  }, 60_000);

  afterAll(async () => { await closePg(); });

  const utr = () => `UTRUF${RUN}${String(seq).padStart(6, '0')}`.toUpperCase();

  /** A PAID deposit assigned to this merchant: the player has already paid. */
  const paidDeposit = async (merchantId, tokens = 5000) => {
    seq += 1;
    const who = await actor({});
    const orderId = `UF-${RUN}-${seq}`;
    await createOrderRecord({
      orderId, userId: who.userId, type: 'DEPOSIT',
      tokenAmountRupees: tokens, fiatAmountRupees: tokens, state: 'PAID',
      depositAllocation: tokens * 0.9, reserveAllocation: tokens * 0.1,
      merchantId, proofScreenshot: 'https://cdn/p.png',
    });
    return { orderId, who };
  };

  it('the deposit is refused, and nobody is paid — which is correct so far', async () => {
    // A merchant with 100 tokens against a 5,000-token deposit. The guard in
    // the UPDATE's WHERE refuses the debit, which is the wallet layer doing
    // exactly its job (proven under concurrency in
    // database/tests/merchantWalletConcurrencyPg.test.js).
    const m = await merchantActor({ tokensRupees: 100 });
    const { orderId, who } = await paidDeposit(m.merchantId, 5000);

    const before = await getBalancesPaise(who.userId);
    const res = await as(app, m).post(`/confirm/${orderId}`).send({ utrNumber: utr() });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/insufficient token inventory/i);

    // No tokens were minted and none moved. This half is right.
    const after = await getBalancesPaise(who.userId);
    expect(after.depositBalance).toBe(before.depositBalance);
    expect(after.reserveBalance).toBe(before.reserveBalance);
    expect(await getMerchantTokenBalance(m.merchantId)).toBe(100);
  });

  it('BUT THE ORDER IS ALREADY COMPLETED, and the player was never credited', async () => {
    // The defect. `completeOrder` runs BEFORE the debit, so the refusal lands
    // after the status has committed. The player paid real money — PAID is what
    // that state means — the order now reads COMPLETED, and their wallet never
    // moved.
    //
    // §21, in the words it was already recorded in: the release button "marked
    // a disputed deposit COMPLETED and never credited the player, then told the
    // admin it had failed. The order left the DISPUTED queue, so nothing
    // remained to show it had gone wrong."
    const m = await merchantActor({ tokensRupees: 100 });
    const { orderId, who } = await paidDeposit(m.merchantId, 5000);

    await as(app, m).post(`/confirm/${orderId}`).send({ utrNumber: utr() });

    const row = await getOrderRecord(orderId);
    const balances = await getBalancesPaise(who.userId);

    // THIS is the assertion that matters. It is written as the CORRECT
    // expectation, so it fails until the ordering is fixed and passes after —
    // a test that asserted the current behaviour would lock the defect in.
    expect(
      row.state,
      'a deposit whose money never moved must not read COMPLETED — the player '
      + `has paid and holds ${balances.depositBalance} paise`,
    ).not.toBe('COMPLETED');

    // And the state it SHOULD be left in: still PAID, so the next confirm can
    // replay it once the merchant tops up, exactly as moveDepositMoney's
    // ordering guarantees on the other route.
    expect(row.state).toBe('PAID');
  });

  it('and the player cannot even dispute it, because dispute requires PAID', async () => {
    // The recourse the platform offers a player whose deposit stalls is
    // `POST /api/payment/order/:orderId/dispute`, and its first check is
    // `if (order.status !== 'PAID') return 400 'Can only dispute PAID orders'`.
    //
    // So the ordering defect does not merely leave a wrong row: it closes the
    // one door the player had. `expireOrders` does not sweep COMPLETED either,
    // and a COMPLETED order reads as SUCCESS in their history.
    const m = await merchantActor({ tokensRupees: 100 });
    const { orderId } = await paidDeposit(m.merchantId, 5000);

    await as(app, m).post(`/confirm/${orderId}`).send({ utrNumber: utr() });

    const row = await getOrderRecord(orderId);
    expect(
      row.state,
      'the order must stay disputable — a player who paid and was not credited '
      + 'must have somewhere to go',
    ).toBe('PAID');
  });

  it('a funded merchant still completes normally — the fix must not break the happy path', async () => {
    // The mirror, so a fix that simply stops completing orders is not mistaken
    // for a fix.
    const m = await merchantActor({ tokensRupees: 20_000 });
    const { orderId, who } = await paidDeposit(m.merchantId, 5000);

    const res = await as(app, m).post(`/confirm/${orderId}`).send({ utrNumber: utr() });
    expect(res.status).toBe(200);

    expect((await getOrderRecord(orderId)).state).toBe('COMPLETED');
    const after = await getBalancesPaise(who.userId);
    // 90/10 of 5,000 tokens, in paise.
    expect(after.depositBalance).toBe(450_000);
    expect(after.reserveBalance).toBe(50_000);
    // Tokens moved, never minted: the merchant parts with the whole amount.
    expect(await getMerchantTokenBalance(m.merchantId)).toBe(15_000);
  });
});
