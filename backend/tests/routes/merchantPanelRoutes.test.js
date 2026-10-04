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
 *    else knew the number. It is derived from the orders now, by the router.
 *
 * 3. A DEPOSIT CONFIRM COULD MINT TOKENS. The user was credited first and the
 *    merchant debit was best-effort (overdraft allowed, error swallowed), so an
 *    under-funded merchant confirming a deposit created tokens out of nothing.
 *    The pool's hold is spent first and hard now; only then is the player paid.
 *
 * ── On the team model (PROJECT_STATUS §3.10, Step 2c) ────────────────────────
 * A member holds no tokens; their TEAM's pool does, and every order reaches a
 * member by being ROUTED to them — there is no open pool to claim from. So
 * every order below is made the way production makes it (§32 S16): created
 * queued with its split, offered by `tryAssignMerchant` to the one online
 * member of a working team on the order's rail (which HOLDS a buy's tokens in
 * the pool), marked paid by the player through `markOrderPaid`, and moved on
 * from there by the member's own routes. No fixture writes a state or a
 * merchant onto a row.
 *
 * Deleted with the features they guarded (2c): the merchant's own token
 * balance on the profile, the accept-time wallet check and its F-018
 * subtraction (the pool HOLD at assignment replaced both — teamRoutingPg,
 * depositConfirmUnderfundedPg), claiming a SELL from the open pool, the
 * accept-time concurrency cap and the accept-time rail check (both are the
 * router's now: teamRoutingPg 'only teams on the order's rail are candidates',
 * 'a member with cap 1 is given one of two racing orders').
 *
 * Nothing below the HTTP boundary is mocked — CLAUDE.md: where a boundary
 * carries money, test through it against a real database.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pgConfigured, applySchema, closePg, withTransaction } from '#db/client.js';
import { getBalancesPaise } from '#db/repositories/wallets.core.js';
import {
  createOrderRecord, getOrderRecord, setOrderFields, getMerchantOrder,
} from '#db/repositories/orders.record.js';
import { updateMerchant, getMerchant, pauseAssignment, resumeAssignment } from '#db/repositories/merchants.js';
import { updateUser } from '#db/repositories/users.js';
import { getPool } from '#db/repositories/teamPools.js';
import { PAYMENT_MODES } from '#db/repositories/orderRails.js';
import { getSystemConfig, applySystemConfig } from '#db/repositories/config.js';
import { creditWinnings } from '../../domains/wallet/walletAuthority.service.js';
import {
  tryAssignMerchant, markOrderPaid, createWithdrawalOrder,
} from '../../domains/payment/paymentProcessing.service.js';
import { teamFixture, readyToPay } from '../teamFixture.js';
import { mountRouter, actor, merchantActor, as, request } from './_harness.js';

// Every sell is paid by bank transfer, so the member gives its UTR (2d).
let payoutSeq = 0;
const payoutUtr = () => `UTRMP${String(Date.now()).slice(-7)}${String(++payoutSeq).padStart(4, '0')}`;

const describePg = pgConfigured() ? describe : describe.skip;

// Above the cash ceiling: a UPI_BANK buy, so no Ready press is involved.
const UPI_TOKENS = 50_000;
// A cash denomination: the CASH rail.
const CASH_TOKENS = 1_000;
// The smallest USDT size (§25).
const USDT_TOKENS = 50_000;

