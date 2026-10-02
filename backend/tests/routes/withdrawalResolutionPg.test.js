// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Every way an admin ends a withdrawal, in every state its money can be in.
 *
 * ── Why a matrix ───────────────────────────────────────────────────────────
 * A withdrawal's money is in one of two positions when an admin decides it:
 *
 *   NOT YET CONFIRMED   the player's stake is LOCKED and the team's pool has
 *                       not been credited (PENDING_QUEUE / ASSIGNED /
 *                       PROCESSING, or DISPUTED from PROCESSING)
 *   HELD                the member asserted payment; the stake is still
 *                       LOCKED and the pool is STILL not credited — the hold
 *                       window freezes both sides until it is settled (PAID,
 *                       or DISPUTED from PAID)
 *
 * and three routes decide it: the admin queue action, the Payment Control
 * Centre resolve, and the Dispute Manager resolve. Each was written with ONE
 * of those positions in mind, so each was right for some and wrong for others:
 * a refund that credited winnings and left the lock standing (the wallet reads
 * double), a release that cleared a flag and moved nothing, a hold left
 * standing on an order that can no longer reach the sweep, a resolved dispute
 * written back into the dispute queue. All three now go through
 * `withdrawalHold.endWithdrawal` (F-027).
 *
 * So the assertion is the same for every cell — about MONEY, both sides:
 *
 *   REFUND   winnings +a, locked −a; the team's pool is untouched and the
 *            treasury moves nothing; the order is CANCELLED
 *   RELEASE  locked −a (the stake left the player); the team's pool
 *            `available` +a, and the treasury moves a from USER_FLOAT to
 *            TEAM_FLOAT; the order is COMPLETED
 *
 * ── How the withdrawals are made (PROJECT_STATUS §3.10, 2c) ─────────────────
 * Through the real path, so every cell is a row the platform can produce (§32
 * S16): the player's ₹1,000 withdrawal is a CASH order by its size, ROUTED to
 * the one online member of a working CASH team, accepted (PROCESSING) and —
 * for a HELD cell — confirmed (PAID, HELD) through the member's own routes,
 * and put in DISPUTED by the member's red flag. The stake is locked by the
 * withdrawal's own admission, not by the fixture.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pgConfigured, applySchema, closePg, pgQuery } from '#db/client.js';
import { getOrderRecord } from '#db/repositories/orders.record.js';
import { getBalancesPaise } from '#db/repositories/wallets.core.js';
import { updateUser } from '#db/repositories/users.js';
import { getPool } from '#db/repositories/teamPools.js';
import { getTreasuryBalances, ACCOUNTS } from '#db/repositories/treasury.js';
import { getSystemConfig, applySystemConfig } from '#db/repositories/config.js';
import { PAYMENT_MODES } from '#db/repositories/teamRouting.js';
import { creditWinnings } from '../../domains/wallet/walletAuthority.service.js';
import { createWithdrawalOrder } from '../../domains/payment/paymentProcessing.service.js';
import { teamFixture } from '../teamFixture.js';
import { mountRouter, actor, merchantActor, as } from './_harness.js';

const describePg = pgConfigured() ? describe : describe.skip;
const RUPEES = 1_000;     // a cash denomination: the CASH rail
const A = RUPEES * 100;   // in paise

