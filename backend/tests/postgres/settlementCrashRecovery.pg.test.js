// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * Settlement under failure injection: what survives a crash, and what a resume
 * must not do twice.
 *
 * ── The invariant these tests exist to prove ────────────────────────────────
 *   A bet is settled exactly once FINANCIALLY, however many times the
 *   settlement worker runs over it.
 *
 * Every other property of a settlement — the run's counters, its recorded
 * payout, the mirror in Mongo — is a report. Reports can be rebuilt. A double
 * credit cannot, because by the time anyone notices, it has been withdrawn.
 *
 * ── How the crash is injected ───────────────────────────────────────────────
 * Not by mocking, and not by throwing from inside the code under test: both of
 * those prove that the code unwinds ITSELF correctly, which is the easy half.
 * The hard half is the process dying with a transaction open — no `finally`,
 * no ROLLBACK, no chance to compensate.
 *
 * So a control connection takes a table-level EXCLUSIVE lock, the code under
 * test runs until it blocks on that table, and its backend is then destroyed
 * with `pg_terminate_backend`. That is a real crash from PostgreSQL's point of
 * view — the server unwinds the transaction, not the client — and the choice of
 * table decides exactly WHERE in the transaction it dies:
 *
 *   LOCK wallet_ledger      → after the bet is stamped WON and the payout has
 *                             been added to the wallet row, before the audit
 *                             row and before COMMIT. The maximum amount of
 *                             uncommitted damage the settle path can hold.
 *   LOCK cycle_settlements  → after `winBet` has COMMITTED, before the run's
 *                             progress counter is bumped. The one window where
 *                             a crash leaves real money moved.
 *
 * ── What has to be true afterwards ─────────────────────────────────────────
 * The wallet and the ledger are the answer, not the return values. A pass that
 * reports success having moved nothing is a bug; so is one that reports failure
 * having moved something. Both are asserted against the rows.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { placeBet, winBet, getBet, derivePayoutTotalsForCycle } from '../../postgres/betPg.js';
import {
  openSettlement, settleBet, completeSettlement, getCycleSettlement,
  reconcileSettlement, findIncompleteSettlements,
} from '../../postgres/settlementPg.js';
import { getPool, pgQuery, applySchema } from '../../postgres/pgClient.js';

const USER = 'crash_user';
const STAKE = 5_000;      // ₹50
const PAYOUT = 9_500;     // ₹95 net of the 5% winnings fee on ₹100 gross
const FEE = 500;
const FUNDED = 10_000_000;

const slices = () => [{ field: 'depositBalance', amountPaise: STAKE }];

let seq = 0;
const nextCycle = () => `crash_cycle_${Date.now()}_${seq++}`;

const wallet = async () => (await pgQuery(
  `SELECT deposit_paise, winnings_paise, locked_paise FROM wallets WHERE user_id = $1`, [USER],
)).rows[0];

const ledgerFor = async (betId) => (await pgQuery(
  `SELECT tx_id, field, amount_paise, tx_type FROM wallet_ledger WHERE ref_id = $1 ORDER BY tx_id`, [betId],
)).rows;

/**
 * Run `work()` and destroy its database backend the moment it blocks on
 * `table`. Returns whatever `work()` settled to — resolution or rejection,
 * captured rather than thrown, because the caller is asserting on the rows.
 */
async function crashWhileBlockedOn(table, work) {
  const pool = await getPool();
  const control = await pool.connect();
  try {
    await control.query('BEGIN');
    await control.query(`LOCK TABLE ${table} IN EXCLUSIVE MODE`);

    const settled = work().then(
      (value) => ({ crashed: false, value }),
      (error) => ({ crashed: true, error }),
    );

    let pid = null;
    for (let attempt = 0; attempt < 100 && pid === null; attempt++) {
      await new Promise((r) => setTimeout(r, 50));
      const { rows } = await control.query(
        `SELECT pid FROM pg_stat_activity
          WHERE datname = current_database() AND pid <> pg_backend_pid()
            AND wait_event_type = 'Lock' AND query ILIKE $1`,
        [`%${table}%`],
      );
      if (rows.length) pid = rows[0].pid;
    }
    if (pid === null) {
      throw new Error(
        `failure injection never armed: nothing blocked on ${table}. `
        + 'The code under test no longer reaches that table inside its transaction, '
        + 'so this test is proving nothing — fix the injection point, do not delete the test.',
      );
    }

    await control.query('SELECT pg_terminate_backend($1)', [pid]);
    return await settled;
  } finally {
    try { await control.query('ROLLBACK'); } catch { /* already unwound */ }
    control.release();
  }
}

