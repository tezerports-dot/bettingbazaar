// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * The Mongo→Postgres mirrors for domains 6 and 8, against a REAL PostgreSQL.
 *
 * These run WITHOUT MongoDB, which is the point: both mirrors take a plain
 * document object and write only to Postgres, so the half that can be proven
 * here is proven here rather than deferred to a suite that needs a replica set.
 *
 * ── The two properties that carry the weight ────────────────────────────────
 * MIRRORS DO NOT MOVE MONEY. `mirrorBonusGrant` records a grant without paying
 * the treasury pool, because while Mongo is authoritative that money has
 * ALREADY moved on the Mongo side — paying again here would double-spend the
 * pool. `mirrorCycleSettlement` records the run without settling any bet.
 * Every assertion about an untouched treasury below is that invariant.
 *
 * THE FLIP STOPS THE FORWARD MIRROR. Once Postgres owns a path, a Mongo-derived
 * overwrite could drag state BACKWARDS through the transitions the guards exist
 * to prevent, so both mirrors return without writing. See the note on the
 * resolver mock below for why that flip is simulated rather than set with the
 * env var an operator would use.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';

/**
 * The flip is simulated at the RESOLVER, not with the env var, and that is not
 * a shortcut — it is the only honest way to test this today.
 *
 * `authorityFor` refuses Postgres for any domain whose capabilities are not
 * satisfied, and both of these still carry `implemented: false`. So setting
 * MONEY_AUTHORITY_SETTLEMENTS=postgres correctly changes nothing, and a test
 * written that way would assert the ORDERING GATE while claiming to assert the
 * mirror's own guard. Mocking the resolver isolates the branch actually under
 * test: given Postgres owns the path, does the forward mirror stand down?
 */
const onPostgres = new Set();
vi.mock('../../postgres/moneyAuthority.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, isPostgresAuthoritative: (path) => onPostgres.has(path) };
});

import { pgConfigured, pgQuery, applySchema, closePg } from '../../postgres/pgClient.js';
import { MONEY_PATHS } from '../../postgres/moneyAuthority.js';
import { mirrorCycleSettlement, mirrorBonusGrant } from '../../postgres/dualWrite.js';
import { getCycleSettlement, SETTLEMENT_STATUS } from '../../postgres/settlementPg.js';
import { getGrant } from '../../postgres/bonusPg.js';
import { ACCOUNTS, getTreasuryBalances } from '../../postgres/treasuryPg.js';

const hasPg = pgConfigured();
const describePg = hasPg ? describe : describe.skip;

/** A 24-hex id, so the value is a legitimate Mongo _id rather than a lookalike. */
const oid = (suffix) => `6512ab34cd56ef78${String(suffix).padStart(8, '0')}`;

