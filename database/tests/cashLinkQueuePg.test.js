// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
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
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
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

  /**
   * A REAL, eligible merchant row.
   *
   * This used to be `uid('mch')` — a bare string — under the comment "the queue
   * does not join it, deliberately". That deliberate non-join WAS the gap: a
   * link is supplied minutes before it is claimed, and nothing re-checked who
   * its merchant had become in between. An admin could block a merchant, or the
   * refusal cap suspend one, and orders kept reaching them through a link they
   * had left behind.
   *
   * The claim joins `merchants` now, so the fixture has to be a merchant rather
   * than an identity — aligned to the invariant rather than the invariant
   * relaxed to the fixture. Every field set here is one the claim query reads,
   * which is also what makes the eligibility tests below able to turn each of
   * them off in turn.
   */
  const merchant = async ({ denominationPaise = 100_000, ...overrides } = {}) => {
    const merchantId = uid('mch');
    await pgQuery(
      `INSERT INTO merchants
         (merchant_id, name, public_ref, mobile, status, merchant_approval_status,
          is_online, accepts_deposits, accepted_currencies, cash_denomination_paise,
          max_concurrent_orders, max_concurrent_deposit_orders)
       VALUES ($1, 'CLQ merchant', $2, $3, 'ACTIVE', 'APPROVED',
               TRUE, TRUE, ARRAY['INR'], $4, 5, 5)`,
      [merchantId, `CLQ${seq}${Math.random().toString(36).slice(2, 6)}`.toUpperCase(),
        `9${String(seq).padStart(4, '0')}${String(Date.now()).slice(-5)}`.slice(0, 10), denominationPaise],
      'clq_test_merchant',
    );
    if (Object.keys(overrides).length) {
      const sets = Object.keys(overrides).map((k, i) => `${k} = $${i + 2}`).join(', ');
      await pgQuery(
        `UPDATE merchants SET ${sets} WHERE merchant_id = $1`,
        [merchantId, ...Object.values(overrides)], 'clq_test_merchant_patch',
      );
    }
    return merchantId;
  };

  // `userId` is a parameter because the refusal bar is a PAIR — a merchant who
  // refused this player must not be given their next order either — and that
  // cannot be tested with every order belonging to the same person.
  const orderAt = async (denominationPaise, state = 'PENDING_QUEUE', userId = 'clq-user') => {
    const orderId = uid('ord');
    await pgQuery(
      `INSERT INTO order_states
         (order_id, user_id, order_type, state, token_amount_paise, payment_mode)
       VALUES ($1, $4, 'DEPOSIT', $2, $3, 'CASH_ATM')`,
      [orderId, state, denominationPaise, userId],
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
    const m = await merchant({ denominationPaise: 500_000 });
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
    // The assertion this whole design turns on, run concurrently because
    // reading the SQL proves nothing about behaviour under contention.
    //
    // Note what it does and does not pin down: it proves the row LOCK, since
    // without `FOR UPDATE` two claimants read and write the same link. It does
    // NOT distinguish `SKIP LOCKED`, because PostgreSQL re-qualifies a blocked
    // row and moves to the next one, so the outcome is identical either way.
    // SKIP LOCKED is here for contention, not correctness.
    const denomination = 100_000;
    const links = [];
    for (let i = 0; i < 4; i += 1) {
      const r = await supplyLink({
        linkId: uid('lnk'), merchantId: await merchant({ denominationPaise: denomination }), denominationPaise: denomination,
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
      linkId: uid('lnk'), merchantId: await merchant({ denominationPaise: denomination }), denominationPaise: denomination,
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
      linkId: uid('lnk'), merchantId: await merchant({ denominationPaise: denomination }), denominationPaise: denomination,
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
      linkId: uid('lnk'), merchantId: await merchant({ denominationPaise: denomination }), denominationPaise: denomination,
      paymentLink: 'upi://pay?am=500', expiresAt: inMinutes(5),
    });
    const orderId = await orderAt(denomination);
    expect((await claimLinkForOrder({ orderId, denominationPaise: denomination, minRemainingSeconds: 60 })).ok).toBe(true);

    // A second link for the same order would send the player two places.
    const spare = await supplyLink({
      linkId: uid('lnk'), merchantId: await merchant({ denominationPaise: denomination }), denominationPaise: denomination,
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
      linkId: uid('lnk'), merchantId: await merchant({ denominationPaise: denomination }), denominationPaise: denomination,
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
      linkId: uid('lnk'), merchantId: await merchant({ denominationPaise: denomination }), denominationPaise: denomination,
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
      linkId: uid('lnk'), merchantId: await merchant({ denominationPaise: 100_000 }), denominationPaise: 100_000,
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

    // ── And the other direction, which is the dangerous one ────────────────
    // A LARGER link must not serve a smaller order either. A merchant standing
    // at a machine dispensing ₹40,000 cannot hand over ₹5,000: the notes come
    // out in one amount. A relation like ">= the order" would look reasonable
    // and quietly promise a player four times what they paid for.
    const big = await supplyLink({
      linkId: uid('lnk'), merchantId: await merchant({ denominationPaise: 4_000_000 }), denominationPaise: 4_000_000,
      paymentLink: 'upi://pay?am=40000', expiresAt: inMinutes(1),
    });
    expect(big.ok).toBe(true);

    const small = await claimLinkForOrder({
      orderId: await orderAt(500_000), denominationPaise: 500_000, minRemainingSeconds: 30,
    });
    if (small.ok) {
      expect(small.link.denominationPaise).toBe(500_000);
      expect(small.link.linkId).not.toBe(big.link.linkId);
    } else {
      expect(small.reason).toBe('NO_LINK_AVAILABLE');
    }
    const { rows: bigRow } = await pgQuery(
      'SELECT status FROM cash_link_queue WHERE link_id = $1', [big.link.linkId],
    );
    expect(bigRow[0].status).toBe('LIVE');
    await cancelLink(big.link.linkId, big.link.merchantId);

    // Leave the queue as it was found — a live link this case does not need is
    // supply the next file would have to reason about.
    await cancelLink(mine.link.linkId, mine.link.merchantId);
  });

  it('expires what is due, idempotently, and owes the merchant nothing', async () => {
    const m = await merchant({ denominationPaise: 50_000 });
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

  /**
   * ── Who the link's merchant must still BE, at claim time ──────────────────
   *
   * A link is supplied minutes before it is claimed, and this query used to
   * match on denomination, LIVE and expiry alone — it did not join `merchants`
   * at all, under a comment saying so deliberately. So everything that can stop
   * a merchant serving stopped nothing here: an admin blocking them, the
   * consecutive-refusal cap suspending them, going offline, turning buys off,
   * filling up with other orders, or having refused this very player before.
   *
   * The UPI rail enforced every one of these in `assignmentCandidates` the whole
   * time. Two paths to the same decision, one of them with none of the rules —
   * the §5 shape, and the reason each is asserted separately below rather than
   * as one "ineligible merchant" case: a single test would pass while five of
   * the six predicates were missing.
   */
  describe('the merchant must still be eligible when the link is CLAIMED', () => {
    const DEN = 100_000;

    // Each case supplies ONE link and asserts it is refused. Earlier tests in
    // this file leave LIVE links at the same tier behind, and the claim would
    // happily take one of THOSE and report success — the assertion would fail
    // while the predicate under test was working perfectly. The queue is
    // emptied first so the only link that can be claimed is the one the case
    // made (trap 10, inside a single file).
    beforeEach(async () => {
      await pgQuery("DELETE FROM cash_link_queue WHERE status = 'LIVE'", [], 'clq_test_clear');
    });

    const linkFrom = async (merchantId) => {
      const supplied = await supplyLink({
        linkId: uid('lnk'), merchantId, denominationPaise: DEN,
        paymentLink: 'upi://pay?am=1000', expiresAt: inMinutes(5),
      });
      expect(supplied.ok, 'the link was not supplied — the test proves nothing').toBe(true);
      return supplied;
    };

    const claim = (orderId, userId = 'clq-user') => claimLinkForOrder({
      orderId, denominationPaise: DEN, minRemainingSeconds: 30,
      userId, currency: 'INR', maxDepositOrders: 1, maxTotalOrders: 1,
    });

    it('claims normally while the merchant is eligible — the control', async () => {
      // Without this, every case below could pass because the fixture never
      // produced a claimable link at all.
      const m = await merchant({ denominationPaise: DEN });
      await linkFrom(m);
      expect((await claim(await orderAt(DEN))).ok).toBe(true);
    });

    // The statuses are the ones `merchants_status_known` actually allows —
    // ACTIVE, SUSPENDED, INACTIVE, PENDING, REJECTED. There is no BLOCKED on a
    // merchant; that value belongs to `users`. A first draft of this table used
    // it and the UPDATE was refused by the CHECK, which is the database being
    // right about a vocabulary the test had invented.
    //
    // SUSPENDED carries its reason in the same statement, because
    // `merchants_suspension_reason_present` refuses a suspension nobody can
    // explain — a merchant cannot be stopped without an appealable cause.
    it.each([
      ['suspended by an admin',        { status: "'SUSPENDED'", suspension_reason: "'admin action'" }],
      ['deactivated by an admin',      { status: "'INACTIVE'" }],
      ['rejected',                     { status: "'REJECTED'" }],
      ['approval withdrawn',           { merchant_approval_status: "'SUSPENDED'" }],
      ['gone offline',                 { is_online: 'FALSE' }],
      ['stopped accepting buy orders', { accepts_deposits: 'FALSE' }],
      ['moved to another tier',        { cash_denomination_paise: '50000' }],
    ])('refuses the link of a merchant %s', async (_label, patch) => {
      const m = await merchant({ denominationPaise: DEN });
      await linkFrom(m);
      const sets = Object.entries(patch).map(([c, v]) => `${c} = ${v}`).join(', ');
      await pgQuery(`UPDATE merchants SET ${sets} WHERE merchant_id = $1`,
        [m], 'clq_test_ineligible');

      const got = await claim(await orderAt(DEN));
      expect(got.ok, 'an ineligible merchant was handed a player').toBe(false);
      expect(got.reason).toBe('NO_LINK_AVAILABLE');
    });

    it('refuses a merchant already at their concurrency cap', async () => {
      // Their OWN cap, set to one. `COALESCE(m.max_concurrent_orders, $n)`
      // means the merchant's column wins over the rail default, so a fixture
      // left at the helper's default of 5 would pass this test while holding
      // one order — proving nothing about the cap.
      const m = await merchant({ denominationPaise: DEN, max_concurrent_orders: 1 });
      await linkFrom(m);
      // One order already on their plate. On this rail the cap is ONE, because
      // the notes they are holding are the same notes.
      await pgQuery(
        `INSERT INTO order_states
           (order_id, user_id, order_type, state, token_amount_paise, payment_mode, merchant_id)
         VALUES ($1, 'clq-other', 'DEPOSIT', 'PROCESSING', $2, 'CASH_ATM', $3)`,
        [uid('ord'), DEN, m], 'clq_test_busy',
      );
      expect((await claim(await orderAt(DEN))).ok).toBe(false);
    });

    it('refuses a merchant who already refused THIS ORDER', async () => {
      const m = await merchant({ denominationPaise: DEN });
      await linkFrom(m);
      const orderId = await orderAt(DEN);
      await pgQuery(
        `INSERT INTO order_rejections (order_id, merchant_id, user_id, reason)
         VALUES ($1, $2, 'clq-user', 'declined')`,
        [orderId, m], 'clq_test_refused_order',
      );
      expect((await claim(orderId)).ok, 'an order came back to the merchant who refused it')
        .toBe(false);
    });

    it('refuses a merchant who already refused THIS PLAYER', async () => {
      // A different ORDER, the same player. This is the half of F-021 that
      // stops a merchant declining one player's orders over and over.
      const m = await merchant({ denominationPaise: DEN });
      await linkFrom(m);
      // A REAL earlier order of theirs: `order_rejections.order_id` is a foreign
      // key, so a fabricated id is refused — the audit row cannot point at an
      // order that never existed.
      const earlier = await orderAt(DEN, 'CANCELLED', 'barred-player');
      await pgQuery(
        `INSERT INTO order_rejections (order_id, merchant_id, user_id, reason)
         VALUES ($1, $2, 'barred-player', 'declined')`,
        [earlier, m], 'clq_test_refused_player',
      );
      expect((await claim(await orderAt(DEN, 'PENDING_QUEUE', 'barred-player'), 'barred-player')).ok,
        'a merchant was given another order from a player they had refused').toBe(false);
      // …and is still available to everybody else.
      expect((await claim(await orderAt(DEN), 'someone-else')).ok).toBe(true);
    });
  });

  it('claims from the merchant whose last trip was wasted, first', async () => {
    const denomination = 4_000_000;
    const wasted = await merchant({ denominationPaise: denomination });
    const fresh = await merchant({ denominationPaise: denomination });

    // The wasted merchant drove out and nobody took it.
    const dead = await supplyLink({
      linkId: uid('lnk'), merchantId: wasted, denominationPaise: denomination,
      paymentLink: 'upi://pay?am=40000', expiresAt: new Date(Date.now() + 400),
    });
    expect(dead.ok).toBe(true);
    await new Promise((r) => setTimeout(r, 800));
    await expireDueLinks();

    // Both now supply. The fresh merchant's link expires SOONER, so without
    // the priority the oldest-first rule would take theirs.
    const freshLink = await supplyLink({
      linkId: uid('lnk'), merchantId: fresh, denominationPaise: denomination,
      paymentLink: 'upi://pay?am=40000', expiresAt: inMinutes(2),
    });
    const wastedLink = await supplyLink({
      linkId: uid('lnk'), merchantId: wasted, denominationPaise: denomination,
      paymentLink: 'upi://pay?am=40000', expiresAt: inMinutes(9),
    });
    expect(freshLink.ok && wastedLink.ok).toBe(true);

    const first = await claimLinkForOrder({
      orderId: await orderAt(denomination), denominationPaise: denomination, minRemainingSeconds: 30,
    });
    expect(first.ok).toBe(true);
    expect(first.link.linkId).toBe(wastedLink.link.linkId);

    // ── And the credit is CONSUMED, not permanent ────────────────────────
    // The claim above is now their most recent, so the expired link is no
    // longer newer than it. A merchant who was once unlucky must not outrank
    // everybody forever.
    const secondWasted = await supplyLink({
      linkId: uid('lnk'), merchantId: wasted, denominationPaise: denomination,
      paymentLink: 'upi://pay?am=40000', expiresAt: inMinutes(9),
    });
    expect(secondWasted.ok).toBe(true);

    const second = await claimLinkForOrder({
      orderId: await orderAt(denomination), denominationPaise: denomination, minRemainingSeconds: 30,
    });
    expect(second.ok).toBe(true);
    // Back to oldest-first: the fresh merchant's link expires sooner.
    expect(second.link.linkId).toBe(freshLink.link.linkId);
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
      linkId: uid('lnk'), merchantId: await merchant({ denominationPaise: denomination }), denominationPaise: denomination,
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
    // ── Asserted on rows THIS test made, not on the whole table ────────────
    // The first version walked everything the query returned and asserted each
    // amount was a known denomination. It failed on 777000 — ₹7,770, from the
    // B6 suite's "refuses an amount between the denominations" case.
    //
    // That order exists because the MUTATION HARNESS reverts the source file
    // but not the database: when the mutant disabling the denomination check
    // ran, the order was created successfully before the assertion caught it.
    // So the table permanently contains rows that a passing platform would
    // never produce, and any test asserting a global invariant over it is
    // asserting something about other processes rather than about this query.
    const denomination = 1_000_000;
    const beforeDemand = (await demandByDenomination())
      .find((r) => r.denominationPaise === denomination)?.waiting ?? 0;
    const beforeSupply = (await supplyByDenomination())
      .find((r) => r.denominationPaise === denomination)?.live ?? 0;

    await orderAt(denomination);
    const supplied = await supplyLink({
      linkId: uid('lnk'), merchantId: await merchant({ denominationPaise: denomination }), denominationPaise: denomination,
      paymentLink: 'upi://pay?am=10000', expiresAt: inMinutes(5),
    });
    expect(supplied.ok).toBe(true);

    const demand = await demandByDenomination().then((rows) =>
      rows.find((r) => r.denominationPaise === denomination));
    const supply = await supplyByDenomination().then((rows) =>
      rows.find((r) => r.denominationPaise === denomination));

    expect(demand.waiting).toBe(beforeDemand + 1);
    expect(supply.live).toBe(beforeSupply + 1);

    await cancelLink(supplied.link.linkId, supplied.link.merchantId);
  });

  it('refuses an empty link and one that expires in the past', async () => {
    const m = await merchant({ denominationPaise: 50_000 });
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
