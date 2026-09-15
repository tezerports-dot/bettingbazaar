// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Supplying an ATM link, from the merchant's side.
 *
 * ── What the client is NOT allowed to decide ───────────────────────────────
 * A merchant sends the link and nothing else. The amount comes from their
 * approval and the lifetime from the policy, because a client that supplies its
 * own denomination can claim to serve ₹10,000 orders from a ₹500 machine, and a
 * client that supplies its own expiry can keep a link alive indefinitely.
 * Asserted here rather than assumed: both are trivially forgeable if the
 * handler ever starts reading them off the body.
 *
 * ── Why `worthGoing` matters enough to test ────────────────────────────────
 * An expired link earns a merchant nothing — no compensation, no priority.
 * That puts the whole weight of "do not waste a merchant's trip" on this
 * figure. A merchant without the tokens to serve an order must not be told to
 * go: on this rail a buy means they receive cash and give TOKENS.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pgConfigured, applySchema, closePg } from '#db/client.js';
import { updateMerchant } from '#db/repositories/merchants.js';
import { createOrderRecord } from '#db/repositories/orders.record.js';
import { cancelOrder } from '#db/repositories/orders.core.js';
import {
  PAYMENT_MODES, getActivePolicy, publishPolicyVersion,
} from '#db/repositories/paymentModePolicy.js';
import { getLiveLinkFor } from '#db/repositories/cashLinks.js';
import { mountRouter, merchantActor, as, request } from './_harness.js';

const describePg = pgConfigured() ? describe : describe.skip;

