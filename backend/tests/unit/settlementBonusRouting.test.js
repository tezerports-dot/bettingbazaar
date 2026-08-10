// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * The routing decisions for domains 6 and 8 — which store owns the write, and
 * what the caller is told when it is not the one it expected.
 *
 * No database. These assert the DECISION, not the movement: whether the
 * Postgres implementation is called at all, what the adapter reports back, and
 * whether the reverse mirror is fired to keep Mongo usable as a fallback. The
 * movements themselves are proven against a real PostgreSQL elsewhere.
 *
 * ── Why the no-op path deserves tests of its own ────────────────────────────
 * Every one of these adapters spends its production life in the OFF position:
 * no flag is flipped, so `onPostgres()` is false and the function returns
 * without touching Postgres. A bug there is not a migration bug, it is a
 * live-traffic bug — it would break gift codes and cycle settlement today, on
 * a path that is supposed to be inert. So the off position is tested first.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const onPostgres = new Set();
vi.mock('../../postgres/moneyAuthority.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, isPostgresAuthoritative: (path) => onPostgres.has(path) };
});

const settlementPg = { openSettlement: vi.fn(), completeSettlement: vi.fn(), getCycleSettlement: vi.fn() };
vi.mock('../../postgres/settlementPg.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    openSettlement: (...a) => settlementPg.openSettlement(...a),
    completeSettlement: (...a) => settlementPg.completeSettlement(...a),
    getCycleSettlement: (...a) => settlementPg.getCycleSettlement(...a),
  };
});

const bonusPg = { grantBonus: vi.fn(), clawBackBonus: vi.fn() };
vi.mock('../../postgres/bonusPg.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    grantBonus: (...a) => bonusPg.grantBonus(...a),
    clawBackBonus: (...a) => bonusPg.clawBackBonus(...a),
  };
});

const reverse = { cycleSettlement: vi.fn() };
vi.mock('../../postgres/reverseMirror.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, reverseMirrorCycleSettlement: (...a) => reverse.cycleSettlement(...a) };
});

import { MONEY_PATHS } from '../../postgres/moneyAuthority.js';
import { beginSettlement, finishSettlement } from '../../postgres/settlementPgAuthority.js';
import { grant, clawBack, KIND_FROM_RECORD_TYPE } from '../../postgres/bonusPgAuthority.js';

beforeEach(() => {
  onPostgres.clear();
  vi.clearAllMocks();
  settlementPg.openSettlement.mockResolvedValue({ ok: true, resumed: false, settlement: { payoutPaise: 0 } });
  settlementPg.completeSettlement.mockResolvedValue({ ok: true, idempotent: false, settlement: { completedAt: new Date() } });
  bonusPg.grantBonus.mockResolvedValue({ ok: true, idempotent: false, grant: { grantId: 'g1' } });
  bonusPg.clawBackBonus.mockResolvedValue({ ok: true });
});
afterEach(() => { onPostgres.clear(); });

describe('settlement routing (domain 6)', () => {
  it('does not touch Postgres while Mongo is authoritative', async () => {
    const r = await beginSettlement({ cycleId: 'c1', winningSide: 'DELHI' });
    expect(r).toMatchObject({ ok: true, source: 'mongo' });
    expect(settlementPg.openSettlement).not.toHaveBeenCalled();
  });

  it('claims the cycle in Postgres once it owns the path', async () => {
    onPostgres.add(MONEY_PATHS.SETTLEMENTS);
    const r = await beginSettlement({ cycleId: 'c1', winningSide: 'DELHI', stakeRupees: 12.34 });

    expect(r.source).toBe('postgres');
    // Rupees became integer paise at the boundary — the one wall where the
    // float representation is allowed to end.
    expect(settlementPg.openSettlement).toHaveBeenCalledWith(
      expect.objectContaining({ cycleId: 'c1', winningSide: 'DELHI', stakePaise: 1234 }),
    );
  });

  it('pushes the claim straight back to Mongo', async () => {
    onPostgres.add(MONEY_PATHS.SETTLEMENTS);
    await beginSettlement({ cycleId: 'c1', winningSide: 'DELHI' });

    // The engine's own tick and recovery queries read Cycle.isSettled. A run
    // that existed only in Postgres would be invisible to the sweep that has
    // to finish it if this node dies mid-payout.
    expect(reverse.cycleSettlement).toHaveBeenCalledWith(
      expect.objectContaining({ cycle_id: 'c1', status: 'RUNNING' }),
    );
  });

  it('reports a resumed run as ok, because resuming is the supported case', async () => {
    onPostgres.add(MONEY_PATHS.SETTLEMENTS);
    settlementPg.openSettlement.mockResolvedValue({ ok: true, resumed: true, settlement: { payoutPaise: 500 } });

    const r = await beginSettlement({ cycleId: 'c1', winningSide: 'DELHI' });
    // A caller that treated `resumed` as a refusal would strand exactly the
    // cycles that need finishing, with player stakes locked and nothing coming
    // to release them.
    expect(r).toMatchObject({ ok: true, resumed: true });
  });

  it('carries the payout total into the close', async () => {
    onPostgres.add(MONEY_PATHS.SETTLEMENTS);
    await finishSettlement({ cycleId: 'c1', payoutRupees: 87.65 });

    expect(reverse.cycleSettlement).toHaveBeenCalledWith(
      expect.objectContaining({ cycle_id: 'c1', status: 'COMPLETED', payout_paise: 8765 }),
    );
  });

  it('does not mirror back a close Postgres refused', async () => {
    onPostgres.add(MONEY_PATHS.SETTLEMENTS);
    settlementPg.completeSettlement.mockResolvedValue({ ok: false, reason: 'invalid_transition' });

    const r = await finishSettlement({ cycleId: 'c1', payoutRupees: 10 });
    expect(r).toMatchObject({ ok: false, reason: 'invalid_transition' });
    // Mirroring a transition that did not happen would tell Mongo the payout
    // finished when the source of truth says it did not.
    expect(reverse.cycleSettlement).not.toHaveBeenCalled();
  });
});

