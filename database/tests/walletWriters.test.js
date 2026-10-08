// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The order-facing wallet writers, against a REAL PostgreSQL.
 *
 * ── What this replaces, and why it is not the same test ─────────────────────
 * There was a unit suite over the same writers on the document-store path,
 * with the data layer MOCKED. It existed because a refactor had rewritten `refId:
 * orderId` to a shorthand `refId` at four call sites while declaring the
 * variable at one — so deposits, reserve credits and withdrawals all threw
 * ReferenceError inside the transaction, and every one of them returned 500.
 * `node --check` passed, the unit suite passed, the Postgres suite passed. Only
 * a suite that ran the real bodies caught it.
 *
 * The assertions are about the LEDGER ROW each writer produces, because that
 * row is the audit record. A wrong field there is not cosmetic — it is a money
 * movement nobody can afterwards explain.
 *
 * ── The writers changed shape (owner, 2026-10-07) ──────────────────────────
 * `creditDeposit`, `creditReserve` and `refundOrder` were standalone
 * transactions that moved a player's wallet with nothing on the other side.
 * The player's half of a team pool movement now runs INSIDE the transaction
 * that moves the pool and posts USER_FLOAT — `creditBuyWithin`,
 * `consumeWithdrawalStakeWithin`, `returnSettledStakeWithin` — because the
 * database refuses to commit one without the other. Here the caller playing
 * that part is the PLATFORM, releasing from its own holding, which is what it
 * does for a referral reward.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { pgConfigured, pgQuery, applySchema, closePg, getPool } from '../client.js';
import {
  creditBuyWithin, consumeWithdrawalStakeWithin, returnSettledStakeWithin,
  debitWinningsForWithdrawal, refundWithdrawal, creditWinnings, getBalances,
} from '../repositories/wallets.js';
import { lockWalletWithin, getBalancesPaise } from '../repositories/wallets.core.js';
import { ACCOUNTS, postMovement } from '../repositories/treasury.js';
import { refusedBy } from './_funding.js';

const describePg = pgConfigured() ? describe : describe.skip;
const USER = 'wallet-writer-user';
const ORDER = 'ord_12345';

/** The ledger rows for a transaction id, in write order. */
async function ledgerFor(txId) {
  const { rows } = await pgQuery(
    `SELECT tx_id, field, tx_type, amount_paise, balance_before_paise,
            balance_after_paise, description, ref_id
       FROM wallet_ledger WHERE tx_id = $1 ORDER BY id`, [txId]);
  return rows;
}

/**
 * The CALLER's half, which in production is `teamPools.js`: one transaction
 * that takes the wallet lock, runs the writer, and posts the USER_FLOAT leg
 * against the platform's holding. `userDeltaPaise` is what the wallet gains
 * (negative when it loses); 0 means the writer only moves the player's own
 * pockets and needs no leg at all.
 */
