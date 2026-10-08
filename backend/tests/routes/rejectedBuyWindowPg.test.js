// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The BUY escrow window (2c+, owner 2026-10-02 21:13).
 *
 * A player taps Paid and gives a UTR; the team member says nothing arrived and
 * rejects the buy. That is one side's word, so:
 *
 *   the buy waits in REJECTED, the team's tokens still HELD in its pool
 *   the player has `rejectedBuyDisputeMinutes` (default 15) to dispute
 *   a dispute in time keeps the hold until the dispute manager decides
 *   no dispute: the window sweep cancels the buy and the hold goes back
 *
 * Every order here is one production makes: created with its split, routed to
 * a member of a WORKING team (which takes the hold), marked paid with a real
 * reference, rejected on the member's own route (§32 S16). The only thing moved
 * by hand is the clock: the window's end is put behind us, as fifteen minutes
 * passing would.
 *
 * It also holds the fix that made the window possible at all: `expectFrom` was
 * checked for being a subset and then IGNORED by the order writer, so a
 * member's "rejected as unpaid" could close a buy the player had already
 * DISPUTED and give the team its tokens back.
 *
 * And the rule that the button is for a buy the player marked PAID, and for
 * nothing before it (owner, 2026-10-07): REJECTED's one edge in the state
 * machine is from PAID, so an accepted buy the player has not paid yet is
 * refused with 400 by the route, by the proof upload and by the transition's
 * own WHERE, and the player is neither warned nor flagged.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { pgConfigured, applySchema, closePg, pgQuery, withTransaction } from '#db/client.js';
import { createOrderRecord, getOrderRecord } from '#db/repositories/orders.record.js';
import { getOrderHistory } from '#db/repositories/orders.core.js';
import { getPool } from '#db/repositories/teamPools.js';
import { getUser } from '#db/repositories/users.js';
import { setCashReady } from '#db/repositories/teamRouting.js';
import { getSystemConfig, applyConfig } from '#db/repositories/config.js';
import { tryAssignMerchant, markOrderPaid } from '../../domains/payment/paymentProcessing.service.js';
import { completeOrder, disputeOrder, rejectOrder } from '../../domains/payment/orderLifecycle.service.js';
import { closeRejectedBuyWindows } from '../../domains/payment/rejectedBuyWindow.service.js';
import { toPlayerOrderView } from '../../domains/payment/playerOrderView.js';
import { toMerchantOrderView } from '../../domains/merchant/merchantOrderView.js';
import { teamFixture, readyToPay } from '../teamFixture.js';
import { mountRouter, actor, merchantActor, as } from './_harness.js';

const describePg = pgConfigured() ? describe : describe.skip;

// The S3 boundary only: the route's rules are what is under test, and the
// proof's binding to this member and order is asserted in
// merchantRejectPaidRoutes.test.js.
const cdn = vi.hoisted(() => ({ verify: vi.fn(), presign: vi.fn() }));
vi.mock('../../services/cdn.service.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    default: { ...actual.default, verifyUploadedObject: cdn.verify, generatePresignedUploadUrl: cdn.presign },
  };
});

// Above the cash ceiling: a UPI_BANK buy, reference at Paid.
const TOKENS = 20_000;
const PAISE = TOKENS * 100;
// One of the CASH sizes: the member scans the machine's QR, and the player may
// tap Paid before the reference (Step 2d).
const CASH_TOKENS = 1_000;
const REJECT = {
  reason: 'No credit against this UTR in my statement',
  proofFileKey: 'merchant-reject-proof/x.jpg', proofCdnUrl: 'https://cdn.test/x.jpg',
};

