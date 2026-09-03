// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * The player-facing payment routes, over HTTP against a real database.
 *
 * ── The one that matters ────────────────────────────────────────────────────
 * `POST /deposit/:orderId/confirm` is where tokens are dispensed. It debits a
 * merchant and credits a player, and it once debited `depositAllocation ||
 * tokenAmount` while crediting `depositAllocation + reserveAllocation` — so
 * every deposit carrying a reserve share credited more than it debited, and the
 * difference came from nowhere. The books did not close and nothing said so.
 *
 * The conservation test below is therefore the point of this file: what leaves
 * the merchant equals what reaches the player, to the paise, on the same
 * request.
 *
 * ── Why not mocked ──────────────────────────────────────────────────────────
 * CLAUDE.md: do not mock the boundary that carries money. A suite that mocked
 * the settlement writer and asserted on its arguments once reported settlement
 * working while the real function threw on every call. So the router, the auth
 * middleware, the wallet authority, the merchant wallet and the ledger are all
 * the real ones.
 *
 * ── What is deliberately NOT driven end-to-end ──────────────────────────────
 * `POST /deposit/create` and `/withdrawal/create` delegate to
 * `paymentProcessing.service.js`, which assigns a merchant and starts a retry
 * loop on failure — a timer this suite would leave running. Those services have
 * their own suites (`withdrawalAdmissionPg`, `depositConservationPg`); what is
 * asserted here is the gate chain in front of them, which is the router's own
 * responsibility and short-circuits before the handler runs.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pgConfigured, applySchema, closePg, pgQuery } from '#db/client.js';
import { getBalancesPaise } from '#db/repositories/wallets.core.js';
import { createOrderRecord, getOrderRecord, setOrderFields } from '#db/repositories/orders.record.js';
import { claimUtr, getUtr } from '#db/repositories/utr.js';
import { getMerchantTokenBalance } from '../../domains/merchant/merchantWallet.service.js';
import { mountRouter, actor, merchantActor, as, request } from './_harness.js';

const describePg = pgConfigured() ? describe : describe.skip;
const R = (paise) => paise / 100;

