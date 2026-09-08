// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * The ATM cash-link queue — supply arriving before demand.
 *
 * ── What has to be true, and why each of these is a money question ─────────
 * A link is a claim on physical notes about to come out of a machine. So:
 *
 *   • TWO ORDERS MUST NEVER TAKE ONE LINK. If they do, two players are sent to
 *     collect the same pile of cash and one of them finds an empty machine
 *     having already paid. This is asserted with REAL CONCURRENT CLAIMS, not
 *     by reading the SQL — `FOR UPDATE SKIP LOCKED` is the entire mechanism and
 *     a test that does not run it concurrently proves nothing about it.
 *
 *   • A MERCHANT MUST NEVER HOLD TWO LIVE LINKS. They are standing at one
 *     machine. A second live link is a promise they cannot keep.
 *
 *   • A CLAIM MUST BE ALL OR NOTHING. Marking the link taken and then failing
 *     to stamp the order would leave a player waiting beside a link nothing
 *     will ever hand them.
 *
 *   • A LINK WITH SECONDS LEFT MUST NOT BE HANDED OUT. Worse than no link: the
 *     player cannot reach the machine and now believes they have been served.
 *
 * In the database tier because these are properties of the table and its
 * locking, and proving them means concurrent transactions rather than routes.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pgConfigured, pgQuery, applySchema, closePg } from '../client.js';
import {
  supplyLink, claimLinkForOrder, expireDueLinks, cancelLink,
  getLiveLinkFor, getLinkForOrder, countOrdersAwaitingLink,
  demandByDenomination, supplyByDenomination,
} from '../repositories/cashLinks.js';

const describePg = pgConfigured() ? describe : describe.skip;