beforeAll(async () => { await applySchema(); });

beforeEach(async () => {
  await pgQuery(
    `INSERT INTO wallets (user_id, deposit_paise) VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE
        SET deposit_paise = $2, winnings_paise = 0, token_paise = 0, reserve_paise = 0,
            locked_paise = 0, locked_deposit_paise = 0, locked_winnings_paise = 0`,
    [USER, FUNDED],
  );
});

describe('a crash mid-transaction leaves no half-settled bet', () => {
  it('rolls back a payout that had already reached the wallet row', async () => {
    const cycle = nextCycle();
    const betId = `${cycle}_b1`;
    expect((await placeBet({ betId, userId: USER, cycleId: cycle, side: 'DELHI', slices: slices() })).ok).toBe(true);

    const staked = await wallet();
    expect(Number(staked.locked_paise)).toBe(STAKE);

    const outcome = await crashWhileBlockedOn('wallet_ledger', () => winBet({
      betId, userId: USER, slices: slices(), payoutPaise: PAYOUT, platformFeePaise: FEE,
      actor: 'settlement', reason: 'crash test',
    }));
    expect(outcome.crashed, 'the injected crash did not reach the caller').toBe(true);

    // The transaction had stamped the bet WON and added ₹95 to the wallet row
    // before it died. None of it is here.
    expect((await getBet(betId)).status).toBe('PENDING');
    const after = await wallet();
    expect(after).toEqual(staked);
    expect(await ledgerFor(betId)).toHaveLength(1); // the stake lock from placeBet, nothing since

    // And the worker's next pass pays it — once.
    const retry = await winBet({
      betId, userId: USER, slices: slices(), payoutPaise: PAYOUT, platformFeePaise: FEE,
      actor: 'settlement', reason: 'crash test',
    });
    expect(retry.ok).toBe(true);
    expect(retry.idempotent).toBe(false);

    const paid = await wallet();
    expect(Number(paid.winnings_paise)).toBe(PAYOUT);
    expect(Number(paid.locked_paise)).toBe(0);
    expect(Number(paid.deposit_paise)).toBe(FUNDED - STAKE);
    const payouts = (await ledgerFor(betId)).filter((r) => r.tx_id.endsWith('_payout'));
    expect(payouts).toHaveLength(1);
  });

  it('rolls back a stake that had already left the wallet row', async () => {
    // Same shape on the way IN. A stake that is debited but whose bet was never
    // committed is money the player cannot see, bet, or withdraw.
    const cycle = nextCycle();
    const betId = `${cycle}_b1`;
    const before = await wallet();

    const outcome = await crashWhileBlockedOn('wallet_ledger', () => placeBet({
      betId, userId: USER, cycleId: cycle, side: 'DELHI', slices: slices(),
    }));
    expect(outcome.crashed).toBe(true);

    expect(await wallet()).toEqual(before);
    expect(await getBet(betId)).toBeNull();

    const retry = await placeBet({ betId, userId: USER, cycleId: cycle, side: 'DELHI', slices: slices() });
    expect(retry.ok).toBe(true);
    const { rows } = await pgQuery('SELECT count(*)::int AS n FROM bets WHERE bet_id = $1', [betId]);
    expect(rows[0].n).toBe(1);
    expect(Number((await wallet()).locked_paise)).toBe(STAKE);
  });
});