async function asPoolWould(movementId, userDeltaPaise, write) {
  const pool = await getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ctx = await lockWalletWithin(client, USER);
    const result = await write(ctx);
    if (userDeltaPaise) {
      const moved = await postMovement({
        client, movementId, operation: 'TEST_POOL_SIDE',
        legs: { [ACCOUNTS.TOKEN_SUPPLY]: 0 - userDeltaPaise, [ACCOUNTS.USER_FLOAT]: userDeltaPaise },
      });
      if (!moved.ok) throw new Error(`the test's own treasury leg was refused: ${moved.reason}`);
      if (moved.idempotent) throw new Error(`the test's own movement ${movementId} already existed`);
    }
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

describePg('the order-facing wallet writers (PostgreSQL)', () => {
  beforeAll(async () => { await applySchema(); });
  afterAll(async () => { await closePg(); });
  beforeEach(async () => {
    // The treasury goes too: USER_FLOAT describes these wallets, so resetting
    // one and not the other would leave the two disagreeing, and a movement id
    // surviving from an earlier run would replay as a no-op (trap 10).
    await pgQuery('TRUNCATE wallets, wallet_ledger, treasury_entries, treasury_accounts RESTART IDENTITY CASCADE');
  });

  describe('creditBuyWithin — a completed buy reaching the player', () => {
    it('splits by the order\'s own allocation and writes a row per pocket', async () => {
      const r = await asPoolWould(`m_${ORDER}`, 2500, (ctx) => creditBuyWithin(ctx, {
        orderId: ORDER, amountPaise: 2500,
        depositAllocationPaise: 2000, reserveAllocationPaise: 500,
      }));
      expect(r).toMatchObject({ ok: true, idempotent: false });
      expect(r.split).toEqual({ depositPaise: 2000, reservePaise: 500, split: true });

      const [dep] = await ledgerFor(`dep_complete_${ORDER}`);
      expect(dep).toMatchObject({ field: 'depositBalance', amount_paise: '2000', ref_id: ORDER });
      // The row must say what happened, in a form a human reading a dispute
      // can follow back to the order.
      expect(dep.description).toContain(ORDER);
      const [res] = await ledgerFor(`reserve_credit_${ORDER}`);
      expect(res).toMatchObject({ field: 'reserveBalance', amount_paise: '500' });
      expect(await getBalances(USER)).toMatchObject({ depositBalance: 20, reserveBalance: 5, winningsBalance: 0 });
    });

    it('credits the whole amount to deposit when the allocation does not add up', async () => {
      const r = await asPoolWould(`m_odd_${ORDER}`, 2500, (ctx) => creditBuyWithin(ctx, {
        orderId: `odd_${ORDER}`, amountPaise: 2500,
        depositAllocationPaise: 2000, reserveAllocationPaise: 100,
      }));
      expect(r.split).toEqual({ depositPaise: 2500, reservePaise: 0, split: false });
      expect((await getBalances(USER)).depositBalance).toBe(25);
    });

    it('is idempotent — a redelivered confirmation credits once', async () => {
      await asPoolWould(`m_${ORDER}`, 2500, (ctx) => creditBuyWithin(ctx, {
        orderId: ORDER, amountPaise: 2500, depositAllocationPaise: 2500, reserveAllocationPaise: 0,
      }));
      const again = await asPoolWould(`m_${ORDER}`, 0, (ctx) => creditBuyWithin(ctx, {
        orderId: ORDER, amountPaise: 2500, depositAllocationPaise: 2500, reserveAllocationPaise: 0,
      }));
      expect(again.idempotent).toBe(true);
      expect((await getBalances(USER)).depositBalance).toBe(25);
      expect(await ledgerFor(`dep_complete_${ORDER}`)).toHaveLength(1);
    });

    it('does NOT commit when the caller posts no USER_FLOAT leg', async () => {
      // The whole point: a credit with nothing on the other side is tokens
      // from nowhere, and it is the DATABASE that refuses it — not this
      // writer, not its caller.
      const refusal = await refusedBy(asPoolWould(`m_none_${ORDER}`, 0, (ctx) => creditBuyWithin(ctx, {
        orderId: `none_${ORDER}`, amountPaise: 2500,
        depositAllocationPaise: 2500, reserveAllocationPaise: 0,
      })));
      expect(refusal.constraint).toBe('bb_conservation_user_float');
      expect(await getBalances(USER)).toMatchObject({ depositBalance: 0 });
      expect(await ledgerFor(`dep_complete_none_${ORDER}`)).toHaveLength(0);
    });
  });

  describe('the withdrawal stake, both ways', () => {
    /** Winnings, honestly: the platform pays them out of its own holding. */
    const fund = (rupees, key) => creditWinnings(USER, rupees, 'Test funding', 'Test', key, `fund_${key}`);

    it('consumeWithdrawalStakeWithin takes the stake out of `locked`', async () => {
      await fund(50, 'k1');
      await debitWinningsForWithdrawal(USER, 30, ORDER);     // winnings -> locked
      expect(await getBalances(USER)).toMatchObject({ winningsBalance: 20, lockedBalance: 30 });

      const r = await asPoolWould(`m_sell_${ORDER}`, -3000, (ctx) => consumeWithdrawalStakeWithin(ctx, {
        orderId: ORDER, amountPaise: 3000,
      }));
      expect(r).toMatchObject({ ok: true, idempotent: false });
      const [row] = await ledgerFor(`wd_release_${ORDER}`);
      // The row names the balance that actually MOVED. Labelling it
      // `winningsBalance` while `locked` moved makes the ledger describe a
      // movement that did not happen.
      // Stored as a positive magnitude with the direction in `tx_type` — the
      // convention every sum-based check reads.
      expect(row).toMatchObject({ field: 'lockedBalance', tx_type: 'DEBIT', amount_paise: '3000' });
      expect(await getBalances(USER)).toMatchObject({ winningsBalance: 20, lockedBalance: 0 });
    });

    it('refuses to consume a stake that was already REFUNDED', async () => {
      await fund(50, 'k2');
      await debitWinningsForWithdrawal(USER, 30, ORDER);
      await refundWithdrawal(USER, 30, ORDER);               // locked -> winnings
      expect(await getBalances(USER)).toMatchObject({ winningsBalance: 50, lockedBalance: 0 });

      const r = await asPoolWould(`m_sell2_${ORDER}`, 0, (ctx) => consumeWithdrawalStakeWithin(ctx, {
        orderId: ORDER, amountPaise: 3000,
      }));
      // `excluded`, not `insufficient`: what is in `locked` now belongs to
      // other orders, and taking it would pay this sell out of theirs.
      expect(r).toMatchObject({ ok: false, excluded: `refund_${ORDER}` });
      expect(await getBalances(USER)).toMatchObject({ winningsBalance: 50 });
    });

    it('returnSettledStakeWithin gives a consumed stake back as winnings', async () => {
      await fund(50, 'k3');
      await debitWinningsForWithdrawal(USER, 30, ORDER);
      await asPoolWould(`m_sell_${ORDER}`, -3000, (ctx) => consumeWithdrawalStakeWithin(ctx, {
        orderId: ORDER, amountPaise: 3000,
      }));

      const r = await asPoolWould(`m_rev_${ORDER}`, 3000, (ctx) => returnSettledStakeWithin(ctx, {
        orderId: ORDER, amountPaise: 3000,
      }));
      expect(r).toMatchObject({ ok: true, idempotent: false });
      const [row] = await ledgerFor(`dispute_wd_refund_${ORDER}`);
      expect(row).toMatchObject({ field: 'winningsBalance', tx_type: 'CREDIT', amount_paise: '3000' });
      expect(await getBalances(USER)).toMatchObject({ winningsBalance: 50, lockedBalance: 0 });
    });

    it('refundWithdrawal refuses once the stake has been CONSUMED', async () => {
      await fund(50, 'k4');
      await debitWinningsForWithdrawal(USER, 30, ORDER);
      await asPoolWould(`m_sell_${ORDER}`, -3000, (ctx) => consumeWithdrawalStakeWithin(ctx, {
        orderId: ORDER, amountPaise: 3000,
      }));
      await expect(refundWithdrawal(USER, 30, ORDER)).rejects.toMatchObject({ status: 409 });
      expect(await getBalances(USER)).toMatchObject({ winningsBalance: 20 });
    });
  });

  describe('debitWinningsForWithdrawal', () => {
    it('takes from winnings and never from deposit', async () => {
      await asPoolWould('m_seed_dep', 10000, (ctx) => creditBuyWithin(ctx, {
        orderId: 'seed-dep', amountPaise: 10000, depositAllocationPaise: 10000, reserveAllocationPaise: 0,
      }));
      await creditWinnings(USER, 40, 'Test funding', 'Test', 'seed-win', 'fund_seed_win');

      await debitWinningsForWithdrawal(USER, 30, ORDER);
      const balances = await getBalances(USER);
      expect(balances.winningsBalance).toBe(10);
      // Deposit is NOT withdrawable. A withdrawal that reached into it would
      // pay out money the player was never entitled to take.
      expect(balances.depositBalance).toBe(100);
    });

    it('REFUSES to overdraw winnings, and moves nothing when it refuses', async () => {
      await creditWinnings(USER, 10, 'Test funding', 'Test', 'seed-small', 'fund_small');
      await expect(debitWinningsForWithdrawal(USER, 50, ORDER)).rejects.toThrow();
      expect((await getBalances(USER)).winningsBalance).toBe(10);
      expect(await ledgerFor(`wd_${ORDER}`)).toHaveLength(0);
    });
  });

  describe('every writer leaves the books explicable', () => {
    it('the ledger sums to the balance it produced', async () => {
      await asPoolWould('m_o1', 4000, (ctx) => creditBuyWithin(ctx, {
        orderId: 'o1', amountPaise: 4000, depositAllocationPaise: 2500, reserveAllocationPaise: 1500,
      }));
      await creditWinnings(USER, 15, 'Test funding', 'Test', 'o2', 'fund_o2');

      const { rows } = await pgQuery(
        `SELECT field, SUM(CASE WHEN amount_paise < 0 THEN amount_paise ELSE amount_paise END)::bigint AS net
           FROM wallet_ledger WHERE user_id = $1 GROUP BY field`, [USER]);
      const net = Object.fromEntries(rows.map((r) => [r.field, Number(r.net)]));

      const balances = await getBalancesPaise(USER);
      // A balance the ledger cannot explain is the P1 this whole design exists
      // to make impossible.
      expect(net.depositBalance).toBe(balances.depositBalance);
      expect(net.reserveBalance).toBe(balances.reserveBalance);
      expect(net.winningsBalance).toBe(balances.winningsBalance);
    });
  });
});
