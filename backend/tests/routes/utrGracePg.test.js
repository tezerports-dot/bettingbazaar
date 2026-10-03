// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The minute a player gets to fetch the UTR, and why it is exactly one.
 *
 * ── What this protects ─────────────────────────────────────────────────────
 * The order's own timer IS the UTR deadline. A player who taps "I have paid"
 * with fifteen seconds left cannot find a twelve-character bank reference in
 * fifteen seconds, and the order expiring under them cancels a payment they
 * have ALREADY MADE. The money is gone and the order is not — the worst
 * outcome this flow has.
 *
 * ── And why it is not more than one ────────────────────────────────────────
 * Repeatable, this stops being a courtesy and becomes an unbounded extension: a
 * player taps every fifty seconds and holds a merchant's capacity open
 * indefinitely. That is a denial of service against the merchant queue wearing
 * the shape of a kindness, so "once" is asserted as hard as the extension is.
 *
 * ── The window belongs to the admin ────────────────────────────────────────
 * `utrSubmitSeconds` sat on the admin screen — labelled "how long the player
 * has to submit the UTR after clicking Paid" — and NOTHING read it. A value an
 * operator can edit is only configuration if something consults it, so the
 * test that matters most here is the one that changes the number and watches
 * the deadline follow. It lives in `SystemConfig.teamRouting` now
 * (PROJECT_STATUS §3.10, 2c); the payment-mode policy that used to hold it is
 * gone.
 *
 * ── How the orders are made ────────────────────────────────────────────────
 * Through the real path (§32 S16): a ₹20,000 buy is a UPI order by its size and
 * is ROUTED to a member of a working UPI team, its tokens held in the team's
 * pool. Only the clock is moved — `expiresAt` is set to "a few seconds left",
 * which is the one interesting case and would otherwise take fifteen minutes
 * to reach.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pgConfigured, applySchema, closePg, pgQuery } from '#db/client.js';
import { getOrderRecord, setOrderFields } from '#db/repositories/orders.record.js';
import { getSystemConfig, applySystemConfig } from '#db/repositories/config.js';
import { routingSettings } from '#db/repositories/teamRouting.js';
import { updateUser } from '#db/repositories/users.js';
import {
  createDepositOrder, createWithdrawalOrder, cancelOrder,
} from '../../domains/payment/paymentProcessing.service.js';
import { teamFixture } from '../teamFixture.js';
import { mountRouter, actor, as } from './_harness.js';

const describePg = pgConfigured() ? describe : describe.skip;

