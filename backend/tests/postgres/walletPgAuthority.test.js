// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * walletAuthority's operations, executed against Postgres.
 *
 * walletPg.test.js proves the primitives (row lock, negative guard, unique
 * tx_id). This file proves the LAYER ABOVE them: that each named operation
 * moves the right pockets, writes the ledger row the Mongo path would have
 * written under the same key, and reports the shape its callers read.
 *
 * The txId assertions are the ones that matter most. They are what makes a
 * rollback safe — the reverse mirror copies these rows into Mongo, where
 * `WalletLedger.findOne({ txId })` is the idempotency gate, so a key that
 * drifted from the Mongo format would let a rolled-back deployment replay
 * movements Postgres had already made.
 *
 * Real PostgreSQL, no MongoDB (see vitest.pg.config.ts).
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { pgConfigured, pgQuery, applySchema, closePg } from '../../postgres/pgClient.js';
import * as pg from '../../postgres/walletPgAuthority.js';
import { applyDeltaRupees } from '../../postgres/walletPg.js';

const hasPg = pgConfigured();
const describePg = hasPg ? describe : describe.skip;

const USER = 'pg-authority-user';

/** Every ledger row for the user, oldest first. */
async function ledger() {
  const { rows } = await pgQuery(
    `SELECT tx_id, field, amount_paise, balance_before_paise, balance_after_paise, tx_type, description
       FROM wallet_ledger WHERE user_id = $1 ORDER BY id`,
    [USER],
  );
  return rows;
}

/** Seed a balance without going through an operation under test. */
async function seed(field, rupees, key) {
  await applyDeltaRupees({ userId: USER, field, deltaRupees: rupees, txId: `seed_${key}` });
}

