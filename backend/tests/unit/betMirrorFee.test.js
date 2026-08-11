// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * The retained platform fee crossing between the two stores, in both directions.
 *
 * `Cycle.totalPlatformFees` is derived by summing `Bet.platformFee` over the
 * cycle's WON bets. Once Postgres settles the bet, the only thing that puts
 * that number back on the Mongo document is the reverse mirror — so a mirror
 * that carried the status and the payout but not the fee would leave every
 * Postgres-settled cycle reporting ZERO platform revenue, with every state
 * check still green because no state check looks at the fee.
 *
 * The forward direction matters for a different reason: `--backfill` ADOPTS
 * historical bets by replaying them through `mirrorBet`, and a bet settled on
 * the Mongo path before the cutover already carries a real fee. Dropping it
 * there would hand the authoritative store a zero it would later mirror back
 * over the correct value.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const onPostgres = new Set();
vi.mock('../../postgres/moneyAuthority.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, isPostgresAuthoritative: (path) => onPostgres.has(path) };
});

const queries = [];
vi.mock('../../postgres/pgClient.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    pgConfigured: () => true,
    pgQuery: async (text, params) => { queries.push({ text, params }); return { rows: [], rowCount: 0 }; },
  };
});

const updates = [];
vi.mock('mongoose', () => ({
  default: {
    model: () => ({ updateOne: async (filter, update, opts) => { updates.push({ filter, update, opts }); return {}; } }),
  },
}));

const { mirrorBet } = await import('../../postgres/dualWrite.js');
const { reverseMirrorBet, reverseMirrorBetRow } = await import('../../postgres/reverseMirror.js');

beforeEach(() => { queries.length = 0; updates.length = 0; onPostgres.clear(); });

describe('Postgres row → Mongo document (the rollback leg)', () => {
  it('writes the fee alongside the status and the payout', async () => {
    await reverseMirrorBetRow({
      bet_id: 'b1', mongo_id: 'b1', user_id: 'u1', cycle_id: 'c1', side: 'DELHI',
      stake_paise: 10_000, payout_paise: 19_800, platform_fee_paise: 200,
      status: 'WON', settled_at: new Date(2), placed_at: new Date(1),
    });

    expect(updates[0].update.$set).toMatchObject({ status: 'WON', payout: 198, platformFee: 2 });
  });

  it('writes a ZERO fee — a 0% policy is a real value, not a missing one', async () => {
    // Guarded on presence rather than truthiness, unlike the payout beside it.
    // A settlement that legitimately retained nothing has to be able to write 0
    // over whatever the document said before.
    await reverseMirrorBetRow({
      bet_id: 'b1', mongo_id: 'b1', user_id: 'u1', cycle_id: 'c1', side: 'DELHI',
      stake_paise: 10_000, payout_paise: 20_000, platform_fee_paise: 0,
      status: 'WON', settled_at: new Date(2), placed_at: new Date(1),
    });

    expect(updates[0].update.$set.platformFee).toBe(0);
  });

  it('leaves the field untouched when the row does not carry the column', async () => {
    // A caller selecting an older column list must not write `undefined` over a
    // real fee. Absent means "no opinion", not "zero".
    await reverseMirrorBet({ _id: 'b1', status: 'LOST' });
    expect(updates[0].update.$set).not.toHaveProperty('platformFee');
  });
});

describe('Mongo document → Postgres row (the dual-write leg)', () => {
  it('carries the fee forward, so an adopted bet arrives complete', async () => {
    await mirrorBet({
      _id: 'b1', userId: 'u1', cycleId: 'c1', side: 'DELHI',
      amount: 100, payout: 198, platformFee: 2, status: 'WON', timestamp: new Date(1),
    });

    expect(queries).toHaveLength(1);
    expect(queries[0].text).toMatch(/platform_fee_paise/);
    // paise at the boundary, like every other money value crossing it.
    expect(queries[0].params).toContain(200);
  });

  it('does NOT mirror a phantom bet', async () => {
    // A phantom bet is synthetic: positive `amount`, zero funding provenance,
    // no balance deduction. betPg.settle requires slices summing to the stake,
    // so a mirrored phantom bet could never be settled through the
    // authoritative path — it would sit PENDING in Postgres forever while Mongo
    // stamped it LOST, and reconcileBetStates would report that as drift on
    // every cycle. It also inflates reconcileUserStakes' outstanding total
    // against a lockedBalance that never moved.
    await mirrorBet({
      _id: 'p1', userId: 'u1', cycleId: 'c1', side: 'DELHI',
      amount: 100, status: 'PENDING', isPhantom: true, timestamp: new Date(1),
    });

    expect(queries).toHaveLength(0);
  });

  it('still mirrors an ordinary bet — the guard is on the flag, not the shape', async () => {
    await mirrorBet({
      _id: 'r1', userId: 'u1', cycleId: 'c1', side: 'DELHI',
      amount: 100, status: 'PENDING', isPhantom: false, timestamp: new Date(1),
    });

    expect(queries).toHaveLength(1);
  });
});