describePg('ending a withdrawal, in every state its money can be in', () => {
  const teams = teamFixture();
  let adminApp;
  let disputeApp;
  let merchantApp;
  let team;
  let restoreHold = null;
  let seq = 0;
  const players = [];
  // A cash member holds ONE open order. Every cell closes its order, but a
  // failed cell would leave its member at the cap — so members are handed out
  // in turn rather than reused at once.
  const members = [];
  let turn = 0;
  const nextMember = () => members[(turn++) % members.length];
  const admin = () => actor({ isAdmin: true });

  beforeAll(async () => {
    await applySchema();
    adminApp = mountRouter((await import('../../domains/payment/paymentOrder.routes.js')).default);
    disputeApp = mountRouter((await import('../../domains/disputes/disputeResolution.admin.routes.js')).default);
    merchantApp = mountRouter((await import('../../domains/merchant/merchant.routes.js')).default);
    for (let i = 0; i < 10; i += 1) members.push(await merchantActor({}));
    team = await teams.workingTeam({ rail: 'CASH', include: members.map((m) => m.merchantId) });
    // The hold ON, at an hour, so a confirmed withdrawal is HELD and stays
    // there for the length of the suite. Put back after, outside any assertion
    // — the config row is shared by every suite (trap 10).
    restoreHold = (await getSystemConfig({ fresh: true }))?.withdrawalHoldMinutes ?? null;
    await applySystemConfig({ withdrawalHoldMinutes: 60 });
  }, 120_000);

  afterAll(async () => {
    if (restoreHold !== null) await applySystemConfig({ withdrawalHoldMinutes: restoreHold });
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

  /**
   * A withdrawal whose stake is REALLY locked — by the withdrawal's own
   * admission — taken to `state` through the member's routes, optionally HELD
   * by the member's confirm.
   */
  const sell = async ({ state, held = false }) => {
    const merchant = nextMember();
    const player = await actor({});
    players.push(player.userId);
    await updateUser(player.userId, {
      bankDetails: {
        accountNumber: '000111222333', ifscCode: 'HDFC0000001',
        bankName: 'HDFC Bank', accountHolderName: 'Test Player',
      },
    });
    seq += 1;
    await creditWinnings(player.userId, RUPEES, 'resolution suite float', 'Test',
      `seed_${player.userId}`, `wres_seed_${player.userId}_${seq}`);
    await teams.onlyOnline([merchant.merchantId]);
    const { order } = await createWithdrawalOrder(player.userId, RUPEES);
    const orderId = order.orderId ?? order._id;
    const routed = await getOrderRecord(orderId);
    expect(routed.status, 'the withdrawal was not routed to the member').toBe('ASSIGNED');
    expect(routed.merchantId).toBe(String(merchant.merchantId));
    expect(routed.paymentMode).toBe(PAYMENT_MODES.CASH_ATM);

    const accepted = await as(merchantApp, merchant).post(`/accept/${orderId}`).send({});
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    if (held) {
      // No reference: a cash payout is evidenced by its CDM slip, not a UTR.
      const confirmed = await as(merchantApp, merchant).post(`/confirm/${orderId}`).send({});
      expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
      const row = await getOrderRecord(orderId);
      expect(row.status).toBe('PAID');
      expect(row.merchantCreditStatus).toBe('HELD');
    }
    if (state === 'DISPUTED') {
      const flagged = await as(merchantApp, merchant).post(`/orders/${orderId}/red-flag`)
        .send({ reason: 'player says nothing arrived' });
      expect(flagged.status, JSON.stringify(flagged.body)).toBe(200);
    }
    expect((await getOrderRecord(orderId)).status).toBe(state);
    const bal = await getBalancesPaise(player.userId);
    expect(bal.lockedBalance, 'the withdrawal never locked a stake').toBe(A);
    return { merchant, player, orderId };
  };

  const snapshot = async ({ player }) => {
    const p = await getBalancesPaise(player.userId);
    const pool = await getPool(team.teamId);
    const t = await getTreasuryBalances();
    return {
      winnings: p.winningsBalance, locked: p.lockedBalance,
      poolAvailable: pool.availablePaise, poolHeld: pool.heldPaise,
      teamFloat: t[ACCOUNTS.TEAM_FLOAT], userFloat: t[ACCOUNTS.USER_FLOAT],
    };
  };

  const expectRefunded = async (s, before) => {
    const after = await snapshot(s);
    expect(after.winnings - before.winnings, 'winnings not returned').toBe(A);
    expect(after.locked - before.locked, 'the lock was left standing').toBe(-A);
    expect(after.poolAvailable, 'the team was paid for a refunded withdrawal').toBe(before.poolAvailable);
    expect(after.poolHeld).toBe(before.poolHeld);
    expect(after.teamFloat, 'the treasury moved for a refunded withdrawal').toBe(before.teamFloat);
    expect(after.userFloat).toBe(before.userFloat);
    expect((await getOrderRecord(s.orderId)).status).toBe('CANCELLED');
  };

  const expectReleased = async (s, before) => {
    const after = await snapshot(s);
    expect(after.locked - before.locked, 'the stake never left the player').toBe(-A);
    expect(after.winnings, 'the player was credited on a release').toBe(before.winnings);
    expect(after.poolAvailable - before.poolAvailable, 'the team\'s pool was never credited').toBe(A);
    expect(after.poolHeld).toBe(before.poolHeld);
    expect(after.teamFloat - before.teamFloat, 'TEAM_FLOAT did not receive the tokens').toBe(A);
    expect(before.userFloat - after.userFloat, 'USER_FLOAT did not give them up').toBe(A);
    expect((await getOrderRecord(s.orderId)).status).toBe('COMPLETED');
  };

  describe('the admin queue action', () => {
    it('APPROVE on a withdrawal the member has paid moves the stake to the team', async () => {
      // APPROVE completed the order and moved nothing: the stake stayed locked
      // for good and whoever paid the player was never credited.
      const s = await sell({ state: 'PROCESSING' });
      const before = await snapshot(s);
      const res = await as(adminApp, await admin())
        .post(`/payment-orders/${s.orderId}/action`).send({ action: 'APPROVE', reason: 'payout seen' });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      await expectReleased(s, before);
    });

    it('APPROVE on a HELD withdrawal settles it', async () => {
      const s = await sell({ state: 'PAID', held: true });
      const before = await snapshot(s);
      const res = await as(adminApp, await admin())
        .post(`/payment-orders/${s.orderId}/action`).send({ action: 'APPROVE', reason: 'payout seen' });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      await expectReleased(s, before);
    });

    it('CANCEL on a HELD withdrawal returns the stake and credits nobody', async () => {
      const s = await sell({ state: 'PAID', held: true });
      const before = await snapshot(s);
      const res = await as(adminApp, await admin())
        .post(`/payment-orders/${s.orderId}/action`).send({ action: 'CANCEL', reason: 'member never paid' });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      await expectRefunded(s, before);
    });
  });

  describe('the Payment Control Centre', () => {
    it('refund, not yet confirmed', async () => {
      const s = await sell({ state: 'DISPUTED' });
      const before = await snapshot(s);
      const res = await as(adminApp, await admin())
        .post(`/payment-orders/${s.orderId}/resolve`).send({ resolution: 'refund', reason: 'no payout' });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      await expectRefunded(s, before);
    });

    it('refund, HELD', async () => {
      const s = await sell({ state: 'DISPUTED', held: true });
      const before = await snapshot(s);
      const res = await as(adminApp, await admin())
        .post(`/payment-orders/${s.orderId}/resolve`).send({ resolution: 'refund', reason: 'no payout' });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      await expectRefunded(s, before);
    });

    it('release, not yet confirmed', async () => {
      const s = await sell({ state: 'DISPUTED' });
      const before = await snapshot(s);
      const res = await as(adminApp, await admin())
        .post(`/payment-orders/${s.orderId}/resolve`).send({ resolution: 'release', reason: 'payout seen' });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      await expectReleased(s, before);
    });

    it('release, HELD', async () => {
      const s = await sell({ state: 'DISPUTED', held: true });
      const before = await snapshot(s);
      const res = await as(adminApp, await admin())
        .post(`/payment-orders/${s.orderId}/resolve`).send({ resolution: 'release', reason: 'payout seen' });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      await expectReleased(s, before);
    });
  });

  describe('the Dispute Manager', () => {
    it('cancel, not yet confirmed', async () => {
      const s = await sell({ state: 'DISPUTED' });
      const before = await snapshot(s);
      const res = await as(disputeApp, await admin())
        .post(`/dispute-orders/${s.orderId}/resolve`).send({ decision: 'CANCEL_ORDER', resolution: 'no payout' });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      await expectRefunded(s, before);
    });

    it('cancel, HELD', async () => {
      const s = await sell({ state: 'DISPUTED', held: true });
      const before = await snapshot(s);
      const res = await as(disputeApp, await admin())
        .post(`/dispute-orders/${s.orderId}/resolve`).send({ decision: 'CANCEL_ORDER', resolution: 'no payout' });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      await expectRefunded(s, before);
    });

    it('release to the member, not yet confirmed', async () => {
      const s = await sell({ state: 'DISPUTED' });
      const before = await snapshot(s);
      const res = await as(disputeApp, await admin())
        .post(`/dispute-orders/${s.orderId}/resolve`).send({ decision: 'RELEASE_TO_MERCHANT', resolution: 'payout seen' });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      await expectReleased(s, before);
    });

    it('release to the member, HELD', async () => {
      const s = await sell({ state: 'DISPUTED', held: true });
      const before = await snapshot(s);
      const res = await as(disputeApp, await admin())
        .post(`/dispute-orders/${s.orderId}/resolve`).send({ decision: 'RELEASE_TO_MERCHANT', resolution: 'payout seen' });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      await expectReleased(s, before);
    });
  });

  // ── The member's own confirm, with the hold switched off ─────────────────
  // `withdrawalHoldMinutes` is admin-editable down to 0. That path completed the
  // order FIRST and then released the stake and credited the merchant — a write
  // after the commit. It now takes the held path with a window that is already
  // over and settles through `settleHold`, money before status.
  describe('the member confirm with the hold disabled', () => {
    let restoreSuiteHold = null;
    beforeAll(async () => {
      restoreSuiteHold = (await getSystemConfig({ fresh: true }))?.withdrawalHoldMinutes ?? null;
      await applySystemConfig({ withdrawalHoldMinutes: 0 });
    }, 60_000);
    // Outside any assertion (trap 10): the config row is shared by every suite.
    afterAll(async () => {
      if (restoreSuiteHold !== null) await applySystemConfig({ withdrawalHoldMinutes: restoreSuiteHold });
    });

    it('settles both sides before the order reads COMPLETED', async () => {
      const s = await sell({ state: 'PROCESSING' });
      const before = await snapshot(s);
      const res = await as(merchantApp, s.merchant).post(`/confirm/${s.orderId}`).send({});
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      await expectReleased(s, before);
      expect((await getOrderRecord(s.orderId)).merchantCreditStatus).toBe('RELEASED');
    });
  });
});