describePg('a merchant supplying an ATM cash link', () => {
  let app;
  let seq = 0;
  let restore = null;
  const oid = () => `clr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}-${seq += 1}`;

  // ── ₹40,000, and the reason it is not ₹5,000 ──────────────────────────
  // These tests are about SUPPLY mechanics — the denomination the server picks,
  // the lifetime it sets, who may cancel a link — and every one of them needs
  // the link it supplied to still be there when it looks.
  //
  // Supplying now hands the link straight to any buy order waiting at that
  // denomination, which is the whole point of the matcher. In a shared test
  // database there is nearly always one, so at ₹5,000 these links were being
  // claimed out from under their own assertions.
  //
  // ₹40,000 is a WITHDRAWAL tier: the INR buy ceiling is ₹10,000, so no buy
  // order can ever exist at it and no matcher can ever take one of these links.
  // That is a property of the denomination ladder, not a quiet hour.
  const DENOMINATION = 4_000_000; // ₹40,000 — withdrawal-only, so never claimed

  const cashMerchant = async ({ tokensRupees = 50_000, denominationPaise = DENOMINATION } = {}) => {
    const m = await merchantActor({ tokensRupees });
    await updateMerchant(m.merchantId, {
      cashDenominationPaise: denominationPaise, isOnline: true,
    });
    return m;
  };

  // Through the repository, not raw SQL: the route tier does not reach past
  // #db, and the suite has already put the platform on the cash rail so the
  // order is stamped CASH_ATM by the same stamp production uses.
  //
  // Every one is CANCELLED in `afterAll`, and that is not tidiness.
  //
  // These rows are buy orders waiting at DENOMINATION, which is exactly what
  // claims a link the moment it is supplied. Left in PENDING_QUEUE they stay in
  // the shared database as candidates for the NEXT run of this same file, where
  // the three supply-mechanics tests above create a link and then look for it.
  //
  // The DENOMINATION comment above reasons that no buy order can exist at
  // ₹40,000, because the INR buy ceiling is ₹10,000. That is true of
  // PRODUCTION, and the defence still holds against every other suite. It
  // cannot hold against this one, which creates those very orders through the
  // repository, beneath the route that enforces the ceiling. Trap 10: create
  // your own rows — and then put them back.
  //
  // ── What is established, and what is not ───────────────────────────────
  // These three tests DID fail together on a long-lived local database
  // (`getLiveLinkFor` null; a second supply answering ALREADY_SERVING instead
  // of LINK_ALREADY_LIVE) while passing 9/9 on a fresh one, so the cause was
  // accumulated state and not the product. Orders left by an earlier run were
  // observed being ASSIGNED to a later run's merchants, which is the mechanism.
  //
  // But removing this teardown and re-running on a fresh database does NOT
  // reproduce the failure — six consecutive runs stayed green, with the
  // PENDING_QUEUE leftovers sitting at a steady three rather than accumulating.
  // So this cleanup removes a real contamination source and the suite is green
  // with it; it is not proven to be the whole cause of the flake. Do not read
  // its presence as a closed case. If these three fail again, the first thing
  // to look at is what else is holding cash buy orders at DENOMINATION.
  const created = [];
  const waitingOrder = async (paise = DENOMINATION) => {
    const orderId = oid();
    await createOrderRecord({
      orderId, userId: 'clr-user', type: 'DEPOSIT',
      tokenAmountRupees: paise / 100, fiatAmountRupees: paise / 100,
    });
    created.push(orderId);
    return orderId;
  };

  beforeAll(async () => {
    await applySchema();
    app = mountRouter((await import('../../domains/merchant/merchant.routes.js')).default);
    restore = await getActivePolicy();
    // These routes only work on the cash rail, so the suite puts the platform
    // there and hands it back exactly as it found it.
    await publishPolicyVersion({
      activeMode: PAYMENT_MODES.CASH_ATM,
      justification: 'Cash-link route suite.', changedByName: 'test setup',
    });
  }, 60_000);

  afterAll(async () => {
    // Before the rail goes back, and outside any assertion — a cleanup that only
    // runs when the suite passed is the one that matters least (trap 10).
    for (const orderId of created) {
      await cancelOrder({ orderId, actor: 'test-cleanup', reason: 'cash-link suite teardown' }).catch(() => {});
    }
    if (restore) {
      await publishPolicyVersion({
        activeMode: restore.activeMode,
        justification: 'Restoring the rail this suite found in force.',
        changedByName: 'test teardown',
      });
    }
    await closePg();
  });

  it('supplies a link at the merchant\'s OWN denomination, whatever the body claims', async () => {
    const m = await cashMerchant();
    const res = await as(app, m).post('/cash-links').send({
      paymentLink: 'upi://pay?pa=atm&am=5000',
      // Both ignored. A client deciding either of these decides how much cash
      // it is promising and for how long.
      denominationPaise: 4_000_000,
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    expect(res.status).toBe(200);

    const stored = await getLiveLinkFor(m.merchantId);
    expect(stored.denominationPaise).toBe(DENOMINATION);

    // The lifetime is the policy's, measured in minutes not a day.
    const policy = await getActivePolicy();
    const lifetimeSeconds = (new Date(stored.expiresAt).getTime() - Date.now()) / 1000;
    expect(lifetimeSeconds).toBeLessThanOrEqual(policy.linkExpirySeconds + 5);
    expect(lifetimeSeconds).toBeGreaterThan(0);
  });

  it('refuses a second live link, and lets them supply again once it is cancelled', async () => {
    const m = await cashMerchant();
    const first = await as(app, m).post('/cash-links').send({ paymentLink: 'upi://pay?pa=atm&am=5000' });
    expect(first.status).toBe(200);

    const second = await as(app, m).post('/cash-links').send({ paymentLink: 'upi://pay?pa=atm&am=5000' });
    expect(second.status).toBe(409);
    expect(second.body.reason).toBe('LINK_ALREADY_LIVE');

    const cancelled = await as(app, m).delete(`/cash-links/${first.body.link.linkId}`);
    expect(cancelled.status).toBe(200);

    const third = await as(app, m).post('/cash-links').send({ paymentLink: 'upi://pay?pa=atm&am=5000' });
    expect(third.status).toBe(200);
  });

  it('refuses a merchant who is not approved for the cash rail', async () => {
    const m = await merchantActor({ tokensRupees: 50_000 });
    await updateMerchant(m.merchantId, { cashDenominationPaise: null, isOnline: true });

    const res = await as(app, m).post('/cash-links').send({ paymentLink: 'upi://pay?pa=atm&am=5000' });
    expect(res.status).toBe(400);
    expect(res.body.reason).toBe('NOT_APPROVED_FOR_CASH');

    // And their screen says so plainly rather than showing an empty queue,
    // which would be indistinguishable from "no work right now".
    const view = await as(app, m).get('/cash-links/current');
    expect(view.status).toBe(200);
    expect(view.body.approved).toBe(false);
  });

  it('will not let one merchant cancel another\'s link', async () => {
    const owner = await cashMerchant();
    const other = await cashMerchant();
    const supplied = await as(app, owner).post('/cash-links').send({ paymentLink: 'upi://pay?pa=atm&am=5000' });
    expect(supplied.status).toBe(200);

    const stolen = await as(app, other).delete(`/cash-links/${supplied.body.link.linkId}`);
    expect(stolen.status).toBe(404);

    // Untouched: still the owner's, still live.
    expect((await getLiveLinkFor(owner.merchantId)).linkId).toBe(supplied.body.link.linkId);
  });

  it('shows a merchant only their own denomination\'s demand', async () => {
    const m = await cashMerchant();
    const before = (await as(app, m).get('/cash-links/current')).body.waiting;

    await waitingOrder(DENOMINATION);
    await waitingOrder(DENOMINATION);
    // Another denomination is another merchant's work entirely.
    await waitingOrder(50_000);

    const view = await as(app, m).get('/cash-links/current');
    expect(view.body.denominationPaise).toBe(DENOMINATION);
    expect(view.body.waiting).toBe(before + 2);
  });

  it('does not tell a merchant to go to an ATM when they cannot serve the order', async () => {
    // On this rail a buy means the merchant receives cash and gives TOKENS.
    // Without the tokens the trip is wasted, and a wasted trip earns nothing.
    const broke = await cashMerchant({ tokensRupees: 0 });
    await waitingOrder(DENOMINATION);

    const view = await as(app, broke).get('/cash-links/current');
    expect(view.body.waiting).toBeGreaterThan(0);
    expect(view.body.worthGoing).toBe(false);

    const funded = await cashMerchant({ tokensRupees: 50_000 });
    const fundedView = await as(app, funded).get('/cash-links/current');
    expect(fundedView.body.waiting).toBeGreaterThan(0);
    expect(fundedView.body.worthGoing).toBe(true);
  });

  it('refuses a link that is not a payment, and one that names no payee', async () => {
    // The link is handed to a waiting player as WHERE TO PAY, and it used to be
    // stored raw — any string at all reached their screen. Two refusals, both
    // by name, because a merchant standing at a machine has to know what to fix:
    //
    //   not a UPI intent  — an http link to a page the merchant controls would
    //                       otherwise be shown to the player as a payment
    //   no `pa=` payee    — a UPI intent naming nobody cannot be paid by
    //                       anyone, and the player is at a machine on a
    //                       two-minute window
    //
    // The fixtures elsewhere in this file carry `pa=atm` for the same reason:
    // an intent without one is not a link any ATM produces.
    const m = await cashMerchant();

    const notAPayment = await as(app, m).post('/cash-links')
      .send({ paymentLink: 'https://merchant-controlled.example/pay' });
    expect(notAPayment.status).toBe(400);
    expect(notAPayment.body.reason).toBe('INVALID_LINK');
    expect(notAPayment.body.message).toMatch(/UPI/);

    const noPayee = await as(app, m).post('/cash-links')
      .send({ paymentLink: 'upi://pay?am=5000' });
    expect(noPayee.status).toBe(400);
    expect(noPayee.body.reason).toBe('INVALID_LINK');
    expect(noPayee.body.message).toMatch(/payee/);

    // Neither attempt may leave a link behind for a player to be handed.
    expect(await getLiveLinkFor(m.merchantId)).toBeNull();
  });

  it('refuses an empty link, and refuses anyone without a merchant token', async () => {
    const m = await cashMerchant();
    const empty = await as(app, m).post('/cash-links').send({ paymentLink: '   ' });
    expect(empty.status).toBe(400);
    expect(empty.body.reason).toBe('LINK_REQUIRED');

    const anon = await request(app).post('/cash-links').send({ paymentLink: 'upi://pay?pa=atm&am=5000' });
    expect([401, 403]).toContain(anon.status);
  });

  it('refuses to take a link at all while the platform is on the UPI rail', async () => {
    const m = await cashMerchant();
    await publishPolicyVersion({
      activeMode: PAYMENT_MODES.P2P_UPI,
      justification: 'Back to UPI mid-suite.', changedByName: 'test',
    });

    const res = await as(app, m).post('/cash-links').send({ paymentLink: 'upi://pay?pa=atm&am=5000' });
    expect(res.status).toBe(400);
    expect(res.body.reason).toBe('WRONG_RAIL');

    await publishPolicyVersion({
      activeMode: PAYMENT_MODES.CASH_ATM,
      justification: 'Restoring the cash rail for the rest of the suite.', changedByName: 'test',
    });
  });
});
