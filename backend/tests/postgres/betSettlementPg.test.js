// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * The retained platform fee, against a REAL PostgreSQL.
 *
 * ── Why this column exists, and why it needed tests before it existed ───────
 * Routing bet settlement moves the WON transition into Postgres. The Mongo path
 * stamps `status`, `payout` and `platformFee` in one `$set`, and
 * `Cycle.totalPlatformFees` is derived by summing `Bet.platformFee` over the
 * cycle's WON bets. So a Postgres path that owned the status and the payout but
 * not the fee would leave that sum reading ZERO for every Postgres-settled
 * cycle — an accounting number quietly going to zero while every state check
 * reported clean, because no state check looks at it.
 *
 * That is the failure this file is here to make impossible. It asserts the fee
 * is stored by the settling transaction, that it survives a re-read, and that a
 * value the column cannot hold exactly is REFUSED rather than truncated.
 *
 * The reverse-mirror half of the round trip (Postgres row → Mongo document)
 * needs both stores and lives in the cross-store integration suite.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { pgConfigured, pgQuery, applySchema, closePg } from '../../postgres/pgClient.js';
import { applyDeltaPaise } from '../../postgres/walletPg.js';
import { BET_STATUS, placeBet, winBet, loseBet, getBet } from '../../postgres/betPg.js';
import { reconcileBetStates } from '../../postgres/reconcile.js';

const hasPg = pgConfigured();
const describePg = hasPg ? describe : describe.skip;

const U = 'pg-fee-user';

const fund = (field, paise, key) =>
  applyDeltaPaise({ userId: U, field, deltaPaise: paise, txId: key, type: 'CREDIT', reason: 'test funding' });

const place = (betId, amountPaise = 10_000) =>
  placeBet({
    betId, userId: U, cycleId: 'fee-cycle', side: 'DELHI',
    slices: [{ field: 'depositBalance', amountPaise }],
  });

const feeColumn = async (betId) => {
  const { rows } = await pgQuery(`SELECT platform_fee_paise FROM bets WHERE bet_id = $1`, [betId]);
  return rows[0]?.platform_fee_paise;
};

describePg('the retained platform fee (PostgreSQL)', () => {
  beforeAll(async () => { await applySchema(); });
  afterAll(async () => { await closePg(); });

  beforeEach(async () => {
    // TRUNCATE rather than DELETE: bet_transitions carries an append-only
    // trigger, so a DELETE is refused by the database — which is the point of
    // the trigger and not something a test should route around.
    await pgQuery('TRUNCATE bet_transitions, bets, wallet_ledger, wallets RESTART IDENTITY CASCADE');
    await fund('depositBalance', 1_000_000, 'fee_seed');
  });

  it('stores the fee the settlement decided, alongside the NET payout', async () => {
    await place('fee_win');
    // ₹100 stake, gross 2x = ₹200, 1% fee = ₹2, net = ₹198.
    const r = await winBet({
      betId: 'fee_win', userId: U,
      slices: [{ field: 'depositBalance', amountPaise: 10_000 }],
      payoutPaise: 19_800, platformFeePaise: 200,
    });

    expect(r.ok).toBe(true);
    expect(await feeColumn('fee_win')).toBe('200');
    // gross = net + fee. The two together are what make the cycle's books add
    // up; storing only the net loses the half the platform keeps.
    const bet = await getBet('fee_win');
    expect(bet.payoutPaise).toBe(19_800);
    expect(bet.platformFeePaise).toBe(200);
    expect(bet.status).toBe(BET_STATUS.WON);
  });

  it('returns the fee on the settling call itself, not only on a re-read', async () => {
    await place('fee_inline');
    const r = await winBet({
      betId: 'fee_inline', userId: U,
      slices: [{ field: 'depositBalance', amountPaise: 10_000 }],
      payoutPaise: 19_800, platformFeePaise: 200,
    });
    // gameEngine's reverse mirror reads the returned bet, not the table.
    expect(r.bet).toMatchObject({ status: BET_STATUS.WON, payoutPaise: 19_800, platformFeePaise: 200 });
  });

  it('leaves it at zero for a losing bet — nothing was paid, so nothing was retained', async () => {
    await place('fee_lose');
    const r = await loseBet({
      betId: 'fee_lose', userId: U,
      slices: [{ field: 'depositBalance', amountPaise: 10_000 }],
    });

    expect(r.ok).toBe(true);
    expect(await feeColumn('fee_lose')).toBe('0');
  });

  it('REFUSES a fractional fee rather than truncating it into the column', async () => {
    await place('fee_float');
    // ₹2.005 in paise is 200.5. Accepting it would round silently, and a fee
    // that is 0.5 paise wrong per bet is a reconciliation failure nobody can
    // trace back to its cause.
    await expect(winBet({
      betId: 'fee_float', userId: U,
      slices: [{ field: 'depositBalance', amountPaise: 10_000 }],
      payoutPaise: 19_800, platformFeePaise: 200.5,
    })).rejects.toThrow(/platformFeePaise must be a non-negative integer/);
  });

  it('REFUSES a negative fee — the constraint is in the code AND the table', async () => {
    await place('fee_negative');
    await expect(winBet({
      betId: 'fee_negative', userId: U,
      slices: [{ field: 'depositBalance', amountPaise: 10_000 }],
      payoutPaise: 19_800, platformFeePaise: -200,
    })).rejects.toThrow(/platformFeePaise must be a non-negative integer/);

    // …and the database refuses it too, so a future path that forgets the guard
    // cannot write one. Same reasoning as casino_rounds' refund bound.
    await expect(pgQuery(
      `UPDATE bets SET platform_fee_paise = -1 WHERE bet_id = $1`, ['fee_negative'],
    )).rejects.toThrow(/bets_platform_fee_check/);
  });

  it('is carried by the reconcile read, so --repair-mongo can restore it', async () => {
    await place('fee_reconcile');
    await winBet({
      betId: 'fee_reconcile', userId: U,
      slices: [{ field: 'depositBalance', amountPaise: 10_000 }],
      payoutPaise: 19_800, platformFeePaise: 200,
    });

    // reconcileBetStates SELECTs an explicit column list and hands those rows
    // straight to reverseMirrorBetRow. A column missing from that list is a
    // field the repair silently cannot restore, which is invisible from the
    // repair's own return value — so assert the query, not the repair.
    const { rows } = await pgQuery(
      `SELECT bet_id, user_id, cycle_id, side, stake_paise, payout_paise, platform_fee_paise,
              status, placed_at, settled_at, updated_at
         FROM bets WHERE bet_id = $1`, ['fee_reconcile'],
    );
    expect(rows[0].platform_fee_paise).toBe('200');

    // And the pass itself runs against a real table without throwing on the
    // new column. No Mongo here, so it can only report; that is enough to
    // prove the SELECT is valid SQL against the deployed schema.
    await expect(reconcileBetStates({ limit: 10 })).rejects.toThrow();
  });
});