describePg('payment routes', () => {
  let app; let admin;
  const RUN = Math.random().toString(36).slice(2, 8);
  let seq = 0;

  beforeAll(async () => {
    await applySchema();
    const mod = await import('../../domains/payment/payment.routes.js');
    app = mountRouter(mod.default);
    admin = await actor({ isAdmin: true, roles: ['admin'] });
  }, 60_000);

  afterAll(async () => { await closePg(); });

  /**
   * A deposit order sitting where a confirm can reach it.
   *
   * `depositAllocation` + `reserveAllocation` must add up to `tokenAmount` or
   * `depositCreditSplit` refuses the split and credits the whole amount to the
   * betting pocket — which is the safe fallback, not the case under test.
   */
  const depositOrder = async ({
    state = 'PAID', tokens = 500, betting = 400, reserve = 100,
    owner = null, merchant = null, extra = {},
  } = {}) => {
    seq += 1;
    const who = owner || await actor({});
    const m = merchant || await merchantActor({ tokensRupees: 10_000 });
    const orderId = `PAY-${RUN}-${seq}`;
    await createOrderRecord({
      orderId, userId: who.userId, type: 'DEPOSIT',
      tokenAmountRupees: tokens, fiatAmountRupees: tokens, state,
      merchantId: m.merchantId,
      depositAllocation: betting, reserveAllocation: reserve,
      ...extra,
    });
    return { orderId, who, merchant: m };
  };

  // ── The gate chain in front of the create routes ──────────────────────────
  it('refuses every route without a token', async () => {
    for (const call of [
      () => request(app).post('/deposit/create').send({ tokenAmount: 500 }),
      () => request(app).post('/withdrawal/create').send({ tokenAmount: 500 }),
      () => request(app).post('/order/x/mark-paid').send({ utrNumber: 'A', proofFileKey: 'k' }),
      () => request(app).get('/orders'),
      () => request(app).get('/order/x'),
      () => request(app).post('/order/cancel').send({ orderId: 'x' }),
      () => request(app).get('/order/x/status'),
      () => request(app).post('/order/x/dispute').send({ reason: 'r' }),
    ]) {
      expect((await call()).status, 'an unauthenticated call must never reach a handler').toBe(401);
    }
  });

  it('serves the rate card without a token — it is public', async () => {
    const res = await request(app).get('/rates');
    expect(res.status).toBe(200);
    // Fixed 1:1 internal conversion, no spread. A rate that drifted from 1
    // would mean tokens and rupees stopped being the same unit.
    expect(res.body.rates).toEqual({ buyRate: 1, sellRate: 1, merchantProfitPerToken: 0 });
  });

  it('refuses deposits and withdrawals to an unverified player', async () => {
    // KYC gates the money routes and nothing else. A player who cannot deposit
    // must still be able to read their own order history.
    const unverified = await actor({ kycStatus: 'PENDING_APPROVAL' });
    expect((await as(app, unverified).post('/deposit/create').send({ tokenAmount: 500 })).status).toBe(403);
    expect((await as(app, unverified).post('/withdrawal/create').send({ tokenAmount: 500 })).status).toBe(403);
    expect((await as(app, unverified).get('/orders')).status).toBe(200);
  });

  // ── mark-paid validation ──────────────────────────────────────────────────
  it('refuses a payment claim with no reference and no proof', async () => {
    // The UTR is what makes a claim checkable and the screenshot is what makes
    // it disputable. A claim with neither is a merchant's word against a
    // player's.
    const player = await actor({});
    const bad = [
      [{ proofFileKey: 'k' }, /utrNumber/i],
      [{ utrNumber: '   ', proofFileKey: 'k' }, /utrNumber/i],
      [{ utrNumber: 'UTR1' }, /proofFileKey/i],
      [{ utrNumber: 'UTR1', proofFileKey: '  ' }, /proofFileKey/i],
    ];
    for (const [body, message] of bad) {
      const res = await as(app, player).post('/order/anything/mark-paid').send(body);
      expect(res.status, `accepted ${JSON.stringify(body)}`).toBe(400);
      expect(res.body.message).toMatch(message);
    }
  });

  // ── Who may confirm a deposit ─────────────────────────────────────────────
  it('refuses a confirm from a plain player', async () => {
    const { orderId } = await depositOrder();
    const nobody = await actor({});
    const res = await as(app, nobody).post(`/deposit/${orderId}/confirm`).send({});
    expect(res.status).toBe(403);
  });

  it('refuses a confirm from a merchant the order is not assigned to', async () => {
    // The assignment is what makes a merchant the counterparty. Without this
    // check any approved merchant could dispense tokens against anyone's order.
    const { orderId } = await depositOrder();
    const stranger = await merchantActor({ tokensRupees: 10_000 });
    const res = await as(app, stranger).post(`/deposit/${orderId}/confirm`).send({});
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/not assigned to you/i);
  });

  it('refuses a merchant whose account is not approved', async () => {
    const pending = await merchantActor({ status: 'PENDING', approval: 'PENDING' });
    const { orderId } = await depositOrder({ merchant: pending });
    expect((await as(app, pending).post(`/deposit/${orderId}/confirm`).send({})).status).toBe(403);
  });

  it('404s a confirm against an order that is not a deposit', async () => {
    seq += 1;
    const who = await actor({});
    const orderId = `PAY-${RUN}-wd-${seq}`;
    await createOrderRecord({
      orderId, userId: who.userId, type: 'WITHDRAWAL',
      tokenAmountRupees: 500, fiatAmountRupees: 500, state: 'PAID',
    });
    expect((await as(app, admin).post(`/deposit/${orderId}/confirm`).send({})).status).toBe(404);
  });

  // ── The money ─────────────────────────────────────────────────────────────
  it('DEBITS THE MERCHANT EXACTLY WHAT IT CREDITS THE PLAYER', async () => {
    // The defect this pins: the merchant was debited `depositAllocation` while
    // the player was credited `depositAllocation + reserveAllocation`, so every
    // deposit with a reserve share created tokens out of nothing.
    const { orderId, who, merchant } = await depositOrder({ tokens: 500, betting: 400, reserve: 100 });

    const merchantBefore = await getMerchantTokenBalance(merchant.merchantId);
    const playerBefore = await getBalancesPaise(who.userId);

    const res = await as(app, admin).post(`/deposit/${orderId}/confirm`).send({});
    expect(res.status, res.body.message).toBe(200);

    const merchantAfter = await getMerchantTokenBalance(merchant.merchantId);
    const playerAfter = await getBalancesPaise(who.userId);

    const merchantOut = merchantBefore - merchantAfter;
    const playerIn = R(
      (playerAfter.depositBalance - playerBefore.depositBalance)
      + (playerAfter.reserveBalance - playerBefore.reserveBalance),
    );

    expect(merchantOut).toBe(500);
    expect(playerIn, 'the merchant and the player did not move the same amount').toBe(merchantOut);
  });

  it('honours the split — betting and reserve pockets each get their share', async () => {
    const { orderId, who } = await depositOrder({ tokens: 500, betting: 400, reserve: 100 });
    const before = await getBalancesPaise(who.userId);
    await as(app, admin).post(`/deposit/${orderId}/confirm`).send({});
    const after = await getBalancesPaise(who.userId);

    expect(after.depositBalance - before.depositBalance).toBe(400_00);
    expect(after.reserveBalance - before.reserveBalance).toBe(100_00);
  });

  it('cannot be handed an order whose split does not close — the ROW is impossible', async () => {
    // `depositCreditSplit` falls back to crediting the whole amount to betting
    // when the allocations do not add up to the deposit. That fallback is
    // unreachable through this route, and deliberately so: the CHECK
    // `order_states_allocation_closes` refuses the row, so an order carrying a
    // difference nothing accounts for cannot be created at all. The stronger
    // guarantee is the one worth pinning.
    await expect(depositOrder({ tokens: 500, betting: 300, reserve: 100 }))
      .rejects.toThrow(/order_states_allocation_closes/);
  });

  it('credits the whole amount to betting when there is no split at all', async () => {
    // Zero allocations is the other value the CHECK allows: an order that never
    // split. The whole deposit goes to the betting pocket, and the merchant is
    // debited the same amount.
    const { orderId, who, merchant } = await depositOrder({ tokens: 500, betting: 0, reserve: 0 });
    const before = await getBalancesPaise(who.userId);
    const merchantBefore = await getMerchantTokenBalance(merchant.merchantId);

    await as(app, admin).post(`/deposit/${orderId}/confirm`).send({});

    const after = await getBalancesPaise(who.userId);
    expect(after.depositBalance - before.depositBalance).toBe(500_00);
    expect(after.reserveBalance).toBe(before.reserveBalance);
    expect(merchantBefore - await getMerchantTokenBalance(merchant.merchantId)).toBe(500);
  });

  it('refuses BEFORE anything moves when the merchant cannot cover it', async () => {
    // Refusing is the ordinary case — a merchant confirming more than they
    // hold — and it must leave the player's wallet and the order untouched.
    const poor = await merchantActor({ tokensRupees: 10 });
    const { orderId, who } = await depositOrder({ tokens: 500, merchant: poor });
    const before = await getBalancesPaise(who.userId);

    const res = await as(app, admin).post(`/deposit/${orderId}/confirm`).send({});
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/insufficient/i);

    expect(await getBalancesPaise(who.userId)).toMatchObject({
      depositBalance: before.depositBalance, reserveBalance: before.reserveBalance,
    });
    expect((await getOrderRecord(orderId)).state).toBe('PAID');
    expect(await getMerchantTokenBalance(poor.merchantId)).toBe(10);
  });

  it('CREDITS ONCE when the same confirm arrives twice', async () => {
    // A merchant clicking while an admin force-approves is the real case. Every
    // movement is keyed on the order, so the second pass replays them as no-ops
    // and exactly one caller is told it completed the order.
    const { orderId, who, merchant } = await depositOrder({ tokens: 500, betting: 400, reserve: 100 });

    const first = await as(app, admin).post(`/deposit/${orderId}/confirm`).send({});
    const balanceAfterFirst = await getBalancesPaise(who.userId);
    const merchantAfterFirst = await getMerchantTokenBalance(merchant.merchantId);

    const second = await as(app, admin).post(`/deposit/${orderId}/confirm`).send({});
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.message).toMatch(/already completed/i);

    expect(await getBalancesPaise(who.userId)).toMatchObject({
      depositBalance: balanceAfterFirst.depositBalance,
      reserveBalance: balanceAfterFirst.reserveBalance,
    });
    expect(await getMerchantTokenBalance(merchant.merchantId)).toBe(merchantAfterFirst);
  });

  it('survives two confirms racing each other', async () => {
    const { orderId, who, merchant } = await depositOrder({ tokens: 500, betting: 400, reserve: 100 });
    const before = await getBalancesPaise(who.userId);
    const merchantBefore = await getMerchantTokenBalance(merchant.merchantId);

    const results = await Promise.all(
      Array.from({ length: 4 }, () => as(app, admin).post(`/deposit/${orderId}/confirm`).send({})),
    );
    expect(results.every((r) => r.status === 200 || r.status === 409)).toBe(true);

    const after = await getBalancesPaise(who.userId);
    expect(after.depositBalance - before.depositBalance).toBe(400_00);
    expect(after.reserveBalance - before.reserveBalance).toBe(100_00);
    expect(merchantBefore - await getMerchantTokenBalance(merchant.merchantId)).toBe(500);
  });

  it('posts the accounting event in the same transaction as the completion', async () => {
    // A completed order always has its ledger entry: the state change and the
    // event are one transaction, so there is no window where money moved and
    // the books do not know.
    const { orderId } = await depositOrder();
    await as(app, admin).post(`/deposit/${orderId}/confirm`).send({});

    const { rows } = await pgQuery(
      `SELECT t.to_state, t.ledger_key, e.event_type
         FROM order_transitions t
         LEFT JOIN accounting_events e ON e.idempotency_key = t.ledger_key
        WHERE t.order_id = $1 AND t.to_state = 'COMPLETED'`, [orderId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].ledger_key, 'the completion recorded no ledger key').toBeTruthy();
    expect(rows[0].event_type, 'the completion has no accounting event behind it').toBeTruthy();
  });

  it('releases the bank reference when the deposit completes', async () => {
    // RELEASED means the order finished and the reference is SPENT. Leaving it
    // ACTIVE would let the same transfer be claimed again.
    const { orderId } = await depositOrder({ extra: { utrNumber: `UTRPAY${RUN}${seq}` } });
    const order = await getOrderRecord(orderId);
    await claimUtr({ utr: order.utrNumber, orderId, userId: order.userId, amountRupees: 500 });

    await as(app, admin).post(`/deposit/${orderId}/confirm`).send({});
    expect((await getUtr(order.utrNumber)).status).toBe('RELEASED');
  });

  it('409s a confirm on an order that has not been paid yet', async () => {
    const { orderId, who } = await depositOrder({ state: 'PENDING_QUEUE' });
    const before = await getBalancesPaise(who.userId);
    const res = await as(app, admin).post(`/deposit/${orderId}/confirm`).send({});
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/PENDING_QUEUE/);
    expect(await getBalancesPaise(who.userId)).toMatchObject({ depositBalance: before.depositBalance });
  });

  // ── What a merchant is allowed to see ─────────────────────────────────────
  it('STRIPS the player’s contact and bank details from a merchant’s response', async () => {
    // Those fields are on the order because a merchant needs them to PAY a
    // withdrawal. In a deposit the money flows the other way and they are a
    // leak.
    const merchant = await merchantActor({ tokensRupees: 10_000 });
    const { orderId } = await depositOrder({
      merchant,
      extra: { userPhone: '9998887777', userBankDetails: { accountNo: '123456789', ifsc: 'HDFC0001' } },
    });

    const res = await as(app, merchant).post(`/deposit/${orderId}/confirm`).send({});
    expect(res.status, res.body.message).toBe(200);
    for (const leak of ['userPhone', 'userBankDetails', 'merchantSnapshot', 'upiId']) {
      expect(res.body.order, `${leak} reached the merchant`).not.toHaveProperty(leak);
    }
    // And the order itself still holds them — they are stripped from the
    // response, not lost from the record a withdrawal will need.
    expect((await getOrderRecord(orderId)).userPhone).toBe('9998887777');
  });

  it('gives an admin the unredacted order', async () => {
    const { orderId } = await depositOrder({ extra: { userPhone: '9998887777' } });
    const res = await as(app, admin).post(`/deposit/${orderId}/confirm`).send({});
    expect(res.body.order.userPhone).toBe('9998887777');
  });

  // ── The player's own history ──────────────────────────────────────────────
  it('shows a player only their OWN orders', async () => {
    const mine = await depositOrder();
    const theirs = await depositOrder();
    const res = await as(app, mine.who).get('/orders?limit=100');
    expect(res.status).toBe(200);
    const ids = res.body.orders.map((o) => o.orderId);
    expect(ids).toContain(mine.orderId);
    expect(ids).not.toContain(theirs.orderId);
  });

  it('reports a total that describes the same instant as the page', async () => {
    // `find()` plus `countDocuments()` are two reads of a table that accepts an
    // order between them, so a player watching their own history saw a footer
    // that disagreed with the rows above it.
    const who = await actor({});
    await depositOrder({ owner: who });
    await depositOrder({ owner: who });
    const res = await as(app, who).get('/orders?limit=1');
    expect(res.body.orders).toHaveLength(1);
    expect(res.body.pagination).toMatchObject({ total: 2, limit: 1, skip: 0 });
  });

  it('filters the history by status and by type', async () => {
    const who = await actor({});
    const paid = await depositOrder({ owner: who, state: 'PAID' });
    const queued = await depositOrder({ owner: who, state: 'PENDING_QUEUE' });

    const byState = await as(app, who).get('/orders?status=PAID&limit=100');
    expect(byState.body.orders.map((o) => o.orderId)).toEqual([paid.orderId]);

    const byType = await as(app, who).get('/orders?type=WITHDRAWAL&limit=100');
    expect(byType.body.orders).toHaveLength(0);
    expect(byType.body.pagination.total).toBe(0);

    expect(queued.orderId).toBeTruthy();
  });

  it('clamps an absurd page size rather than serving it', async () => {
    const who = await actor({});
    await depositOrder({ owner: who });
    const res = await as(app, who).get('/orders?limit=100000');
    expect(res.body.pagination.limit).toBe(100);
  });

  // ── Ownership ─────────────────────────────────────────────────────────────
  it('404s — never 403 — on somebody else’s order', async () => {
    // A distinguishable 404-vs-403 tells someone probing ids which ones are
    // real. Every read of an order they do not own answers the same way.
    const { orderId } = await depositOrder();
    const stranger = await actor({});
    for (const path of [`/order/${orderId}`, `/order/${orderId}/status`]) {
      const res = await as(app, stranger).get(path);
      expect(res.status, `${path} distinguished a real id from a fake one`).toBe(404);
    }
    const disputed = await as(app, stranger).post(`/order/${orderId}/dispute`).send({ reason: 'mine actually' });
    expect(disputed.status).toBe(404);

    const missing = await as(app, stranger).get(`/order/NOSUCH-${RUN}`);
    expect(missing.status).toBe(404);
  });

  it('lets an admin read any order', async () => {
    const { orderId } = await depositOrder();
    const res = await as(app, admin).get(`/order/${orderId}`);
    expect(res.status).toBe(200);
    expect(res.body.order.orderId).toBe(orderId);
  });

  // ── The polling endpoint ──────────────────────────────────────────────────
  it('serves only the fields the payment screen polls for', async () => {
    const { orderId, who } = await depositOrder({ extra: { userPhone: '9998887777' } });
    const res = await as(app, who).get(`/order/${orderId}/status`);
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(
      ['expiresAt', 'merchantSnapshot', 'proofScreenshot', 'status', 'success', 'utrNumber'],
    );
  });

  it('HIDES a payment screenshot once it has expired', async () => {
    const { orderId, who } = await depositOrder({ extra: { proofScreenshot: 'https://cdn/proof.png' } });
    await setOrderFields(orderId, { proofExpiresAt: new Date(Date.now() - 1000) });
    const res = await as(app, who).get(`/order/${orderId}/status`);
    expect(res.body.proofScreenshot).toBeNull();
    // The order itself is unchanged — only what is served expires.
    expect((await getOrderRecord(orderId)).proofScreenshot).toBe('https://cdn/proof.png');
  });

  it('treats an ABSENT expiry as 48 hours, not as "never"', async () => {
    // An order written before the column existed must not read as a screenshot
    // that is visible forever.
    const { orderId, who } = await depositOrder({ extra: { proofScreenshot: 'https://cdn/proof.png' } });
    await pgQuery(
      `UPDATE order_states SET proof_expires_at = NULL, created_at = now() - interval '49 hours'
        WHERE order_id = $1`, [orderId],
    );
    expect((await as(app, who).get(`/order/${orderId}/status`)).body.proofScreenshot).toBeNull();

    await pgQuery(
      `UPDATE order_states SET created_at = now() - interval '1 hour' WHERE order_id = $1`, [orderId],
    );
    expect((await as(app, who).get(`/order/${orderId}/status`)).body.proofScreenshot).toBe('https://cdn/proof.png');
  });

  // ── Disputes ──────────────────────────────────────────────────────────────
  it('requires a reason to raise a dispute', async () => {
    const { orderId, who } = await depositOrder();
    for (const body of [{}, { reason: '' }, { reason: '   ' }]) {
      const res = await as(app, who).post(`/order/${orderId}/dispute`).send(body);
      expect(res.status, `accepted ${JSON.stringify(body)}`).toBe(400);
    }
  });

  it('only disputes a PAID order', async () => {
    const { orderId, who } = await depositOrder({ state: 'PENDING_QUEUE' });
    const res = await as(app, who).post(`/order/${orderId}/dispute`).send({ reason: 'nobody is paying me' });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/only dispute PAID/i);
  });

  it('makes a player wait ten minutes before disputing', async () => {
    // A merchant needs a moment to confirm. Disputing instantly turns every
    // normal payment into an escalation.
    const { orderId, who } = await depositOrder({ state: 'PAID' });
    await setOrderFields(orderId, { paidAt: new Date() });
    const res = await as(app, who).post(`/order/${orderId}/dispute`).send({ reason: 'too slow' });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/at least 10 minutes/i);
  });

  it('raises the dispute through the state machine once the wait is over', async () => {
    const { orderId, who } = await depositOrder({ state: 'PAID' });
    await setOrderFields(orderId, { paidAt: new Date(Date.now() - 11 * 60 * 1000) });

    const res = await as(app, who).post(`/order/${orderId}/dispute`).send({ reason: '  Merchant never confirmed.  ' });
    expect(res.status, res.body.message).toBe(200);

    const order = await getOrderRecord(orderId);
    expect(order.state).toBe('DISPUTED');
    expect(order.disputeReason).toBe('Merchant never confirmed.');
    expect(order.disputeRaisedBy).toBe('user');

    const { rows } = await pgQuery(
      `SELECT from_state, to_state FROM order_transitions WHERE order_id = $1 ORDER BY id DESC LIMIT 1`,
      [orderId],
    );
    expect(rows[0]).toMatchObject({ from_state: 'PAID', to_state: 'DISPUTED' });
  });

  it('does not let a second dispute overwrite the first', async () => {
    // The order is DISPUTED by then, so the elapsed-time route's own pre-read
    // answers 400 ("can only dispute PAID orders") before the transition is
    // asked. Either way the first reason is the one that stands — an overwrite
    // would erase what the player actually complained about.
    const { orderId, who } = await depositOrder({ state: 'PAID' });
    await setOrderFields(orderId, { paidAt: new Date(Date.now() - 11 * 60 * 1000) });
    await as(app, who).post(`/order/${orderId}/dispute`).send({ reason: 'first' });

    const second = await as(app, who).post(`/order/${orderId}/dispute`).send({ reason: 'second' });
    expect(second.status).toBe(400);
    expect((await getOrderRecord(orderId)).disputeReason).toBe('first');
  });

  it('409s — not 400 — when the transition itself refuses', async () => {
    // The status endpoint has no pre-read: it asks the state machine and reports
    // what it says. "Understood and refused because the order moved on" is a
    // different answer from "your request was malformed", and a merchant
    // confirming while the player was typing is the ordinary case.
    const { orderId, who } = await depositOrder({ state: 'PENDING_QUEUE' });
    const res = await as(app, who).post(`/order/${orderId}/status`).send({ status: 'DISPUTED' });
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/PENDING_QUEUE/);
    expect((await getOrderRecord(orderId)).state).toBe('PENDING_QUEUE');
  });

  it('accepts only the DISPUTED transition on the status endpoint', async () => {
    const { orderId, who } = await depositOrder({ state: 'PAID' });
    for (const status of [undefined, 'COMPLETED', 'CANCELLED', 'disputed']) {
      const res = await as(app, who).post(`/order/${orderId}/status`).send({ status });
      expect(res.status, `accepted status=${status}`).toBe(400);
    }
    expect((await getOrderRecord(orderId)).state).toBe('PAID');
  });

  it('truncates a runaway dispute reason rather than storing it whole', async () => {
    const { orderId, who } = await depositOrder({ state: 'PAID' });
    const res = await as(app, who).post(`/order/${orderId}/status`).send({ status: 'DISPUTED', reason: 'x'.repeat(5000) });
    expect(res.status, res.body.message).toBe(200);
    expect((await getOrderRecord(orderId)).disputeReason).toHaveLength(1000);
  });
});
