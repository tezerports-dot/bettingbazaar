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
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { pgConfigured, applySchema, closePg, pgQuery, withTransaction } from '#db/client.js';
import { createOrderRecord, getOrderRecord } from '#db/repositories/orders.record.js';
import { getPool } from '#db/repositories/teamPools.js';
import { getSystemConfig, applyConfig } from '#db/repositories/config.js';
import { tryAssignMerchant, markOrderPaid } from '../../domains/payment/paymentProcessing.service.js';
import { completeOrder, disputeOrder } from '../../domains/payment/orderLifecycle.service.js';
import { closeRejectedBuyWindows } from '../../domains/payment/rejectedBuyWindow.service.js';
import { toPlayerOrderView } from '../../domains/payment/playerOrderView.js';
import { toMerchantOrderView } from '../../domains/merchant/merchantOrderView.js';
import { teamFixture, readyToPay } from '../teamFixture.js';
import { mountRouter, actor, merchantActor, as } from './_harness.js';

const describePg = pgConfigured() ? describe : describe.skip;

// The S3 boundary only: the route's rules are what is under test, and the
// proof's binding to this member and order is asserted in
// merchantRejectPaidRoutes.test.js.
const cdn = vi.hoisted(() => ({ verify: vi.fn() }));
vi.mock('../../services/cdn.service.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, default: { ...actual.default, verifyUploadedObject: cdn.verify } };
});

// Above the cash ceiling: a UPI_BANK buy, reference at Paid.
const TOKENS = 20_000;
const PAISE = TOKENS * 100;
const REJECT = {
  reason: 'No credit against this UTR in my statement',
  proofFileKey: 'merchant-reject-proof/x.jpg', proofCdnUrl: 'https://cdn.test/x.jpg',
};

describePg('the window after a member rejects a buy as unpaid', () => {
  let merchantApp; let playerApp;
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
    cdn.verify.mockResolvedValue({ cdnUrl: REJECT.proofCdnUrl, fileKey: REJECT.proofFileKey });
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

  /** A PAID buy as production makes one, its tokens held in the member's team pool. */
  const paidBuy = async () => {
    const member = await merchantActor();
    const team = await teams.workingTeam({ rail: 'UPI_BANK', poolTokens: 50_000, include: [member.merchantId] });
    const player = await actor({});
    const orderId = oid();
    made.push(orderId);
    const order = await createOrderRecord({
      orderId, userId: player.userId, type: 'DEPOSIT',
      tokenAmountRupees: TOKENS, fiatAmountRupees: TOKENS,
      depositAllocation: TOKENS, reserveAllocation: 0,
    });
    expect(await tryAssignMerchant(order), 'the router did not assign the buy').toBe(true);
    expect((await getOrderRecord(orderId)).merchantId).toBe(member.merchantId);
    await readyToPay(orderId);
    expect((await markOrderPaid(player.userId, orderId, nextUtr())).status).toBe('PAID');
    return { member, player, orderId, team };
  };

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
