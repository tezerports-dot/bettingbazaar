// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * An order nobody ever took, and the money it was holding.
 *
 * ── The defect this covers ─────────────────────────────────────────────────
 * `expires_at` is set at ASSIGNMENT, not at creation. So an order no member
 * ever took had no deadline at all — and `findExpiredOrders` opened with
 * `expires_at IS NOT NULL`, which skipped it forever.
 *
 * `expireOrders` states in its own comment that PENDING_QUEUE was added to its
 * state list precisely so an unassigned WITHDRAWAL releases its escrow rather
 * than locking a player's money with nothing scheduled to free it. That fix was
 * made in one clause and cancelled by another in the same query: the state list
 * admitted the order, the deadline test threw it back out. Every check in this
 * repository was green.
 *
 * So the assertion that matters is not "the order was cancelled" — it is that
 * the MONEY CAME BACK. An order tidied away while the escrow stays locked is
 * the same defect wearing a cancelled status. Since 2c a buy holds money too —
 * its team's pool tokens, from the moment it is assigned — so an expired buy
 * must give the team its tokens back by the same reasoning.
 *
 * ── Whose window ────────────────────────────────────────────────────────────
 * The wait is `SystemConfig.teamRouting.assignmentWaitSeconds` (there is no
 * payment-mode policy any more). `findExpiredOrders` is handed it by the
 * caller, and `expireOrders` is that caller — so the repository is asserted
 * with a one-second window, and the sweep is asserted against the admin's
 * value, which is the only way to prove the sweep reads it.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pgConfigured, pgQuery, applySchema, closePg, withTransaction } from '#db/client.js';
import {
  createOrderRecord, getOrderRecord, findExpiredOrders, setOrderFields,
} from '#db/repositories/orders.record.js';
import { getBalancesPaise } from '#db/repositories/wallets.core.js';
import { updateUser } from '#db/repositories/users.js';
import { getPool } from '#db/repositories/teamPools.js';
import { getTreasuryBalances, ACCOUNTS } from '#db/repositories/treasury.js';
import { getSystemConfig, applySystemConfig } from '#db/repositories/config.js';
import { routingSettings } from '#db/repositories/teamRouting.js';
import {
  expireOrders, createWithdrawalOrder, tryAssignMerchant,
} from '../../domains/payment/paymentProcessing.service.js';
import { teamFixture } from '../teamFixture.js';
import { actor, merchantActor } from './_harness.js';

const describePg = pgConfigured() ? describe : describe.skip;