describePg('the ATM cash-link queue', () => {
  let seq = 0;
  const uid = (p) => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}-${seq += 1}`;
  const inMinutes = (m) => new Date(Date.now() + m * 60_000);

  // A merchant row is needed only as a foreign identity here; the queue does
  // not join it, deliberately (the denomination is copied at supply time).
  const merchant = () => uid('mch');

  const orderAt = async (denominationPaise, state = 'PENDING_QUEUE') => {
    const orderId = uid('ord');
    await pgQuery(
      `INSERT INTO order_states
         (order_id, user_id, order_type, state, token_amount_paise, payment_mode)
       VALUES ($1, 'clq-user', 'DEPOSIT', $2, $3, 'CASH_ATM')`,
      [orderId, state, denominationPaise],
    );
    return orderId;
  };

  beforeAll(async () => {
    await applySchema();
    // The queue is emptied first, and this is the one table in this tier where
    // that is the RIGHT setup rather than a shortcut.
    //
    // Every other suite here works from a baseline count, because it shares
    // tables with the rest of the platform. This table is owned entirely by
    // this feature, and the thing under test is "what is available to claim" —
    // so a live link left by an earlier run is not background noise, it is a
    // different question being answered. The first version of these assertions
    // passed and failed depending on what a previous run had left behind.
    //
    // Safe because `fileParallelism: false`: files in this tier run one at a
    // time against the shared database.
    await pgQuery('DELETE FROM cash_link_queue');
  }, 60_000);
  afterAll(async () => { await closePg(); });

  it('lets one merchant hold exactly one live link', async () => {
    const m = merchant();
    const first = await supplyLink({
      linkId: uid('lnk'), merchantId: m, denominationPaise: 500_000,
      paymentLink: 'upi://pay?am=5000', expiresAt: inMinutes(2),
    });
    expect(first.ok).toBe(true);

    const second = await supplyLink({
      linkId: uid('lnk'), merchantId: m, denominationPaise: 500_000,
      paymentLink: 'upi://pay?am=5000', expiresAt: inMinutes(2),
    });
    expect(second.ok).toBe(false);
    expect(second.reason).toBe('LINK_ALREADY_LIVE');

    // Once the first is out of the way, they may supply again.
    await cancelLink(first.link.linkId, m);
    const third = await supplyLink({
      linkId: uid('lnk'), merchantId: m, denominationPaise: 500_000,
      paymentLink: 'upi://pay?am=5000', expiresAt: inMinutes(2),
    });
    expect(third.ok).toBe(true);

    // Retired rather than left live. This tier shares one database, so a link
    // this case no longer needs is ambient supply every later case would have
    // to reason about — and it is exactly what made the cross-denomination
    // assertion below pass for the wrong reason the first time it was written.
    await cancelLink(third.link.linkId, m);
  });

  it('gives two simultaneous orders two DIFFERENT links, never the same one', async () => {
    // The assertion this whole design turns on. Run concurrently, because
    // FOR UPDATE SKIP LOCKED is the mechanism and reading the SQL proves
    // nothing about how it behaves under contention.
    const denomination = 100_000;
    const links = [];
    for (let i = 0; i < 4; i += 1) {
      const r = await supplyLink({
        linkId: uid('lnk'), merchantId: merchant(), denominationPaise: denomination,
        paymentLink: `upi://pay?am=1000&i=${i}`, expiresAt: inMinutes(5),
      });
      expect(r.ok).toBe(true);
      links.push(r.link.linkId);
    }

    const orders = await Promise.all([1, 2, 3, 4].map(() => orderAt(denomination)));
    const claims = await Promise.all(orders.map((orderId) => claimLinkForOrder({
      orderId, denominationPaise: denomination, minRemainingSeconds: 60,
    })));

    expect(claims.every((c) => c.ok)).toBe(true);
    const taken = claims.map((c) => c.link.linkId);
    // Four orders, four distinct links. Two orders sharing one would send two
    // players to the same machine for one pile of notes.
    expect(new Set(taken).size).toBe(4);
    expect(new Set(taken)).toEqual(new Set(links));
  });

  it('runs out rather than handing the same link to a fifth order', async () => {
    const denomination = 4_000_000;
    const r = await supplyLink({
      linkId: uid('lnk'), merchantId: merchant(), denominationPaise: denomination,
      paymentLink: 'upi://pay?am=40000', expiresAt: inMinutes(5),
    });
    expect(r.ok).toBe(true);

    const a = await claimLinkForOrder({
      orderId: await orderAt(denomination), denominationPaise: denomination, minRemainingSeconds: 60,
    });
    expect(a.ok).toBe(true);

    const b = await claimLinkForOrder({
      orderId: await orderAt(denomination), denominationPaise: denomination, minRemainingSeconds: 60,
    });
    expect(b.ok).toBe(false);
    expect(b.reason).toBe('NO_LINK_AVAILABLE');
  });

  it('stamps the order in the same transaction as the claim', async () => {
    const denomination = 50_000;
    const supplied = await supplyLink({
      linkId: uid('lnk'), merchantId: merchant(), denominationPaise: denomination,
      paymentLink: 'upi://pay?am=500', expiresAt: inMinutes(5),
    });
    const orderId = await orderAt(denomination);
    const claim = await claimLinkForOrder({ orderId, denominationPaise: denomination, minRemainingSeconds: 60 });
    expect(claim.ok).toBe(true);

    // Both sides agree, because both were written together.
    const { rows } = await pgQuery('SELECT cash_link_id FROM order_states WHERE order_id = $1', [orderId]);
    expect(rows[0].cash_link_id).toBe(supplied.link.linkId);
    expect((await getLinkForOrder(orderId)).linkId).toBe(supplied.link.linkId);
  });

  it('refuses to give an order a second link, and returns the first one to the queue', async () => {
    const denomination = 50_000;
    await supplyLink({
      linkId: uid('lnk'), merchantId: merchant(), denominationPaise: denomination,
      paymentLink: 'upi://pay?am=500', expiresAt: inMinutes(5),
    });
    const orderId = await orderAt(denomination);
    expect((await claimLinkForOrder({ orderId, denominationPaise: denomination, minRemainingSeconds: 60 })).ok).toBe(true);

    // A second link for the same order would send the player two places.
    const spare = await supplyLink({
      linkId: uid('lnk'), merchantId: merchant(), denominationPaise: denomination,
      paymentLink: 'upi://pay?am=500', expiresAt: inMinutes(5),
    });
    const again = await claimLinkForOrder({ orderId, denominationPaise: denomination, minRemainingSeconds: 60 });
    expect(again.ok).toBe(false);
    expect(again.reason).toBe('ORDER_ALREADY_LINKED');

    // And the rollback put the spare back: it is still LIVE and claimable.
    const other = await claimLinkForOrder({
      orderId: await orderAt(denomination), denominationPaise: denomination, minRemainingSeconds: 60,
    });
    expect(other.ok).toBe(true);
    expect(other.link.linkId).toBe(spare.link.linkId);
  });

  it('refuses to claim for an order that does not exist, and leaves the link live', async () => {
    // The double-claim case above is caught by the unique index on
    // `claimed_by_order`, so it does not exercise the row-count check at all.
    // THIS is what that check is for: an order id that matches no row.
    //
    // Without it the link is marked CLAIMED by an order nobody can look up —
    // gone from the queue forever, with the merchant's trip wasted and no
    // player served. A link silently removed from supply is the worst failure
    // this table has, because nothing looks wrong anywhere.
    const denomination = 100_000;
    const supplied = await supplyLink({
      linkId: uid('lnk'), merchantId: merchant(), denominationPaise: denomination,
      paymentLink: 'upi://pay?am=1000', expiresAt: inMinutes(5),
    });
    expect(supplied.ok).toBe(true);

    const phantom = await claimLinkForOrder({
      orderId: uid('no-such-order'), denominationPaise: denomination, minRemainingSeconds: 60,
    });
    expect(phantom.ok).toBe(false);

    // The rollback put it back: still LIVE, still claimable by a real order.
    const { rows } = await pgQuery(
      'SELECT status, claimed_by_order FROM cash_link_queue WHERE link_id = $1',
      [supplied.link.linkId],
    );
    expect(rows[0].status).toBe('LIVE');
    expect(rows[0].claimed_by_order).toBeNull();

    const real = await claimLinkForOrder({
      orderId: await orderAt(denomination), denominationPaise: denomination, minRemainingSeconds: 60,
    });
    expect(real.ok).toBe(true);
    expect(real.link.linkId).toBe(supplied.link.linkId);
  });

  it('will not hand out a link with less than the floor remaining', async () => {
    const denomination = 1_000_000;
    // Alive, but only 30 seconds left.
    await supplyLink({
      linkId: uid('lnk'), merchantId: merchant(), denominationPaise: denomination,
      paymentLink: 'upi://pay?am=10000', expiresAt: new Date(Date.now() + 30_000),
    });

    const tooLate = await claimLinkForOrder({
      orderId: await orderAt(denomination), denominationPaise: denomination, minRemainingSeconds: 60,
    });
    expect(tooLate.ok).toBe(false);
    expect(tooLate.reason).toBe('NO_LINK_AVAILABLE');

    // The same link IS claimable when the floor is lower — it is the floor
    // doing the work, not the link being broken.
    const fine = await claimLinkForOrder({
      orderId: await orderAt(denomination), denominationPaise: denomination, minRemainingSeconds: 5,
    });
    expect(fine.ok).toBe(true);
  });

  it('never crosses denominations', async () => {
    // A merchant at a machine dispensing ₹1,000 cannot serve a ₹5,000 order.
    //
    // Asserted as "the claim never returns another denomination" rather than
    // "nothing is available": this tier shares one database and never resets
    // it, so an unrelated live link of the asked-for size is a normal state of
    // the world. A test that assumed the queue was empty would pass or fail on
    // what other cases happened to leave behind — the same defect that let M98
    // survive a full-tier run earlier on this branch.
    const mine = await supplyLink({
      linkId: uid('lnk'), merchantId: merchant(), denominationPaise: 100_000,
      paymentLink: 'upi://pay?am=1000', expiresAt: inMinutes(5),
    });
    expect(mine.ok).toBe(true);

    const claim = await claimLinkForOrder({
      orderId: await orderAt(500_000), denominationPaise: 500_000, minRemainingSeconds: 60,
    });
    if (claim.ok) {
      expect(claim.link.denominationPaise).toBe(500_000);
      expect(claim.link.linkId).not.toBe(mine.link.linkId);
    } else {
      expect(claim.reason).toBe('NO_LINK_AVAILABLE');
    }

    // The ₹1,000 link is untouched, whichever branch ran.
    const { rows } = await pgQuery(
      'SELECT status, claimed_by_order FROM cash_link_queue WHERE link_id = $1',
      [mine.link.linkId],
    );
    expect(rows[0].status).toBe('LIVE');
    expect(rows[0].claimed_by_order).toBeNull();

    // Leave the queue as it was found — a live link this case does not need is
    // supply the next file would have to reason about.
    await cancelLink(mine.link.linkId, mine.link.merchantId);
  });

  it('expires what is due, idempotently, and owes the merchant nothing', async () => {
    const m = merchant();
    const stale = await supplyLink({
      linkId: uid('lnk'), merchantId: m, denominationPaise: 50_000,
      paymentLink: 'upi://pay?am=500', expiresAt: new Date(Date.now() + 500),
    });
    expect(stale.ok).toBe(true);
    await new Promise((r) => setTimeout(r, 900));

    const swept = await expireDueLinks();
    expect(swept.map((l) => l.linkId)).toContain(stale.link.linkId);

    // Running it again retires nothing a second time.
    const twice = await expireDueLinks();
    expect(twice.map((l) => l.linkId)).not.toContain(stale.link.linkId);

    // The merchant is free to supply again, and holds no credit for the trip.
    expect(await getLiveLinkFor(m)).toBeNull();
    const fresh = await supplyLink({
      linkId: uid('lnk'), merchantId: m, denominationPaise: 50_000,
      paymentLink: 'upi://pay?am=500', expiresAt: inMinutes(2),
    });
    expect(fresh.ok).toBe(true);
  });

  it('counts only orders that have no link yet, at that denomination', async () => {
    const denomination = 500_000;
    const before = await countOrdersAwaitingLink(denomination);

    await orderAt(denomination);
    await orderAt(denomination);
    expect(await countOrdersAwaitingLink(denomination)).toBe(before + 2);

    // An order that HAS a link is served, and advertising it would send a
    // merchant to an ATM for work that no longer exists.
    await supplyLink({
      linkId: uid('lnk'), merchantId: merchant(), denominationPaise: denomination,
      paymentLink: 'upi://pay?am=5000', expiresAt: inMinutes(5),
    });
    const claim = await claimLinkForOrder({
      orderId: await orderAt(denomination), denominationPaise: denomination, minRemainingSeconds: 60,
    });
    expect(claim.ok).toBe(true);
    expect(await countOrdersAwaitingLink(denomination)).toBe(before + 2);

    // An order at another denomination is another merchant's work.
    await orderAt(50_000);
    expect(await countOrdersAwaitingLink(denomination)).toBe(before + 2);
  });

  it('reports demand and supply per denomination for an admin overview', async () => {
    const demand = await demandByDenomination();
    const supply = await supplyByDenomination();
    for (const row of [...demand, ...supply]) {
      expect([50_000, 100_000, 500_000, 1_000_000, 4_000_000]).toContain(row.denominationPaise);
    }
  });

  it('refuses an empty link and one that expires in the past', async () => {
    const m = merchant();
    const empty = await supplyLink({
      linkId: uid('lnk'), merchantId: m, denominationPaise: 50_000,
      paymentLink: '   ', expiresAt: inMinutes(2),
    });
    expect(empty.ok).toBe(false);
    expect(empty.reason).toBe('LINK_REQUIRED');

    const past = await supplyLink({
      linkId: uid('lnk'), merchantId: m, denominationPaise: 50_000,
      paymentLink: 'upi://pay?am=500', expiresAt: new Date(Date.now() - 60_000),
    });
    expect(past.ok).toBe(false);
    expect(past.reason).toBe('ALREADY_EXPIRED');
  });
});