describePg('merchant panel routes', () => {
  let app;
  const RUN = Math.random().toString(36).slice(2, 8);
  let seq = 0;
  const teams = teamFixture();
  const players = [];
  let priorPricing = null;

  // A DIFFERENT wallet address every time. An address is UNIQUE across
  // merchants — it is an identity, like a UPI id — so a constant collides with
  // the row the PREVIOUS RUN of this suite left behind. The database is shared
  // and never reset between files (trap 10).
  const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const trc20 = () => `T${Array.from({ length: 33 },
    () => BASE58[Math.floor(Math.random() * BASE58.length)]).join('')}`;
  const bep20 = () => `0x${Array.from({ length: 40 },
    () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('')}`;

  beforeAll(async () => {
    await applySchema();
    const mod = await import('../../domains/merchant/merchant.routes.js');
    app = mountRouter(mod.default);
    // The USDT price is shared config, never reset between suites: the value
    // found here is put back at the end (trap 10). 100 tokens per USDT.
    priorPricing = (await getSystemConfig({ fresh: true }))?.usdtPricing ?? null;
    await applySystemConfig({ usdtPricing: { userMerchantBuyInr: 100 } }, { actor: 'merchant-panel-suite' });
  }, 60_000);

  afterAll(async () => {
    if (priorPricing) await applySystemConfig({ usdtPricing: priorPricing }, { actor: 'merchant-panel-suite' });
    await withTransaction(async (c) => {
      await c.query('SET LOCAL session_replication_role = replica');
      await c.query(
        'DELETE FROM order_transitions WHERE order_id IN (SELECT order_id FROM order_states WHERE user_id = ANY($1))',
        [players]);
      await c.query('DELETE FROM order_states WHERE user_id = ANY($1)', [players]);
    });
    await teams.cleanup();
    await closePg();
  });

  /** A reference nothing else in the run has claimed: twelve digits, a bank UTR. */
  const utr = () => String(510000000000 + (seq * 7919) + Math.floor(Math.random() * 7000));

  // ── Members, handed out one at a time ──────────────────────────────────────
  // Each test takes members nobody has used, so no earlier test's open orders
  // count against a cap and no earlier refusal bars them. A team works only
  // at ten (2a), so members come in tens: a working team on the rail, its
  // pool funded through the supervisor's request and the admin's fulfilment.
  const POOL = { UPI_BANK: 1_000_000, CASH: 50_000, USDT: 500_000 };
  const bench = { UPI_BANK: [], CASH: [], USDT: [] };
  const member = async (rail = 'UPI_BANK') => {
    if (!bench[rail].length) {
      const ms = [];
      for (let i = 0; i < 10; i += 1) {
        const m = await merchantActor();
        if (rail === 'USDT') {
          // The rail is the admin's to set; the addresses are what a USDT
          // member keeps in Profile — both chains, so either order can reach them.
          await updateMerchant(m.merchantId, {
            acceptedCurrencies: ['USDT'], usdtAddressTrc20: trc20(), usdtAddressBep20: bep20(),
          });
        }
        ms.push(m);
      }
      const team = await teams.workingTeam({ rail, poolTokens: POOL[rail], include: ms.map((m) => m.merchantId) });
      bench[rail].push(...ms.map((m) => ({ ...m, team })));
    }
    return bench[rail].shift();
  };

  const player = async () => {
    const who = await actor({});
    players.push(who.userId);
    return who;
  };

  /**
   * A buy as `createDepositOrder` writes it — queued, with its split — and
   * offered once to the teams with only `to` online. Unless `mayWait`, it must
   * reach `to`.
   */
  const buy = async ({
    to = null, owner = null, tokens = UPI_TOKENS, betting = null, reserve = null,
    currency = 'INR', usdtChain = null, mayWait = false,
  } = {}) => {
    seq += 1;
    const who = owner || await player();
    const orderId = `MP-${RUN}-${seq}`;
    const bet = betting ?? Math.round(tokens * 0.8);
    const res = reserve ?? tokens - bet;
    const order = await createOrderRecord({
      orderId, userId: who.userId, type: 'DEPOSIT',
      tokenAmountRupees: tokens,
      depositAllocation: bet, reserveAllocation: res,
      ...(currency === 'USDT'
        ? { currency, usdtChain, fiatAmountRupees: tokens / 100, rateUsed: 100 }
        : { fiatAmountRupees: tokens }),
    });
    await teams.onlyOnline(to ? [to.merchantId] : []);
    const routed = await tryAssignMerchant(order);
    if (to && !mayWait) {
      expect(routed, `the buy was not routed to ${to.merchantId}`).toBe(true);
      expect((await getOrderRecord(orderId)).merchantId).toBe(String(to.merchantId));
    }
    return { orderId, who, routed };
  };

  /** A routed buy the player has paid, with a bank reference the registry claimed. */
  const paidBuy = async (opts) => {
    const b = await buy(opts);
    b.utr = utr();
    await readyToPay(b.orderId);
    expect((await markOrderPaid(b.who.userId, b.orderId, b.utr)).status).toBe('PAID');
    return b;
  };

  /** A routed buy its member has accepted: PROCESSING, the player's window running. */
  const acceptedBuy = async (opts) => {
    const b = await buy(opts);
    const res = await as(app, opts.to).post(`/accept/${b.orderId}`).send({});
    expect(res.status, res.body.message).toBe(200);
    return b;
  };

  /**
   * A sell through the player's own admission — the stake really locked — and
   * offered to the teams with only `to` online. Returns the row as created.
   */
  const sell = async ({ to = null, tokens = UPI_TOKENS } = {}) => {
    const who = await player();
    await updateUser(who.userId, {
      bankDetails: {
        accountNumber: '000111222333', ifscCode: 'HDFC0000001',
        bankName: 'HDFC Bank', accountHolderName: 'Test Player',
      },
    });
    seq += 1;
    await creditWinnings(who.userId, tokens, 'merchant panel suite float', 'Test',
      `seed_${who.userId}`, `mp_seed_${who.userId}_${seq}`);
    await teams.onlyOnline(to ? [to.merchantId] : []);
    const { order } = await createWithdrawalOrder(who.userId, tokens);
    const orderId = order.orderId ?? order._id;
    return { orderId, who, row: await getOrderRecord(orderId) };
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
    const who = await actor({});
    const res = await as(app, who).get('/profile');
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

  // The platform stops sending a merchant buys after three unpaid in a row
  // (§2). The Dashboard read "Online · Accepting orders" throughout, because the
  // profile never said — found by opening the panel AS a paused merchant
  // (browser profile `merchant-paused`).
  it('tells a merchant their new buy orders are paused, and when that is lifted', async () => {
    const m = await merchantActor();
    expect((await as(app, m).get('/profile')).body.merchant.assignmentPausedAt,
      'a merchant who was never paused reads as paused').toBeNull();

    await pauseAssignment(m.merchantId, '3 buy orders in a row expired with no payment.');
    const paused = (await as(app, m).get('/profile')).body.merchant;
    expect(paused.assignmentPausedAt, 'the pause never reached the merchant').toBeTruthy();
    // The stored reason is worded for an admin; the merchant gets the panel's own words.
    expect(paused).not.toHaveProperty('assignmentPauseReason');

    await resumeAssignment(m.merchantId);
    expect((await as(app, m).get('/profile')).body.merchant.assignmentPausedAt).toBeNull();
  });

  // ── Accepting an order ────────────────────────────────────────────────────
  it('404s an order that does not exist', async () => {
    const m = await member();
    expect((await as(app, m).post(`/accept/NOSUCH-${RUN}`).send({})).status).toBe(404);
  });

  it('refuses an order already held by a different merchant', async () => {
    const holder = await member();
    const other = await member();
    const { orderId } = await buy({ to: holder });

    const res = await as(app, other).post(`/accept/${orderId}`).send({});
    expect(res.status).toBe(403);
    expect((await getOrderRecord(orderId)).merchantId).toBe(String(holder.merchantId));
  });

  it('refuses an order that is past the point of being taken', async () => {
    const m = await member();
    const { orderId } = await paidBuy({ to: m });
    const res = await as(app, m).post(`/accept/${orderId}`).send({});
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/cannot be accepted in status: PAID/i);
  });

  // ── The member's two switches, "Accept deposit orders" / "…withdrawal…" ────
  // ProfileSettings saves them through PUT /preferences and the admin's
  // capabilities route sets the same columns. Before 2c the assignment query
  // and the accept handler both read them. 2c replaced the one and stripped
  // the other, and nothing read them at all (§32 S5): a member who switched
  // buys off was told it saved and kept being handed buys (§3 — an editable
  // field with no consumer). The router reads them again, where an order
  // reaches a member: a member who has switched a direction off is not a
  // candidate for it, and stays one for the other.
  it('routes no BUY to a member who has switched buys off — and still routes them sells', async () => {
    const m = await member();
    const off = await as(app, m).put('/preferences').send({ acceptsDeposits: false });
    expect(off.status, off.body.message).toBe(200);
    expect(off.body.merchant.acceptsDeposits).toBe(false);

    const waiting = await buy({ to: null });
    await teams.onlyOnline([m.merchantId]);
    expect(await tryAssignMerchant(await getOrderRecord(waiting.orderId)),
      'a member who switched buys off was handed one').toBe(false);
    const row = await getOrderRecord(waiting.orderId);
    expect(row.state).toBe('PENDING_QUEUE');
    expect(row.merchantId ?? null).toBeNull();

    // The other direction is untouched by it.
    const s = await sell({ to: m });
    expect(s.row.state, 'switching buys off stopped their sells too').toBe('ASSIGNED');
    expect(s.row.merchantId).toBe(String(m.merchantId));

    // And switched back on, the waiting buy reaches them on the next offer.
    expect((await as(app, m).put('/preferences').send({ acceptsDeposits: true })).status).toBe(200);
    expect(await tryAssignMerchant(await getOrderRecord(waiting.orderId))).toBe(true);
    expect((await getOrderRecord(waiting.orderId)).merchantId).toBe(String(m.merchantId));
  });

  it('routes no SELL to a member who has switched sells off — and still routes them buys', async () => {
    const m = await member();
    const off = await as(app, m).put('/preferences').send({ acceptsWithdrawals: false });
    expect(off.status, off.body.message).toBe(200);
    expect(off.body.merchant.acceptsWithdrawals).toBe(false);

    const s = await sell({ to: m });
    expect(s.row.state, 'a member who switched sells off was handed one').toBe('PENDING_QUEUE');
    expect(s.row.merchantId ?? null).toBeNull();

    // The other direction is untouched by it.
    const b = await buy({ to: m });
    expect(b.routed).toBe(true);

    expect((await as(app, m).put('/preferences').send({ acceptsWithdrawals: true })).status).toBe(200);
    expect(await tryAssignMerchant(await getOrderRecord(s.orderId))).toBe(true);
    expect((await getOrderRecord(s.orderId)).merchantId).toBe(String(m.merchantId));
  });

  // ── The USDT chain, re-checked where the member takes the order ───────────
  // Routing required an address on the order's chain; a member can remove one
  // from Profile between being routed the order and taking it. USDT sent to a
  // chain the address is not on is gone (§25), so the accept refuses and names
  // the chain. Profile keeps at least one address, so the state is reached the
  // way a member reaches it: holding both, clearing the order's.
  it('refuses a USDT member who no longer holds an address on the order’s chain (Tron)', async () => {
    const usdt = await member('USDT');
    const { orderId } = await buy({ to: usdt, tokens: USDT_TOKENS, currency: 'USDT', usdtChain: 'TRC20' });
    const cleared = await as(app, usdt).put('/profile').send({ usdtAddressTrc20: '' });
    expect(cleared.status, cleared.body.message).toBe(200);

    const res = await as(app, usdt).post(`/accept/${orderId}`).send({});
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Tron \(TRC-20\)/i);
    expect((await getOrderRecord(orderId)).state).toBe('ASSIGNED');
  });

  it('refuses a USDT member who holds only the OTHER chain’s address', async () => {
    // The sharp case, and the reason there are two columns. This member is on
    // the USDT rail and has an address — on Tron. The order is being paid on
    // BNB Smart Chain. Sending there would put the tokens on a network the
    // address does not exist on, and they would be gone.
    const usdt = await member('USDT');
    const { orderId } = await buy({ to: usdt, tokens: USDT_TOKENS, currency: 'USDT', usdtChain: 'BEP20' });
    const cleared = await as(app, usdt).put('/profile').send({ usdtAddressBep20: '' });
    expect(cleared.status, cleared.body.message).toBe(200);
    expect((await getMerchant(usdt.merchantId)).usdtAddressTrc20, 'the Tron address went too').toBeTruthy();

    const res = await as(app, usdt).post(`/accept/${orderId}`).send({});
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/BNB Smart Chain/i);
  });

  it('lets a USDT member take an order on a chain they DO hold', async () => {
    // The other half: the refusals above pass just as happily if no USDT
    // member can ever accept anything.
    const usdt = await member('USDT');
    const { orderId } = await buy({ to: usdt, tokens: USDT_TOKENS, currency: 'USDT', usdtChain: 'BEP20' });
    const res = await as(app, usdt).post(`/accept/${orderId}`).send({});
    expect(res.status, res.body.message).toBe(200);
    expect((await getOrderRecord(orderId)).state).toBe('PROCESSING');
  });

  it('accepts an order and writes the snapshot WITH the transition', async () => {
    // An order cannot be found PROCESSING without the merchant details the
    // player is about to be shown.
    const m = await member();
    const { orderId } = await buy({ to: m });
    const res = await as(app, m).post(`/accept/${orderId}`).send({});
    expect(res.status, res.body.message).toBe(200);

    const row = await getOrderRecord(orderId);
    expect(row.state).toBe('PROCESSING');
    expect(row.merchantId).toBe(String(m.merchantId));
    expect(row.merchantSnapshot, 'accepted with no merchant snapshot').toBeTruthy();
    expect(row.expiresAt, 'accepted with no payment window').toBeTruthy();
    expect(new Date(row.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('a QUEUED order cannot be claimed at all, in either direction — orders are routed, never fought over', async () => {
    // ── This replaces a test that proved the race was fair ────────────────
    // It used to fire four merchants at one PENDING_QUEUE buy and assert that
    // exactly one won. That the race was fair was true; that there was a race
    // was the defect. An order reaches a member through the router, which
    // checks the rail, the cap and — on a buy — holds the pool's tokens. A
    // handler that admitted an unrouted order would let anyone holding its id
    // claim it first-come, which rewards whoever polls hardest and skips every
    // one of those checks. 2c took the SELL's open pool away too, so both
    // directions are asserted here.
    const contenders = [];
    for (let i = 0; i < 4; i += 1) contenders.push(await member());
    const queuedBuy = await buy({ to: null });
    expect(queuedBuy.routed, 'nobody was online, and the buy was routed anyway').toBe(false);
    const queuedSell = await sell({ to: null });
    expect(queuedSell.row.state).toBe('PENDING_QUEUE');

    for (const orderId of [queuedBuy.orderId, queuedSell.orderId]) {
      const results = await Promise.all(
        contenders.map((m) => as(app, m).post(`/accept/${orderId}`).send({})),
      );
      expect(results.filter((r) => r.status === 200), 'a queued order was claimable').toHaveLength(0);
      expect(results.every((r) => r.status === 403), results.map((r) => r.status).join(',')).toBe(true);

      // Untouched, and still there for the assignment sweep to hand out properly.
      const row = await getOrderRecord(orderId);
      expect(row.state).toBe('PENDING_QUEUE');
      expect(row.merchantId ?? null).toBeNull();
    }
  });

  it('DERIVES a member’s open-order count from the orders, not from a counter', async () => {
    // `activeOrderCount` was incremented on accept and decremented on finish, so
    // a crash between the two throttled that merchant permanently. The count is
    // the router's now, read from `order_states` on every offer — so finishing
    // an order frees the place with nothing decremented.
    const cfg = await getSystemConfig({ fresh: true });
    const cap = Number(cfg?.teamRouting?.concurrency?.UPI_BANK ?? 3); // schema default: 3
    const m = await member();
    const open = [];
    for (let i = 0; i < cap; i += 1) open.push(await paidBuy({ to: m }));

    const waiting = await buy({ to: m, mayWait: true });
    expect(waiting.routed, `a member at the cap of ${cap} was handed another`).toBe(false);
    expect((await getOrderRecord(waiting.orderId)).state).toBe('PENDING_QUEUE');

    // Finish one through the member's own confirm; the place is free again.
    const done = await as(app, m).post(`/confirm/${open[0].orderId}`);
    expect(done.status, done.body.message).toBe(200);
    expect(await tryAssignMerchant(await getOrderRecord(waiting.orderId))).toBe(true);
    expect((await getOrderRecord(waiting.orderId)).merchantId).toBe(String(m.merchantId));
  });

  it('lets a member accept a cash order routed to them, at the cash limit of one', async () => {
    // The open-order count includes ASSIGNED orders, and the order being
    // accepted was assigned to this member — so at a limit of 1 it was once the
    // one order blocking its own acceptance. Accepting moves it from ASSIGNED
    // to PROCESSING; it does not add to the plate.
    const m = await member('CASH');
    const ready = await as(app, m).put('/cash-ready').send({ ready: true });
    expect(ready.status, ready.body.message).toBe(200);
    const { orderId } = await buy({ to: m, tokens: CASH_TOKENS });
    expect((await getOrderRecord(orderId)).paymentMode).toBe(PAYMENT_MODES.CASH_ATM);

    const res = await as(app, m).post(`/accept/${orderId}`).send({});
    expect(res.status, res.body.message).toBe(200);
    expect((await getOrderRecord(orderId)).state).toBe('PROCESSING');
  });

  it('records a response time only for the merchant who WON', async () => {
    // Applied after the transition: a merchant who did not get the order must
    // not have their average moved by it.
    const winner = await member();
    const loser = await member();
    const { orderId } = await buy({ to: winner });
    // Three minutes on the clock since the router assigned it.
    await setOrderFields(orderId, { assignedAt: new Date(Date.now() - 3 * 60 * 1000) });

    expect((await as(app, winner).post(`/accept/${orderId}`).send({})).status).toBe(200);
    expect((await as(app, loser).post(`/accept/${orderId}`).send({})).status).toBe(403);

    expect((await getMerchant(winner.merchantId)).avgResponseMinutes).toBeGreaterThan(2);
    expect((await getMerchant(loser.merchantId)).avgResponseMinutes ?? 2).toBe(2);
  });

  // ── Confirming ────────────────────────────────────────────────────────────
  it('404s an order that is not this merchant’s', async () => {
    const mine = await member();
    const theirs = await member();
    const { orderId } = await paidBuy({ to: mine });
    expect((await as(app, theirs).post(`/confirm/${orderId}`).send({ utrNumber: '1234567890123' })).status).toBe(404);
    expect((await getOrderRecord(orderId)).state).toBe('PAID');
  });

  it('will not confirm a deposit the player has not referenced', async () => {
    // The reference is read off the ROW. On the CASH rail the player's Paid
    // tap reaches PAID before the reference does (the ATM's clock), so a PAID
    // buy with no reference is a real state — and the one a confirm must not
    // complete.
    const m = await member('CASH');
    expect((await as(app, m).put('/cash-ready').send({ ready: true })).status).toBe(200);
    const { orderId, who } = await buy({ to: m, tokens: CASH_TOKENS });
    await readyToPay(orderId);
    expect((await markOrderPaid(who.userId, orderId)).status).toBe('PAID');
    expect((await getOrderRecord(orderId)).utrNumber ?? null).toBeNull();
    const before = await getBalancesPaise(who.userId);

    const res = await as(app, m).post(`/confirm/${orderId}`);
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/no payment reference/i);
    expect((await getOrderRecord(orderId)).state).toBe('PAID');
    expect(await getBalancesPaise(who.userId)).toEqual(before);
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
    const m = await member();
    const { orderId, utr: stored } = await paidBuy({ to: m });
    expect((await getOrderRecord(orderId)).utrNumber).toBe(stored);

    const res = await as(app, m).post(`/confirm/${orderId}`)
      .send({ utrNumber: 'MERCHANTSUPPLIED9', proof: 'https://cdn/forged.png' });
    expect(res.status, res.body.message).toBe(200);

    const row = await getOrderRecord(orderId);
    expect(row.utrNumber).toBe(stored);
    expect(row.proofScreenshot ?? null).toBeNull();
  });

  it('will not confirm a deposit that has not been paid', async () => {
    const m = await member();
    const { orderId } = await acceptedBuy({ to: m });
    expect((await getOrderRecord(orderId)).state).toBe('PROCESSING');
    const res = await as(app, m).post(`/confirm/${orderId}`);
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/only be confirmed in PAID status/i);
  });

  /** Both pockets of a pool, refusing a figure that is not a number (§32 S40). */
  const poolTotal = async (teamId) => {
    const p = await getPool(teamId);
    const total = p.availablePaise + p.heldPaise;
    if (!Number.isFinite(total)) throw new Error(`pool pockets unreadable: ${JSON.stringify(p)}`);
    return total;
  };

  it('TRANSFERS tokens on a deposit confirm — never mints them', async () => {
    // The user used to be credited first with a best-effort merchant debit
    // (overdraft allowed, error swallowed), so an under-funded merchant
    // confirming a deposit created tokens out of nothing. The tokens now leave
    // the team's pool — the hold the router took — and arrive at the player.
    const m = await member();
    const { orderId, who } = await paidBuy({ to: m, betting: 40_000, reserve: 10_000 });

    const poolBefore = await poolTotal(m.team.teamId);
    const before = await getBalancesPaise(who.userId);

    const res = await as(app, m).post(`/confirm/${orderId}`);
    expect(res.status, res.body.message).toBe(200);

    const after = await getBalancesPaise(who.userId);
    const poolOut = (poolBefore - await poolTotal(m.team.teamId)) / 100;
    const playerIn = ((after.depositBalance - before.depositBalance)
      + (after.reserveBalance - before.reserveBalance)) / 100;

    expect(poolOut).toBe(UPI_TOKENS);
    expect(playerIn, 'the pool and the player did not move the same amount').toBe(poolOut);
    expect(after.depositBalance - before.depositBalance).toBe(40_000_00);
    expect(after.reserveBalance - before.reserveBalance).toBe(10_000_00);
  });

  it('CREDITS ONCE when a merchant double-taps confirm', async () => {
    const m = await member();
    const { orderId, who } = await paidBuy({ to: m });

    const first = await as(app, m).post(`/confirm/${orderId}`);
    const balance = await getBalancesPaise(who.userId);
    const pool = await getPool(m.team.teamId);

    const second = await as(app, m).post(`/confirm/${orderId}`);
    expect(first.status).toBe(200);
    // The order is COMPLETED after the first, so the second is refused — the
    // point is only that it moves no money a second time, not the exact code.
    expect(second.status, second.body.message).toBeGreaterThanOrEqual(400);

    expect(await getBalancesPaise(who.userId)).toMatchObject({
      depositBalance: balance.depositBalance, reserveBalance: balance.reserveBalance,
    });
    expect(await getPool(m.team.teamId)).toEqual(pool);
  });

  it('survives four confirms racing each other', async () => {
    const m = await member();
    const { orderId, who } = await paidBuy({ to: m, betting: 40_000, reserve: 10_000 });
    const before = await getBalancesPaise(who.userId);
    const poolBefore = await poolTotal(m.team.teamId);

    await Promise.all(Array.from({ length: 4 }, () =>
      as(app, m).post(`/confirm/${orderId}`)));

    const after = await getBalancesPaise(who.userId);
    expect(after.depositBalance - before.depositBalance).toBe(40_000_00);
    expect(after.reserveBalance - before.reserveBalance).toBe(10_000_00);
    expect(poolBefore - await poolTotal(m.team.teamId)).toBe(UPI_TOKENS * 100);
    expect((await getOrderRecord(orderId)).state).toBe('COMPLETED');
  });

  it('will not confirm a withdrawal that is not in flight', async () => {
    // A cash sell, routed, accepted and confirmed — PAID, the credit HELD.
    // Confirming it again is a withdrawal no longer in flight.
    const m = await member('CASH');
    const s = await sell({ to: m, tokens: CASH_TOKENS });
    expect(s.row.state).toBe('ASSIGNED');
    expect(s.row.merchantId).toBe(String(m.merchantId));
    expect((await as(app, m).post(`/accept/${s.orderId}`).send({})).status).toBe(200);
    const first = await as(app, m).post(`/confirm/${s.orderId}`).send({ utrNumber: payoutUtr() });
    expect(first.status, first.body.message).toBe(200);
    expect((await getOrderRecord(s.orderId)).state).toBe('PAID');

    const res = await as(app, m).post(`/confirm/${s.orderId}`).send({});
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/PROCESSING\/ASSIGNED/i);
  });

  // ── The merchant's own queue ──────────────────────────────────────────────
  it('shows a merchant only their own orders', async () => {
    const mine = await member();
    const theirs = await member();
    const a = await acceptedBuy({ to: mine });
    const b = await acceptedBuy({ to: theirs });

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
    const m = await member();

    // The repository alias itself — the first link in the chain.
    const row = await getMerchant(m.merchantId);
    expect(row._id, 'toMerchant no longer aliases merchant_id to _id').toBe(m.merchantId);
    expect(row.id).toBe(m.merchantId);

    // And the chain end to end: a real token → merchantAuth → the scoped
    // lookup returns THIS merchant's order.
    const mine = await acceptedBuy({ to: m });
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
    const m = await merchantActor();
    const res = await as(app, m).get('/profile');
    expect(res.status, res.body.message).toBe(200);
    expect(res.body.merchant.merchantId ?? res.body.merchant._id).toBe(m.merchantId);
  });
});
