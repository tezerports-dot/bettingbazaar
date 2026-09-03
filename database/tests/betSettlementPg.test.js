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
import { pgConfigured, pgQuery, applySchema, closePg } from '../client.js';
import { applyDeltaPaise } from '../repositories/wallets.core.js';
import { BET_STATUS, placeBet, winBet, loseBet, getBet, resolveBetId } from '../repositories/bets.core.js';
import { publicIdFor } from '../repositories/bets.js';

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
});

/**
 * A bet has two identities, and settlement only ever holds one of them.
 *
 * Every settlement path reads its bets from MONGO — gameEngine's `Bet.find` for
 * the losing side and its aggregation for the winners — so the id it hands to
 * the authority is always the Mongo `_id`. But a bet PLACED under Postgres
 * authority has `bet_id` = the idempotency key and `public_id` = the ObjectId
 * derived from it, while a bet MIRRORED from Mongo has `bet_id` = the Mongo
 * `_id` and no `public_id` at all.
 *
 * So settling by the Mongo id alone matched nothing for every bet the routed
 * placement path had created: refused `not_found`, stake still locked, on
 * exactly the configuration the routing exists to support. These pin the
 * translation, in both directions of origin.
 */
describePg('resolving a bet by whichever id the caller holds', () => {
  beforeAll(async () => { await applySchema(); });

  beforeEach(async () => {
    await pgQuery('TRUNCATE bet_transitions, bets, wallet_ledger, wallets RESTART IDENTITY CASCADE');
    await fund('depositBalance', 1_000_000, 'fee_seed');
  });

  it('finds a POSTGRES-placed bet by its derived Mongo _id', async () => {
    const key = 'bet_pgfee_placed';
    const publicId = publicIdFor(key);
    await placeBet({
      betId: key, publicId, userId: U, cycleId: 'fee-cycle', side: 'DELHI',
      slices: [{ field: 'depositBalance', amountPaise: 10_000 }],
    });

    // The two are genuinely different strings — otherwise this proves nothing.
    expect(publicId).not.toBe(key);
    expect(await resolveBetId(publicId)).toBe(key);
    // …and by its own key, for any caller that already holds it.
    expect(await resolveBetId(key)).toBe(key);
  });

  it('finds a bet whose bet_id IS an external id, with no derived id recorded', async () => {
    // Inserted directly rather than through a writer, because the property
    // under test belongs to the resolver: a row it did not create itself must
    // still resolve by the only id that row carries.
    await pgQuery(
      `INSERT INTO bets (bet_id, public_id, user_id, cycle_id, side, stake_paise, status, placed_at)
       VALUES ($1, NULL, $2, 'fee-cycle', 'DELHI', 10000, 'PENDING', now())`,
      ['507f1f77bcf86cd799439011', U],
    );

    expect(await resolveBetId('507f1f77bcf86cd799439011')).toBe('507f1f77bcf86cd799439011');
  });

  it('returns null for a bet Postgres has never seen', async () => {
    // Not an error: it is what tells the settlement pass to REPORT the bet
    // rather than settle it, so `--backfill` can adopt it.
    expect(await resolveBetId('507f1f77bcf86cd799439099')).toBeNull();
    expect(await resolveBetId(null)).toBeNull();
  });

  it('SETTLES a Postgres-placed bet addressed by its Mongo _id', async () => {
    // The end-to-end shape of the bug: this is exactly what gameEngine does.
    const key = 'bet_pgfee_settle';
    const publicId = publicIdFor(key);
    await placeBet({
      betId: key, publicId, userId: U, cycleId: 'fee-cycle', side: 'DELHI',
      slices: [{ field: 'depositBalance', amountPaise: 10_000 }],
    });

    // Before the fix this returned { ok: false, reason: 'not_found' }.
    const resolved = await resolveBetId(publicId);
    const r = await winBet({
      betId: resolved, userId: U,
      slices: [{ field: 'depositBalance', amountPaise: 10_000 }],
      payoutPaise: 19_800, platformFeePaise: 200,
    });

    expect(r).toMatchObject({ ok: true, idempotent: false });
    expect((await getBet(key)).status).toBe(BET_STATUS.WON);

    // And the stake actually left `locked` — a settle that reported success
    // without moving money would satisfy the status assertion alone.
    const { rows } = await pgQuery(`SELECT locked_paise FROM wallets WHERE user_id = $1`, [U]);
    expect(Number(rows[0].locked_paise)).toBe(0);
  });
});
