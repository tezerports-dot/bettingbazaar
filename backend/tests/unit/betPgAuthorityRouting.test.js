// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * Routing bet placement, and the identity a bet carries across two stores.
 *
 * betPg.test.js proves the BEHAVIOUR against a real PostgreSQL — the
 * idempotency gate, the transactional stake, the state machine. What is left is
 * the seam between the stores, and it is where this domain is most likely to go
 * wrong quietly:
 *
 *  - the Mongo document's `_id` cannot BE the idempotency key (Mongo types it
 *    as an ObjectId), so it is derived — and if that derivation were not
 *    stable, a replayed request would find the Postgres bet already there
 *    (correct) and create a SECOND Mongo document behind it (not);
 *  - the funding split has to survive the round trip in both directions, or a
 *    refund returns money to the wrong pocket;
 *  - the route must be given the same shape by both stores, or the flip becomes
 *    a user-visible change.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const authoritative = vi.hoisted(() => ({ value: true }));
const pg = vi.hoisted(() => ({ result: null, calls: [] }));

vi.mock('../../postgres/moneyAuthority.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, isPostgresAuthoritative: () => authoritative.value };
});

const settlePg = vi.hoisted(() => ({ calls: [], result: null, resolved: undefined }));

vi.mock('../../postgres/betPg.js', () => ({
  BET_STATUS: { PENDING: 'PENDING', WON: 'WON', LOST: 'LOST', VOID: 'VOID', REFUNDED: 'REFUNDED' },
  placeBet: (args) => { pg.calls.push(args); return pg.result; },
  resolveBetId: async (id) => (settlePg.resolved === undefined ? String(id) : settlePg.resolved),
  winBet: async (args) => { settlePg.calls.push({ op: 'win', ...args }); return settlePg.result; },
  loseBet: async (args) => { settlePg.calls.push({ op: 'lose', ...args }); return settlePg.result; },
  voidBet: async (args) => { settlePg.calls.push({ op: 'void', ...args }); return settlePg.result; },
  refundBet: async (args) => { settlePg.calls.push({ op: 'refund', ...args }); return settlePg.result; },
}));

const reverseMirrorBet = vi.fn();
const reverseMirrorBetRow = vi.fn();
vi.mock('../../postgres/reverseMirror.js', () => ({ reverseMirrorBet, reverseMirrorBetRow }));
vi.mock('mongoose', () => ({ default: { model: () => ({ findById: () => ({ lean: async () => null }) }) } }));

const {
  placeBet, mongoIdFor, sourcesFromSlices, slicesFromBet, onPostgres, settleBetOnPostgres,
} = await import('../../postgres/betPgAuthority.js');

const slices = [
  { field: 'depositBalance', amount: 200 },
  { field: 'winningsBalance', amount: 100 },
];

beforeEach(() => {
  vi.clearAllMocks();
  pg.calls.length = 0;
  settlePg.calls.length = 0;
  settlePg.resolved = undefined;
  settlePg.result = { ok: true, idempotent: false, bet: { status: 'WON', settledAt: new Date(9) } };
  authoritative.value = true;
  pg.result = {
    ok: true, idempotent: false,
    bet: { betId: 'bet_u1_k1', placedAt: new Date(5) },
    balances: { depositBalance: 70_000, winningsBalance: 40_000, lockedBalance: 30_000 },
  };
});

