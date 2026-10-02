// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * A disputed withdrawal must not settle itself while the dispute is open.
 *
 * ── What the hold is for ────────────────────────────────────────────────────
 * On a sell, the member asserting they sent the money settles NOTHING. The
 * order reaches PAID, the team's credit is HELD, the player's stake stays
 * locked, and a worker settles it once the window passes — crediting the
 * TEAM'S POOL (PROJECT_STATUS §3.10, 2c) and consuming the stake. That gap is
 * the whole design: until it closes neither side has moved, so a dispute is a
 * REVERSAL rather than a clawback.
 *
 * The player's reason for disputing a sell is precisely this: the member
 * clicked paid and nothing arrived in their bank.
 *
 * ── What is being checked ───────────────────────────────────────────────────
 * The dispute writes `disputeReason`, `disputeRaisedAt` and `disputeRaisedBy`
 * and moves the state. It does NOT touch `merchantCreditStatus` or
 * `merchantCreditHoldUntil` — so the question this file answers is whether
 * raising a dispute actually stops the money, or only records that somebody
 * objected while the worker pays the pool on schedule anyway. "Stops the
 * money" is asserted on both sides: the player's lock, and the pool plus the
 * order's treasury legs.
 *
 * ── The withdrawals are real ones ───────────────────────────────────────────
 * Created by `createWithdrawalOrder` (the stake locked in the same transaction
 * as the order), routed to a member of a working CASH team, accepted and
 * confirmed on the member's own routes (§32 S16). The only thing moved by hand
 * is the clock: the hold deadline is put behind us, as an hour passing would.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pgConfigured, applySchema, closePg, pgQuery, withTransaction } from '#db/client.js';
import { getOrderRecord, setOrderFields, findDueHolds } from '#db/repositories/orders.record.js';
import { getBalancesPaise } from '#db/repositories/wallets.core.js';
import { updateUser } from '#db/repositories/users.js';
import { getPool } from '#db/repositories/teamPools.js';
import { creditWinnings } from '../../domains/wallet/walletAuthority.service.js';
import { createWithdrawalOrder } from '../../domains/payment/paymentProcessing.service.js';
import { settleDueHolds, settleHold } from '../../domains/payment/withdrawalHold.service.js';
import { teamFixture } from '../teamFixture.js';
import { mountRouter, actor, merchantActor, as } from './_harness.js';

const describePg = pgConfigured() ? describe : describe.skip;