describePg('Mongo→Postgres mirrors for settlements and bonuses', () => {
  beforeAll(async () => { await applySchema(); });
  afterAll(async () => { await closePg(); });

  beforeEach(async () => {
    await pgQuery(`DELETE FROM cycle_settlements WHERE cycle_id LIKE 'mir_%'`);
    await pgQuery(`DELETE FROM bonus_grants WHERE grant_id LIKE 'bg_%'`);
  });

  afterEach(() => { onPostgres.clear(); });

  // ── Domain 6: the settlement run ──────────────────────────────────────────

  it('mirrors a PROCESSING cycle as a RUNNING settlement run', async () => {
    await mirrorCycleSettlement({ cycleId: 'mir_c1', winner: 'DELHI', isSettled: 'PROCESSING' });

    const run = await getCycleSettlement('mir_c1');
    expect(run).toMatchObject({ status: SETTLEMENT_STATUS.RUNNING, winningSide: 'DELHI' });
    // The run exists; no bet was settled and nothing was paid. A mirror that
    // moved money would show up right here.
    expect(run.betsSettled).toBe(0);
    expect(run.payoutPaise).toBe(0);
  });

  it('carries the payout total when the cycle completes', async () => {
    await mirrorCycleSettlement({ cycleId: 'mir_c2', winner: 'BOMBAY', isSettled: 'PROCESSING' });
    await mirrorCycleSettlement({
      cycleId: 'mir_c2', winner: 'BOMBAY', isSettled: 'COMPLETED',
      settledAt: new Date('2026-08-01T00:00:00Z'), totalPaidOut: 1234.56,
    });

    const run = await getCycleSettlement('mir_c2');
    expect(run.status).toBe(SETTLEMENT_STATUS.COMPLETED);
    // Mongo's rupees became Postgres's integer paise at the boundary. Leaving
    // this at 0 would make the reconciler report the whole cycle as drift.
    expect(run.payoutPaise).toBe(123456);
    expect(run.completedAt).toBeTruthy();
  });

  it('does not rewrite winning_side once the run exists', async () => {
    await mirrorCycleSettlement({ cycleId: 'mir_c3', winner: 'DELHI', isSettled: 'PROCESSING' });
    // A corrected result arriving mid-payout. Letting it through would make the
    // run claim it settled every bet against a side only some of them saw.
    await mirrorCycleSettlement({ cycleId: 'mir_c3', winner: 'BOMBAY', isSettled: 'COMPLETED', totalPaidOut: 10 });

    expect((await getCycleSettlement('mir_c3')).winningSide).toBe('DELHI');
  });

  it('mirrors nothing for a cycle with no declared result', async () => {
    await mirrorCycleSettlement({ cycleId: 'mir_c4', winner: null, isSettled: 'PROCESSING' });
    expect(await getCycleSettlement('mir_c4')).toBeNull();
  });

  it('mirrors nothing while the cycle is still PENDING', async () => {
    // An un-started settlement is not a RUNNING one. A row here would make
    // findIncompleteSettlements report every unsettled cycle as a stalled payout.
    await mirrorCycleSettlement({ cycleId: 'mir_c5', winner: 'DELHI', isSettled: 'PENDING' });
    expect(await getCycleSettlement('mir_c5')).toBeNull();
  });

  it('stops mirroring once Postgres owns the path', async () => {
    onPostgres.add(MONEY_PATHS.SETTLEMENTS);
    await mirrorCycleSettlement({ cycleId: 'mir_c6', winner: 'DELHI', isSettled: 'COMPLETED', totalPaidOut: 99 });
    expect(await getCycleSettlement('mir_c6')).toBeNull();
  });

  // ── Domain 8: bonus grants ────────────────────────────────────────────────

  it('records a gift-code grant against the promo pool without paying it', async () => {
    const before = await getTreasuryBalances();

    await mirrorBonusGrant({
      _id: oid(1), userId: oid(101), type: 'GIFT_CODE', amount: 50, refId: 'WELCOME50',
    });

    const g = await getGrant(`bg_${oid(1)}`);
    expect(g).toMatchObject({
      kind: 'PROMO', pool: ACCOUNTS.BONUS_POOL, amountPaise: 5000, status: 'PAID',
      refModel: 'BonusRecord', refId: 'WELCOME50',
    });

    // THE invariant for this mirror. The Mongo side already paid; paying again
    // here would double-spend the pool that funds every promotion.
    const after = await getTreasuryBalances();
    expect(after).toEqual(before);
  });

  it('routes a referral commission to the commission pool', async () => {
    await mirrorBonusGrant({ _id: oid(2), userId: oid(102), type: 'REFERRAL_COMMISSION', amount: 12.5 });
    // A commission is EARNED, so it is funded differently from a giveaway —
    // and on the authoritative path it lands in winnings rather than deposit.
    expect(await getGrant(`bg_${oid(2)}`)).toMatchObject({
      kind: 'COMMISSION', pool: ACCOUNTS.COMMISSION_POOL, amountPaise: 1250,
    });
  });

  it('does not mirror an ADMIN_CREDIT', async () => {
    // A manual adjustment has no pool behind it. Recording one would make the
    // treasury claim it financed something it did not; those movements reach
    // Postgres as ordinary wallet ledger rows instead.
    await mirrorBonusGrant({ _id: oid(3), userId: oid(103), type: 'ADMIN_CREDIT', amount: 500 });
    expect(await getGrant(`bg_${oid(3)}`)).toBeNull();
  });

  it('ignores a grant of nothing', async () => {
    await mirrorBonusGrant({ _id: oid(4), userId: oid(104), type: 'GIFT_CODE', amount: 0 });
    // amount_paise carries a CHECK (> 0); guarding in the mirror keeps a
    // malformed record out rather than letting the constraint reject it once
    // per save, forever.
    expect(await getGrant(`bg_${oid(4)}`)).toBeNull();
  });

  it('is idempotent, and never resurrects a clawed-back grant', async () => {
    await mirrorBonusGrant({ _id: oid(5), userId: oid(105), type: 'GIFT_CODE', amount: 20 });
    await pgQuery(`UPDATE bonus_grants SET status = 'CLAWED_BACK' WHERE grant_id = $1`, [`bg_${oid(5)}`]);

    // A replayed mirror — a reconcile backfill, a retried save. DO NOTHING is
    // what stops it dragging the grant back to PAID after fraud review pulled it.
    await mirrorBonusGrant({ _id: oid(5), userId: oid(105), type: 'GIFT_CODE', amount: 20 });

    const g = await getGrant(`bg_${oid(5)}`);
    expect(g.status).toBe('CLAWED_BACK');
    const { rows } = await pgQuery(`SELECT COUNT(*)::int AS n FROM bonus_grants WHERE grant_id = $1`, [`bg_${oid(5)}`]);
    expect(rows[0].n).toBe(1);
  });

  it('stops mirroring once Postgres owns the path', async () => {
    onPostgres.add(MONEY_PATHS.BONUSES_AND_COMMISSIONS);
    await mirrorBonusGrant({ _id: oid(6), userId: oid(106), type: 'GIFT_CODE', amount: 30 });
    expect(await getGrant(`bg_${oid(6)}`)).toBeNull();
  });
});