describePg('the assignment window', () => {
  let seq = 0;
  let priorWait = null;
  const teams = teamFixture();
  const orders = [];
  const oid = () => `aw-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}-${seq += 1}`;

  /** The admin's wait, written the way the System Settings save writes it. */
  const setWait = (seconds) => applySystemConfig(
    { teamRouting: { assignmentWaitSeconds: seconds } }, { actor: 'assignment-window-suite' },
  );

  /**
   * Make an order `seconds` older. The clock is the thing under test, and a
   * queued order two minutes old is exactly what production holds two minutes
   * after creating one — so this moves the order's age, not its state.
   */
  const age = (orderId, seconds) => pgQuery(
    `UPDATE order_states SET created_at = created_at - make_interval(secs => $2) WHERE order_id = $1`,
    [orderId, seconds],
  );

  beforeAll(async () => {
    await applySchema();
    priorWait = routingSettings(await getSystemConfig()).assignmentWaitSeconds;
    // Nobody is online until a test puts its own member on: a queued order
    // here must stay queued.
    await teams.onlyOnline([]);
  }, 60_000);

  afterAll(async () => {
    // Trap 10: the admin's window goes back to what this suite found.
    if (priorWait !== null) await setWait(priorWait);
    await withTransaction(async (c) => {
      await c.query('SET LOCAL session_replication_role = replica');
      await c.query('DELETE FROM order_transitions WHERE order_id = ANY($1)', [orders]);
      await c.query('DELETE FROM order_states WHERE order_id = ANY($1)', [orders]);
    });
    await teams.cleanup();
    await closePg();
  });

  /** A buy nobody has taken: queued, with NO deadline — what creation leaves. */
  const unassignedBuy = async (player) => {
    const orderId = oid();
    orders.push(orderId);
    await createOrderRecord({
      orderId, userId: player.userId, type: 'DEPOSIT',
      tokenAmountRupees: 1000, fiatAmountRupees: 1000,
    });
    return orderId;
  };

  /** A player who can withdraw: bank details, and winnings. */
  const withdrawer = async (winningsRupees) => {
    const player = await actor({});
    await updateUser(player.userId, {
      bankDetails: {
        accountNumber: '000111222333', ifscCode: 'HDFC0000001',
        bankName: 'HDFC Bank', accountHolderName: 'Test Player',
      },
    });
    const { creditWinnings } = await import('../../domains/wallet/walletAuthority.service.js');
    await creditWinnings(player.userId, winningsRupees, 'assignment window suite seed', 'Test',
      `aw_seed_${player.userId}`, `aw_seed_${player.userId}`);
    return player;
  };

  it('leaves an order alone while it is still inside the window', async () => {
    const orderId = await unassignedBuy(await actor({}));

    // Fresh, and with no deadline of its own — the state that used to be
    // permanent. It must NOT be swept yet: expiring an order a member could
    // still take cancels work that was going to happen.
    const due = await findExpiredOrders({ limit: 500, assignmentWaitSeconds: 1 });
    expect(due.map((o) => o.orderId)).not.toContain(orderId);
    expect((await getOrderRecord(orderId)).status).toBe('PENDING_QUEUE');
  });

  it('finds an order that has waited out the window and has no deadline', async () => {
    const orderId = await unassignedBuy(await actor({}));

    const due = await findExpiredOrders({ limit: 500, assignmentWaitSeconds: 1 });
    await new Promise((r) => setTimeout(r, 1200));
    const dueAfter = await findExpiredOrders({ limit: 500, assignmentWaitSeconds: 1 });

    // Before the second it had not aged out; after it, it has.
    expect(due.map((o) => o.orderId)).not.toContain(orderId);
    expect(dueAfter.map((o) => o.orderId)).toContain(orderId);
  });

  it('the sweep waits as long as the admin says, and no longer', async () => {
    // Two minutes old. Under a one-hour window it is not due; under the
    // shortest window the spec allows (60 s) it is. A sweep that ignored the
    // setting — reading a fallback, or nothing — gets one of the two wrong.
    const orderId = await unassignedBuy(await actor({}));
    await age(orderId, 120);

    await setWait(3600);
    await expireOrders();
    expect((await getOrderRecord(orderId)).status).toBe('PENDING_QUEUE');

    await setWait(60);
    await expireOrders();
    const row = await getOrderRecord(orderId);
    expect(row.status).toBe('CANCELLED');
    expect(row.cancelReason).toBe('EXPIRED');
  });

  it('gives the player their tokens back — not just a cancelled status', async () => {
    const player = await withdrawer(5000);
    const before = await getBalancesPaise(player.userId);

    // The real withdrawal path: the stake is locked in the same transaction
    // that writes the order, and with nobody online the order waits queued.
    const { order } = await createWithdrawalOrder(player.userId, 1000);
    orders.push(order.orderId);
    const locked = await getBalancesPaise(player.userId);
    expect(locked.lockedBalance - before.lockedBalance).toBe(1000_00);
    expect((await getOrderRecord(order.orderId)).status).toBe('PENDING_QUEUE');

    // Waited out the default window — nobody ever took it.
    await setWait(priorWait);
    await age(order.orderId, priorWait + 60);
    await expireOrders();

    expect((await getOrderRecord(order.orderId)).status).toBe('CANCELLED');
    // THE assertion. An order tidied away with the escrow still locked is the
    // same defect wearing a cancelled status.
    const after = await getBalancesPaise(player.userId);
    expect(after.lockedBalance).toBe(before.lockedBalance);
    expect(after.winningsBalance).toBe(before.winningsBalance);
  });

  it('gives the team its held tokens back when an assigned buy runs out of time', async () => {
    // A buy holds its team's tokens from the moment it is assigned. The player
    // never paid, so the hold must end — or the team's capacity shrinks by one
    // order every time somebody walks away from a purchase.
    const member = await merchantActor();
    const team = await teams.workingTeam({ rail: 'UPI_BANK', poolTokens: 50_000, include: [member.merchantId] });
    const player = await actor({});
    const orderId = oid();
    orders.push(orderId);
    const order = await createOrderRecord({
      orderId, userId: player.userId, type: 'DEPOSIT',
      tokenAmountRupees: 20_000, fiatAmountRupees: 20_000,
    });
    expect(await tryAssignMerchant(order)).toBe(true);
    expect(await getPool(team.teamId)).toMatchObject({ availablePaise: 30_000_00, heldPaise: 20_000_00 });
    const floatBefore = (await getTreasuryBalances())[ACCOUNTS.TEAM_FLOAT];

    // Its processing deadline passes — the deadline assignment wrote, moved
    // to the past rather than waited for.
    await setOrderFields(orderId, { expiresAt: new Date(Date.now() - 60_000) });
    await expireOrders();

    const row = await getOrderRecord(orderId);
    expect(row.status).toBe('CANCELLED');
    expect(row.poolHeldPaise).toBe(0);
    expect(await getPool(team.teamId)).toMatchObject({ availablePaise: 50_000_00, heldPaise: 0 });
    // Nothing left the team: the tokens went back to `available`, not anywhere else.
    expect((await getTreasuryBalances())[ACCOUNTS.TEAM_FLOAT]).toBe(floatBefore);
    // And the player was given nothing for a buy they never paid for.
    const wallet = await getBalancesPaise(player.userId);
    expect(wallet.depositBalance + wallet.reserveBalance).toBe(0);
  });
});