describePg('the window after a member rejects a buy as unpaid', () => {
  let merchantApp; let playerApp; let uploadApp;
  let seq = 0;
  const teams = teamFixture();
  const made = [];
  let baseline;
  const oid = () => `rbw-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}-${seq += 1}`;
  const nextUtr = () => String(470000000000 + (seq * 7919) + Math.floor(Math.random() * 7000));

  beforeAll(async () => {
    await applySchema();
    merchantApp = mountRouter((await import('../../domains/merchant/merchant.routes.js')).default);
    playerApp = mountRouter((await import('../../domains/payment/payment.routes.js')).default);
    uploadApp = mountRouter((await import('../../routes/upload.routes.js')).default);
    cdn.verify.mockResolvedValue({ cdnUrl: REJECT.proofCdnUrl, fileKey: REJECT.proofFileKey });
    cdn.presign.mockResolvedValue({ uploadUrl: 'https://s3.test/put', fileKey: REJECT.proofFileKey, cdnUrl: REJECT.proofCdnUrl });
    // Trap 10: the window lengths are config, shared by every suite after this.
    const cfg = await getSystemConfig();
    baseline = { rejectedBuyDisputeMinutes: cfg.rejectedBuyDisputeMinutes, withdrawalHoldMinutes: cfg.withdrawalHoldMinutes };
  }, 60_000);

  afterAll(async () => {
    await applyConfig({ scope: 'system', actor: 'test', patch: baseline }).catch(() => {});
    await withTransaction(async (c) => {
      await c.query('SET LOCAL session_replication_role = replica');
      await c.query('DELETE FROM order_transitions WHERE order_id = ANY($1)', [made]);
      await c.query('DELETE FROM order_states WHERE order_id = ANY($1)', [made]);
    });
    await teams.cleanup();
    await closePg();
  });

  /**
   * A buy as production makes one, its tokens held in the member's team pool,
   * taken as far as `upTo`: ASSIGNED (routed), PROCESSING (accepted, and on
   * cash the machine's QR scanned: the player has somewhere to pay) or PAID
   * (the player tapped Paid; on cash, before the reference).
   */
  const routedBuy = async ({ rail = 'UPI_BANK', upTo = 'PAID' } = {}) => {
    const cash = rail === 'CASH';
    const tokens = cash ? CASH_TOKENS : TOKENS;
    const member = await merchantActor();
    const team = await teams.workingTeam({ rail, poolTokens: cash ? 10_000 : 50_000, include: [member.merchantId] });
    if (cash) expect((await setCashReady(member.merchantId, true)).ok).toBe(true);
    const player = await actor({});
    const orderId = oid();
    made.push(orderId);
    const order = await createOrderRecord({
      orderId, userId: player.userId, type: 'DEPOSIT',
      tokenAmountRupees: tokens, fiatAmountRupees: tokens,
      depositAllocation: tokens, reserveAllocation: 0,
    });
    expect(await tryAssignMerchant(order), 'the router did not assign the buy').toBe(true);
    expect((await getOrderRecord(orderId)).merchantId).toBe(member.merchantId);
    if (upTo !== 'ASSIGNED') await readyToPay(orderId);
    if (upTo === 'PAID') {
      expect((await markOrderPaid(player.userId, orderId, cash ? undefined : nextUtr())).status).toBe('PAID');
    }
    expect((await getOrderRecord(orderId)).status, `the buy did not reach ${upTo}`).toBe(upTo);
    return { member, player, orderId, team, tokens };
  };

  /** A PAID buy as production makes one, its tokens held in the member's team pool. */
  const paidBuy = () => routedBuy();

  /** The same, rejected on the member's own route. */
  const rejectedBuy = async () => {
    const buy = await paidBuy();
    const res = await as(merchantApp, buy.member).post(`/orders/${buy.orderId}/reject`).send(REJECT);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return { ...buy, res };
  };

  /** Fifteen minutes pass. */
  const windowPasses = (orderId) => pgQuery(
    `UPDATE order_states SET dispute_window_until = now() - interval '1 minute' WHERE order_id = $1`, [orderId]);

  const dispute = (buy, reason = 'I paid from my bank; the UTR is on the order') =>
    as(playerApp, buy.player).post(`/order/${buy.orderId}/dispute`).send({ reason });

  // ── The rejection keeps the escrow ─────────────────────────────────────────
  it('leaves the buy REJECTED with the team\'s tokens still held, and opens the window', async () => {
    const buy = await paidBuy();
    const poolBefore = await getPool(buy.team.teamId);
    expect(poolBefore.heldPaise, 'the precondition: assignment held the tokens').toBeGreaterThanOrEqual(PAISE);

    const res = await as(merchantApp, buy.member).post(`/orders/${buy.orderId}/reject`).send(REJECT);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.disputeUntil).toBeTruthy();

    const row = await getOrderRecord(buy.orderId);
    expect(row.status).toBe('REJECTED');
    // Nothing went back to the pool on the member's word alone.
    expect(await getPool(buy.team.teamId)).toEqual(poolBefore);
    // The deadline is the database clock plus the configured window.
    const { rows } = await pgQuery(
      `SELECT EXTRACT(EPOCH FROM dispute_window_until - now()) * 1000 AS left_ms FROM order_states WHERE order_id = $1`, [buy.orderId]);
    const leftMs = Number(rows[0].left_ms);
    expect(Number.isFinite(leftMs)).toBe(true);
    const minutes = (await getSystemConfig()).rejectedBuyDisputeMinutes;
    expect(leftMs).toBeGreaterThan((minutes - 1) * 60_000);
    expect(leftMs).toBeLessThanOrEqual(minutes * 60_000);
  });

  it('tells the player until when, and the member too — without the merchant\'s credit standing', async () => {
    const buy = await rejectedBuy();
    const row = await getOrderRecord(buy.orderId);
    const playerView = toPlayerOrderView(row);
    expect(new Date(playerView.disputeUntil).getTime()).toBe(new Date(row.disputeWindowUntil).getTime());
    expect(playerView).not.toHaveProperty('disputeWindowUntil');
    expect(playerView).not.toHaveProperty('merchantCreditHoldUntil');
    expect(toMerchantOrderView(row).disputeWindowUntil).toBeTruthy();
  });

  it('follows the admin\'s window length', async () => {
    await applyConfig({ scope: 'system', actor: 'test', patch: { rejectedBuyDisputeMinutes: 40 } });
    try {
      const buy = await rejectedBuy();
      const { rows } = await pgQuery(
        `SELECT dispute_window_until - now() BETWEEN interval '39 minutes' AND interval '40 minutes' AS ok
           FROM order_states WHERE order_id = $1`, [buy.orderId]);
      expect(rows[0].ok).toBe(true);
    } finally {
      await applyConfig({ scope: 'system', actor: 'test', patch: { rejectedBuyDisputeMinutes: baseline.rejectedBuyDisputeMinutes } });
    }
  });

  // ── The player disputes ───────────────────────────────────────────────────
  it('lets the player dispute inside the window, and the hold stays', async () => {
    const buy = await rejectedBuy();
    const poolBefore = await getPool(buy.team.teamId);
    const res = await dispute(buy);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await getOrderRecord(buy.orderId)).status).toBe('DISPUTED');
    expect(await getPool(buy.team.teamId)).toEqual(poolBefore);
  });

  it('refuses a dispute once the window has passed, and says so', async () => {
    const buy = await rejectedBuy();
    await windowPasses(buy.orderId);
    const res = await dispute(buy);
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/window to dispute this rejected payment has closed/i);
    expect((await getOrderRecord(buy.orderId)).status).toBe('REJECTED');
  });

  it('refuses a retry while the window is open, naming the way out', async () => {
    const buy = await rejectedBuy();
    const res = await as(playerApp, buy.player).post(`/order/${buy.orderId}/retry`);
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/raise a dispute before the window closes/i);
  });

  // ── The window closes ─────────────────────────────────────────────────────
  it('cancels the buy and gives the team its tokens back when the window passes undisputed', async () => {
    const buy = await rejectedBuy();
    const poolBefore = await getPool(buy.team.teamId);
    await windowPasses(buy.orderId);

    await closeRejectedBuyWindows();
    const row = await getOrderRecord(buy.orderId);
    expect(row.status).toBe('CANCELLED');
    const poolAfter = await getPool(buy.team.teamId);
    expect(poolAfter.heldPaise).toBe(poolBefore.heldPaise - PAISE);
    expect(poolAfter.availablePaise).toBe(poolBefore.availablePaise + PAISE);

    // A second sweep moves nothing: the pool is where the first one left it.
    await closeRejectedBuyWindows();
    expect(await getPool(buy.team.teamId)).toEqual(poolAfter);
  });

  it('leaves an open window alone', async () => {
    const buy = await rejectedBuy();
    const poolBefore = await getPool(buy.team.teamId);
    await closeRejectedBuyWindows();
    expect((await getOrderRecord(buy.orderId)).status).toBe('REJECTED');
    expect(await getPool(buy.team.teamId)).toEqual(poolBefore);
  });

  it('a dispute that landed first beats the sweep, with no time limit', async () => {
    const buy = await rejectedBuy();
    expect((await dispute(buy)).status).toBe(200);
    const poolBefore = await getPool(buy.team.teamId);
    // Long after the window: a disputed buy waits for the dispute manager.
    await windowPasses(buy.orderId);
    await closeRejectedBuyWindows();
    expect((await getOrderRecord(buy.orderId)).status).toBe('DISPUTED');
    expect(await getPool(buy.team.teamId)).toEqual(poolBefore);
  });

  it('a dispute and the sweep racing on a closing window: exactly one wins, and the hold moves once', async () => {
    const buy = await rejectedBuy();
    const poolBefore = await getPool(buy.team.teamId);
    // The window is open for the dispute's own check and then closes: both
    // decide on the database clock under the order's row lock.
    await pgQuery(`UPDATE order_states SET dispute_window_until = now() + interval '150 milliseconds' WHERE order_id = $1`, [buy.orderId]);
    await new Promise((r) => setTimeout(r, 120));
    const [disputed] = await Promise.all([dispute(buy), (async () => {
      await new Promise((r) => setTimeout(r, 40));
      await closeRejectedBuyWindows();
    })()]);
    const row = await getOrderRecord(buy.orderId);
    const poolAfter = await getPool(buy.team.teamId);
    if (row.status === 'DISPUTED') {
      expect(disputed.status).toBe(200);
      expect(poolAfter).toEqual(poolBefore);
    } else {
      expect(row.status).toBe('CANCELLED');
      expect(disputed.status).toBe(409);
      expect(poolAfter.heldPaise).toBe(poolBefore.heldPaise - PAISE);
    }
  });

  // ── expectFrom is applied ─────────────────────────────────────────────────
  it('a member cannot use "rejected as unpaid" to close a buy the player has DISPUTED', async () => {
    // Failing first: the writer ignored `expectFrom`, the table lets CANCELLED
    // and REJECTED come from DISPUTED, and the button took the dispute away.
    const buy = await rejectedBuy();
    expect((await dispute(buy)).status).toBe(200);
    const poolBefore = await getPool(buy.team.teamId);
    const res = await as(merchantApp, buy.member).post(`/orders/${buy.orderId}/reject`).send(REJECT);
    expect(res.status).toBe(409);
    expect((await getOrderRecord(buy.orderId)).status).toBe('DISPUTED');
    expect(await getPool(buy.team.teamId)).toEqual(poolBefore);
  });

  it('a narrowed transition refuses a state the table allows but the caller did not name', async () => {
    // The paid-timeout sweep disputes from PAID only. COMPLETED -> DISPUTED is
    // in the table (a player disputes a finished order), so before the fix a
    // sweep that read PAID and lost the race to the confirm disputed a buy that
    // had just completed.
    const buy = await paidBuy();
    expect((await completeOrder(buy.orderId, { set: { completedAt: new Date() } })).ok).toBe(true);
    const narrowed = await disputeOrder(buy.orderId, { expectFrom: 'PAID', set: { disputeRaisedBy: 'system' } });
    expect(narrowed.ok).toBe(false);
    expect((await getOrderRecord(buy.orderId)).status).toBe('COMPLETED');
    // The opposite: without the narrowing the table's own edge still works.
    expect((await disputeOrder(buy.orderId, { set: { disputeRaisedBy: 'user' } })).ok).toBe(true);
  });

  // ── Only a buy the player marked PAID (owner, 2026-10-07) ─────────────────
  // "Payment not received" says the player's money never arrived. Before the
  // player has tapped Paid there is no claimed payment for it to deny: the
  // route took a PROCESSING buy too, moved it to REJECTED, and warned and
  // flagged a player who had said nothing yet. Failing first: each test below
  // passed the old route.
  describe('"payment not received" before the player tapped Paid', () => {
    const reject = (buy, who = buy.member) => as(merchantApp, who).post(`/orders/${buy.orderId}/reject`).send(REJECT);

    /** Everything a rejection writes, read back, so a refusal can be shown to have written none of it. */
    const footprint = async (buy) => {
      const row = await getOrderRecord(buy.orderId);
      const user = await getUser(buy.player.userId);
      return {
        status: row.status,
        window: row.disputeWindowUntil ?? null,
        rejectedAt: row.rejectedAt ?? null,
        proof: row.rejectionProofUrl ?? null,
        pool: await getPool(buy.team.teamId),
        warnings: Number(user.warningCount || 0),
        flagged: Boolean(user.paymentFlagged),
        intoRejected: (await getOrderHistory(buy.orderId)).filter((t) => t.to === 'REJECTED'),
      };
    };

    for (const [label, spec] of [
      ['an accepted bank-transfer buy', { upTo: 'PROCESSING' }],
      ['a cash buy whose QR is scanned', { rail: 'CASH', upTo: 'PROCESSING' }],
      ['a buy the member has not accepted', { upTo: 'ASSIGNED' }],
    ]) {
      it(`is refused with 400 on ${label}, and nothing moves: no REJECTED, no warning, no flag, the hold untouched`, async () => {
        const buy = await routedBuy(spec);
        const before = await footprint(buy);
        expect(before).toMatchObject({ status: spec.upTo, window: null, warnings: 0, flagged: false, intoRejected: [] });
        cdn.verify.mockClear();

        const res = await reject(buy);

        expect(res.status, JSON.stringify(res.body)).toBe(400);
        expect(res.body).toMatchObject({ success: false, code: 'NOT_PAID_YET' });
        // What the member can do about it, not just "cannot": wait for the tap.
        expect(res.body.message).toMatch(/has not tapped Paid/);
        expect(res.body.message).toMatch(/expires on its own/);
        expect(await footprint(buy)).toEqual(before);
        // Nothing to accuse anybody of yet, so no evidence is asked for either.
        expect(cdn.verify).not.toHaveBeenCalled();
      });
    }

    it('the proof upload asks the same question: no upload URL before Paid, one after', async () => {
      // §32 S3: the panel asks for the upload URL first. Left wider than the
      // reject, it staged evidence for an accusation the reject then refused.
      const buy = await routedBuy({ upTo: 'PROCESSING' });
      cdn.presign.mockClear();
      const ask = () => as(uploadApp, buy.member).post(`/merchant/order-reject-proof/${buy.orderId}/upload-url`)
        .send({ fileName: 'statement.jpg', contentType: 'image/jpeg', fileSize: 1024 });

      const early = await ask();
      expect(early.status, JSON.stringify(early.body)).toBe(400);
      expect(early.body).toMatchObject({ success: false, code: 'NOT_PAID_YET' });
      expect(cdn.presign).not.toHaveBeenCalled();

      // The opposite: once the player taps Paid, the same member gets one.
      expect((await markOrderPaid(buy.player.userId, buy.orderId, nextUtr())).status).toBe('PAID');
      const paid = await ask();
      expect(paid.status, JSON.stringify(paid.body)).toBe(200);
      expect(paid.body.uploadUrl).toBeTruthy();
      expect(cdn.presign).toHaveBeenCalledWith(expect.objectContaining({
        category: 'merchant-reject-proof', userId: String(buy.member.merchantId), orderId: buy.orderId,
      }));
    });

    it('the state machine has no edge into REJECTED but PAID: the transition itself refuses', async () => {
      // Trap 18: the route's question is a snapshot. The rule is the table the
      // transition's WHERE is built from, so a caller that skips the route —
      // and names no `expectFrom` — is refused by the database the same way.
      for (const upTo of ['ASSIGNED', 'PROCESSING']) {
        const buy = await routedBuy({ upTo });
        const moved = await rejectOrder(buy.orderId, { actor: 'test', set: { rejectedReason: 'never paid' } });
        expect(moved, upTo).toMatchObject({ ok: false, reason: 'illegal_transition', status: upTo });
        expect((await getOrderRecord(buy.orderId)).status).toBe(upTo);
        expect((await getOrderHistory(buy.orderId)).filter((t) => t.to === 'REJECTED')).toEqual([]);
      }
    });

    it('a refusal costs nothing: once the player taps Paid, the same member rejects the same buy and the window opens', async () => {
      // The opposite behaviour and the retry pair at once: the 400 must not
      // spend anything the legitimate rejection needs a moment later.
      const buy = await routedBuy({ upTo: 'PROCESSING' });
      const poolBefore = await getPool(buy.team.teamId);
      expect((await reject(buy)).status).toBe(400);
      expect((await reject(buy)).status, 'a repeat is refused the same way').toBe(400);

      expect((await markOrderPaid(buy.player.userId, buy.orderId, nextUtr())).status).toBe('PAID');
      const res = await reject(buy);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.disputeUntil).toBeTruthy();

      const after = await footprint(buy);
      expect(after).toMatchObject({ status: 'REJECTED', warnings: 1, flagged: true, proof: REJECT.proofCdnUrl });
      expect(after.window).toBeTruthy();
      expect(after.intoRejected).toEqual([expect.objectContaining({ from: 'PAID', to: 'REJECTED' })]);
      // The escrow is intact: the hold stays for the player's window.
      expect(after.pool).toEqual(poolBefore);
      // A second press is a conflict that names where the buy stands, and
      // warns nobody twice.
      const again = await reject(buy);
      expect(again.status).toBe(409);
      expect(again.body).toMatchObject({ code: 'NOT_REJECTABLE' });
      expect(again.body.message).toMatch(/REJECTED now/);
      expect((await footprint(buy)).warnings).toBe(1);
      // …and the player can still dispute it inside the window.
      expect((await dispute(buy)).status).toBe(200);
    });

    it('a cash buy the player tapped Paid on, its reference still to come, can be rejected', async () => {
      // The other rail, and the PAID that carries no reference yet: the rule is
      // the Paid tap, not the UTR.
      const buy = await routedBuy({ rail: 'CASH', upTo: 'PAID' });
      expect(String((await getOrderRecord(buy.orderId)).utrNumber ?? '')).toBe('');
      const res = await reject(buy);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const after = await footprint(buy);
      expect(after).toMatchObject({ status: 'REJECTED', warnings: 1, flagged: true });
      expect(after.intoRejected).toEqual([expect.objectContaining({ from: 'PAID' })]);
    });

    it('a sell is never "payment not received", paid or not: both doors say so, and nothing moves', async () => {
      // The member is the one who pays a sell. Built directly, PAID and
      // assigned, because both doors refuse it before anything reads its money
      // (the same way merchantRejectPaidRoutes.test.js builds its buys).
      const member = await merchantActor();
      const player = await actor({});
      const orderId = oid();
      made.push(orderId);
      await createOrderRecord({
        orderId, userId: player.userId, type: 'WITHDRAWAL',
        tokenAmountRupees: CASH_TOKENS, fiatAmountRupees: CASH_TOKENS, state: 'PAID', merchantId: member.merchantId,
      });
      cdn.presign.mockClear();

      const proof = await as(uploadApp, member).post(`/merchant/order-reject-proof/${orderId}/upload-url`)
        .send({ fileName: 'statement.jpg', contentType: 'image/jpeg', fileSize: 1024 });
      const res = await as(merchantApp, member).post(`/orders/${orderId}/reject`).send(REJECT);

      expect(proof.status, JSON.stringify(proof.body)).toBe(400);
      expect(proof.body.code).toBe('NOT_A_BUY');
      expect(cdn.presign).not.toHaveBeenCalled();
      expect(res.status, JSON.stringify(res.body)).toBe(400);
      expect(res.body.code).toBe('NOT_A_BUY');
      expect((await getOrderRecord(orderId)).status).toBe('PAID');
      expect(Number((await getUser(player.userId)).warningCount || 0)).toBe(0);
    });

    it('another member is told the buy is not theirs, not where it stands', async () => {
      // §32 S34: the state question comes after ownership, so a refusal never
      // tells a stranger whether somebody's buy has been paid.
      const buy = await routedBuy({ upTo: 'PROCESSING' });
      const stranger = await merchantActor();
      const res = await reject(buy, stranger);
      expect(res.status).toBe(403);
      expect(res.body.code).toBeUndefined();
      expect((await getOrderRecord(buy.orderId)).status).toBe('PROCESSING');
    });

    it('the read is a snapshot, the transition is the guard: a buy disputed while the proof was checked is refused by the database, and nobody is warned', async () => {
      // The route read PAID; the player's dispute lands in the gap the proof
      // check leaves before the transition. The WHERE refuses, and the member
      // is told where the buy now stands rather than a bare status.
      const buy = await paidBuy();
      cdn.verify.mockImplementationOnce(async () => {
        const raised = await disputeOrder(buy.orderId, {
          expectFrom: 'PAID',
          set: { disputeRaisedBy: 'user', disputeReason: 'I paid', disputeRaisedAt: new Date() },
        });
        expect(raised.ok).toBe(true);
        return { cdnUrl: REJECT.proofCdnUrl, fileKey: REJECT.proofFileKey };
      });

      const res = await reject(buy);

      expect(res.status, JSON.stringify(res.body)).toBe(409);
      expect(res.body).toMatchObject({ success: false, code: 'NOT_REJECTABLE' });
      expect(res.body.message).toMatch(/DISPUTED now/);
      expect(await footprint(buy)).toMatchObject({
        status: 'DISPUTED', window: null, warnings: 0, flagged: false, intoRejected: [],
      });
    });

    it('a reject racing the player\'s Paid tap: REJECTED only ever follows PAID, and only then is the player warned', async () => {
      const buy = await routedBuy({ upTo: 'PROCESSING' });
      const [rejected] = await Promise.all([
        reject(buy),
        markOrderPaid(buy.player.userId, buy.orderId, nextUtr()),
      ]);
      const after = await footprint(buy);
      if (after.status === 'REJECTED') {
        expect(rejected.status).toBe(200);
        expect(after.intoRejected).toEqual([expect.objectContaining({ from: 'PAID' })]);
        expect(after.warnings).toBe(1);
      } else {
        expect(after.status).toBe('PAID');
        expect(rejected.status).toBe(400);
        expect(after.intoRejected).toEqual([]);
        expect(after).toMatchObject({ warnings: 0, flagged: false, window: null });
      }
    });
  });

  // ── The window lengths are the admin's, within the owner's bounds ──────────
  it('takes 5 to 1440 minutes for the rejected-buy window, and refuses outside it', async () => {
    try {
      await expect(applyConfig({ scope: 'system', actor: 'test', patch: { rejectedBuyDisputeMinutes: 4 } })).rejects.toThrow(/rejectedBuyDisputeMinutes/);
      await expect(applyConfig({ scope: 'system', actor: 'test', patch: { rejectedBuyDisputeMinutes: 1441 } })).rejects.toThrow(/rejectedBuyDisputeMinutes/);
      // A fraction is refused by name, not stored and then read as the default.
      await expect(applyConfig({ scope: 'system', actor: 'test', patch: { rejectedBuyDisputeMinutes: 7.5 } })).rejects.toThrow(/rejectedBuyDisputeMinutes' must be a whole number/);
      await applyConfig({ scope: 'system', actor: 'test', patch: { rejectedBuyDisputeMinutes: 5 } });
      expect((await getSystemConfig()).rejectedBuyDisputeMinutes).toBe(5);
    } finally {
      await applyConfig({ scope: 'system', actor: 'test', patch: { rejectedBuyDisputeMinutes: baseline.rejectedBuyDisputeMinutes } });
    }
  });

  it('keeps the sell hold at an hour or more: "at least 1 hour" is the owner\'s floor', async () => {
    try {
      await expect(applyConfig({ scope: 'system', actor: 'test', patch: { withdrawalHoldMinutes: 59 } })).rejects.toThrow(/withdrawalHoldMinutes/);
      await expect(applyConfig({ scope: 'system', actor: 'test', patch: { withdrawalHoldMinutes: 0 } })).rejects.toThrow(/withdrawalHoldMinutes/);
      await expect(applyConfig({ scope: 'system', actor: 'test', patch: { withdrawalHoldMinutes: 90.5 } })).rejects.toThrow(/withdrawalHoldMinutes' must be a whole number/);
      await applyConfig({ scope: 'system', actor: 'test', patch: { withdrawalHoldMinutes: 60 } });
      expect((await getSystemConfig()).withdrawalHoldMinutes).toBe(60);
    } finally {
      await applyConfig({ scope: 'system', actor: 'test', patch: { withdrawalHoldMinutes: baseline.withdrawalHoldMinutes } });
    }
  });
});
