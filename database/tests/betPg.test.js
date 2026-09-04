// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * The bet lifecycle — domain 5, against a REAL PostgreSQL.
 *
 * ── What is on trial ────────────────────────────────────────────────────────
 * Not "does the database work". The shape this replaced had two structural
 * defects, and
 * this domain exists to remove them rather than reproduce them somewhere
 * faster. Each gets tests that FAIL if it comes back:
 *
 *   M-2  the balance move has NO idempotency key. `bet.routes.js` hides it by
 *        minting `bet_<userId>_<randomUUID()>` per request — but a fresh id per
 *        attempt is not idempotency, it is a NEW BET, so a user whose
 *        connection dropped and retried ends up with two bets and two debits.
 *   M-4  the ledger is written OUTSIDE the transaction, best-effort, so money
 *        can move unaudited — and the ledger is what reconciliation is computed
 *        from, so the failure erases its own symptom.
 *
 * The invariants, asserted rather than a particular winner:
 *   • a bet's status and its money can never disagree — they commit or unwind
 *     together
 *   • one bet happens exactly once however many copies of the request arrive
 *   • a returned stake goes back to the pockets it CAME from
 *   • a settlement arriving twice, or after a void, is refused not obeyed
 *   • no balance ever moves without its ledger row
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { pgConfigured, pgQuery, applySchema, closePg, getPool } from '../client.js';
import { getBalancesPaise, applyDeltaPaise } from '../repositories/wallets.core.js';
import {
  BET_STATUS, placeBet, winBet, loseBet, voidBet, refundBet,
  getBet, getBetHistory, reconcileUserStakes, findBetsMissingStakeMovement,
  listSettleableBets,
} from '../repositories/bets.core.js';

const hasPg = pgConfigured();
const describePg = hasPg ? describe : describe.skip;

const U = 'pg-bet-user';

/** Fund a pocket directly, so a test starts from a known position. */
const fund = (field, paise, key, userId = U) =>
  applyDeltaPaise({ userId, field, deltaPaise: paise, txId: key, type: 'CREDIT', reason: 'test funding' });

const slice = (field, amountPaise) => ({ field, amountPaise });

const place = (betId, slices, extra = {}) =>
  placeBet({ betId, userId: U, cycleId: 'cyc1', side: 'DELHI', slices, ...extra });

const bal = (userId = U) => getBalancesPaise(userId);

/** Every wallet_ledger row this bet produced. */
const ledgerFor = async (betId) => {
  const { rows } = await pgQuery(
    `SELECT tx_id, field, amount_paise, tx_type FROM wallet_ledger WHERE ref_id = $1 ORDER BY tx_id`,
    [betId],
  );
  return rows;
};

