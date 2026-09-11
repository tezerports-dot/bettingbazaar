// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
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
import { assignOrder } from '#db/repositories/orders.core.js';
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

  // A DIFFERENT wallet address every time. An address is UNIQUE across
  // merchants — it is an identity, like a UPI id — so a constant collides with
  // the row the PREVIOUS RUN of this suite left behind. The database is shared
  // and never reset between files (trap 10).
  const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const trc20 = () => `T${Array.from({ length: 33 },
    () => BASE58[Math.floor(Math.random() * BASE58.length)]).join('')}`;
  const bep20 = () => `0x${Array.from({ length: 40 },
    () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('')}`;

  const order = async ({
    type = 'DEPOSIT', state = 'PENDING_QUEUE', tokens = 500,
    betting = 400, reserve = 100, owner = null, merchantId = null, extra = {},
    // The chain a USDT order is paid on. A named parameter, not part of
    // `extra`, because it is not settable: the row freezes it and the merchant
    // snapshot carries the address for this chain alone.
    usdtChain = null,
  } = {}) => {
    seq += 1;
    const who = owner || await actor({});
    const orderId = `MP-${RUN}-${seq}`;
    await createOrderRecord({
      orderId, userId: who.userId, type,
      tokenAmountRupees: tokens, fiatAmountRupees: tokens, state,
      depositAllocation: betting, reserveAllocation: reserve,
      // A PAID deposit ALWAYS carries the player's reference: `mark-paid` is
      // what puts the order in this state and it refuses without one. The
      // confirm reads it off the row, so a fixture without it is not a PAID
      // deposit any route would ever see. `extra` still overrides, for the
      // tests that are about its absence.
      ...(type === 'DEPOSIT' && state === 'PAID' ? { utrNumber: utr() } : {}),
      ...(usdtChain ? { usdtChain } : {}),
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
    const { orderId } = await order({ tokens: 500, state: 'ASSIGNED', merchantId: poor.merchantId });
    const res = await as(app, poor).post(`/accept/${orderId}`).send({});
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/token balance cannot cover this buy order/i);
    // ASSIGNED, not PENDING_QUEUE: a buy reaches a merchant by being assigned,
    // and a refused accept leaves it exactly where it was for the expiry sweep
    // or a queue manager to move on. Nothing about the order is consumed.
    expect((await getOrderRecord(orderId)).state).toBe('ASSIGNED');
  });

  it('counts the orders the merchant is ALREADY serving against them', async () => {
    // F-018, at the route. The open pool is claimed first-come, so a merchant
    // holding 1,000 tokens could take a 600 order and then take a second 600
    // seconds later — both reads saw the full balance, because nothing
    // subtracted the first order from the second's answer. The player on the
    // losing order pays and is never credited.
    const m = await merchantActor({ tokensRupees: 1_000 });
    // The concurrency cap is raised OUT OF THE WAY on purpose. At its default
    // of 1 the second accept is refused for having too many orders open, which
    // is a different rule entirely — the test would pass while proving nothing
    // about whether the tokens are held. Lifting it leaves the hold as the only
    // thing that can refuse.
    await updateMerchant(m.merchantId, { maxConcurrentDepositOrders: 10 });
    const first  = await order({ tokens: 600, betting: 500, reserve: 100, state: 'ASSIGNED', merchantId: m.merchantId });
    const second = await order({ tokens: 600, betting: 500, reserve: 100, state: 'ASSIGNED', merchantId: m.merchantId });

    expect((await as(app, m).post(`/accept/${first.orderId}`).send({})).status).toBe(200);

    const res = await as(app, m).post(`/accept/${second.orderId}`).send({});
    expect(res.status, 'took a second order it cannot fund').toBe(400);
    expect(res.body.message).toMatch(/token balance cannot cover this buy order/i);
    // Untouched and still assignable elsewhere — refusing this merchant is not
    // the same as failing the order.
    expect((await getOrderRecord(second.orderId)).state).toBe('ASSIGNED');
  });

  it('does not charge an assigned order against itself', async () => {
    // The other half of the same subtraction. A merchant holding exactly the
    // order's amount must still be able to accept the order already ASSIGNED
    // to them — counting it would subtract the tokens and then demand them
    // again, and the merchant could never accept anything.
    const m = await merchantActor({ tokensRupees: 500 });
    const { orderId } = await order({ tokens: 500 });
    await assignOrder({ orderId, merchantId: m.merchantId, actor: 'test' });
    expect((await getOrderRecord(orderId)).state).toBe('ASSIGNED');

    expect((await as(app, m).post(`/accept/${orderId}`).send({})).status,
      'refused a merchant their own order').toBe(200);
  });

  it('refuses a merchant who has turned deposits off', async () => {
    const m = await merchantActor({ tokensRupees: 5000 });
    await updateMerchant(m.merchantId, { acceptsDeposits: false });
    const { orderId } = await order({ state: 'ASSIGNED', merchantId: m.merchantId });
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
    // A USDT order names the CHAIN the player will send on — the row insists
    // the two agree, because a USDT order with no chain matches no merchant.
    const { orderId } = await order({ extra: { currency: 'USDT' }, usdtChain: 'TRC20', state: 'ASSIGNED', merchantId: inr.merchantId });
    const res = await as(app, inr).post(`/accept/${orderId}`).send({});
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/USDT order and you settle in INR/i);
  });

  it('refuses a USDT merchant with no wallet address to be paid at', async () => {
    const usdt = await merchantActor({ tokensRupees: 5000 });
    await updateMerchant(usdt.merchantId, { acceptedCurrencies: ['USDT'] });
    const { orderId } = await order({ extra: { currency: 'USDT' }, usdtChain: 'TRC20', state: 'ASSIGNED', merchantId: usdt.merchantId });
    const res = await as(app, usdt).post(`/accept/${orderId}`).send({});
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Tron \(TRC-20\)/i);
  });

  it('refuses a USDT merchant who holds the OTHER chain’s address', async () => {
    // The sharp case, and the reason there are two columns. This merchant is on
    // the USDT rail and has an address — on Tron. The order is being paid on
    // BNB Smart Chain. Sending there would put the tokens on a network the
    // address does not exist on, and they would be gone.
    const usdt = await merchantActor({ tokensRupees: 5000 });
    await updateMerchant(usdt.merchantId, {
      acceptedCurrencies: ['USDT'],
      usdtAddressTrc20: trc20(),
    });
    const { orderId } = await order({ extra: { currency: 'USDT' }, usdtChain: 'BEP20', state: 'ASSIGNED', merchantId: usdt.merchantId });
    const res = await as(app, usdt).post(`/accept/${orderId}`).send({});
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/BNB Smart Chain/i);
  });

  it('lets a USDT merchant take an order on a chain they DO hold', async () => {
    // The other half: the subset assertion above passes just as happily if no
    // USDT merchant can ever accept anything.
    const usdt = await merchantActor({ tokensRupees: 5000 });
    await updateMerchant(usdt.merchantId, {
      acceptedCurrencies: ['USDT'],
      usdtAddressBep20: bep20(),
    });
    const { orderId } = await order({ extra: { currency: 'USDT' }, usdtChain: 'BEP20', state: 'ASSIGNED', merchantId: usdt.merchantId });
    const res = await as(app, usdt).post(`/accept/${orderId}`).send({});
    expect(res.status, res.body.message).toBe(200);
  });

  it('accepts an order and writes the snapshot WITH the transition', async () => {
    // An order cannot be found PROCESSING without the merchant details the
    // player is about to be shown.
    const m = await merchantActor({ tokensRupees: 5000 });
    const { orderId } = await order({ state: 'ASSIGNED', merchantId: m.merchantId });
    const res = await as(app, m).post(`/accept/${orderId}`).send({});
    expect(res.status, res.body.message).toBe(200);

    const row = await getOrderRecord(orderId);
    expect(row.state).toBe('PROCESSING');
    expect(row.merchantId).toBe(m.merchantId);
    expect(row.merchantSnapshot, 'accepted with no merchant snapshot').toBeTruthy();
    expect(row.expiresAt, 'accepted with no payment window').toBeTruthy();
    expect(new Date(row.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('a QUEUED buy cannot be claimed at all — buys are assigned, never fought over', async () => {
    // ── This replaces a test that proved the race was fair ────────────────
    // It used to fire four merchants at one PENDING_QUEUE buy and assert that
    // exactly one won. That the race was fair was true; that there was a race
    // was the defect. There is no open pool for buy orders and never was —
    // every buy goes through `tryAssignMerchant`, which RANKS the eligible
    // merchants so the biggest holder takes the biggest order. This handler
    // nevertheless admitted an unassigned buy, so anyone holding its id could
    // claim it first-come, which rewards whoever polls hardest and throws the
    // ranking away.
    //
    // The sell pool is a different thing and stays: a withdrawal nobody is free
    // for waits in the open rather than burning retry attempts.
    const contenders = await Promise.all(
      Array.from({ length: 4 }, () => merchantActor({ tokensRupees: 5000 })),
    );
    const { orderId } = await order();

    const results = await Promise.all(
      contenders.map((m) => as(app, m).post(`/accept/${orderId}`).send({})),
    );
    expect(results.filter((r) => r.status === 200), 'a queued buy was claimable').toHaveLength(0);
    expect(results.every((r) => r.status === 409)).toBe(true);

    // Untouched, and still there for the assignment sweep to hand out properly.
    const row = await getOrderRecord(orderId);
    expect(row.state).toBe('PENDING_QUEUE');
    expect(row.merchantId ?? null).toBeNull();
  });

  it('a SELL may still be claimed from the open pool', async () => {
    // The other half of the same rule, asserted so that "buys are assigned"
    // cannot be quietly widened into "nothing is ever claimed". A withdrawal
    // that no merchant was free for sits in the open pool by design.
    const m = await merchantActor({ tokensRupees: 50_000 });
    await updateMerchant(m.merchantId, { acceptsWithdrawals: true });
    const { orderId } = await order({ type: 'WITHDRAWAL', betting: 0, reserve: 0 });

    expect((await as(app, m).post(`/accept/${orderId}`).send({})).status).toBe(200);
    expect((await getOrderRecord(orderId)).state).toBe('PROCESSING');
  });

  it('DERIVES the active-order limit from the orders, not from a counter', async () => {
    // `activeOrderCount` was incremented on accept and decremented on finish, so
    // a crash between the two throttled that merchant permanently.
    const m = await merchantActor({ tokensRupees: 50_000 });
    await updateMerchant(m.merchantId, { maxConcurrentDepositOrders: 1 });

    // The second order is created AFTER the first is accepted, because two
    // orders assigned at once to a cap-of-one merchant is a state assignment
    // would never produce — and the accept would then be refused for holding
    // two, which is the cap firing on the fixture rather than on the behaviour.
    const first = await order({ state: 'ASSIGNED', merchantId: m.merchantId });
    expect((await as(app, m).post(`/accept/${first.orderId}`).send({})).status).toBe(200);

    const second = await order({ state: 'ASSIGNED', merchantId: m.merchantId });
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

  it('will not confirm a deposit the player has not referenced', async () => {
    const m = await merchantActor({ tokensRupees: 5000 });
    // The reference is read off the ROW. `mark-paid` is what writes it, so an
    // order without one is a player who has not submitted yet.
    const { orderId } = await order({
      state: 'PAID', merchantId: m.merchantId, extra: { utrNumber: null },
    });
    const res = await as(app, m).post(`/confirm/${orderId}`);
    expect(res.status).toBe(400);
    expect((await getOrderRecord(orderId)).state).toBe('PAID');
  });

  // These two tests used to say the opposite, and they were green while no
  // deposit on the platform could be confirmed at all:
  //
  //   'will not confirm a deposit without a usable bank reference' drove the
  //   refusal from the request BODY, asserting a contract where the merchant
  //   restates the player's reference. The route wrote whatever they sent over
  //   the stored value, so the order could end up naming a reference
  //   `utr_registry` had never claimed (§27).
  //
  //   'will not confirm a deposit with no proof on the order and none supplied'
  //   asserted the payment-proof requirement — after proof COLLECTION had been
  //   removed platform-wide. Nothing could supply one, so the refusal it
  //   asserted fired on EVERY deposit. The test passed because the handler did
  //   exactly what it was told; the handler was what was wrong.
  //
  // Absence of a failing check is not evidence of correctness when no check
  // covers the thing being claimed (§29). What covers it now is a test that
  // follows the money: depositConfirmReachablePg.test.js.
  it('ignores a payment reference sent by the merchant', async () => {
    const m = await merchantActor({ tokensRupees: 5000 });
    const { orderId } = await order({ state: 'PAID', merchantId: m.merchantId });
    const stored = (await getOrderRecord(orderId)).utrNumber;

    const res = await as(app, m).post(`/confirm/${orderId}`)
      .send({ utrNumber: 'MERCHANTSUPPLIED9', proof: 'https://cdn/forged.png' });
    expect(res.status, res.body.message).toBe(200);

    const row = await getOrderRecord(orderId);
    expect(row.utrNumber).toBe(stored);
    expect(row.proofScreenshot ?? null).toBeNull();
  });

  it('will not confirm a deposit that has not been paid', async () => {
    const m = await merchantActor({ tokensRupees: 5000 });
    const { orderId } = await order({ state: 'PROCESSING', merchantId: m.merchantId });
    const res = await as(app, m).post(`/confirm/${orderId}`);
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
    });

    const merchantBefore = await getMerchantTokenBalance(m.merchantId);
    const before = await getBalancesPaise(who.userId);

    const res = await as(app, m).post(`/confirm/${orderId}`);
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
      state: 'PAID', merchantId: m.merchantId,
    });

    const first = await as(app, m).post(`/confirm/${orderId}`);
    const balance = await getBalancesPaise(who.userId);
    const inventory = await getMerchantTokenBalance(m.merchantId);

    const second = await as(app, m).post(`/confirm/${orderId}`);
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
    });
    const before = await getBalancesPaise(who.userId);
    const merchantBefore = await getMerchantTokenBalance(m.merchantId);

    await Promise.all(Array.from({ length: 4 }, () =>
      as(app, m).post(`/confirm/${orderId}`)));

    const after = await getBalancesPaise(who.userId);
    expect(after.depositBalance - before.depositBalance).toBe(400_00);
    expect(after.reserveBalance - before.reserveBalance).toBe(100_00);
    expect(merchantBefore - await getMerchantTokenBalance(m.merchantId)).toBe(500);
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
