// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * The merchant's own panel: taking an order and confirming it.
 *
 * ── Three defects these keep dead ───────────────────────────────────────────
 *
 * 1. TWO MERCHANTS COULD ACCEPT THE SAME ORDER. Both passed the `order.status`
 *    read and both saved; the second overwrote the first's merchantId and
 *    snapshot, so the player was shown one merchant's payment details while the
 *    other held the order and expected to be paid. The guarded transition is
 *    the gate now: exactly one caller matches a row.
 *
 * 2. THE ACTIVE-ORDER COUNT WAS A COUNTER. `activeOrderCount` was incremented
 *    on accept and decremented on finish, so a crash between the two throttled
 *    that merchant permanently and nothing could correct it, because nothing
 *    else knew the number. It is derived from the orders now — accepting one IS
 *    the increment.
 *
 * 3. A DEPOSIT CONFIRM COULD MINT TOKENS. The user was credited first and the
 *    merchant debit was best-effort (overdraft allowed, error swallowed), so an
 *    under-funded merchant confirming a deposit created tokens out of nothing.
 *    The debit is first and hard now; only if it succeeds is the player paid.
 *
 * Nothing below the HTTP boundary is mocked — CLAUDE.md: where a boundary
 * carries money, test through it against a real database.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pgConfigured, applySchema, closePg } from '#db/client.js';
import { getBalancesPaise } from '#db/repositories/wallets.core.js';
import { createOrderRecord, getOrderRecord, setOrderFields, getMerchantOrder } from '#db/repositories/orders.record.js';
import { updateMerchant, getMerchant } from '#db/repositories/merchants.js';
import { getMerchantTokenBalance } from '../../domains/merchant/merchantWallet.service.js';
import { mountRouter, actor, merchantActor, as, request } from './_harness.js';

const describePg = pgConfigured() ? describe : describe.skip;

