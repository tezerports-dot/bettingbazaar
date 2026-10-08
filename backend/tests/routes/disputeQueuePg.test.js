// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The Dispute Manager's queue: what each filter lists, and how many there are.
 *
 * ── The defect this holds ─────────────────────────────────────────────────
 * The screen kept its own list of filters: "all", "DISPUTED", "RESOLVED",
 * "ESCALATED", and opened on "all". `disputeQueue` widened only on 'ALL' and
 * otherwise asked for `o.state = <the filter>`, so the screen's default view
 * asked for orders in state 'all' and listed none, and "Resolved" and
 * "Escalated" asked for states no order can be in (the `order_states.state`
 * CHECK). Only "Open" ever listed a dispute. Found by `test:mutate`'s
 * `admin/disputes` cases, which pressed the screen and found every dispute
 * missing until the filter was changed by hand.
 *
 * INVARIANT: the screen and the queue speak ONE vocabulary, owned by the
 * queue (`DISPUTE_FILTERS`, orders.record.js) and sent with every answer;
 * every filter it offers selects rows an order can actually be, and a filter
 * it does not offer is refused by name rather than read as a state.
 *
 * And the count: the page and its total come from one statement, but the total
 * was read off the page's own rows, so a page past the end reported "0
 * disputes" while there were some (S47). The total is now counted apart from
 * the page, in the same statement.
 *
 * The disputes are real ones (§32 S16): a buy routed to a member of a working
 * team, accepted, paid with a reference and disputed on the player's route.
 * Only the clock is moved, past the ten minutes a player must wait.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pgConfigured, applySchema, closePg, pgQuery, withTransaction } from '#db/client.js';
import { createOrderRecord, disputeQueue } from '#db/repositories/orders.record.js';
import { tryAssignMerchant, markOrderPaid } from '../../domains/payment/paymentProcessing.service.js';
import { teamFixture, readyToPay } from '../teamFixture.js';
import { mountRouter, actor, merchantActor, as } from './_harness.js';

const describePg = pgConfigured() ? describe : describe.skip;
const TOKENS = 20_000;

