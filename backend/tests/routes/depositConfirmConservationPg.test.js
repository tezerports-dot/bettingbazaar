// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * A confirmed buy moves the tokens ONCE: what the team's pool loses is exactly
 * what the player gains.
 *
 * ── Why this suite measures the TOTAL, not a pocket ────────────────────────
 * A team's tokens live in two pockets — `available`, and `held` for buys its
 * members were given — and a buy moves them twice over its life: `available →
 * held` in the transaction that assigns it (`teamRouting.assignToTeam`), and
 * `held → (the player)` when it completes (`teamPools.spendForBuy`).
 *
 * Asserting each pocket separately is how the merchant-wallet version of this
 * stayed green while charging twice (F-026): "held down by the order" and
 * "available down by the order" each read as a correct statement about one
 * pocket, and together they say the buy was paid for twice. So this measures
 * the figure that cannot be argued with — the pool's total against the
 * player's total, across the whole life of the order — and the treasury's two
 * floats beside it, because TEAM_FLOAT must move with the pool or the books
 * stop closing.
 *
 * The second half is the consequence nobody would see until it happened: a
 * team whose whole pool is held for this one order has nothing in `available`,
 * so a second charge would be REFUSED — after the hold had been spent — and
 * the member could never confirm a buy the player had paid for.
 *
 * Every order here is built the way production builds one: created queued,
 * assigned by the real router (which takes the hold), and marked paid by the
 * player with a reference the registry claims. No row is staged in a state the
 * platform could not reach (§32 S16).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pgConfigured, applySchema, closePg, withTransaction } from '#db/client.js';
import { createOrderRecord, getOrderRecord } from '#db/repositories/orders.record.js';
import { getPool, spendForBuy } from '#db/repositories/teamPools.js';
import { getTreasuryBalances, ACCOUNTS } from '#db/repositories/treasury.js';
import { getBalances } from '../../domains/wallet/walletAuthority.service.js';
import { tryAssignMerchant, markOrderPaid } from '../../domains/payment/paymentProcessing.service.js';
import { disputeOrder } from '../../domains/payment/orderLifecycle.service.js';
import { teamFixture } from '../teamFixture.js';
import { mountRouter, actor, merchantActor, as } from './_harness.js';

const describePg = pgConfigured() ? describe : describe.skip;

// Above the cash ceiling (10,000 tokens), so these buys run on UPI_BANK and
// need no Ready press — the money is the subject here, not the machine.
const ORDER_TOKENS = 20_000;
const ORDER_PAISE = ORDER_TOKENS * 100;

/**
 * Every token the team holds, in paise — both pockets.
 *
 * A total that is not a finite number is a broken measurement, not a result:
 * `Number(undefined)` is NaN, and under `toBe` NaN equals NaN, which is how an
 * assertion on a key that does not exist passes for any value (§32 S40).
 */
const poolTotal = async (teamId) => {
  const p = await getPool(teamId);
  const total = p.availablePaise + p.heldPaise;
  if (!Number.isFinite(total)) throw new Error(`pool pockets unreadable: ${JSON.stringify(p)}`);
  return total;
};

/** Every token the player holds from a buy — the two pockets a deposit splits into. */
const playerCredited = async (userId) => {
  const w = await getBalances(userId);
  const total = Math.round((Number(w.depositBalance) + Number(w.reserveBalance)) * 100);
  if (!Number.isFinite(total)) throw new Error(`player pockets unreadable: ${JSON.stringify(w)}`);
  return total;
};

/** The two treasury accounts a buy moves between. */
const floats = async () => {
  const t = await getTreasuryBalances();
  return { team: t[ACCOUNTS.TEAM_FLOAT] ?? 0, user: t[ACCOUNTS.USER_FLOAT] ?? 0 };
};