describePg('merchant panel routes', () => {
  let app;
  const RUN = Math.random().toString(36).slice(2, 8);
  let seq = 0;

  beforeAll(async () => {
    await applySchema();
    const mod = await import('../../domains/merchant/merchant.routes.js');
    app = mountRouter(mod.default);
  }, 60_000);

  afterAll(async () => { await closePg(); });

  /** A reference nothing else in the run has claimed. The registry's key is it. */
  const utr = () => `UTRMP${RUN}${String(seq).padStart(6, '0')}`.toUpperCase();

  const order = async ({
    type = 'DEPOSIT', state = 'PENDING_QUEUE', tokens = 500,
    betting = 400, reserve = 100, owner = null, merchantId = null, extra = {},
  } = {}) => {
    seq += 1;
    const who = owner || await actor({});
    const orderId = `MP-${RUN}-${seq}`;
    await createOrderRecord({
      orderId, userId: who.userId, type,
      tokenAmountRupees: tokens, fiatAmountRupees: tokens, state,
      depositAllocation: betting, reserveAllocation: reserve,
      ...(merchantId ? { merchantId } : {}),
      ...extra,
    });
    return { orderId, who };
  };

  // ── Who gets in ───────────────────────────────────────────────────────────
  it('refuses the panel without a token', async () => {
    for (const call of [
      () => request(app).get('/profile'),
      () => request(app).get('/orders'),
      () => request(app).post('/accept/x').send({}),
      () => request(app).post('/confirm/x').send({}),
    ]) {
      expect((await call()).status).toBe(401);
    }
  });

  it('refuses a PLAYER’s token — it carries no merchant claim', async () => {
    const player = await actor({});
    const res = await as(app, player).get('/profile');
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/Merchant token required/i);
  });

  it('refuses a suspended merchant, and says why', async () => {
    const suspended = await merchantActor({ status: 'SUSPENDED' });
    const res = await as(app, suspended).get('/profile');
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/suspended/i);
  });

  it('refuses a merchant awaiting approval', async () => {
    const pending = await merchantActor({ status: 'PENDING', approval: 'PENDING' });
    expect((await as(app, pending).get('/profile')).status).toBe(403);
  });

  // ── Accepting an order ────────────────────────────────────────────────────
  it('404s an order that does not exist', async () => {
    const m = await merchantActor({ tokensRupees: 5000 });
    expect((await as(app, m).post(`/accept/NOSUCH-${RUN}`).send({})).status).toBe(404);
  });

  it('refuses an order already held by a different merchant', async () => {
    const holder = await merchantActor({ tokensRupees: 5000 });
    const other = await merchantActor({ tokensRupees: 5000 });
    const { orderId } = await order({ state: 'ASSIGNED', merchantId: holder.merchantId });

    const res = await as(app, other).post(`/accept/${orderId}`).send({});
    expect(res.status).toBe(403);
    expect((await getOrderRecord(orderId)).merchantId).toBe(holder.merchantId);
  });

  it('refuses an order that is past the point of being taken', async () => {
    const m = await merchantActor({ tokensRupees: 5000 });
    const { orderId } = await order({ state: 'PAID', merchantId: m.merchantId });
    const res = await as(app, m).post(`/accept/${orderId}`).send({});
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/cannot be accepted in status: PAID/i);
  });

  it('DECIDES FROM THE WALLET whether a deposit can be funded', async () => {
    // The gate admits an order the merchant then has to fund. Deciding it from
    // a stored copy of the balance is how one came to be accepted that could
    // not be served.
    const poor = await merchantActor({ tokensRupees: 100 });
    const { orderId } = await order({ tokens: 500 });
    const res = await as(app, poor).post(`/accept/${orderId}`).send({});
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/insufficient token balance/i);
    expect((await getOrderRecord(orderId)).state).toBe('PENDING_QUEUE');
  });

  it('refuses a merchant who has turned deposits off', async () => {
    const m = await merchantActor({ tokensRupees: 5000 });
    await updateMerchant(m.merchantId, { acceptsDeposits: false });
    const { orderId } = await order();
    expect((await as(app, m).post(`/accept/${orderId}`).send({})).status).toBe(400);
  });

  it('refuses a merchant who has turned withdrawals off', async () => {
    const m = await merchantActor({ tokensRupees: 5000 });
    await updateMerchant(m.merchantId, { acceptsWithdrawals: false });
    const { orderId } = await order({ type: 'WITHDRAWAL', betting: 0, reserve: 0 });
    const res = await as(app, m).post(`/accept/${orderId}`).send({});
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/not enabled for sell orders/i);
  });

  it('refuses an order on the wrong RAIL', async () => {
    // Assignment already matches currency, but an order can be claimed straight
    // out of the open pool — so the rail is re-checked where the merchant
    // actually takes it.
    const inr = await merchantActor({ tokensRupees: 5000 });
    const { orderId } = await order({ extra: { currency: 'USDT' } });
    const res = await as(app, inr).post(`/accept/${orderId}`).send({});
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/USDT order and you settle in INR/i);
  });

  it('refuses a USDT merchant with no wallet address to be paid at', async () => {
    const usdt = await merchantActor({ tokensRupees: 5000 });
    await updateMerchant(usdt.merchantId, { acceptedCurrencies: ['USDT'] });
    const { orderId } = await order({ extra: { currency: 'USDT' } });
    const res = await as(app, usdt).post(`/accept/${orderId}`).send({});
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/TRC-20 wallet address/i);
  });

  it('accepts an order and writes the snapshot WITH the transition', async () => {
    // An order cannot be found PROCESSING without the merchant details the
    // player is about to be shown.
    const m = await merchantActor({ tokensRupees: 5000 });
    const { orderId } = await order();
    const res = await as(app, m).post(`/accept/${orderId}`).send({});
    expect(res.status, res.body.message).toBe(200);

    const row = await getOrderRecord(orderId);
    expect(row.state).toBe('PROCESSING');
    expect(row.merchantId).toBe(m.merchantId);
    expect(row.merchantSnapshot, 'accepted with no merchant snapshot').toBeTruthy();
    expect(row.expiresAt, 'accepted with no payment window').toBeTruthy();
    expect(new Date(row.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('LETS EXACTLY ONE MERCHANT WIN a race for a queued order', async () => {
    // Both used to pass the status read and both used to save. The second
    // overwrote the first's merchantId and snapshot, so the player was shown
    // one merchant's payment details while the other held the order.
    const contenders = await Promise.all(
      Array.from({ length: 4 }, () => merchantActor({ tokensRupees: 5000 })),
    );
    const { orderId } = await order();

    const results = await Promise.all(
      contenders.map((m) => as(app, m).post(`/accept/${orderId}`).send({})),
    );
    const winners = results.filter((r) => r.status === 200);
    expect(winners, 'more than one merchant took the same order').toHaveLength(1);
    expect(results.filter((r) => r.status === 409).length).toBeGreaterThanOrEqual(1);

    const row = await getOrderRecord(orderId);
    expect(row.state).toBe('PROCESSING');
    expect(contenders.map((m) => m.merchantId)).toContain(row.merchantId);
  });

  it('DERIVES the active-order limit from the orders, not from a counter', async () => {
    // `activeOrderCount` was incremented on accept and decremented on finish, so
    // a crash between the two throttled that merchant permanently.
    const m = await merchantActor({ tokensRupees: 50_000 });
    await updateMerchant(m.merchantId, { maxConcurrentDepositOrders: 1 });

    const first = await order();
    const second = await order();

    expect((await as(app, m).post(`/accept/${first.orderId}`).send({})).status).toBe(200);
    const blocked = await as(app, m).post(`/accept/${second.orderId}`).send({});
    expect(blocked.status).toBe(400);
    expect(blocked.body.message).toMatch(/active order limit \(1\)/i);

    // Finish the first and the slot is free again — with nothing decremented.
    // Through the lifecycle, because `setOrderFields` refuses a state change:
    // that is the boundary that keeps a status from being written past its
    // own rule table.
    const { completeOrder } = await import('../../domains/payment/orderLifecycle.service.js');
    expect((await completeOrder(first.orderId, { expectFrom: 'PROCESSING' })).ok).toBe(true);
    expect((await as(app, m).post(`/accept/${second.orderId}`).send({})).status).toBe(200);
  });

  it('lets a merchant accept an order ASSIGNED to them at the default limit', async () => {
    // The active-order count includes ASSIGNED orders, and the order being
    // accepted was assigned to this merchant — so at the default limit of 1 it
    // was the one order blocking its own acceptance. Accepting moves it from
    // ASSIGNED to PROCESSING; it does not add to the plate.
    const m = await merchantActor({ tokensRupees: 5000 });
    const { orderId } = await order({ state: 'ASSIGNED', merchantId: m.merchantId });
    const res = await as(app, m).post(`/accept/${orderId}`).send({});
    expect(res.status, res.body.message).toBe(200);
    expect((await getOrderRecord(orderId)).state).toBe('PROCESSING');
  });

  it('records a response time only for the merchant who WON', async () => {
    // Applied after the transition: a merchant who lost the accept race must
    // not have their average moved by an order they did not get.
    const winner = await merchantActor({ tokensRupees: 5000 });
    const loser = await merchantActor({ tokensRupees: 5000 });
    const { orderId } = await order({ state: 'ASSIGNED', merchantId: winner.merchantId });
    await setOrderFields(orderId, { assignedAt: new Date(Date.now() - 3 * 60 * 1000) });

    expect((await as(app, winner).post(`/accept/${orderId}`).send({})).status).toBe(200);
    expect((await as(app, loser).post(`/accept/${orderId}`).send({})).status).toBe(403);

    expect((await getMerchant(winner.merchantId)).avgResponseMinutes).toBeGreaterThan(2);
    expect((await getMerchant(loser.merchantId)).avgResponseMinutes ?? 2).toBe(2);
  });

  // ── Confirming ────────────────────────────────────────────────────────────
  it('404s an order that is not this merchant’s', async () => {
    const mine = await merchantActor({ tokensRupees: 5000 });
    const theirs = await merchantActor({ tokensRupees: 5000 });
    const { orderId } = await order({ state: 'PAID', merchantId: mine.merchantId });
    expect((await as(app, theirs).post(`/confirm/${orderId}`).send({ utrNumber: '1234567890123' })).status).toBe(404);
  });

  it('will not confirm a deposit without a usable bank reference', async () => {
    const m = await merchantActor({ tokensRupees: 5000 });
    const { orderId } = await order({ state: 'PAID', merchantId: m.merchantId, extra: { proofScreenshot: 'https://cdn/p.png' } });
    for (const utrNumber of [undefined, '', 'short', '12345678901']) {
      const res = await as(app, m).post(`/confirm/${orderId}`).send({ utrNumber });
      expect(res.status, `accepted utr=${JSON.stringify(utrNumber)}`).toBe(400);
      expect(res.body.message).toMatch(/UTR number/i);
    }
    expect((await getOrderRecord(orderId)).state).toBe('PAID');
  });

  it('will not confirm a deposit with no proof on the order and none supplied', async () => {
    const m = await merchantActor({ tokensRupees: 5000 });
    const { orderId } = await order({ state: 'PAID', merchantId: m.merchantId });
    const res = await as(app, m).post(`/confirm/${orderId}`).send({ utrNumber: utr() });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/proof screenshot is required/i);
  });

  it('will not confirm a deposit that has not been paid', async () => {
    const m = await merchantActor({ tokensRupees: 5000 });
    const { orderId } = await order({ state: 'PROCESSING', merchantId: m.merchantId });
    const res = await as(app, m).post(`/confirm/${orderId}`).send({ utrNumber: utr(), proof: 'p' });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/only be confirmed in PAID status/i);
  });

  it('TRANSFERS tokens on a deposit confirm — never mints them', async () => {
    // The user used to be credited first with a best-effort merchant debit
    // (overdraft allowed, error swallowed), so an under-funded merchant
    // confirming a deposit created tokens out of nothing.
    const m = await merchantActor({ tokensRupees: 5000 });
    const { orderId, who } = await order({
      state: 'PAID', merchantId: m.merchantId, tokens: 500, betting: 400, reserve: 100,
      extra: { proofScreenshot: 'https://cdn/p.png' },
    });

    const merchantBefore = await getMerchantTokenBalance(m.merchantId);
    const before = await getBalancesPaise(who.userId);

    const res = await as(app, m).post(`/confirm/${orderId}`).send({ utrNumber: utr() });
    expect(res.status, res.body.message).toBe(200);

    const after = await getBalancesPaise(who.userId);
    const merchantOut = merchantBefore - await getMerchantTokenBalance(m.merchantId);
    const playerIn = ((after.depositBalance - before.depositBalance)
      + (after.reserveBalance - before.reserveBalance)) / 100;

    expect(merchantOut).toBe(500);
    expect(playerIn, 'the merchant and the player did not move the same amount').toBe(merchantOut);
    expect(after.depositBalance - before.depositBalance).toBe(400_00);
    expect(after.reserveBalance - before.reserveBalance).toBe(100_00);
  });

  it('CREDITS ONCE when a merchant double-taps confirm', async () => {
    const m = await merchantActor({ tokensRupees: 5000 });
    const { orderId, who } = await order({
      state: 'PAID', merchantId: m.merchantId, extra: { proofScreenshot: 'https://cdn/p.png' },
    });

    const first = await as(app, m).post(`/confirm/${orderId}`).send({ utrNumber: utr() });
    const balance = await getBalancesPaise(who.userId);
    const inventory = await getMerchantTokenBalance(m.merchantId);

    const second = await as(app, m).post(`/confirm/${orderId}`).send({ utrNumber: utr() });
    expect(first.status).toBe(200);
    // The order is COMPLETED after the first, so the second is refused — the
    // point is only that it moves no money a second time, not the exact code.
    expect(second.status, second.body.message).toBeGreaterThanOrEqual(400);

    expect(await getBalancesPaise(who.userId)).toMatchObject({
      depositBalance: balance.depositBalance, reserveBalance: balance.reserveBalance,
    });
    expect(await getMerchantTokenBalance(m.merchantId)).toBe(inventory);
  });

  it('survives four confirms racing each other', async () => {
    const m = await merchantActor({ tokensRupees: 5000 });
    const { orderId, who } = await order({
      state: 'PAID', merchantId: m.merchantId, tokens: 500, betting: 400, reserve: 100,
      extra: { proofScreenshot: 'https://cdn/p.png' },
    });
    const before = await getBalancesPaise(who.userId);
    const merchantBefore = await getMerchantTokenBalance(m.merchantId);

    await Promise.all(Array.from({ length: 4 }, () =>
      as(app, m).post(`/confirm/${orderId}`).send({ utrNumber: utr() })));

    const after = await getBalancesPaise(who.userId);
    expect(after.depositBalance - before.depositBalance).toBe(400_00);
    expect(after.reserveBalance - before.reserveBalance).toBe(100_00);
    expect(merchantBefore - await getMerchantTokenBalance(m.merchantId)).toBe(500);
  });

  it('carries the reference and the proof onto the order with the confirm', async () => {
    const m = await merchantActor({ tokensRupees: 5000 });
    const { orderId } = await order({ state: 'PAID', merchantId: m.merchantId });
    await as(app, m).post(`/confirm/${orderId}`).send({ utrNumber: `  ${utr()}  `, proof: 'https://cdn/proof.png' });

    const row = await getOrderRecord(orderId);
    expect(row.utrNumber).toBe(utr());
    expect(row.proofScreenshot).toBe('https://cdn/proof.png');
    expect(row.state).toBe('COMPLETED');
  });

  it('will not confirm a withdrawal that is not in flight', async () => {
    const m = await merchantActor({ tokensRupees: 5000 });
    const { orderId } = await order({
      type: 'WITHDRAWAL', state: 'PENDING_QUEUE', merchantId: m.merchantId, betting: 0, reserve: 0,
    });
    const res = await as(app, m).post(`/confirm/${orderId}`).send({});
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/PROCESSING\/ASSIGNED/i);
  });

  // ── The merchant's own queue ──────────────────────────────────────────────
  it('shows a merchant only their own orders', async () => {
    const mine = await merchantActor({ tokensRupees: 5000 });
    const theirs = await merchantActor({ tokensRupees: 5000 });
    const a = await order({ state: 'PROCESSING', merchantId: mine.merchantId });
    const b = await order({ state: 'PROCESSING', merchantId: theirs.merchantId });

    const res = await as(app, mine).get('/orders?limit=100');
    expect(res.status).toBe(200);
    const ids = (res.body.orders || []).map((o) => o.orderId);
    expect(ids).toContain(a.orderId);
    expect(ids).not.toContain(b.orderId);
  });

  // ── The authorization data flow, made explicit ────────────────────────────
  it('carries merchant identity all the way from the token to the order lookup', async () => {
    // This pins a dependency that is otherwise invisible: `toMerchant` aliases
    // merchant_id to `_id`, `merchantAuth` reads `merchant._id` into
    // `req.merchantId`, and every merchant handler passes that as the SECOND
    // argument of getMerchantOrder(orderId, merchantId) — where the ownership
    // test actually lives, in the WHERE clause.
    //
    // Drop the alias in a future cleanup and req.merchantId becomes undefined:
    // the lookup then matches no row, which fails CLOSED (a merchant still
    // cannot reach anyone else's order) but silently 404s every one of their
    // OWN orders. A green suite without this test would not notice.
    const m = await merchantActor({ tokensRupees: 5000 });

    // The repository alias itself — the first link in the chain.
    const row = await getMerchant(m.merchantId);
    expect(row._id, 'toMerchant no longer aliases merchant_id to _id').toBe(m.merchantId);
    expect(row.id).toBe(m.merchantId);

    // And the chain end to end: a real token → merchantAuth → the scoped
    // lookup returns THIS merchant's order.
    const mine = await order({ state: 'PROCESSING', merchantId: m.merchantId });
    const res = await as(app, m).get('/orders?limit=100');
    expect(res.status, res.body.message).toBe(200);
    expect((res.body.orders || []).map((o) => o.orderId)).toContain(mine.orderId);

    // The same lookup the handlers use, driven directly with the id the
    // middleware would have set.
    const scoped = await getMerchantOrder(mine.orderId, row._id);
    expect(scoped, 'getMerchantOrder did not resolve with the aliased id').toBeTruthy();
    expect(scoped.orderId).toBe(mine.orderId);
  });

  it('serves the merchant’s own profile and nobody else’s', async () => {
    const m = await merchantActor({ tokensRupees: 1234 });
    const res = await as(app, m).get('/profile');
    expect(res.status, res.body.message).toBe(200);
    expect(res.body.merchant.merchantId ?? res.body.merchant._id).toBe(m.merchantId);
  });
});
