// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The player-facing payment routes, over HTTP against a real database.
 *
 * ── Where the confirm went ──────────────────────────────────────────────────
 * This file used to centre on `POST /deposit/:orderId/confirm`, a second way to
 * complete a buy that once debited `depositAllocation || tokenAmount` while
 * crediting `depositAllocation + reserveAllocation`, so every deposit with a
 * reserve share credited more than it debited. No screen called it, and it was
 * deleted 2026-10-01; its conservation, split, idempotency and race assertions
 * now run against the route merchants use, in merchantConfirmMoneyPg.test.js.
 * What remains here is the player's side: creating orders, the payment claim,
 * the order list and the dispute.
 *
 * ── Why not mocked ──────────────────────────────────────────────────────────
 * CLAUDE.md: do not mock the boundary that carries money. A suite that mocked
 * the settlement writer and asserted on its arguments once reported settlement
 * working while the real function threw on every call. So the router, the auth
 * middleware, the wallet authority, the team pool and the ledger are all the
 * real ones.
 *
 * ── Every order is one the platform can produce (§32 S16, 2c) ───────────────
 * An order reaches a member by being ROUTED to them (PROJECT_STATUS §3.10):
 * so the orders below are created queued with their split, offered by
 * `tryAssignMerchant` to a working UPI team — which HOLDS the buy's tokens in
 * the team's pool — and marked paid by the player through `markOrderPaid`.
 * A queued order is one nobody was free for. A player has one open buy at a
 * time (BUY_ALREADY_OPEN), so a history of two holds one the player cancelled.
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
import { pgConfigured, applySchema, closePg, withTransaction } from '#db/client.js';
import { createOrderRecord, getOrderRecord, setOrderFields, listOrderTransitions } from '#db/repositories/orders.record.js';
import { tryAssignMerchant, markOrderPaid } from '../../domains/payment/paymentProcessing.service.js';
import { teamFixture, readyToPay } from '../teamFixture.js';
import { mountRouter, actor, as, request } from './_harness.js';

const describePg = pgConfigured() ? describe : describe.skip;

// Above the cash ceiling: a UPI_BANK buy, whose reference is required up front.
const TOKENS = 20_000;