describePg('Bet lifecycle (PostgreSQL)', () => {
  beforeAll(async () => { await applySchema(); });
  afterAll(async () => { await closePg(); });
  beforeEach(async () => {
    await pgQuery('TRUNCATE bet_transitions, bets, wallet_ledger, wallets RESTART IDENTITY CASCADE');
  });

  // ── Placement ─────────────────────────────────────────────────────────────
  describe('placing a bet', () => {
    it('moves the stake into locked and records the bet, in one transaction', async () => {
      await fund('depositBalance', 100_000, 'f1');

      const r = await place('bet1', [slice('depositBalance', 30_000)]);
      expect(r).toMatchObject({ ok: true, idempotent: false });

      expect(await bal()).toMatchObject({
        depositBalance: 70_000,
        lockedBalance: 30_000,
        // Provenance: how much of the locked total came from deposit. A return
        // needs this to put the money back where it belongs.
        lockedDepositAmount: 30_000,
      });
      expect((await getBet('bet1')).status).toBe(BET_STATUS.PENDING);
    });

    it('splits a stake across pockets and tracks each one', async () => {
      await fund('depositBalance', 50_000, 'f1');
      await fund('winningsBalance', 50_000, 'f2');

      await place('bet_split', [slice('depositBalance', 20_000), slice('winningsBalance', 10_000)]);

      expect(await bal()).toMatchObject({
        depositBalance: 30_000, winningsBalance: 40_000,
        lockedBalance: 30_000,
        lockedDepositAmount: 20_000, lockedWinningsAmount: 10_000,
      });
    });

    it('writes a ledger row per slice — no balance moves unaudited (M-4)', async () => {
      await fund('depositBalance', 50_000, 'f1');
      await fund('winningsBalance', 50_000, 'f2');
      await place('bet_aud', [slice('depositBalance', 20_000), slice('winningsBalance', 10_000)]);

      const rows = await ledgerFor('bet_aud');
      expect(rows).toHaveLength(2);
      expect(rows.map((r) => r.tx_id)).toEqual(['bet_aud_stake_depositBalance', 'bet_aud_stake_winningsBalance']);
      expect(rows.every((r) => r.tx_type === 'DEBIT')).toBe(true);
    });

    it('refuses a stake the user cannot cover, and moves nothing', async () => {
      await fund('depositBalance', 10_000, 'f1');

      expect(await place('bet_broke', [slice('depositBalance', 30_000)]))
        .toMatchObject({ ok: false, reason: 'insufficient' });

      // The whole transaction unwound: no bet row, no balance change.
      expect(await getBet('bet_broke')).toBeNull();
      expect(await bal()).toMatchObject({ depositBalance: 10_000, lockedBalance: 0 });
    });

    it('requires a betId — the key IS the idempotency (M-2)', async () => {
      await expect(placeBet({ userId: U, cycleId: 'c', side: 'X', slices: [slice('depositBalance', 1)] }))
        .rejects.toThrow(/betId/);
    });
  });

  // ── M-2: the defect this domain exists to remove ──────────────────────────
  describe('a bet happens once however many times the request arrives', () => {
    it('a replayed request debits NOTHING further', async () => {
      await fund('depositBalance', 100_000, 'f1');
      await place('bet_dup', [slice('depositBalance', 30_000)]);

      const again = await place('bet_dup', [slice('depositBalance', 30_000)]);
      expect(again).toMatchObject({ ok: true, idempotent: true });

      // The defect, in one number: 70,000 and not 40,000. The bare
      // $inc runs a second time and the user is charged twice for one bet.
      expect(await bal()).toMatchObject({ depositBalance: 70_000, lockedBalance: 30_000 });
      expect(await ledgerFor('bet_dup')).toHaveLength(1);
    });

    it('100 racing copies of one request place exactly one bet', async () => {
      await fund('depositBalance', 100_000, 'f1');

      const results = await Promise.all(
        Array.from({ length: 100 }, () => place('bet_storm', [slice('depositBalance', 30_000)])),
      );

      expect(results.every((r) => r.ok)).toBe(true);
      expect(results.filter((r) => !r.idempotent)).toHaveLength(1);
      expect(await bal()).toMatchObject({ depositBalance: 70_000, lockedBalance: 30_000 });
      expect(await getBetHistory('bet_storm')).toHaveLength(1);
    });

    it('different keys are different bets — idempotency must not collapse real ones', async () => {
      await fund('depositBalance', 100_000, 'f1');
      await place('bet_a', [slice('depositBalance', 30_000)]);
      await place('bet_b', [slice('depositBalance', 30_000)]);
      expect(await bal()).toMatchObject({ depositBalance: 40_000, lockedBalance: 60_000 });
    });
  });

  // ── Settlement ────────────────────────────────────────────────────────────
  describe('settling', () => {
    const stake = [slice('depositBalance', 30_000)];
    beforeEach(async () => {
      await fund('depositBalance', 100_000, 'f1');
      await place('b', stake);
    });

    it('a win consumes the stake and credits the payout as a SEPARATE movement', async () => {
      const r = await winBet({ betId: 'b', userId: U, slices: stake, payoutPaise: 60_000 });
      expect(r.ok).toBe(true);

      expect(await bal()).toMatchObject({
        depositBalance: 70_000,      // the stake is gone, not returned
        winningsBalance: 60_000,     // the payout
        lockedBalance: 0, lockedDepositAmount: 0,
      });

      // Two rows, not one net row. Netting them would make a won bet look like
      // a smaller loss and leave nobody able to audit the payout.
      const rows = await ledgerFor('b');
      expect(rows.map((r) => r.tx_id)).toContain('b_win');
      expect(rows.map((r) => r.tx_id)).toContain('b_payout');
    });

    it('a loss consumes the stake and pays nothing', async () => {
      await loseBet({ betId: 'b', userId: U, slices: stake });
      expect(await bal()).toMatchObject({
        depositBalance: 70_000, winningsBalance: 0, lockedBalance: 0, lockedDepositAmount: 0,
      });
      expect((await getBet('b')).status).toBe(BET_STATUS.LOST);
    });

    it('a void returns the stake to the pocket it CAME from', async () => {
      await voidBet({ betId: 'b', userId: U, slices: stake });
      // 100,000 again — and specifically in depositBalance.
      expect(await bal()).toMatchObject({
        depositBalance: 100_000, winningsBalance: 0, lockedBalance: 0, lockedDepositAmount: 0,
      });
    });

    it('a refund returns a SPLIT stake to each source pocket separately', async () => {
      await pgQuery('TRUNCATE bet_transitions, bets, wallet_ledger, wallets RESTART IDENTITY CASCADE');
      await fund('depositBalance', 50_000, 'g1');
      await fund('winningsBalance', 50_000, 'g2');
      const split = [slice('depositBalance', 20_000), slice('winningsBalance', 10_000)];
      await place('bs', split);

      await refundBet({ betId: 'bs', userId: U, slices: split });

      // Returning it all to one pocket would silently convert non-withdrawable
      // deposit into withdrawable winnings — a cash-out route, not a rounding
      // error. So this asserts the exact split, not just the total.
      expect(await bal()).toMatchObject({
        depositBalance: 50_000, winningsBalance: 50_000,
        lockedBalance: 0, lockedDepositAmount: 0, lockedWinningsAmount: 0,
      });
    });

    it('refuses to settle without the funding slices', async () => {
      // Defaulting them would mean guessing which pocket to return money to.
      await expect(voidBet({ betId: 'b', userId: U })).rejects.toThrow(/funding slices/);
    });

    it('refuses slices that do not add up to the stake', async () => {
      await expect(voidBet({ betId: 'b', userId: U, slices: [slice('depositBalance', 29_000)] }))
        .rejects.toThrow(/slices total 29000 paise but the stake is 30000/);
    });
  });

  // ── The state machine ─────────────────────────────────────────────────────
  // ── Enumerating what a settlement pass has to settle ──────────────────────
  // ── The reply a REPLAYED placement gets ───────────────────────────────────
  describe('a replayed placement answers, rather than throwing', () => {
    it('returns the same bet on every delivery of one request', async () => {
      const { placeBet: placeThroughApi, getBetDoc } = await import('../repositories/bets.js');
      await fund('depositBalance', 100_00, 'f-replay');

      const args = {
        betId: 'bet-replay-1', userId: U, cycleId: 'cyc1', side: 'DELHI',
        amount: 100, slices: [{ field: 'depositBalance', amount: 100 }],
      };

      const first  = await placeThroughApi(args);
      const second = await placeThroughApi(args);

      // The second delivery used to fall past a bare `if (!result.idempotent)`
      // left behind when a mirror call was removed, and return UNDEFINED — so
      // the route read `.ok` off nothing and every retried bet placement threw
      // a TypeError, on the highest-traffic endpoint, in the exact case
      // idempotency exists to make safe.
      expect(second).toBeDefined();
      expect(second.ok).toBe(true);
      expect(second.idempotent).toBe(true);
      expect(second.bet._id).toBe(first.bet._id);

      // And it debited once.
      expect((await bal()).depositBalance).toBe(0);
      expect((await bal()).lockedBalance).toBe(100_00);
    });

    it('finds a bet by either of the two keys it carries', async () => {
      const { placeBet: placeThroughApi, getBetDoc, publicIdFor } = await import('../repositories/bets.js');
      await fund('depositBalance', 50_00, 'f-keys');
      await placeThroughApi({
        betId: 'bet-keys-1', userId: U, cycleId: 'cyc1', side: 'DELHI',
        amount: 50, slices: [{ field: 'depositBalance', amount: 50 }],
      });

      // The idempotency key and the derived public id both resolve to one row.
      const byKey = await getBetDoc('bet-keys-1');
      const byPublicId = await getBetDoc(publicIdFor('bet-keys-1'));
      expect(byKey.betId).toBe('bet-keys-1');
      expect(byPublicId.betId).toBe('bet-keys-1');
      // Rupees, because that is what the response carries.
      expect(byKey.amount).toBe(50);
      expect(await getBetDoc('no-such-bet')).toBeNull();
    });
  });

  describe('the settlement pass reads the rows it settles', () => {
    /** A cycle row, so the winning/losing split can be resolved in the statement. */
    const declareCycle = (cycleId, winner) => pgQuery(
      `INSERT INTO cycles (cycle_id, cycle_type, status, winner, start_time, end_time)
       VALUES ($1, '30_MIN', 'RESULT_DECLARED', $2,
               now() - interval '30 minutes', now())
       ON CONFLICT (cycle_id) DO UPDATE SET winner = EXCLUDED.winner`,
      [cycleId, winner],
    );

    it('reconstructs each stake\'s funding split from the ledger', async () => {
      await fund('depositBalance', 30_000, 'f1');
      await fund('winningsBalance', 20_000, 'f2');
      await place('b-split', [slice('depositBalance', 30_000), slice('winningsBalance', 20_000)]);
      await declareCycle('cyc1', 'DELHI');

      const [bet] = await listSettleableBets('cyc1');
      // The bets row holds the TOTAL; the pockets it came out of live in the
      // placement ledger. Reconstructing from there cannot disagree with what
      // actually moved, which a second copy stored on the bet could.
      expect(bet.stakePaise).toBe(50_000);
      expect(bet.slices).toEqual([
        { field: 'depositBalance', amountPaise: 30_000 },
        { field: 'winningsBalance', amountPaise: 20_000 },
      ]);
    });

    it('gives back slices that settle without being refused', async () => {
      await fund('depositBalance', 40_000, 'f1');
      await place('b-round', [slice('depositBalance', 40_000)]);
      await declareCycle('cyc1', 'DELHI');

      const [bet] = await listSettleableBets('cyc1', { side: 'WINNING' });
      // The round trip is the point: `settle` refuses slices that do not sum
      // exactly to the stake, so this proves the enumeration and the transition
      // agree about the same bet.
      const won = await winBet({
        betId: bet.betId, userId: bet.userId, slices: bet.slices,
        payoutPaise: 76_000, platformFeePaise: 4_000, actor: 'test',
      });
      expect(won.ok).toBe(true);
      expect((await bal()).winningsBalance).toBe(76_000);
    });

    it('splits winning from losing against the cycle\'s own winner', async () => {
      await fund('depositBalance', 60_000, 'f1');
      await place('b-delhi', [slice('depositBalance', 20_000)]);
      await placeBet({
        betId: 'b-bombay', userId: U, cycleId: 'cyc1', side: 'BOMBAY',
        slices: [slice('depositBalance', 20_000)],
      });
      await declareCycle('cyc1', 'DELHI');

      // The side is resolved IN the statement from `cycles.winner`, so a pass
      // cannot settle against a result that changed after it started.
      expect((await listSettleableBets('cyc1', { side: 'WINNING' })).map((b) => b.betId))
        .toEqual(['b-delhi']);
      expect((await listSettleableBets('cyc1', { side: 'LOSING' })).map((b) => b.betId))
        .toEqual(['b-bombay']);
    });

    it('leaves out bets an earlier pass already settled', async () => {
      await fund('depositBalance', 40_000, 'f1');
      await place('b-1', [slice('depositBalance', 20_000)]);
      await place('b-2', [slice('depositBalance', 20_000)]);
      await declareCycle('cyc1', 'DELHI');

      await loseBet({ betId: 'b-1', userId: U, slices: [slice('depositBalance', 20_000)], actor: 'test' });

      // Only PENDING. A resumed pass re-processes what is left rather than
      // re-settling what is done — which is what makes the pass restartable.
      expect((await listSettleableBets('cyc1')).map((b) => b.betId)).toEqual(['b-2']);
    });

    it('leaves phantom bets out entirely', async () => {
      await fund('depositBalance', 20_000, 'f1');
      await place('b-real', [slice('depositBalance', 20_000)]);
      await pgQuery(
        `INSERT INTO bets (bet_id, user_id, cycle_id, side, stake_paise, status, is_phantom)
         VALUES ('b-phantom','house','cyc1','DELHI',900_00,'PENDING',TRUE)`, [],
      );
      await declareCycle('cyc1', 'DELHI');

      // A phantom bet moved no money and has no provenance, so there is no
      // stake to consume and `settle` would refuse it.
      expect((await listSettleableBets('cyc1')).map((b) => b.betId)).toEqual(['b-real']);
    });

    it('reports a bet whose stake movement was never recorded, rather than guessing', async () => {
      await pgQuery(
        `INSERT INTO bets (bet_id, user_id, cycle_id, side, stake_paise, status)
         VALUES ('b-orphan','u-orphan','cyc1','DELHI',20_000,'PENDING')`, [],
      );
      await declareCycle('cyc1', 'DELHI');

      const [bet] = await listSettleableBets('cyc1');
      // Empty, not defaulted. Inventing a split would return the money to a
      // pocket it never came from — and returning a deposit-funded stake into
      // winningsBalance turns non-withdrawable money withdrawable.
      expect(bet.slices).toEqual([]);
    });

    it('pages through a cycle by row id, so a large cycle settles in batches', async () => {
      await fund('depositBalance', 60_000, 'f1');
      for (const id of ['p1', 'p2', 'p3']) {
        await place(id, [slice('depositBalance', 20_000)]);
      }
      await declareCycle('cyc1', 'DELHI');

      const first = await listSettleableBets('cyc1', { limit: 2 });
      expect(first.map((b) => b.betId)).toEqual(['p1', 'p2']);
      const next = await listSettleableBets('cyc1', { limit: 2, after: first[first.length - 1].id });
      expect(next.map((b) => b.betId)).toEqual(['p3']);
    });
  });

  describe('transition guards', () => {
    const stake = [slice('depositBalance', 30_000)];
    beforeEach(async () => {
      await fund('depositBalance', 100_000, 'f1');
      await place('b', stake);
    });

    it('reports a replayed settlement as ALREADY DONE, never as a failure', async () => {
      await loseBet({ betId: 'b', userId: U, slices: stake });
      const again = await loseBet({ betId: 'b', userId: U, slices: stake });

      // Collapsing "already done" into "invalid" is how a retry-safe API stops
      // being retry-safe: the caller compensates for something that succeeded.
      expect(again).toMatchObject({ ok: true, idempotent: true });
      expect(await bal()).toMatchObject({ depositBalance: 70_000, lockedBalance: 0 });
    });

    it('refuses a settlement that arrives after a void', async () => {
      await voidBet({ betId: 'b', userId: U, slices: stake });
      expect(await winBet({ betId: 'b', userId: U, slices: stake, payoutPaise: 60_000 }))
        .toMatchObject({ ok: false, reason: 'invalid_transition', status: BET_STATUS.VOID });
      // And no payout leaked out of the refusal.
      expect(await bal()).toMatchObject({ winningsBalance: 0, depositBalance: 100_000 });
    });

    it('refuses a settlement for a bet that does not exist', async () => {
      expect(await loseBet({ betId: 'nope', userId: U, slices: stake }))
        .toMatchObject({ ok: false, reason: 'not_found' });
    });

    it('racing win-vs-lose: exactly one wins, and the books match it', async () => {
      const [won, lost] = await Promise.all([
        winBet({ betId: 'b', userId: U, slices: stake, payoutPaise: 60_000 }),
        loseBet({ betId: 'b', userId: U, slices: stake }),
      ]);

      expect([won.ok, lost.ok].filter(Boolean)).toHaveLength(1);
      const bet = await getBet('b');
      const balances = await bal();
      if (won.ok) {
        expect(bet.status).toBe(BET_STATUS.WON);
        expect(balances.winningsBalance).toBe(60_000);
      } else {
        expect(bet.status).toBe(BET_STATUS.LOST);
        expect(balances.winningsBalance).toBe(0);
      }
      expect(balances.lockedBalance).toBe(0);
    });

    it('keeps an append-only history the database enforces', async () => {
      await winBet({ betId: 'b', userId: U, slices: stake, payoutPaise: 1 });
      expect((await getBetHistory('b')).map((h) => h.to))
        .toEqual([BET_STATUS.PENDING, BET_STATUS.WON]);

      await expect(pgQuery(`UPDATE bet_transitions SET to_status = 'LOST' WHERE bet_id = 'b'`))
        .rejects.toThrow(/append-only/);
      await expect(pgQuery(`DELETE FROM bet_transitions WHERE bet_id = 'b'`))
        .rejects.toThrow(/append-only/);
    });
  });

  // ── Reconciliation ────────────────────────────────────────────────────────
  describe('reconciliation', () => {
    it('every outstanding stake is backed by locked balance', async () => {
      await fund('depositBalance', 100_000, 'f1');
      await place('r1', [slice('depositBalance', 30_000)]);
      await place('r2', [slice('depositBalance', 20_000)]);

      expect(await reconcileUserStakes(U)).toMatchObject({
        ok: true, stakedPaise: 50_000, lockedPaise: 50_000, unexplainedPaise: 0,
      });
    });

    it('settling releases the claim on locked balance', async () => {
      await fund('depositBalance', 100_000, 'f1');
      const stake = [slice('depositBalance', 30_000)];
      await place('r1', stake);
      await loseBet({ betId: 'r1', userId: U, slices: stake });

      expect(await reconcileUserStakes(U)).toMatchObject({ stakedPaise: 0, lockedPaise: 0 });
    });

    it('finds a settled bet whose stake never moved', async () => {
      await fund('depositBalance', 100_000, 'f1');
      await place('r1', [slice('depositBalance', 30_000)]);

      // Exactly what M-4 produces: a bet advanced to a
      // settled status with no ledger row behind it. The row is INSERTED
      // rather than a real bet stripped of its ledger, because wallet_ledger
      // is append-only and the database refuses the deletion — which is itself
      // the reason this state is unreachable through this module and has to be
      // manufactured to test the detector at all.
      await pgQuery(
        `INSERT INTO bets (bet_id, user_id, cycle_id, side, stake_paise, status)
         VALUES ('ghost', $1, 'cyc1', 'DELHI', 30000, 'LOST')`, [U],
      );

      const found = await findBetsMissingStakeMovement();
      expect(found).toEqual([{ betId: 'ghost', userId: U, status: 'LOST' }]);
      // And the properly-placed bet is NOT reported: it is still PENDING, and
      // a detector that flagged healthy rows would be ignored within a week.
      expect(found.map((f) => f.betId)).not.toContain('r1');
    });
  });

  // ── Concurrency: the mandate ──────────────────────────────────────────────
  describe('concurrency and pool safety', () => {
    it('60 concurrent bets against a balance that fits 20 admit exactly 20', async () => {
      await fund('depositBalance', 200_000, 'f1');

      const results = await Promise.all(
        Array.from({ length: 60 }, (_, i) => place(`race_${i}`, [slice('depositBalance', 10_000)])),
      );

      // The guard is in the UPDATE's WHERE clause under a row lock, so it holds
      // under contention rather than being a read that 60 callers all pass
      // before any of them writes.
      expect(results.filter((r) => r.ok)).toHaveLength(20);
      expect(results.filter((r) => r.reason === 'insufficient')).toHaveLength(40);
      expect(await bal()).toMatchObject({ depositBalance: 0, lockedBalance: 200_000 });
      expect(await reconcileUserStakes(U)).toMatchObject({ ok: true, unexplainedPaise: 0 });
    });

    it('50 users betting at once neither deadlock nor exhaust the pool', async () => {
      const users = Array.from({ length: 50 }, (_, i) => `pg-bet-u${i}`);
      await Promise.all(users.map((u, i) => fund('depositBalance', 50_000, `f_${i}`, u)));

      const pool = await getPool();
      const started = Date.now();
      const results = await Promise.all(users.map((u, i) =>
        placeBet({ betId: `mb_${i}`, userId: u, cycleId: 'cyc1', side: 'DELHI', slices: [slice('depositBalance', 10_000)] })));

      expect(results.every((r) => r.ok && !r.idempotent)).toBe(true);
      // A leaked client shows up here as a pool that never drains, and the NEXT
      // suite inherits the exhaustion rather than this one failing — which is
      // how a pool bug hides.
      expect(pool.waitingCount).toBe(0);
      expect(pool.idleCount).toBe(pool.totalCount);
      // Postgres breaks a deadlock with a 1s timeout, so a run that hit one and
      // retried takes seconds longer than one that simply queued.
      expect(Date.now() - started).toBeLessThan(20_000);
    });

    it('never holds two pooled connections for one bet', async () => {
      // The rule that makes the above hold: a placement takes ONE client and
      // does everything inside it — the wallet lock, the bet insert, the
      // transition row, the balance move and the ledger rows. A second checkout
      // while the first is held is the classic self-deadlock, and with a pool
      // this small it is not subtle: it hangs.
      const pool = await getPool();
      const max = pool.options.max ?? 10;
      const users = Array.from({ length: max }, (_, i) => `pg-bet-p${i}`);
      await Promise.all(users.map((u, i) => fund('depositBalance', 20_000, `p_${i}`, u)));

      await Promise.all(users.map((u, i) =>
        placeBet({ betId: `pb_${i}`, userId: u, cycleId: 'c', side: 'X', slices: [slice('depositBalance', 1_000)] })));

      expect(pool.waitingCount).toBe(0);
      expect(pool.totalCount).toBeLessThanOrEqual(max);
    });
  });
});