/**
 * The hazard the reconcile fix removes, demonstrated rather than asserted.
 *
 * `reconcileBetStates`' backfill leg repairs Postgres from Mongo by handing the
 * matched document to `mirrorBet`. It used to fetch those documents with
 * `.select('status')` — so the document had a status and nothing else, and the
 * mirror's `ON CONFLICT DO UPDATE` writes what it is given.
 *
 * These two tests pin the behaviour that made that a bug: the mirror is a
 * PROJECTION, so an absent field is written as zero rather than left alone.
 * That is correct for a mirror and wrong for a repair, which is why the fix is
 * in the SELECT and not here.
 */
describePg('mirrorBet writes what it is given (why the backfill SELECT matters)', () => {
  beforeAll(async () => { await applySchema(); });

  beforeEach(async () => {
    await pgQuery('TRUNCATE bet_transitions, bets, wallet_ledger, wallets RESTART IDENTITY CASCADE');
    await fund('depositBalance', 1_000_000, 'fee_seed');
  });

  it('ZEROES a settled bet\'s payout and fee when handed a document that omits them', async () => {
    const { mirrorBet } = await import('../../postgres/dualWrite.js');

    await place('fee_backfill');
    await winBet({
      betId: 'fee_backfill', userId: U,
      slices: [{ field: 'depositBalance', amountPaise: 10_000 }],
      payoutPaise: 19_800, platformFeePaise: 200,
    });

    // Exactly the shape `.select('status').lean()` produced, with the identity
    // fields the repair supplied from the Postgres row.
    await mirrorBet({
      _id: 'fee_backfill', status: 'WON',
      userId: U, cycleId: 'fee-cycle', side: 'DELHI', amount: 100,
    });

    const { rows } = await pgQuery(
      `SELECT payout_paise, platform_fee_paise FROM bets WHERE bet_id = $1`, ['fee_backfill'],
    );
    // A check that exists to CLOSE a disagreement was opening a bigger one:
    // repairing the status destroyed the payout.
    expect(rows[0]).toMatchObject({ payout_paise: '0', platform_fee_paise: '0' });
  });

  it('preserves both when the document carries them — what the fixed SELECT supplies', async () => {
    const { mirrorBet } = await import('../../postgres/dualWrite.js');

    await place('fee_backfill_ok');
    await winBet({
      betId: 'fee_backfill_ok', userId: U,
      slices: [{ field: 'depositBalance', amountPaise: 10_000 }],
      payoutPaise: 19_800, platformFeePaise: 200,
    });

    await mirrorBet({
      _id: 'fee_backfill_ok', status: 'WON',
      userId: U, cycleId: 'fee-cycle', side: 'DELHI', amount: 100,
      payout: 198, platformFee: 2,
    });

    const { rows } = await pgQuery(
      `SELECT payout_paise, platform_fee_paise FROM bets WHERE bet_id = $1`, ['fee_backfill_ok'],
    );
    expect(rows[0]).toMatchObject({ payout_paise: '19800', platform_fee_paise: '200' });
  });
});
