// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * Every forward mirror must STOP once Postgres owns its path.
 *
 * While Mongo is authoritative the mirror copies Mongo→Postgres. The moment the
 * flag flips, Postgres decides and the REVERSE mirror writes Mongo — so a
 * forward mirror still running would send the projection back as though it were
 * the source of truth. Worse, because the reverse mirror updates the Mongo
 * document, a forward mirror racing it can overwrite a Postgres state with the
 * value it is in the middle of replacing.
 *
 * This is asserted as a PROPERTY across all the mirrors rather than one test per
 * mirror, because the failure that prompted it was an omission: mirrorBet had no
 * gate at all while bet.model.js's comment said it did. A per-mirror test would
 * have been written for the mirrors someone remembered.
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

vi.mock('mongoose', () => ({ default: { model: () => ({ updateOne: async () => ({}) }) } }));

import { MONEY_PATHS } from '../../postgres/moneyAuthority.js';
import { mirrorBet, mirrorCasinoTransaction, mirrorCycleSettlement, mirrorBonusGrant } from '../../postgres/dualWrite.js';

/** Each mirror, the path that owns it, and a document it would otherwise write. */
const MIRRORS = [
  {
    name: 'mirrorBet', path: MONEY_PATHS.BETS, fn: mirrorBet,
    doc: { _id: 'b1', userId: 'u1', cycleId: 'c1', side: 'DELHI', amount: 100, status: 'PENDING' },
  },
  {
    name: 'mirrorCasinoTransaction', path: MONEY_PATHS.CASINO_SETTLEMENT, fn: mirrorCasinoTransaction,
    doc: { txId: 't1', roundId: 'r1', userId: 'u1', type: 'BET', amount: 100, providerKey: 'acme' },
  },
  {
    name: 'mirrorCycleSettlement', path: MONEY_PATHS.SETTLEMENTS, fn: mirrorCycleSettlement,
    doc: { cycleId: 'c1', isSettled: 'COMPLETED', winner: 'DELHI', totalPaidOut: 500 },
  },
  {
    name: 'mirrorBonusGrant', path: MONEY_PATHS.BONUSES_AND_COMMISSIONS, fn: mirrorBonusGrant,
    // GIFT_CODE, not an invented type: BONUS_KIND_FROM_RECORD maps a closed set
    // and ADMIN_CREDIT is deliberately absent from it, so an unmapped type is
    // indistinguishable from a working gate.
    doc: { _id: 'g1', userId: 'u1', type: 'GIFT_CODE', amount: 50, createdAt: new Date() },
  },
];

beforeEach(() => { onPostgres.clear(); queries.length = 0; });

describe('forward mirrors stop when Postgres owns the path', () => {
  it.each(MIRRORS)('$name writes while Mongo is authoritative', async ({ fn, doc }) => {
    await fn(doc);
    expect(queries.length).toBeGreaterThan(0);
  });

  it.each(MIRRORS)('$name writes NOTHING once its path is on Postgres', async ({ fn, doc, path }) => {
    onPostgres.add(path);
    await fn(doc);
    expect(queries).toEqual([]);
  });

  it('gates on its OWN path, not on any path having moved', async () => {
    // A mirror keyed on the wrong flag would stop early or keep going too long.
    // mirrorBet must not care that the casino path moved.
    onPostgres.add(MONEY_PATHS.CASINO_SETTLEMENT);
    await mirrorBet(MIRRORS[0].doc);
    expect(queries.length).toBeGreaterThan(0);
  });
});