describe('a settlement resumed after a crash pays each bet once', () => {
  it('re-offers every bet and credits only the ones that were still owed', async () => {
    const cycle = nextCycle();
    const ids = [0, 1, 2, 3].map((i) => `${cycle}_b${i}`);
    for (const betId of ids) {
      expect((await placeBet({ betId, userId: USER, cycleId: cycle, side: 'DELHI', slices: slices() })).ok).toBe(true);
    }

    const { settlement } = await openSettlement({ cycleId: cycle, winningSide: 'DELHI' });
    const settleOne = (betId) => settleBet({
      settlementId: settlement.settlementId, cycleId: cycle, betId, userId: USER,
      slices: slices(), won: true, payoutPaise: PAYOUT,
    });

    // Half the run, then the process dies. Nothing marks it finished.
    await settleOne(ids[0]);
    await settleOne(ids[1]);

    // Restart: the claim is REJOINED, not re-opened. A resume that started a
    // second run would settle every bet against a fresh set of counters.
    const rejoin = await openSettlement({ cycleId: cycle, winningSide: 'DELHI' });
    expect(rejoin.resumed).toBe(true);
    expect(rejoin.settlement.settlementId).toBe(settlement.settlementId);

    // The naive resume: re-offer all four, because a worker that crashed does
    // not know where it got to.
    const outcomes = [];
    for (const betId of ids) outcomes.push(await settleOne(betId));
    expect(outcomes.every((o) => o.ok)).toBe(true);
    expect(outcomes.map((o) => !!o.idempotent)).toEqual([true, true, false, false]);

    await completeSettlement({ cycleId: cycle });

    // ── the invariant ────────────────────────────────────────────────────────
    const paid = await wallet();
    expect(Number(paid.winnings_paise)).toBe(PAYOUT * ids.length);
    expect(Number(paid.deposit_paise)).toBe(FUNDED - STAKE * ids.length);
    expect(Number(paid.locked_paise)).toBe(0);

    for (const betId of ids) {
      const payouts = (await ledgerFor(betId)).filter((r) => r.tx_id.endsWith('_payout'));
      expect(payouts, `bet ${betId} was credited ${payouts.length} times`).toHaveLength(1);
      expect(Number(payouts[0].amount_paise)).toBe(PAYOUT);
    }

    const totals = await derivePayoutTotalsForCycle(cycle);
    expect(totals.paidPaise).toBe(PAYOUT * ids.length);
    expect(totals.bets).toBe(ids.length);
  });
});