describePg('the UTR grace', () => {
  const teams = teamFixture();
  let app;
  let team;
  let restoreWindow = null;
  const players = [];

  const player = async () => {
    const p = await actor({});
    players.push(p.userId);
    return p;
  };

  /** A buy order routed to the team and about to run out of time — the only interesting case. */
  const expiringDeposit = async (p, secondsLeft = 8) => {
    const { order } = await createDepositOrder(p.userId, 50_000);
    const orderId = order.orderId ?? order._id;
    const routed = await getOrderRecord(orderId);
    expect(routed.status, 'the buy was not routed to the team').toBe('ASSIGNED');
    expect(team.members).toContain(routed.merchantId);
    await setOrderFields(orderId, { expiresAt: new Date(Date.now() + secondsLeft * 1000) });
    return orderId;
  };

  const graceWindow = async () => routingSettings(await getSystemConfig({ fresh: true })).utrSubmitSeconds;
  const setWindow = (seconds) => applySystemConfig({ teamRouting: { utrSubmitSeconds: seconds } });

  beforeAll(async () => {
    await applySchema();
    app = mountRouter((await import('../../domains/payment/payment.routes.js')).default);
    // Ten members online, three open orders each: room for every buy here.
    team = await teams.workingTeam({ rail: 'UPI_BANK', poolTokens: 500_000 });
    restoreWindow = await graceWindow();
  }, 120_000);

  afterAll(async () => {
    // Outside any assertion (trap 10): the config row is shared by every suite.
    if (restoreWindow !== null) await setWindow(restoreWindow);
    await pgQuery('SET session_replication_role = replica');
    try {
      await pgQuery(
        'DELETE FROM order_transitions WHERE order_id IN (SELECT order_id FROM order_states WHERE user_id = ANY($1))',
        [players]);
      await pgQuery('DELETE FROM order_states WHERE user_id = ANY($1)', [players]);
    } finally {
      await pgQuery('SET session_replication_role = DEFAULT');
    }
    await teams.cleanup();
    await closePg();
  });

  it('pushes the deadline out to the admin-configured window', async () => {
    const p = await player();
    const orderId = await expiringDeposit(p, 8);
    const before = await getOrderRecord(orderId);
    const window = await graceWindow();

    const res = await as(app, p).post(`/order/${orderId}/utr-grace`).send({});
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const after = await getOrderRecord(orderId);
    const gained = (new Date(after.expiresAt) - new Date(before.expiresAt)) / 1000;
    // It moved OUT by roughly the window minus what was already left. Bounds
    // wide enough for the call's own elapsed time and far too narrow to admit
    // "did not move" or "moved by a hardcoded number".
    expect(gained).toBeGreaterThan(window - 12);
    expect(gained).toBeLessThan(window + 2);
    expect(after.utrGraceAt).toBeTruthy();
  });

  // The merchant's countdown shows this deadline too. The push went out as
  // `order_updated`, a typo variant of `order_update` that the merchant panel
  // never registered (CLAUDE.md §12), so their screen kept the old deadline.
  it('tells the assigned merchant the new deadline, under the name their panel listens for', async () => {
    const p = await player();
    const orderId = await expiringDeposit(p, 8);
    const { merchantId } = await getOrderRecord(orderId);
    const sent = [];
    const previous = global.sseManager;
    global.sseManager = { sendToMerchant: (m, event, data) => sent.push({ m, event, data }) };
    try {
      expect((await as(app, p).post(`/order/${orderId}/utr-grace`).send({})).status).toBe(200);
    } finally {
      global.sseManager = previous;
    }
    const after = await getOrderRecord(orderId);
    expect(sent.map((e) => e.event)).toEqual(['order_update']);
    expect(sent[0].m).toBe(String(merchantId));
    expect(sent[0].data.orderId).toBe(orderId);
    expect(new Date(sent[0].data.expiresAt).getTime()).toBe(new Date(after.expiresAt).getTime());
  });

  it('follows the admin when they change the window', async () => {
    // The assertion that makes `utrSubmitSeconds` configuration rather than
    // decoration. It was on the admin screen and read by nothing.
    await setWindow(300);
    expect(await graceWindow()).toBe(300);

    const p = await player();
    const orderId = await expiringDeposit(p, 5);
    const res = await as(app, p).post(`/order/${orderId}/utr-grace`).send({});
    expect(res.status).toBe(200);

    const after = await getOrderRecord(orderId);
    const left = (new Date(after.expiresAt) - Date.now()) / 1000;
    expect(left).toBeGreaterThan(280);
    expect(left).toBeLessThan(310);
  });

  it('never SHORTENS a deadline that is already further out', async () => {
    // "A full minute from the tap" would be a cut for an order with ten minutes
    // left. The deadline only ever moves outward.
    await setWindow(60);

    const p = await player();
    const orderId = await expiringDeposit(p, 600);
    const before = await getOrderRecord(orderId);

    const res = await as(app, p).post(`/order/${orderId}/utr-grace`).send({});
    expect(res.status).toBe(200);

    const after = await getOrderRecord(orderId);
    expect(new Date(after.expiresAt).getTime()).toBe(new Date(before.expiresAt).getTime());
  });

  it('is claimable ONCE — a second tap buys nothing', async () => {
    const p = await player();
    const orderId = await expiringDeposit(p, 8);

    const first = await as(app, p).post(`/order/${orderId}/utr-grace`).send({});
    expect(first.status).toBe(200);
    const afterFirst = await getOrderRecord(orderId);

    const second = await as(app, p).post(`/order/${orderId}/utr-grace`).send({});
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('GRACE_ALREADY_TAKEN');
    // Told the deadline they actually have, so the screen can correct itself
    // instead of running a countdown the server disagrees with.
    expect(second.body.expiresAt).toBeTruthy();

    // And the deadline did not move a second time. Without this, tapping every
    // fifty seconds holds a merchant's capacity open forever.
    const afterSecond = await getOrderRecord(orderId);
    expect(new Date(afterSecond.expiresAt).getTime())
      .toBe(new Date(afterFirst.expiresAt).getTime());
  });

  it('refuses two simultaneous taps, so a race cannot extend twice', async () => {
    const p = await player();
    const orderId = await expiringDeposit(p, 8);

    // The decision and the write are one statement, which is what makes this
    // safe. A check followed by an update would let both of these through.
    const [a, b] = await Promise.all([
      as(app, p).post(`/order/${orderId}/utr-grace`).send({}),
      as(app, p).post(`/order/${orderId}/utr-grace`).send({}),
    ]);
    const codes = [a.status, b.status].sort();
    expect(codes).toEqual([200, 409]);
  });

  it('will not extend somebody else\'s order', async () => {
    const owner = await player();
    const stranger = await player();
    const orderId = await expiringDeposit(owner, 8);

    const res = await as(app, stranger).post(`/order/${orderId}/utr-grace`).send({});
    expect([403, 404]).toContain(res.status);
    expect((await getOrderRecord(orderId)).utrGraceAt).toBeNull();
  });

  it('refuses an order that is no longer waiting for a reference', async () => {
    // Nobody online, so the buy waits in the queue — the one state a player
    // can cancel from — and the player cancels it.
    await teams.onlyOnline([]);
    let orderId;
    const p = await player();
    try {
      const { order } = await createDepositOrder(p.userId, 50_000);
      orderId = order.orderId ?? order._id;
      expect((await getOrderRecord(orderId)).status).toBe('PENDING_QUEUE');
      await cancelOrder(p.userId, false, orderId);
    } finally {
      await teams.onlyOnline(team.members);
    }
    expect((await getOrderRecord(orderId)).status).toBe('CANCELLED');

    const res = await as(app, p).post(`/order/${orderId}/utr-grace`).send({});
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('NOT_AWAITING_UTR');
    expect((await getOrderRecord(orderId)).utrGraceAt).toBeNull();
  });

  it('refuses a withdrawal — nobody submits a UTR for a payout', async () => {
    const p = await player();
    await updateUser(p.userId, {
      bankDetails: {
        accountNumber: '000111222333', ifscCode: 'HDFC0000001',
        bankName: 'HDFC Bank', accountHolderName: 'Test Player',
      },
    });
    const { creditWinnings } = await import('../../domains/wallet/walletAuthority.service.js');
    await creditWinnings(p.userId, 50_000, 'UTR grace suite seed', 'Test',
      `seed_${p.userId}`, `grace_seed_${p.userId}`);
    const { order } = await createWithdrawalOrder(p.userId, 50_000);
    const orderId = order.orderId ?? order._id;
    const before = await getOrderRecord(orderId);
    expect(before.type).toBe('WITHDRAWAL');

    const res = await as(app, p).post(`/order/${orderId}/utr-grace`).send({});
    expect(res.status).toBe(400);
    const after = await getOrderRecord(orderId);
    expect(after.utrGraceAt).toBeNull();
    expect(new Date(after.expiresAt ?? 0).getTime()).toBe(new Date(before.expiresAt ?? 0).getTime());
  });
});