describe('settling: the two identities a bet carries', () => {
  const mongoDoc = (over = {}) => ({
    _id: mongoIdFor('bet_u1_k1'), userId: 'u1', cycleId: 'c1', side: 'DELHI',
    amount: 100, fromDepositBalance: 100, fromWinningsBalance: 0, fromReserveBalance: 0,
    timestamp: new Date(1), ...over,
  });

  it('settles the POSTGRES key, not the Mongo id it was handed', async () => {
    // Every settlement path reads its bets from Mongo, so the id the caller
    // holds is the Mongo `_id`. A bet placed under Postgres authority is keyed
    // on the idempotency key instead, with the Mongo id in `mongo_id` — so
    // settling by the id in hand matched no row and refused `not_found` with
    // the stake still locked.
    settlePg.resolved = 'bet_u1_k1';
    const r = await settleBetOnPostgres({ bet: mongoDoc(), outcome: 'WON', payoutRupees: 198, platformFeeRupees: 2 });

    expect(r).toMatchObject({ handled: true, ok: true });
    expect(settlePg.calls[0]).toMatchObject({ op: 'win', betId: 'bet_u1_k1', payoutPaise: 19_800, platformFeePaise: 200 });
  });

  it('mirrors back to the MONGO id, not the Postgres key', async () => {
    // reverseMirrorBetRow uses `mongo_id` as the document's `_id`. Writing the
    // Postgres key there would upsert a SECOND document under an id nothing
    // refers to, leaving the real one PENDING — a settled bet the rest of the
    // system still believes is open.
    settlePg.resolved = 'bet_u1_k1';
    await settleBetOnPostgres({ bet: mongoDoc(), outcome: 'WON', payoutRupees: 198, platformFeeRupees: 2 });

    expect(reverseMirrorBetRow).toHaveBeenCalledWith(expect.objectContaining({
      bet_id: 'bet_u1_k1',
      mongo_id: mongoIdFor('bet_u1_k1'),
      platform_fee_paise: 200,
    }));
  });

  it('REFUSES a bet Postgres has never seen rather than settling something else', async () => {
    settlePg.resolved = null;
    const r = await settleBetOnPostgres({ bet: mongoDoc(), outcome: 'LOST' });

    expect(r).toMatchObject({ handled: true, ok: false, reason: 'not_found' });
    expect(settlePg.calls).toHaveLength(0);
    expect(reverseMirrorBetRow).not.toHaveBeenCalled();
  });

  it('refuses a bet with no funding slices BEFORE spending a lookup on it', async () => {
    const r = await settleBetOnPostgres({
      bet: mongoDoc({ fromDepositBalance: 0, fromWinningsBalance: 0, fromReserveBalance: 0 }),
      outcome: 'LOST',
    });

    expect(r).toMatchObject({ handled: true, ok: false, reason: 'no_funding_slices' });
    expect(settlePg.calls).toHaveLength(0);
  });

    it('does not re-mirror a settlement that had already happened', async () => {
    settlePg.result = { ok: true, idempotent: true, bet: { status: 'WON' } };
    const r = await settleBetOnPostgres({ bet: mongoDoc(), outcome: 'WON', payoutRupees: 198 });

    expect(r).toMatchObject({ ok: true, idempotent: true });
    expect(reverseMirrorBetRow).not.toHaveBeenCalled();
  });
});

describe('the Mongo _id derived from the idempotency key', () => {
  it('is a valid ObjectId — the key itself would be a CastError', () => {
    const id = mongoIdFor('bet_u1_7c9e6679-7425-40de-944b-e07fc1f90ae7');
    expect(id).toMatch(/^[0-9a-f]{24}$/);
  });

  it('is STABLE for the same key, so a replay cannot make a second document', () => {
    // The whole reason it is derived rather than generated. A fresh ObjectId
    // per attempt would leave Postgres correctly holding one bet and Mongo
    // holding two — the exact duplication bet_id exists to prevent, hidden on
    // the side nobody is watching.
    expect(mongoIdFor('bet_u1_k1')).toBe(mongoIdFor('bet_u1_k1'));
  });

  it('differs for different keys, so two real bets stay two documents', () => {
    expect(mongoIdFor('bet_u1_k1')).not.toBe(mongoIdFor('bet_u1_k2'));
    expect(mongoIdFor('bet_u1_k1')).not.toBe(mongoIdFor('bet_u2_k1'));
  });
});