describe('the run record survives a crash between the money and the counter', () => {
  it('rebuilds its totals from the bets rather than from the pass that counted them', async () => {
    // The one window where a crash leaves money moved: `settleBet` commits the
    // bet through `winBet`, then bumps `cycle_settlements` in a SEPARATE
    // statement. Dying in between pays the player and loses the count — and
    // the resume cannot restore it, because the bet transition is idempotent
    // and deliberately does not re-count.
    const cycle = nextCycle();
    const ids = [0, 1, 2].map((i) => `${cycle}_b${i}`);
    for (const betId of ids) await placeBet({ betId, userId: USER, cycleId: cycle, side: 'DELHI', slices: slices() });

    const { settlement } = await openSettlement({ cycleId: cycle, winningSide: 'DELHI' });
    const settleOne = (betId) => settleBet({
      settlementId: settlement.settlementId, cycleId: cycle, betId, userId: USER,
      slices: slices(), won: true, payoutPaise: PAYOUT,
    });

    await settleOne(ids[0]);

    const outcome = await crashWhileBlockedOn('cycle_settlements', () => settleOne(ids[1]));
    expect(outcome.crashed).toBe(true);

    // The money for that bet IS committed — this is not a rollback case.
    expect((await getBet(ids[1])).status).toBe('WON');
    const mid = await getCycleSettlement(cycle);
    expect(mid.betsSettled, 'the counter should be the one thing that was lost').toBe(1);

    for (const betId of ids) await settleOne(betId);
    await completeSettlement({ cycleId: cycle });

    // Every bet paid exactly once…
    expect(Number((await wallet()).winnings_paise)).toBe(PAYOUT * ids.length);
    for (const betId of ids) {
      expect((await ledgerFor(betId)).filter((r) => r.tx_id.endsWith('_payout'))).toHaveLength(1);
    }

    // …and the run's record agrees, because completion reconstructs it from
    // the bets. Trusting the accumulator here would leave betsSettled at 2 and
    // payoutPaise one payout short, permanently, on a cycle where every rupee
    // is correct — and `reconcileSettlement` would report that healthy cycle as
    // drifting for the rest of its life.
    const done = await getCycleSettlement(cycle);
    expect(done.betsSettled).toBe(ids.length);
    expect(done.payoutPaise).toBe(PAYOUT * ids.length);
    expect(done.betsTotal).toBe(ids.length);
    expect(done.stakePaise).toBe(STAKE * ids.length);

    const drift = await reconcileSettlement(cycle);
    expect(drift.ok, `a healthy settlement reported drift: ${JSON.stringify(drift.drift)}`).toBe(true);
  });

  it('completes a cycle that took no bets at all', async () => {
    // The derivation aggregates over `bets` with no GROUP BY, so it yields one
    // row even over an empty set and the UPDATE still fires. A correlated or
    // grouped subquery here would match nothing, the WHERE would find no row,
    // and an empty cycle would be reported as an invalid transition and stay
    // RUNNING forever — visible only as a stalled-settlement alert nobody can
    // action.
    const cycle = nextCycle();
    await openSettlement({ cycleId: cycle, winningSide: 'DELHI', betsTotal: 7, stakePaise: 999 });

    const done = await completeSettlement({ cycleId: cycle });
    expect(done.ok).toBe(true);
    expect(done.idempotent).toBe(false);

    // The values the caller guessed at open are replaced by what the bets say,
    // which for an empty cycle is nothing. gameEngine passes neither, so in
    // production these have been 0 since the table existed.
    const row = await getCycleSettlement(cycle);
    expect(row.status).toBe('COMPLETED');
    expect(row.betsTotal).toBe(0);
    expect(row.stakePaise).toBe(0);
    expect(row.payoutPaise).toBe(0);

    expect((await completeSettlement({ cycleId: cycle })).idempotent).toBe(true);
  });

  it('does not paper over a bet that really was left behind', async () => {
    // The corrective stamp must not become a way of declaring success. A cycle
    // completed with a bet still PENDING is the case findIncompleteSettlements
    // exists for, and deriving the totals has to make that MORE visible, not
    // less: bets_settled comes out below bets_total instead of matching a
    // counter that only ever counted what the pass touched.
    const cycle = nextCycle();
    const settled = `${cycle}_b0`;
    const stranded = `${cycle}_b1`;
    for (const betId of [settled, stranded]) {
      await placeBet({ betId, userId: USER, cycleId: cycle, side: 'DELHI', slices: slices() });
    }

    const { settlement } = await openSettlement({ cycleId: cycle, winningSide: 'DELHI' });
    await settleBet({
      settlementId: settlement.settlementId, cycleId: cycle, betId: settled, userId: USER,
      slices: slices(), won: true, payoutPaise: PAYOUT,
    });
    await completeSettlement({ cycleId: cycle });

    const done = await getCycleSettlement(cycle);
    expect(done.betsTotal).toBe(2);
    expect(done.betsSettled).toBe(1);

    const incomplete = await findIncompleteSettlements();
    const mine = incomplete.find((r) => r.cycleId === cycle);
    expect(mine, 'a completed cycle with a PENDING bet was not reported').toBeTruthy();
    expect(mine.stillPending).toBe(1);

    // The stranded stake is still locked — which is exactly why it is reported.
    expect(Number((await wallet()).locked_paise)).toBe(STAKE);
  });
});

describe('a failure AFTER the commit cannot undo or repeat the payout', () => {
  it('keeps the money and stays idempotent when the caller dies publishing the result', async () => {
    // The mirror write, the socket emit and the SSE broadcast all run after
    // `winBet` returns. None of them is transactional with it, and none of them
    // may be able to reverse it — so the only safe behaviour is for the retry
    // to find the work already done.
    const cycle = nextCycle();
    const betId = `${cycle}_b1`;
    await placeBet({ betId, userId: USER, cycleId: cycle, side: 'DELHI', slices: slices() });

    const publish = async () => { throw new Error('mirror unreachable'); };
    const won = await winBet({
      betId, userId: USER, slices: slices(), payoutPaise: PAYOUT, platformFeePaise: FEE,
      actor: 'settlement', reason: 'publish test',
    });
    expect(won.ok).toBe(true);
    await expect(publish()).rejects.toThrow('mirror unreachable');

    const afterPublishFailure = await wallet();
    expect(Number(afterPublishFailure.winnings_paise)).toBe(PAYOUT);

    const replay = await winBet({
      betId, userId: USER, slices: slices(), payoutPaise: PAYOUT, platformFeePaise: FEE,
      actor: 'settlement', reason: 'publish test',
    });
    expect(replay.ok).toBe(true);
    expect(replay.idempotent).toBe(true);
    expect(await wallet()).toEqual(afterPublishFailure);
    expect((await ledgerFor(betId)).filter((r) => r.tx_id.endsWith('_payout'))).toHaveLength(1);
  });
});