describePg('payment routes', () => {
  let app; let admin; let team;
  const RUN = Math.random().toString(36).slice(2, 8);
  let seq = 0;
  const teams = teamFixture();
  const players = [];

  /** A player whose orders this suite removes afterwards (trap 10). */
  const player = async () => {
    const who = await actor({});
    players.push(who.userId);
    return who;
  };

  beforeAll(async () => {
    await applySchema();
    const mod = await import('../../domains/payment/payment.routes.js');
    app = mountRouter(mod.default);
    admin = await actor({ isAdmin: true, roles: ['admin'] });
    // Ten members at three open orders each is room for thirty, and a pool
    // that covers every buy this suite leaves open.
    team = await teams.workingTeam({ rail: 'UPI_BANK', poolTokens: 600_000 });
  }, 120_000);

  afterAll(async () => {
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
  const nextUtr = () => String(520000000000 + (seq * 7919) + Math.floor(Math.random() * 7000));

  /**
   * A deposit in a state PRODUCTION can actually produce, made the way it
   * makes one:
   *
   *   PENDING_QUEUE  created, and offered while nobody was free
   *   ASSIGNED       created, and routed to a member — the pool holds its tokens
   *   PAID           routed, and the player marked it paid with their reference,
   *                  which the registry claimed against it (§27). `mark-paid`
   *                  stamps `paidAt` now; `paidMinutesAgo` moves that clock
   *                  back, for the cases about a dispute after the wait.
   *
   * PAID orders always carry the player's reference, because `mark-paid` is the
   * only way a UPI buy reaches PAID and it requires one. This fixture used to
   * write the state and the merchant onto the row directly, which is how it once
   * staged a PAID deposit carrying no reference — a row the platform cannot
   * create — and both confirm routes happily completed it because only one of
   * them was checking.
   */
  const depositOrder = async ({ state = 'PAID', owner = null, extra = {}, paidMinutesAgo = 0 } = {}) => {
    seq += 1;
    const who = owner || await player();
    if (owner) players.push(owner.userId);
    const orderId = `PAY-${RUN}-${seq}`;
    const order = await createOrderRecord({
      orderId, userId: who.userId, type: 'DEPOSIT',
      tokenAmountRupees: TOKENS, fiatAmountRupees: TOKENS,
      depositAllocation: 16_000, reserveAllocation: 4_000,
      ...extra,
    });
    const queued = state === 'PENDING_QUEUE';
    await teams.onlyOnline(queued ? [] : team.members);
    expect(await tryAssignMerchant(order), `the buy was ${queued ? '' : 'not '}routed`).toBe(!queued);
    // Accepted by its member: from then on the player has somewhere to pay.
    if (state === 'PROCESSING' || state === 'PAID') await readyToPay(orderId);
    let utrNumber = null;
    if (state === 'PAID') {
      utrNumber = nextUtr();
      expect((await markOrderPaid(who.userId, orderId, utrNumber)).status).toBe('PAID');
      if (paidMinutesAgo) await setOrderFields(orderId, { paidAt: new Date(Date.now() - paidMinutesAgo * 60 * 1000) });
    }
    expect((await getOrderRecord(orderId)).state).toBe(state);
    return { orderId, who, utrNumber };
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

  // The rate-card case moved rather than being deleted. GET /rates returned the
  // 1:1 conversion as literals — a third declaration of it, and the one place
  // an edit would silently not take effect — so the route is gone. The
  // invariant it protected is not: "a rate that drifted from 1 would mean
  // tokens and rupees stopped being the same unit" is now asserted against the
  // owner of that value, in unit/systemConfigPayload.test.js.

  /**
   * There is no identity gate on money (owner, 2026-10-02: KYC removed).
   *
   * Deposits and withdrawals were held behind an Aadhaar verdict. With KYC gone,
   * the only identity a player has is the Telegram-verified mobile, and THAT is
   * enforced by the verification gate on the panel, not by these routes. So an
   * ordinary player opens a deposit, and a withdrawal is refused for a money
   * reason (nothing to withdraw) — never for an identity one.
   */
  it('lets an ordinary player deposit, and refuses a withdrawal only for money', async () => {
    const who = await player();
    const deposit = await as(app, who).post('/deposit/create').send({ tokenAmount: 500 });
    expect(deposit.status, `deposit refused: ${JSON.stringify(deposit.body)}`).toBe(200);

    const withdrawal = await as(app, who).post('/withdrawal/create').send({ tokenAmount: 500 });
    expect(withdrawal.status, JSON.stringify(withdrawal.body)).not.toBe(403);
    expect(JSON.stringify(withdrawal.body)).not.toMatch(/kyc|aadhaar/i);
  });

  /**
   * The purchase pace, and that it is the LIMITER refusing rather than the
   * one-open-buy rule.
   *
   * Those two are easy to confuse: a second create would be refused either way.
   * The limiter is middleware and runs BEFORE the handler, so it answers 429
   * while the business rule answers 409 — asserting the code is what proves
   * which control actually fired.
   *
   * `/deposit/create` was the only money-creation route with no limit at all
   * while both its siblings carried one.
   */
  it('paces new purchases per minute, and it is the limiter that says so', async () => {
    const who = await player();

    const first = await as(app, who).post('/deposit/create').send({ tokenAmount: 500 });
    expect(first.status).toBe(200);

    const second = await as(app, who).post('/deposit/create').send({ tokenAmount: 500 });
    expect(second.status, 'the second create inside a minute was not paced').toBe(429);
  });

  // ── mark-paid validation ──────────────────────────────────────────────────
  it('refuses a payment claim with no reference', async () => {
    // The UTR is the whole claim now. It is what makes the payment checkable —
    // the merchant matches it against their own bank statement — and it is the
    // only part of the submission the platform can verify.
    //
    // This needs a REAL order the player owns. `orderAccessGuard` runs before
    // the handler, so an id nobody owns is refused as 404 before the body is
    // ever looked at — which is the right order: a caller who may not see the
    // order gets no feedback about what its body should have contained.
    //
    // A UPI buy: on the CASH rail an empty reference is the Paid TAP, which
    // reaches PAID with the reference to follow (cashPaidThenReferencePg).
    const { orderId, who } = await depositOrder({ state: 'PROCESSING' });

    for (const body of [{}, { utrNumber: '   ' }, { utrNumber: null }]) {
      const res = await as(app, who).post(`/order/${orderId}/mark-paid`).send(body);
      expect(res.status, `accepted ${JSON.stringify(body)}`).toBe(400);
      expect(res.body.message).toMatch(/utrNumber/i);
    }
    // …and nothing about the order moved.
    expect((await getOrderRecord(orderId)).status).toBe('PROCESSING');
  });

  it('takes the UTR alone — no screenshot is asked for or required', async () => {
    // The screenshot proved nothing: trivially forged, read by no approval.
    // This is the assertion that the flow actually COMPLETES without one, which
    // a validation test cannot show — the route used to 400 on the missing
    // proofFileKey before it ever reached the order.
    const { orderId, who } = await depositOrder({ state: 'PROCESSING' });

    // Unique per run: `utr_registry` is permanent, so a fixed reference passes
    // once and 409s on every later run against the same database.
    const utrNumber = `UTR${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
    const res = await as(app, who).post(`/order/${orderId}/mark-paid`).send({ utrNumber });

    expect(res.status).toBe(200);
    const stored = await getOrderRecord(orderId);
    expect(stored.status).toBe('PAID');
    // Normalised and stored, so the merchant has something to match on.
    expect(stored.utrNumber).toBe(utrNumber);
    // And nothing invented an image.
    expect(stored.proofScreenshot ?? null).toBeNull();
  });

  it('normalises the reference a player pastes', async () => {
    // A UTR copied out of a bank app arrives lowercase and with spaces in it.
    // Storing it verbatim means the merchant's search does not find it and the
    // duplicate gate does not either — the SAME reference typed two ways would
    // claim two orders. Normalising is what makes the registry's uniqueness
    // mean anything.
    const { orderId, who } = await depositOrder({ state: 'PROCESSING' });

    const core = `utrn${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const res = await as(app, who).post(`/order/${orderId}/mark-paid`)
      .send({ utrNumber: ` ${core.slice(0, 6)} ${core.slice(6)} ` });

    expect(res.status).toBe(200);
    expect((await getOrderRecord(orderId)).utrNumber).toBe(core.toUpperCase());
  });

  it('measures the length after normalising, not before', async () => {
    // Seven characters padded past twelve with spaces is not a twelve-character
    // reference. Checking the raw string would admit it. The length gate runs
    // after the order is loaded, so this needs a real one.
    const { orderId, who } = await depositOrder({ state: 'PROCESSING' });

    const res = await as(app, who).post(`/order/${orderId}/mark-paid`)
      .send({ utrNumber: 'A B C D E F G' });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/12 characters/i);
    expect((await getOrderRecord(orderId)).status).toBe('PROCESSING');
  });

  it('still refuses a UTR already spent on another order', async () => {
    // Dropping the screenshot must not weaken the one gate that mattered: the
    // reference is claimed in a single statement, so it cannot pay twice.
    // Two players: one player holds one open buy at a time (BUY_ALREADY_OPEN),
    // and a reference is refused on ANY other order, not only the same
    // player's.
    const utrNumber = `UTRDUP${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
    const first = await depositOrder({ state: 'PROCESSING' });
    const second = await depositOrder({ state: 'PROCESSING' });

    expect((await as(app, first.who).post(`/order/${first.orderId}/mark-paid`).send({ utrNumber })).status).toBe(200);
    const dup = await as(app, second.who).post(`/order/${second.orderId}/mark-paid`).send({ utrNumber });
    expect(dup.status).toBe(409);
    // Refused for the reference, not for anything else about the order.
    expect(dup.body.code).toBe('DUPLICATE_UTR');
    expect((await getOrderRecord(second.orderId)).status).toBe('PROCESSING');
  });

  // ── Confirming a deposit ──────────────────────────────────────────────────
  // The confirm cases that stood here drove `POST /deposit/:orderId/confirm`,
  // a second confirm route no screen or workflow called. It was deleted
  // 2026-10-01 (owner decision) after every money assertion it carried — the
  // split, double delivery, the four-way race, the accounting event, the
  // reference release and the merchant's redacted view — was ported to the
  // route merchants use: merchantConfirmMoneyPg.test.js.

  // ── The player's own history ──────────────────────────────────────────────
  /** A buy nobody was free for, which the player then cancelled themselves. */
  const cancelledOrder = async (who) => {
    const o = await depositOrder({ owner: who, state: 'PENDING_QUEUE' });
    const res = await as(app, who).post('/order/cancel').send({ orderId: o.orderId });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await getOrderRecord(o.orderId)).state).toBe('CANCELLED');
    return o;
  };

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
    const who = await player();
    await cancelledOrder(who);
    await depositOrder({ owner: who });
    const res = await as(app, who).get('/orders?limit=1');
    expect(res.body.orders).toHaveLength(1);
    expect(res.body.pagination).toMatchObject({ total: 2, limit: 1, skip: 0 });
  });

  it('filters the history by status and by type', async () => {
    const who = await player();
    const cancelled = await cancelledOrder(who);
    const paid = await depositOrder({ owner: who, state: 'PAID' });

    const byState = await as(app, who).get('/orders?status=PAID&limit=100');
    expect(byState.body.orders.map((o) => o.orderId)).toEqual([paid.orderId]);
    const other = await as(app, who).get('/orders?status=CANCELLED&limit=100');
    expect(other.body.orders.map((o) => o.orderId)).toEqual([cancelled.orderId]);

    const byType = await as(app, who).get('/orders?type=WITHDRAWAL&limit=100');
    expect(byType.body.orders).toHaveLength(0);
    expect(byType.body.pagination.total).toBe(0);
  });

  it('clamps an absurd page size rather than serving it', async () => {
    const who = await player();
    await depositOrder({ owner: who });
    const res = await as(app, who).get('/orders?limit=100000');
    expect(res.body.pagination.limit).toBe(100);
  });

  // ── Ownership ─────────────────────────────────────────────────────────────
  it('404s — never 403 — on somebody else’s order', async () => {
    // A distinguishable 404-vs-403 tells someone probing ids which ones are
    // real. Every read of an order they do not own answers the same way.
    const { orderId } = await depositOrder();
    const stranger = await player();
    for (const path of [`/order/${orderId}`, `/order/${orderId}/status`]) {
      const res = await as(app, stranger).get(path);
      expect(res.status, `${path} distinguished a real id from a fake one`).toBe(404);
    }
    const disputed = await as(app, stranger).post(`/order/${orderId}/dispute`).send({ reason: 'mine actually' });
    expect(disputed.status).toBe(404);

    const missing = await as(app, stranger).get(`/order/NOSUCH-${RUN}`);
    expect(missing.status).toBe(404);
  });

  it('keeps a player\'s order routes the player\'s: an admin reads orders through the admin routes', async () => {
    // These routes admitted any staff account, so a sub-admin trusted with
    // nothing but chat could read any player's order (2026-10-01). Staff work
    // on orders through /api/admin, gated by area — and a staff session is now
    // refused at the player door itself, naming the panel it belongs to.
    const { orderId } = await depositOrder();
    const res = await as(app, admin).get(`/order/${orderId}`);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('WRONG_PANEL');
    expect(res.body.order).toBeUndefined();
  });

  // ── The polling endpoint ──────────────────────────────────────────────────
  it('serves only the fields the payment screen polls for', async () => {
    // `payTo`, not `merchantSnapshot`. This is the response that fires most
    // often — every few seconds while a player is on the payment screen — and
    // it used to carry the snapshot WHOLE: the merchant's UPI handle, their QR
    // image, their bank account number, IFSC and the name on it.
    //
    // The probe is a routed order, so the row really carries the merchant's
    // snapshot the poll used to leak. (It used to plant a player phone number
    // on a deposit; no buy carries one — only a sell does.)
    const { orderId, who } = await depositOrder();
    expect((await getOrderRecord(orderId)).merchantSnapshot, 'nothing on the row to leak').toBeTruthy();
    const res = await as(app, who).get(`/order/${orderId}/status`);
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(
      ['expiresAt', 'payTo', 'proofScreenshot', 'status', 'success', 'utrNumber'],
    );
  });

  // ── The proof screenshot: a consumer with no producer (§32 S4) ────────────
  // These two plant `proofScreenshot` at creation because nothing on the
  // platform writes one any more — proof COLLECTION was removed, and the
  // column, the poll's expiry and the retention job stayed "for orders that
  // already carry an image" (paymentProcessing.service.js), of which there
  // are none (§0.0). The rows are therefore not ones production can make.
  // Left as they were, not deleted: whether the column goes is a decision
  // outside Step 2c, and it is reported rather than taken here.
  it('HIDES a payment screenshot once it has expired', async () => {
    const { orderId, who } = await depositOrder({ extra: { proofScreenshot: 'https://cdn/proof.png' } });
    await setOrderFields(orderId, { proofExpiresAt: new Date(Date.now() - 1000) });
    const res = await as(app, who).get(`/order/${orderId}/status`);
    expect(res.body.proofScreenshot).toBeNull();
    // The order itself is unchanged — only what is served expires.
    expect((await getOrderRecord(orderId)).proofScreenshot).toBe('https://cdn/proof.png');
  });

  it('treats an ABSENT expiry as 48 hours from creation, not as "never"', async () => {
    // An order written before the column existed has a null expiry. On a fresh
    // order that resolves to now()+48h — so the proof is still visible, NOT
    // hidden as a missing value and NOT visible forever. The past-expiry test
    // above proves the hide path; this proves a null expiry is not treated as
    // one. (created_at is append-only and cannot be backdated through the
    // repository, which is why the 49h-old branch is left to the unit test that
    // owns the 48h arithmetic directly.)
    const { orderId, who } = await depositOrder({ extra: { proofScreenshot: 'https://cdn/proof.png' } });
    const row = await getOrderRecord(orderId);
    expect(row.proofExpiresAt ?? null, 'fixture already carried an expiry').toBeNull();
    expect((await as(app, who).get(`/order/${orderId}/status`)).body.proofScreenshot).toBe('https://cdn/proof.png');
  });

  // ── Disputes ──────────────────────────────────────────────────────────────
  it('requires a reason to raise a dispute', async () => {
    // Past the ten-minute wait, so the missing reason is the only thing that
    // can refuse it.
    const { orderId, who } = await depositOrder({ paidMinutesAgo: 11 });
    for (const body of [{}, { reason: '' }, { reason: '   ' }]) {
      const res = await as(app, who).post(`/order/${orderId}/dispute`).send(body);
      expect(res.status, `accepted ${JSON.stringify(body)}`).toBe(400);
    }
  });

  it('disputes a PAID or COMPLETED order, and nothing earlier', async () => {
    // This asserted `only dispute PAID` until 2026-09-10, which read as a
    // tightening and was the opposite: a defect that moved an order to
    // COMPLETED without paying the player ALSO removed their only recourse.
    // The full model, and who owns it, is pinned in disputeOwnershipPg.test.js.
    const early = await depositOrder({ state: 'PENDING_QUEUE' });
    const res = await as(app, early.who).post(`/order/${early.orderId}/dispute`)
      .send({ reason: 'nobody is paying me' });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/paid or completed/i);
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

    const last = (await listOrderTransitions(orderId)).at(-1);
    expect(last).toMatchObject({ fromState: 'PAID', toState: 'DISPUTED' });
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

  // ── These exercised `POST /order/:orderId/status`, which is gone ──────────
  // It was a SECOND route that raised a dispute, with a different admission
  // rule: no reason required and — the part that mattered — no ten-minute wait
  // after payment, which `/dispute` enforces so a merchant can confirm before
  // the order reaches an admin. A DISPUTED order keeps the merchant's tokens
  // reserved (§2), so the bypass let a player pay, dispute at once, and hold a
  // merchant's inventory. No panel ever called it.
  //
  // Its one guard the survivor lacked — the reason cap — moved with it, and is
  // asserted below. The rest is re-pointed at `/dispute` where it still says
  // something.
  it('refuses a dispute on an order that is not disputable', async () => {
    const { orderId, who } = await depositOrder({ state: 'PENDING_QUEUE' });
    const res = await as(app, who).post(`/order/${orderId}/dispute`).send({ reason: 'nothing arrived' });
    expect(res.status).toBe(400);
    expect((await getOrderRecord(orderId)).state).toBe('PENDING_QUEUE');
  });

  it('requires a reason — the admin queue reads it', async () => {
    const { orderId, who } = await depositOrder({ state: 'PAID', paidMinutesAgo: 11 });
    for (const reason of [undefined, '', '   ']) {
      const res = await as(app, who).post(`/order/${orderId}/dispute`).send({ reason });
      expect(res.status, `accepted reason=${JSON.stringify(reason)}`).toBe(400);
    }
    expect((await getOrderRecord(orderId)).state).toBe('PAID');
  });

  it('holds a freshly PAID order back for ten minutes, by EVERY path', async () => {
    // The wait exists so the merchant gets a chance to confirm before the order
    // reaches an admin — and a DISPUTED order keeps the merchant's tokens
    // reserved (§2), so evading it ties up their inventory on demand.
    //
    // It WAS evadable: `POST /order/:id/status` raised the same dispute with no
    // wait at all. That route is gone, and this asserts the rule against every
    // route the player has, so a third path cannot quietly reintroduce the hole.
    // `mark-paid` stamps paidAt now: a freshly PAID order.
    const { orderId, who } = await depositOrder({ state: 'PAID' });

    const res = await as(app, who).post(`/order/${orderId}/dispute`).send({ reason: 'nothing arrived' });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/10 minutes/i);
    expect((await getOrderRecord(orderId)).state).toBe('PAID');

    // And no OTHER route will do it either. Any POST under this order that
    // moves it to DISPUTED would be the bypass coming back.
    for (const path of [`/order/${orderId}/status`, `/order/${orderId}/dispute-now`]) {
      const sneak = await as(app, who).post(path).send({ status: 'DISPUTED', reason: 'let me in' });
      expect(sneak.status, `${path} answered ${sneak.status}`).not.toBe(200);
    }
    expect((await getOrderRecord(orderId)).state).toBe('PAID');
  });

  it('truncates a runaway dispute reason rather than storing it whole', async () => {
    // `dispute_reason` is TEXT, so this does not error — it stores whatever it
    // is sent, and an admin's queue renders it.
    const { orderId, who } = await depositOrder({ state: 'PAID', paidMinutesAgo: 11 });
    const res = await as(app, who).post(`/order/${orderId}/dispute`).send({ reason: 'x'.repeat(5000) });
    expect(res.status, res.body.message).toBe(200);
    expect((await getOrderRecord(orderId)).disputeReason).toHaveLength(1000);
  });
});