describePg('a confirmed buy moves the tokens once', () => {
  let app;
  let seq = 0;
  const teams = teamFixture();
  const orders = [];
  const oid = () => `dcc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}-${seq += 1}`;
  const nextUtr = () => String(420000000000 + (seq * 7919) + Math.floor(Math.random() * 7000));

  beforeAll(async () => {
    await applySchema();
    app = mountRouter((await import('../../domains/merchant/merchant.routes.js')).default);
  }, 60_000);

  afterAll(async () => {
    // Trap 10: this run's orders go, then its teams (and their pool entries).
    await withTransaction(async (c) => {
      await c.query('SET LOCAL session_replication_role = replica');
      await c.query('DELETE FROM order_transitions WHERE order_id = ANY($1)', [orders]);
      await c.query('DELETE FROM order_states WHERE order_id = ANY($1)', [orders]);
    });
    await teams.cleanup();
    await closePg();
  });

  /**
   * A PAID buy, held in its team's pool exactly as assignment holds it.
   * `poolTokens` is what the team owns before the order arrives.
   */
  const heldPaidBuy = async ({ poolTokens }) => {
    const member = await merchantActor();
    const team = await teams.workingTeam({ rail: 'UPI_BANK', poolTokens, include: [member.merchantId] });
    const player = await actor({});
    const orderId = oid();
    orders.push(orderId);
    const order = await createOrderRecord({
      orderId, userId: player.userId, type: 'DEPOSIT',
      tokenAmountRupees: ORDER_TOKENS, fiatAmountRupees: ORDER_TOKENS,
    });
    expect(await tryAssignMerchant(order), 'the router did not assign the buy').toBe(true);
    const assigned = await getOrderRecord(orderId);
    expect(assigned).toMatchObject({ merchantId: member.merchantId, teamId: team.teamId, poolHeldPaise: ORDER_PAISE });
    expect((await markOrderPaid(player.userId, orderId, nextUtr())).status).toBe('PAID');
    return { member, player, orderId, team };
  };

  it('the pool loses exactly what the player gains, and the treasury moves with it', async () => {
    const { member, player, orderId, team } = await heldPaidBuy({ poolTokens: 50_000 });
    // Measured AFTER the hold: the hold moves tokens between the pool's own
    // pockets and changes nothing about how many it owns.
    const poolBefore = await poolTotal(team.teamId);
    const playerBefore = await playerCredited(player.userId);
    const floatsBefore = await floats();

    const res = await as(app, member).post(`/confirm/${orderId}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await getOrderRecord(orderId)).status).toBe('COMPLETED');

    const lost = poolBefore - await poolTotal(team.teamId);
    const gained = await playerCredited(player.userId) - playerBefore;
    expect(gained).toBe(ORDER_PAISE);
    expect(lost, 'the pool paid more than the player received').toBe(gained);

    // The books: TEAM_FLOAT → USER_FLOAT, once, by the order's amount.
    const floatsAfter = await floats();
    expect(floatsBefore.team - floatsAfter.team).toBe(ORDER_PAISE);
    expect(floatsAfter.user - floatsBefore.user).toBe(ORDER_PAISE);
  });

  it('a team whose whole pool is held for this order can still confirm it', async () => {
    // Exactly enough for the one order: after the hold, `available` is empty
    // and every token the team owns is held for THIS player.
    const { member, player, orderId, team } = await heldPaidBuy({ poolTokens: ORDER_TOKENS });
    expect(await getPool(team.teamId)).toMatchObject({ availablePaise: 0, heldPaise: ORDER_PAISE });

    const res = await as(app, member).post(`/confirm/${orderId}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await getOrderRecord(orderId)).status).toBe('COMPLETED');
    expect(await playerCredited(player.userId)).toBe(ORDER_PAISE);
    expect(await getPool(team.teamId)).toMatchObject({ availablePaise: 0, heldPaise: 0 });
  });

  it('a retried confirm after the hold was spent charges nothing more', async () => {
    // The case `alreadyTaken` exists for: the hold is spent, then something
    // after it fails and the member presses confirm again. Reading "no live
    // hold" as "never held" would take the tokens a second time from
    // `available` — and this team has plenty there to take.
    const { member, player, orderId, team } = await heldPaidBuy({ poolTokens: 50_000 });
    expect(await spendForBuy(orderId)).toMatchObject({ ok: true, taken: 'hold' });
    const poolBefore = await poolTotal(team.teamId);
    const floatsBefore = await floats();

    const res = await as(app, member).post(`/confirm/${orderId}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await poolTotal(team.teamId)).toBe(poolBefore);
    expect((await floats()).team).toBe(floatsBefore.team);
    // The player's side had not moved yet, so the retry is what credits them.
    expect(await playerCredited(player.userId)).toBe(ORDER_PAISE);
  });

  // ── The other doors that complete — or end — a buy ───────────────────────
  // Every one goes through `moveDepositMoney` or `releaseBuyHold`. A door that
  // completed a buy by debiting `available` beside the hold would charge twice,
  // and on a fully-held team it would be REFUSED after the order completed.
  describe('the admin and dispute doors take the tokens once, from the hold', () => {
    let adminApp;
    let disputeApp;
    beforeAll(async () => {
      adminApp = mountRouter((await import('../../domains/payment/paymentOrder.routes.js')).default);
      disputeApp = mountRouter((await import('../../domains/disputes/disputeResolution.admin.routes.js')).default);
    }, 60_000);

    const admin = () => actor({ isAdmin: true });

    /** Held in a pool that owns exactly this order's tokens and nothing else. */
    const fullyHeld = async (state) => {
      const buy = await heldPaidBuy({ poolTokens: ORDER_TOKENS });
      if (state === 'DISPUTED') {
        // The player's dispute, through the transition the dispute route uses.
        const d = await disputeOrder(buy.orderId, {
          expectFrom: 'PAID',
          set: { disputeReason: 'conservation suite', disputeRaisedAt: new Date(), disputeRaisedBy: 'user' },
        });
        expect(d.ok).toBe(true);
      }
      buy.floatsBefore = await floats();
      return buy;
    };

    const expectPaidOnce = async ({ player, team, floatsBefore }) => {
      expect(await playerCredited(player.userId)).toBe(ORDER_PAISE);
      // Everything the team had went to the player, and not a token more: not
      // a second charge, not still held.
      expect(await getPool(team.teamId)).toMatchObject({ availablePaise: 0, heldPaise: 0 });
      const after = await floats();
      expect(floatsBefore.team - after.team).toBe(ORDER_PAISE);
      expect(after.user - floatsBefore.user).toBe(ORDER_PAISE);
    };

    it('an admin approval', async () => {
      const buy = await fullyHeld('PAID');
      const res = await as(adminApp, await admin())
        .post(`/payment-orders/${buy.orderId}/action`).send({ action: 'APPROVE', reason: 'paid' });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      await expectPaidOnce(buy);
    });

    it('a Payment Control Centre release', async () => {
      const buy = await fullyHeld('DISPUTED');
      const res = await as(adminApp, await admin())
        .post(`/payment-orders/${buy.orderId}/resolve`).send({ resolution: 'release', reason: 'payment seen' });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      await expectPaidOnce(buy);
    });

    it('a Dispute Manager release to the player', async () => {
      const buy = await fullyHeld('DISPUTED');
      const res = await as(disputeApp, await admin())
        .post(`/dispute-orders/${buy.orderId}/resolve`).send({ decision: 'RELEASE_TO_USER', resolution: 'payment seen' });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      await expectPaidOnce(buy);
    });

    // The opposite decision, on the same doors (§37 step 6): a buy that will
    // not be paid gives the team its tokens back and the player nothing. A
    // door that SPENT here would hand the team's tokens to nobody.
    it('a Dispute Manager cancellation gives the hold back to the pool, and the player nothing', async () => {
      const buy = await fullyHeld('DISPUTED');
      const res = await as(disputeApp, await admin())
        .post(`/dispute-orders/${buy.orderId}/resolve`).send({ decision: 'CANCEL_ORDER', resolution: 'no payment found' });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect((await getOrderRecord(buy.orderId)).status).toBe('CANCELLED');
      expect(await playerCredited(buy.player.userId)).toBe(0);
      expect(await getPool(buy.team.teamId)).toMatchObject({ availablePaise: ORDER_PAISE, heldPaise: 0 });
      const after = await floats();
      expect(after.team).toBe(buy.floatsBefore.team);
      expect(after.user).toBe(buy.floatsBefore.user);
    });

    it('an admin cancel of a PAID buy gives the hold back too', async () => {
      const buy = await fullyHeld('PAID');
      const res = await as(adminApp, await admin())
        .post(`/payment-orders/${buy.orderId}/action`).send({ action: 'CANCEL', reason: 'not paid' });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(await playerCredited(buy.player.userId)).toBe(0);
      expect(await getPool(buy.team.teamId)).toMatchObject({ availablePaise: ORDER_PAISE, heldPaise: 0 });
      expect((await floats()).team).toBe(buy.floatsBefore.team);
    });
  });
});
