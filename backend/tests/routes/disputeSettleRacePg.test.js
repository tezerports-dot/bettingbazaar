// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * A dispute raised WHILE the hold worker is settling that withdrawal.
 *
 * `disputedHoldPg` proves a withdrawal disputed BEFORE the worker looks at it
 * does not settle: `findDueHolds` excludes DISPUTED in its WHERE and
 * `settleHold` repeats the check. Both are READS. This file asks §0.5's second
 * question of them — is the check a snapshot or a guarantee — by putting the
 * dispute in the gap between `settleHold` reading the order and the settlement
 * committing, and then asking what the row says and where the money went.
 *
 * Settling a sell credits the TEAM'S POOL (PROJECT_STATUS §3.10, 2c), and the
 * guarantee is `creditSellToPool`'s gate: it asks for PAID under the ORDER's
 * row lock, the same lock the dispute's transition takes. So the gap is made
 * deterministic, not hoped for, on that lock: the test holds the order row,
 * the player's dispute queues on it FIRST, and the worker — having already
 * read the order as PAID — queues on it SECOND. A row lock is granted in the
 * order it was asked for, so when the test lets go the dispute commits, and the
 * worker's gate then reads what the dispute wrote.
 *
 * The withdrawals are real ones: created by `createWithdrawalOrder`, routed to
 * a member of a working team, accepted and confirmed on the member's routes
 * (§32 S16). Only the clock is moved by hand.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pgConfigured, applySchema, closePg, pgQuery, withTransaction } from '#db/client.js';
import { getOrderRecord, setOrderFields } from '#db/repositories/orders.record.js';
import { getBalancesPaise } from '#db/repositories/wallets.core.js';
import { updateUser } from '#db/repositories/users.js';
import { getPool } from '#db/repositories/teamPools.js';
import { creditWinnings } from '../../domains/wallet/walletAuthority.service.js';
import { createWithdrawalOrder } from '../../domains/payment/paymentProcessing.service.js';
import { settleHold } from '../../domains/payment/withdrawalHold.service.js';
import { teamFixture } from '../teamFixture.js';
import { mountRouter, actor, merchantActor, as } from './_harness.js';

// Every sell is paid by bank transfer, so the member gives its UTR (2d).
let payoutSeq = 0;
const payoutUtr = () => `UTRDS${String(Date.now()).slice(-7)}${String(++payoutSeq).padStart(4, '0')}`;

const describePg = pgConfigured() ? describe : describe.skip;

/**
 * Resolve, with its pid, once a backend running a statement matching `like` is
 * queued behind one of `behind` — this test's own lock holder, or a waiter
 * already queued behind it.
 *
 * Scoped by who blocks it, not by the statement's text alone: pg_stat_activity
 * lists every session on the SERVER, and the text carries `$1`, not the order.
 * Unscoped, any other session waiting on a lock with similar text (another
 * suite, another database on the same server) stood in for the dispute, the
 * worker queued on the order first, and settled it: "the worker settled a
 * withdrawal disputed in the gap".
 */
async function untilBlocked(like, behind, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { rows } = await pgQuery(
      `SELECT pid FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE $1
          AND pg_blocking_pids(pid) && $2::int[]
        LIMIT 1`,
      [like, behind]);
    if (rows.length) return rows[0].pid;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`nothing blocked on ${like} within ${timeoutMs}ms — the interleaving never happened`);
}