describe('bonus routing (domain 8)', () => {
  it('leaves the Mongo credit alone while Mongo is authoritative', async () => {
    const r = await grant({ grantId: 'g1', userId: 'u1', recordType: 'GIFT_CODE', amountRupees: 50 });
    // `applied: false` is the signal the caller uses to run its own credit.
    // Returning ok:true with applied:true here would silently skip the only
    // code path that actually pays the user today.
    expect(r).toMatchObject({ ok: true, source: 'mongo', applied: false });
    expect(bonusPg.grantBonus).not.toHaveBeenCalled();
  });

  it('pays from the pool once Postgres owns the path', async () => {
    onPostgres.add(MONEY_PATHS.BONUSES_AND_COMMISSIONS);
    const r = await grant({ grantId: 'g1', userId: 'u1', recordType: 'GIFT_CODE', amountRupees: 50 });

    expect(r).toMatchObject({ ok: true, source: 'postgres', applied: true });
    expect(bonusPg.grantBonus).toHaveBeenCalledWith(
      expect.objectContaining({ grantId: 'g1', kind: 'PROMO', amountPaise: 5000 }),
    );
  });

  it('surfaces an unfunded pool as a refusal instead of paying anyway', async () => {
    onPostgres.add(MONEY_PATHS.BONUSES_AND_COMMISSIONS);
    bonusPg.grantBonus.mockResolvedValue({ ok: false, reason: 'pool_movement_failed' });

    const r = await grant({ grantId: 'g1', userId: 'u1', recordType: 'GIFT_CODE', amountRupees: 50 });
    // An empty pool means the platform has not funded this promotion. Paying
    // regardless is the exact behaviour the domain exists to prevent.
    expect(r).toMatchObject({ ok: false, reason: 'pool_movement_failed' });
  });

  it('falls back to Mongo for a type no pool funds', async () => {
    onPostgres.add(MONEY_PATHS.BONUSES_AND_COMMISSIONS);
    const r = await grant({ grantId: 'g1', userId: 'u1', recordType: 'ADMIN_CREDIT', amountRupees: 50 });

    // A manual adjustment has no pool behind it. Failing the request would
    // break admin credits the moment the flag flips; inventing a pool would
    // make the treasury claim it financed something it did not.
    expect(r).toMatchObject({ ok: true, applied: false, reason: 'unmapped_kind' });
    expect(bonusPg.grantBonus).not.toHaveBeenCalled();
  });

  it('refuses a non-positive amount rather than passing it down', async () => {
    onPostgres.add(MONEY_PATHS.BONUSES_AND_COMMISSIONS);
    expect(await grant({ grantId: 'g1', userId: 'u1', recordType: 'GIFT_CODE', amountRupees: 0 }))
      .toMatchObject({ ok: false, reason: 'non_positive_amount' });
  });

  it('maps every record type the same way the forward mirror does', async () => {
    // The two mappings living in different files is a real risk: a grant that
    // travelled one way and back must land in the same pool, or a round trip
    // would move money between pools.
    const { BONUS_KIND } = await import('../../postgres/bonusPg.js');
    for (const [recordType, kind] of Object.entries(KIND_FROM_RECORD_TYPE)) {
      expect(BONUS_KIND[kind], `${recordType} → ${kind} is not a funded kind`).toBeTruthy();
    }
    expect(KIND_FROM_RECORD_TYPE.ADMIN_CREDIT).toBeUndefined();
  });

  it('does not claw back through Postgres while Mongo is authoritative', async () => {
    expect(await clawBack({ grantId: 'g1', userId: 'u1' })).toMatchObject({ source: 'mongo', applied: false });
    expect(bonusPg.clawBackBonus).not.toHaveBeenCalled();
  });
});