describe('the funding split survives the round trip', () => {
  it('maps wallet fields onto the three Mongo columns', () => {
    expect(sourcesFromSlices([
      { field: 'depositBalance', amountPaise: 20_000 },
      { field: 'reserveBalance', amountPaise: 5_000 },
    ])).toEqual({ fromDepositBalance: 200, fromWinningsBalance: 0, fromReserveBalance: 50 });
  });

  it('maps back, dropping the pockets that funded nothing', () => {
    // A refund settles against these. A slice of zero would be rejected by
    // betPg's positive-amount guard, so filtering here is what lets a
    // single-pocket bet settle at all.
    expect(slicesFromBet({ fromDepositBalance: 200, fromWinningsBalance: 0, fromReserveBalance: 50 }))
      .toEqual([
        { field: 'depositBalance', amountPaise: 20_000 },
        { field: 'reserveBalance', amountPaise: 5_000 },
      ]);
  });

  it('round-trips without losing a pocket', () => {
    const original = [
      { field: 'depositBalance', amountPaise: 20_000 },
      { field: 'winningsBalance', amountPaise: 10_000 },
    ];
    expect(slicesFromBet(sourcesFromSlices(original))).toEqual(original);
  });
});

describe('placing under PostgreSQL authority', () => {
  it('crosses rupees into paise at the boundary and carries the derived id', async () => {
    await placeBet({ betId: 'bet_u1_k1', userId: 'u1', cycleId: 'c1', side: 'DELHI', amount: 300, slices });

    expect(pg.calls[0]).toMatchObject({
      betId: 'bet_u1_k1',
      mongoId: mongoIdFor('bet_u1_k1'),
      slices: [
        { field: 'depositBalance', amountPaise: 20_000 },
        { field: 'winningsBalance', amountPaise: 10_000 },
      ],
    });
  });

  it('returns a MONGO-shaped bet, so the route\'s response does not change', async () => {
    const r = await placeBet({ betId: 'bet_u1_k1', userId: 'u1', cycleId: 'c1', side: 'DELHI', amount: 300, slices });

    expect(r.bet).toMatchObject({
      _id: mongoIdFor('bet_u1_k1'),
      userId: 'u1', cycleId: 'c1', amount: 300, side: 'DELHI',
      fromDepositBalance: 200, fromWinningsBalance: 100, fromReserveBalance: 0,
      status: 'PENDING', isPhantom: false,
    });
    // Balances come back in rupees, matching what lockBetStake returns on the
    // Mongo path — the route pushes these straight into an SSE frame.
    expect(r.balances).toEqual({ depositBalance: 700, winningsBalance: 400, lockedBalance: 300 });
  });

  it('mirrors the bet to Mongo BEFORE returning', async () => {
    await placeBet({ betId: 'bet_u1_k1', userId: 'u1', cycleId: 'c1', side: 'DELHI', amount: 300, slices });
    // Awaited, not fire-and-forget: every read path still queries Mongo, so
    // answering with a bet the client cannot then fetch would be a visible
    // regression rather than an internal one.
    expect(reverseMirrorBet).toHaveBeenCalledWith(expect.objectContaining({ _id: mongoIdFor('bet_u1_k1') }));
  });

  it('does not re-mirror a replayed placement', async () => {
    pg.result = { ok: true, idempotent: true, bet: { betId: 'bet_u1_k1' } };
    const r = await placeBet({ betId: 'bet_u1_k1', userId: 'u1', cycleId: 'c1', side: 'DELHI', amount: 300, slices });

    expect(r.idempotent).toBe(true);
    expect(reverseMirrorBet).not.toHaveBeenCalled();
  });

  it('passes an insufficient-balance refusal straight through', async () => {
    pg.result = { ok: false, reason: 'insufficient' };
    const r = await placeBet({ betId: 'bet_u1_k1', userId: 'u1', cycleId: 'c1', side: 'DELHI', amount: 300, slices });

    // The route answers 400 on `!ok`, identically for both stores.
    expect(r).toMatchObject({ ok: false, reason: 'insufficient' });
    expect(reverseMirrorBet).not.toHaveBeenCalled();
  });

  });