describePg('walletAuthority on Postgres', () => {
  beforeAll(async () => { await applySchema(); });
  afterAll(async () => { await closePg(); });
  beforeEach(async () => {
    await pgQuery('TRUNCATE wallets, wallet_ledger RESTART IDENTITY CASCADE');
  });

  // ── The ledger's storage contract ─────────────────────────────────────────
  describe('ledger row shape', () => {
    it('stores a positive magnitude with the direction in tx_type, like the forward mirror', async () => {
      await seed('winningsBalance', 100, 'a');
      await pg.lockWithdrawal(USER, 40, 'w1');

      const [, lock] = await ledger();
      // NOT -4000: WalletLedger.amount is a positive Number on the Mongo side,
      // and the reverse mirror copies this column straight into it.
      expect(lock.amount_paise).toBe('4000');
      expect(lock.tx_type).toBe('DEBIT');
    });

    it('records balance_before, which is required on the Mongo schema', async () => {
      await seed('depositBalance', 50, 'b');
      await pg.creditDeposit(USER, 25, 'order-1');

      const [, credit] = await ledger();
      expect(credit.balance_before_paise).toBe('5000');
      expect(credit.balance_after_paise).toBe('7500');
    });
  });

  // ── Credits ───────────────────────────────────────────────────────────────
  describe('credits', () => {
    it('creditDeposit uses the Mongo key format and reports before/after', async () => {
      const r = await pg.creditDeposit(USER, 250.75, 'ord-9');
      expect(r).toMatchObject({ depositBefore: 0, depositAfter: 250.75, txId: 'dep_complete_ord-9' });
      expect((await ledger())[0].tx_id).toBe('dep_complete_ord-9');
    });

    it('creditReserve credits the reserve pocket only', async () => {
      const r = await pg.creditReserve(USER, 30, 'ord-9');
      expect(r).toMatchObject({ reserveAfter: 30, txId: 'reserve_credit_ord-9' });
      expect(await pg.getBalances(USER)).toMatchObject({ reserveBalance: 30, depositBalance: 0 });
    });

    it('creditWinnings reports winningsAfter, which settlement reads', async () => {
      const r = await pg.creditWinnings(USER, 12.5, 'Bet win payout', 'Bet', null, 'win_bet1');
      expect(r.winningsAfter).toBe(12.5);
      expect(r.depositAfter).toBe(0);
    });

    it('refuses a credit with no idempotency key rather than inventing one', async () => {
      await expect(pg.creditWinnings(USER, 10, 'x', 'Bet', null, undefined))
        .rejects.toThrow(/requires a deterministic txId/);
    });

    it('replays a credit as a no-op', async () => {
      await pg.creditDeposit(USER, 100, 'ord-dup');
      const again = await pg.creditDeposit(USER, 100, 'ord-dup');
      expect(again).toEqual({ idempotent: true, txId: 'dep_complete_ord-dup' });
      expect((await pg.getBalances(USER)).depositBalance).toBe(100);
    });
  });

  // ── Spend order ───────────────────────────────────────────────────────────
  describe('debitForBet', () => {
    it('spends deposit first and lets winnings cover the shortfall', async () => {
      await seed('depositBalance', 30, 'c');
      await seed('winningsBalance', 100, 'd');

      const r = await pg.debitForBet(USER, 50, 'Bet ₹50', 'Bet', null, 'bet_x');
      expect(r.fromDeposit).toBe(30);
      expect(r.fromWinnings).toBe(20);
      expect(r.depositAfter).toBe(0);
      expect(r.winningsAfter).toBe(80);

      const rows = await ledger();
      expect(rows.map((x) => x.tx_id)).toEqual(['seed_c', 'seed_d', 'bet_x_dep', 'bet_x_win']);
    });

    it('writes only the _dep row when deposit covers the whole stake', async () => {
      await seed('depositBalance', 100, 'e');
      await pg.debitForBet(USER, 40, 'Bet ₹40', 'Bet', null, 'bet_y');
      expect((await ledger()).map((x) => x.tx_id)).toEqual(['seed_e', 'bet_y_dep']);
    });

    /**
     * The reason the spend-order split is decided under the row lock rather
     * than from an unlocked pre-read: after the first call, a REPLAY's freshly
     * computed split would draw nothing from deposit, write no `_dep` row, miss
     * the UNIQUE collision that makes a replay a no-op — and debit twice.
     */
    it('a replay whose split would differ is still refused', async () => {
      await seed('depositBalance', 30, 'f');
      await seed('winningsBalance', 100, 'g');
      await pg.debitForBet(USER, 50, 'Bet ₹50', 'Bet', null, 'bet_z');

      const replay = await pg.debitForBet(USER, 50, 'Bet ₹50', 'Bet', null, 'bet_z');
      expect(replay).toEqual({ idempotent: true, txId: 'bet_z' });
      expect(await pg.getBalances(USER)).toMatchObject({ depositBalance: 0, winningsBalance: 80 });
    });

    it('throws the same insufficient-balance error the Mongo path throws', async () => {
      await seed('depositBalance', 10, 'h');
      await expect(pg.debitForBet(USER, 50, 'Bet', 'Bet', null, 'bet_poor'))
        .rejects.toThrow(/Insufficient balance: have ₹10, need ₹50/);
      expect((await pg.getBalances(USER)).depositBalance).toBe(10);
    });

    it('never touches deposit for a withdrawal, only winnings', async () => {
      await seed('depositBalance', 500, 'i');
      await seed('winningsBalance', 20, 'j');
      await expect(pg.debitWinningsForWithdrawal(USER, 100, 'ord-w'))
        .rejects.toThrow(/Only winnings are withdrawable/);
      expect(await pg.getBalances(USER)).toMatchObject({ depositBalance: 500, winningsBalance: 20 });
    });
  });

  // ── Withdrawal lifecycle ──────────────────────────────────────────────────
  describe('withdrawal lifecycle', () => {
    it('lock moves winnings into locked under one ledger row', async () => {
      await seed('winningsBalance', 200, 'k');
      const r = await pg.lockWithdrawal(USER, 75, 'wd-1');

      expect(r).toMatchObject({ winningsAfter: 125, lockedAfter: 75, txId: 'wd_lock_wd-1' });
      // ONE row, not a from/to pair — this is what the forward mirror produced,
      // so it is what reconcile expects to find.
      expect((await ledger()).filter((x) => x.tx_id.startsWith('wd_lock'))).toHaveLength(1);
    });

    it('approve burns the locked amount and labels the row lockedBalance', async () => {
      await seed('winningsBalance', 200, 'l');
      await pg.lockWithdrawal(USER, 75, 'wd-2');
      const r = await pg.releaseWithdrawal(USER, 75, 'wd-2');

      expect(r.lockedAfter).toBe(0);
      const release = (await ledger()).find((x) => x.tx_id === 'wd_release_wd-2');
      // The Mongo counterpart labels this row `winningsBalance` while carrying
      // locked numbers. Copying that here would make the reverse mirror write
      // the locked figure into User.winningsBalance on a rollback.
      expect(release.field).toBe('lockedBalance');
    });

    it('reject returns the locked amount to winnings under the historical key', async () => {
      await seed('winningsBalance', 200, 'm');
      await pg.lockWithdrawal(USER, 75, 'wd-3');
      const r = await pg.refundWithdrawal(USER, 75, 'wd-3');

      expect(r).toMatchObject({ winningsAfter: 200, lockedAfter: 0, txId: 'refund_wd-3' });
    });

    it('rejects an approval that would drive locked negative', async () => {
      await seed('winningsBalance', 100, 'n');
      await pg.lockWithdrawal(USER, 10, 'wd-4');
      await expect(pg.releaseWithdrawal(USER, 40, 'wd-4b')).rejects.toThrow(/would go negative/);
      expect((await pg.getBalances(USER)).lockedBalance).toBe(10);
    });
  });

  // ── Bet stake lifecycle ───────────────────────────────────────────────────
  describe('bet stake lock', () => {
    const slices = (d, w, r) => [
      { field: 'depositBalance',  suffix: '_dep', amountPaise: d, reason: 'deposit portion' },
      { field: 'winningsBalance', suffix: '_win', amountPaise: w, reason: 'winnings portion' },
      { field: 'reserveBalance',  suffix: '_res', amountPaise: r, reason: 'reserve portion' },
    ].filter((s) => s.amountPaise > 0);

    it('moves every pocket and the provenance counters in one transaction', async () => {
      await seed('depositBalance', 100, 'o');
      await seed('winningsBalance', 100, 'p');
      await seed('reserveBalance', 100, 'q');

      const r = await pg.lockBetStake(USER, {
        amountPaise: 5000, txId: 'bet_abc', refId: null, slices: slices(2000, 2000, 1000),
      });
      expect(r.ok).toBe(true);

      expect(await pg.getBalances(USER)).toMatchObject({
        depositBalance: 80, winningsBalance: 80, reserveBalance: 90, lockedBalance: 50,
        // Provenance tracks deposit and winnings; the reserve slice has no
        // counter on the Mongo side, so it gets none here.
        lockedDepositAmount: 20, lockedWinningsAmount: 20,
      });
      expect((await ledger()).slice(3).map((x) => x.tx_id))
        .toEqual(['bet_abc_dep', 'bet_abc_win', 'bet_abc_res']);
    });

    it('refuses the whole stake when one pocket is short — no partial debit', async () => {
      await seed('depositBalance', 100, 'r');
      const r = await pg.lockBetStake(USER, {
        amountPaise: 15000, txId: 'bet_short', refId: null, slices: slices(10000, 5000, 0),
      });

      expect(r).toMatchObject({ ok: false, insufficient: true });
      expect(await pg.getBalances(USER)).toMatchObject({ depositBalance: 100, lockedBalance: 0 });
    });

    it('unlock restores every pocket exactly', async () => {
      await seed('depositBalance', 100, 's');
      await seed('reserveBalance', 100, 't');
      await pg.lockBetStake(USER, {
        amountPaise: 3000, txId: 'bet_undo', refId: null, slices: slices(2000, 0, 1000),
      });
      await pg.unlockBetStake(USER, {
        amountPaise: 3000, txId: 'refund_bet_undo', refId: null, slices: slices(2000, 0, 1000),
      });

      expect(await pg.getBalances(USER)).toMatchObject({
        depositBalance: 100, reserveBalance: 100, lockedBalance: 0, lockedDepositAmount: 0,
      });
    });

    it('releaseLockedStake unwinds the provenance counters with the lock', async () => {
      await seed('depositBalance', 100, 'u');
      await pg.lockBetStake(USER, {
        amountPaise: 4000, txId: 'bet_settle', refId: null, slices: slices(4000, 0, 0),
      });
      await pg.releaseLockedStake(USER, {
        amount: 40, fromDeposit: 40, fromWinnings: 0,
        txId: 'unlock_lost_bet_settle', reason: 'Bet lost',
      });

      expect(await pg.getBalances(USER)).toMatchObject({
        lockedBalance: 0, lockedDepositAmount: 0, depositBalance: 60,
      });
    });

    /**
     * The Mongo path `$inc`s the provenance counters without a guard. Matching
     * that is deliberate: a stale split must not be able to strand a settled
     * stake in `locked` forever, which is the worse of the two failures.
     */
    it('lets a stale provenance split go negative rather than strand the stake', async () => {
      await seed('depositBalance', 100, 'v');
      await pg.lockBetStake(USER, {
        amountPaise: 4000, txId: 'bet_stale', refId: null, slices: slices(4000, 0, 0),
      });
      const r = await pg.releaseLockedStake(USER, {
        amount: 40, fromDeposit: 40, fromWinnings: 15, txId: 'unlock_stale', reason: 'x',
      });

      expect(r.lockedAfter).toBe(0);
      expect((await pg.getBalances(USER)).lockedWinningsAmount).toBe(-15);
    });
  });

  // ── Reads ─────────────────────────────────────────────────────────────────
  describe('getUserLedger', () => {
    it('pages newest-first in the shape the panels render', async () => {
      await seed('depositBalance', 10, 'w1');
      await seed('depositBalance', 20, 'w2');
      await seed('depositBalance', 30, 'w3');

      const page = await pg.getUserLedger(USER, 1, 2);
      expect(page.total).toBe(3);
      expect(page.pages).toBe(2);
      expect(page.entries).toHaveLength(2);
      expect(page.entries[0]).toMatchObject({
        txId: 'seed_w3', type: 'CREDIT', field: 'depositBalance',
        amount: 30, balanceBefore: 30, balanceAfter: 60,
      });
    });

    it('reports an empty history rather than throwing for an unknown user', async () => {
      expect(await pg.getUserLedger('nobody', 1, 10)).toMatchObject({ total: 0, pages: 0, entries: [] });
    });
  });

  // ── Concurrency ───────────────────────────────────────────────────────────
  describe('concurrency', () => {
    it('serialises concurrent stake locks so the pocket never overdraws', async () => {
      await seed('depositBalance', 100, 'x');

      const attempts = await Promise.all(
        Array.from({ length: 5 }, (_, i) => pg.lockBetStake(USER, {
          amountPaise: 3000, txId: `bet_race_${i}`, refId: null,
          slices: [{ field: 'depositBalance', suffix: '_dep', amountPaise: 3000, reason: 'race' }],
        })),
      );

      // ₹100 funds exactly three ₹30 stakes.
      expect(attempts.filter((a) => a.ok && !a.idempotent)).toHaveLength(3);
      expect(attempts.filter((a) => a.insufficient)).toHaveLength(2);
      expect(await pg.getBalances(USER)).toMatchObject({ depositBalance: 10, lockedBalance: 90 });
    });

    it('a movement and its replay racing produce exactly one movement', async () => {
      await seed('winningsBalance', 100, 'y');
      const results = await Promise.all(
        Array.from({ length: 6 }, () => pg.lockWithdrawal(USER, 25, 'wd-race')),
      );

      expect(results.filter((r) => r.idempotent)).toHaveLength(5);
      expect(await pg.getBalances(USER)).toMatchObject({ winningsBalance: 75, lockedBalance: 25 });
    });
  });
});