describePg('a dispute that lands while the hold is being settled', () => {
  let playerApp; let merchantApp;
  const RUN = Math.random().toString(36).slice(2, 8);
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

  let seq = 0;
  /** A due held withdrawal with a genuinely locked stake (see disputedHoldPg). */
  const dueHold = async () => {
    seq += 1;
    const who = await actor({});
    const m = await merchantActor({});
    const team = await teams.workingTeam({ rail: 'CASH', include: [m.merchantId] });
    await updateUser(who.userId, {
      bankDetails: { accountNumber: '000111222333', ifscCode: 'TEST0000001', bankName: 'Test Bank', accountHolderName: 'Race Test' },
    });
    await creditWinnings(who.userId, 1000, 'race float', 'Test', `rf-${RUN}-${seq}`, `rf_${RUN}_${seq}`);
    const { orderId } = (await createWithdrawalOrder(who.userId, 1000)).order;
    made.push(orderId);
    expect((await getOrderRecord(orderId)).merchantId, 'routed to somebody else').toBe(m.merchantId);
    expect((await as(merchantApp, m).post(`/accept/${orderId}`)).status).toBe(200);
    const confirmed = await as(merchantApp, m).post(`/confirm/${orderId}`).send({ utrNumber: payoutUtr() });
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
    // The window passes.
    await setOrderFields(orderId, { merchantCreditHoldUntil: new Date(Date.now() - 60 * 1000) });
    const row = await getOrderRecord(orderId);
    expect(row).toMatchObject({ state: 'PAID', merchantCreditStatus: 'HELD' });
    const lockedBefore = (await getBalancesPaise(who.userId)).lockedBalance;
    expect(lockedBefore, 'the fixture never locked a stake').toBe(100_000);
    return { m, who, team, orderId, lockedBefore };
  };

  /**
   * Hold one row lock in its own transaction until `unlock()` is called; `pid`
   * is the holding backend, which is what the waiters are found behind.
   */
  const holdRow = async (sql, params) => {
    let release;
    const released = new Promise((r) => { release = r; });
    let locked;
    const isLocked = new Promise((r) => { locked = r; });
    let pid;
    const done = withTransaction(async (client) => {
      pid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      await client.query(sql, params);
      locked();
      await released;
    });
    await isLocked;
    return { pid, unlock: async () => { release(); await done; } };
  };

  it('is not settled underneath, and is not erased from the dispute queue', async () => {
    const { who, team, orderId, lockedBefore } = await dueHold();
    const poolBefore = await getPool(team.teamId);

    // Hold the ORDER's row: the lock the dispute and the settlement gate share.
    const held = await holdRow('SELECT 1 FROM order_states WHERE order_id = $1 FOR UPDATE', [orderId]);

    // The player's dispute queues on it first…
    const raising = as(playerApp, who).post(`/order/${orderId}/dispute`)
      .send({ reason: 'Marked sent, nothing reached my bank.' }).then((r) => r);
    const disputing = await untilBlocked('%SELECT * FROM order_states WHERE order_id%FOR UPDATE%', [held.pid]);

    // …then the worker reads the order (PAID, not disputed) and queues behind
    // it. A later waiter on a row waits on the one ahead of it, so it is found
    // behind the holder or the dispute.
    const settling = settleHold(orderId);
    await untilBlocked('%SELECT team_id, token_amount_paise, order_type, state FROM order_states%FOR UPDATE%',
      [held.pid, disputing]);

    await held.unlock();
    const raised = await raising;
    expect(raised.status, raised.body?.message).toBe(200);
    expect(await settling, 'the worker settled a withdrawal disputed in the gap').toBe(false);

    const after = await getOrderRecord(orderId);
    // The dispute is still an open dispute — not written over with COMPLETED.
    expect(after.state, 'the settlement mirror wrote over an open dispute').toBe('DISPUTED');
    // And no money moved under it: the stake is still locked, the pool was not
    // credited. A dispute raised in time is a REVERSAL, not a clawback.
    expect(after.merchantCreditStatus, 'the worker settled a withdrawal disputed in time').not.toBe('RELEASED');
    expect((await getBalancesPaise(who.userId)).lockedBalance).toBe(lockedBefore);
    expect(await getPool(team.teamId)).toEqual(poolBefore);
    expect(await legsFor(orderId)).toEqual({});
  });

  it('a dispute landing AFTER the settlement committed stays an open dispute over money that moved', async () => {
    // The other interleaving. The pool credit commits (tokens to the team),
    // then the worker parks on the PLAYER's wallet — releasing their stake —
    // and the dispute lands before the order is mirrored. The money moving is
    // correct: the settlement won the lock first. Erasing the dispute is not.
    const { who, team, orderId } = await dueHold();
    const poolBefore = await getPool(team.teamId);

    const held = await holdRow('SELECT 1 FROM wallets WHERE user_id = $1 FOR UPDATE', [who.userId]);
    const settling = settleHold(orderId);
    await untilBlocked('%FROM wallets WHERE user_id%FOR UPDATE%', [held.pid]);

    const raised = await as(playerApp, who).post(`/order/${orderId}/dispute`)
      .send({ reason: 'Marked sent, nothing reached my bank.' });
    expect(raised.status, raised.body?.message).toBe(200);

    await held.unlock();
    await settling.catch(() => false);

    const after = await getOrderRecord(orderId);
    expect(after.state, 'the mirror wrote COMPLETED over a dispute raised after settlement').toBe('DISPUTED');
    // The credit status tells the truth about the money, so the admin who picks
    // the dispute up is resolving a clawback, not a hold.
    expect(after.merchantCreditStatus).toBe('RELEASED');
    expect((await getBalancesPaise(who.userId)).lockedBalance).toBe(0);
    // Both sides of what moved: into the team's pool, out of the players'.
    expect((await getPool(team.teamId)).availablePaise - poolBefore.availablePaise).toBe(100_000);
    expect(await legsFor(orderId)).toEqual({ TEAM_FLOAT: 100_000, USER_FLOAT: -100_000 });
  });
});