describePg('a disputed withdrawal hold', () => {
  let playerApp; let merchantApp;
  const RUN = Math.random().toString(36).slice(2, 8);
  let seq = 0;
  const teams = teamFixture();
  const made = [];

  beforeAll(async () => {
    await applySchema();
    playerApp = mountRouter((await import('../../domains/payment/payment.routes.js')).default);
    merchantApp = mountRouter((await import('../../domains/merchant/merchant.routes.js')).default);
  }, 60_000);

  afterAll(async () => {
    // Trap 10: this run's orders, then its teams (append-only transitions, so
    // with replication triggers off, inside one transaction).
    await withTransaction(async (c) => {
      await c.query('SET LOCAL session_replication_role = replica');
      await c.query('DELETE FROM order_transitions WHERE order_id = ANY($1)', [made]);
      await c.query('DELETE FROM order_states WHERE order_id = ANY($1)', [made]);
    });
    await teams.cleanup();
    await closePg();
  });

  /** What the treasury moved for ONE order, account → paise. */
  const legsFor = async (orderId) => {
    const { rows } = await pgQuery(
      `SELECT account, SUM(amount_paise)::bigint AS paise FROM treasury_entries
        WHERE ref_id = $1 GROUP BY account`, [orderId]);
    return Object.fromEntries(rows.map((r) => [r.account, Number(r.paise)]));
  };

  /**
   * A sell the member has asserted they paid: PAID, credit HELD, and the hold
   * deadline already in the past so the worker considers it due right now.
   */
  const heldWithdrawal = async () => {
    seq += 1;
    const who = await actor({});
    const merchant = await merchantActor({});
    const team = await teams.workingTeam({ rail: 'CASH', include: [merchant.merchantId] });

    // The stake is ACTUALLY LOCKED, and that is not fixture decoration.
    //
    // The first version of this file set `escrowLocked: true` on the row and
    // left `lockedBalance` at zero. Every test passed — and all of them passed
    // for the WRONG REASON: `settleHold` reached `releaseWithdrawal`, which
    // threw `lockedBalance would go negative`, so the settlement reversed and
    // the assertions read that as the dispute having stopped it. In production,
    // where the stake is real, it would have proceeded.
    //
    // That is §0.5's lesson landing on this very file: a green result is not
    // evidence until you know what made it green. Admission locks it here,
    // exactly as a player's withdrawal does.
    await updateUser(who.userId, {
      bankDetails: { accountNumber: '000111222333', ifscCode: 'TEST0000001', bankName: 'Test Bank', accountHolderName: 'Hold Test' },
    });
    await creditWinnings(who.userId, 1000, 'hold test float', 'Test', `hf-${RUN}-${seq}`, `hf_${RUN}_${seq}`);
    const { orderId } = (await createWithdrawalOrder(who.userId, 1000)).order;
    made.push(orderId);
    expect((await getOrderRecord(orderId)).merchantId, 'routed to somebody else').toBe(merchant.merchantId);

    expect((await as(merchantApp, merchant).post(`/accept/${orderId}`)).status).toBe(200);
    const confirmed = await as(merchantApp, merchant).post(`/confirm/${orderId}`);
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
    // The window passes.
    await setOrderFields(orderId, { merchantCreditHoldUntil: new Date(Date.now() - 60 * 1000) });
    return { orderId, who, team };
  };

  it('is picked up by the worker as due — the precondition', async () => {
    // Establishes that the fixture reaches the worker at all, so a green result
    // below cannot mean "nothing was ever going to happen anyway".
    const { orderId } = await heldWithdrawal();

    const row = await getOrderRecord(orderId);
    expect(row.state).toBe('PAID');
    expect(row.merchantCreditStatus).toBe('HELD');
    expect(new Date(row.merchantCreditHoldUntil).getTime()).toBeLessThan(Date.now());
    expect((await findDueHolds({ limit: 500 })).map((o) => o.orderId)).toContain(orderId);
    // And the stake is genuinely locked, so a settlement that reaches
    // `releaseWithdrawal` can actually complete rather than throwing.
    const bal = await getBalancesPaise(row.userId);
    expect(bal.lockedBalance, 'the fixture never locked a stake').toBe(100_000);
    // Nothing has moved yet: the pool is credited by settlement, not by confirm.
    expect(await legsFor(orderId)).toEqual({});
  });

  it('DOES NOT SETTLE once the player has disputed it', async () => {
    const { orderId, who, team } = await heldWithdrawal();

    const raised = await as(playerApp, who).post(`/order/${orderId}/dispute`)
      .send({ reason: 'The member marked this sent and nothing reached my bank.' });
    expect(raised.status, raised.body?.message).toBe(200);
    expect((await getOrderRecord(orderId)).state).toBe('DISPUTED');

    const before = await getBalancesPaise(who.userId);
    const poolBefore = await getPool(team.teamId);
    await settleDueHolds({ limit: 200 });
    const after = await getOrderRecord(orderId);

    // The assertion that matters, written as the CORRECT expectation so it
    // fails until the behaviour is right rather than freezing what it is.
    expect(
      after.merchantCreditStatus,
      'the worker settled a withdrawal the player is disputing — the hold exists '
      + 'so a dispute is a reversal rather than a clawback, and settling it makes '
      + 'the dispute about money that has already moved',
    ).not.toBe('RELEASED');

    // And the player's locked stake is still theirs to have returned…
    const bal = await getBalancesPaise(who.userId);
    expect(bal.lockedBalance).toBe(before.lockedBalance);
    expect(after.state).toBe('DISPUTED');
    // …and the team's pool was not paid for a payout nobody has seen arrive.
    expect(await getPool(team.teamId)).toEqual(poolBefore);
    expect(await legsFor(orderId)).toEqual({});
  });

  it('is refused by settleHold DIRECTLY, not only by the sweep', async () => {
    // The two guards are deliberately independent — the WHERE in `findDueHolds`
    // and the state gate `creditSellToPool` asks under the order's lock —
    // because `settleHold` is exported and callable on its own. Each covers the
    // other, which means a test that only drives the sweep cannot tell you when
    // one of them regresses. This one names the second.
    const { orderId, who, team } = await heldWithdrawal();
    const poolBefore = await getPool(team.teamId);

    const raised = await as(playerApp, who).post(`/order/${orderId}/dispute`)
      .send({ reason: 'Marked sent, nothing arrived.' });
    expect(raised.status, raised.body?.message).toBe(200);

    expect(await settleHold(orderId), 'settleHold settled a disputed withdrawal').toBe(false);
    expect((await getOrderRecord(orderId)).merchantCreditStatus).toBe('HELD');
    expect(await getPool(team.teamId)).toEqual(poolBefore);
    expect(await legsFor(orderId)).toEqual({});
  });

  it('an UNDISPUTED hold still settles — the fix must not stop the ordinary case', async () => {
    // The mirror. A change that simply stops the worker settling anything would
    // pass the test above and break every honest payout.
    const { orderId, who, team } = await heldWithdrawal();
    const before = await getBalancesPaise(who.userId);
    const poolBefore = await getPool(team.teamId);

    await settleDueHolds({ limit: 200 });

    const after = await getOrderRecord(orderId);
    expect(after.merchantCreditStatus, 'an ordinary due hold did not settle').toBe('RELEASED');
    expect(after.state).toBe('COMPLETED');
    // Both sides: the player's stake is consumed, and the team's pool holds it.
    expect((await getBalancesPaise(who.userId)).lockedBalance).toBe(before.lockedBalance - 100_000);
    expect((await getPool(team.teamId)).availablePaise - poolBefore.availablePaise).toBe(100_000);
    expect(await legsFor(orderId)).toEqual({ TEAM_FLOAT: 100_000, USER_FLOAT: -100_000 });
  });
});