describePg('the dispute queue speaks one vocabulary with its screen', () => {
  let playerApp; let disputeApp; let pccApp;
  let admin;
  let seq = 0;
  const teams = teamFixture();
  const made = [];
  const oid = () => `dq-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}-${seq += 1}`;
  const nextUtr = () => String(470000000000 + (seq * 7919) + Math.floor(Math.random() * 7000));
  /** The orders this file made, by what was done to them. */
  const o = {};

  /** A buy the member accepted and the player marked paid. */
  const paidBuy = async () => {
    const member = await merchantActor();
    await teams.workingTeam({ rail: 'UPI_BANK', poolTokens: 50_000, include: [member.merchantId] });
    const player = await actor({});
    const orderId = oid(); made.push(orderId);
    const order = await createOrderRecord({
      orderId, userId: player.userId, type: 'DEPOSIT', tokenAmountRupees: TOKENS, fiatAmountRupees: TOKENS,
      depositAllocation: TOKENS, reserveAllocation: 0,
    });
    expect(await tryAssignMerchant(order)).toBe(true);
    await readyToPay(orderId);
    expect((await markOrderPaid(player.userId, orderId, nextUtr())).status).toBe('PAID');
    return { member, player, orderId };
  };
  /** …and, ten minutes on, disputed by the player. */
  const disputedBuy = async () => {
    const buy = await paidBuy();
    await pgQuery(`UPDATE order_states SET paid_at = now() - interval '11 minutes' WHERE order_id = $1`, [buy.orderId]);
    const res = await as(playerApp, buy.player).post(`/order/${buy.orderId}/dispute`).send({ reason: 'I paid; nothing was credited' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return buy;
  };

  const list = (query = '') => as(disputeApp, admin).get(`/dispute-orders${query}`);
  const idsUnder = async (filter) => {
    const res = await list(`?filter=${filter}&limit=200`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return new Set(res.body.disputes.map((d) => d.orderId));
  };

  beforeAll(async () => {
    await applySchema();
    playerApp = mountRouter((await import('../../domains/payment/payment.routes.js')).default);
    disputeApp = mountRouter((await import('../../domains/disputes/disputeResolution.admin.routes.js')).default);
    pccApp = mountRouter((await import('../../domains/payment/paymentOrder.routes.js')).default);
    admin = await actor({ isAdmin: true });

    o.open = await disputedBuy();
    o.escalated = await disputedBuy();
    expect((await as(disputeApp, admin).post(`/dispute-orders/${o.escalated.orderId}/escalate`)
      .send({ notes: 'needs a senior look' })).status).toBe(200);
    // Decided on the Dispute Manager's own route…
    o.decided = await disputedBuy();
    expect((await as(disputeApp, admin).post(`/dispute-orders/${o.decided.orderId}/resolve`)
      .send({ decision: 'RELEASE_TO_MERCHANT', resolution: 'no credit on the statement' })).status).toBe(200);
    // …and on the payment-order route, which writes the same decision columns.
    o.refunded = await disputedBuy();
    expect((await as(pccApp, admin).post(`/payment-orders/${o.refunded.orderId}/resolve`)
      .send({ resolution: 'refund', reason: 'no credit on the statement' })).status).toBe(200);
    // …and cancelled from the Payment Control Center's action buttons, which
    // close the dispute and record NO decision: "Closed" is the order's state
    // having left DISPUTED, not a decision on the row.
    o.cancelled = await disputedBuy();
    expect((await as(pccApp, admin).post(`/payment-orders/${o.cancelled.orderId}/action`)
      .send({ action: 'CANCEL', reason: 'player withdrew the claim' })).status).toBe(200);
    // A paid buy nobody disputed: in no filter at all.
    o.undisputed = await paidBuy();
  }, 180_000);

  afterAll(async () => {
    await withTransaction(async (c) => {
      await c.query('SET LOCAL session_replication_role = replica');
      await c.query('DELETE FROM dispute_faults WHERE order_id = ANY($1)', [made]);
      await c.query('DELETE FROM order_transitions WHERE order_id = ANY($1)', [made]);
      await c.query('DELETE FROM order_states WHERE order_id = ANY($1)', [made]);
    });
    await teams.cleanup();
    await closePg();
  });

  it('opens on the open disputes, and says which filter it applied and which it offers', async () => {
    // The screen sends no filter on arrival and shows whatever the server
    // applied — so its first view can never ask for something unknown.
    const res = await list('?limit=200');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.filter).toBe('OPEN');
    expect(res.body.filters.map((f) => f.key)).toEqual(['OPEN', 'ESCALATED', 'CLOSED', 'ALL']);
    for (const f of res.body.filters) expect(typeof f.label === 'string' && f.label.length > 0).toBe(true);
    const ids = res.body.disputes.map((d) => d.orderId);
    expect(ids).toContain(o.open.orderId);
    expect(ids).toContain(o.escalated.orderId);
  });

  it('every filter it offers answers, and lists what its name says', async () => {
    const { body } = await list();
    const want = {
      OPEN:      [o.open, o.escalated],
      ESCALATED: [o.escalated],
      CLOSED:    [o.decided, o.refunded, o.cancelled],
      ALL:       [o.open, o.escalated, o.decided, o.refunded, o.cancelled],
    };
    expect(Object.keys(want).sort()).toEqual(body.filters.map((f) => f.key).sort());
    for (const { key } of body.filters) {
      const ids = await idsUnder(key);
      for (const buy of Object.values(o)) {
        const expected = want[key].includes(buy);
        expect(ids.has(buy.orderId), `${key} ${expected ? 'should' : 'should not'} list ${buy.orderId}`).toBe(expected);
      }
    }
  });

  it('a decided dispute carries its decision and when it was decided', async () => {
    const res = await list('?filter=CLOSED&limit=200');
    const decided = res.body.disputes.find((d) => d.orderId === o.decided.orderId);
    expect(decided).toMatchObject({ status: 'CANCELLED', disputeDecision: 'RELEASE_TO_MERCHANT' });
    expect(decided.resolvedAt).toBeTruthy();
    const refunded = res.body.disputes.find((d) => d.orderId === o.refunded.orderId);
    expect(refunded).toMatchObject({ status: 'CANCELLED', disputeDecision: 'CANCEL_ORDER' });
  });

  it('the dispute the Resolve tab opens is the queue\'s own view of it', async () => {
    // The screen replaces the card's row with this answer when it opens the
    // dialog. It was the raw order — no `suspendsIfTo…`, parties under other
    // keys — so the Resolve tab told the admin "Nobody is suspended by this
    // decision" on a dispute where the member would be, and named nobody.
    const row = (await list('?limit=200')).body.disputes.find((d) => d.orderId === o.open.orderId);
    const res = await as(disputeApp, admin).get(`/dispute-orders/${o.open.orderId}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.dispute).toEqual(row);
    expect(res.body.dispute).toMatchObject({ suspendsIfToUser: 'MERCHANT', suspendsIfToMerchant: 'PLAYER' });
    expect(res.body.dispute.merchantId.name).toBeTruthy();
    expect(res.body.dispute.userId.username).toBeTruthy();
  });

  it('a filter it does not offer is refused by name, with the ones it does', async () => {
    // 'all' is what the screen used to send; 'RESOLVED' and 'DISPUTED' are
    // its other words. None is read as an order state any more.
    for (const bad of ['all', 'RESOLVED', 'DISPUTED', 'COMPLETED']) {
      const res = await list(`?filter=${bad}`);
      expect(res.status, `${bad}: ${JSON.stringify(res.body)}`).toBe(400);
      expect(res.body.code).toBe('UNKNOWN_DISPUTE_FILTER');
      for (const key of ['OPEN', 'ESCALATED', 'CLOSED', 'ALL']) expect(res.body.message).toContain(key);
    }
    // The repository refuses it too, with a status a route passes on (§32 S35).
    await expect(disputeQueue({ filter: 'all' })).rejects.toMatchObject({ status: 400, code: 'UNKNOWN_DISPUTE_FILTER' });
  });

  it('the total counts every match, whatever page is asked for', async () => {
    // Read off the page's own rows, a page past the end said there were none.
    const past = await list('?filter=OPEN&limit=1&page=100000');
    expect(past.status).toBe(200);
    expect(past.body.disputes).toEqual([]);
    expect(past.body.total).toBeGreaterThanOrEqual(2);
    expect(past.body.pages).toBe(past.body.total);

    // Consecutive pages never hand back the same dispute twice (the order
    // has a tiebreak, so two disputes raised in one instant still page apart).
    const p1 = (await list('?filter=OPEN&limit=1&page=1')).body.disputes[0]?.orderId;
    const p2 = (await list('?filter=OPEN&limit=1&page=2')).body.disputes[0]?.orderId;
    expect(p1).toBeTruthy();
    expect(p2).toBeTruthy();
    expect(p1).not.toBe(p2);
  });
});
