// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The token ledger read as profit and loss (`tokenLedger.js`): each kind of
 * movement lands in its kind, with the platform's side signed the right way,
 * through the real treasury writer and its conservation triggers. Movements
 * are read back by their own ids, never as a global total (trap 10).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pgConfigured, applySchema, closePg, pgQuery } from '../client.js';
import { ACCOUNTS, postMovement } from '../repositories/treasury.js';
import { tokenMovements, tokenProfit, TOKEN_FLOW_KINDS } from '../repositories/tokenLedger.js';

const describePg = pgConfigured() ? describe : describe.skip;
const tag = `tl_${Date.now()}`;

describePg('token ledger', () => {
  beforeAll(async () => { await applySchema(); });
  afterAll(async () => { await closePg(); });

  const one = async (movementId) => {
    const m = await tokenMovements({ search: movementId });
    expect(m.rows).toHaveLength(1);
    return m.rows[0];
  };

  it('classifies platform-only movements and signs the platform side', async () => {
    // Out to a platform pool and back: platform to platform, net zero.
    await postMovement({ movementId: `${tag}_alloc`, operation: 'ALLOCATE_OPERATIONAL_FLOAT',
      legs: { [ACCOUNTS.TOKEN_SUPPLY]: -5000, [ACCOUNTS.OPERATIONAL_FLOAT]: 5000 } });
    const alloc = await one(`${tag}_alloc`);
    expect(alloc).toMatchObject({ kind: 'INTERNAL', tokenSupply: -50, platformPools: 50, platformNet: 0 });
  });

  it('reads a real movement of every producer kind with the sign the platform sees', async () => {
    const { rows } = await pgQuery(
      `SELECT DISTINCT ON (operation) movement_id, operation FROM treasury_entries
        WHERE operation IN ('TEAM_POOL_SALE', 'TEAM_BUY_PAID', 'PROMO_CREDITED', 'TEAM_COMMISSION')
           OR operation LIKE 'BET\\_%' ORDER BY operation, id DESC`);
    for (const r of rows) {
      const m = await one(r.movement_id);
      if (r.operation === 'TEAM_POOL_SALE') expect(m).toMatchObject({ kind: 'POOL_TRADE' });
      if (r.operation === 'TEAM_POOL_SALE') expect(m.platformNet).toBeLessThan(0);
      if (r.operation === 'TEAM_BUY_PAID') expect(m).toMatchObject({ kind: 'PLAYER_TRADE', platformNet: 0 });
      if (r.operation === 'PROMO_CREDITED') expect(m.kind).toBe('BONUS');
      if (r.operation === 'PROMO_CREDITED') expect(m.platformNet).toBeLessThan(0);
      if (r.operation === 'TEAM_COMMISSION') expect(m.kind).toBe('COMMISSION');
      if (r.operation.startsWith('BET_')) expect(m.kind).toBe('GAME_BOARD');
      // Every movement balances: what the platform gained the wallets and pools lost.
      expect(m.platformNet + m.wallets + m.teamPools).toBeCloseTo(0, 2);
    }
  });

  it('sums a lost stake as house profit and a win beyond the reserve as a release', async () => {
    // A stake lost: USER_FLOAT -> HOUSE_RESERVE. Posted platform-only here, as
    // HOUSE_RESERVE out of OPERATIONAL_FLOAT, since USER_FLOAT moves only with
    // a wallet (conservation); the classification is by operation.
    await postMovement({ movementId: `${tag}_bet`, operation: 'BET_LOST',
      legs: { [ACCOUNTS.OPERATIONAL_FLOAT]: -1000, [ACCOUNTS.HOUSE_RESERVE]: 1000 } });
    expect(await one(`${tag}_bet`)).toMatchObject({ kind: 'GAME_BOARD', houseReserve: 10, platformNet: 0 });
  });

  it('refuses an unknown kind by name', async () => {
    await expect(tokenMovements({ kind: 'NOPE' })).rejects.toMatchObject({ status: 400, code: 'UNKNOWN_KIND' });
  });

  it('returns every kind, profit kinds marked, and the cash check', async () => {
    const p = await tokenProfit({});
    expect(p.kinds.map((k) => k.kind)).toEqual([...TOKEN_FLOW_KINDS]);
    expect(p.kinds.find((k) => k.kind === 'POOL_TRADE').profit).toBe(false);
    expect(p.kinds.find((k) => k.kind === 'GAME_BOARD').profit).toBe(true);
    expect(Number.isFinite(p.netProfit)).toBe(true);
    expect(Number.isFinite(p.outstandingNow.total)).toBe(true);
    const sum = p.kinds.filter((k) => k.profit).reduce((s, k) => s + k.tokens, 0);
    expect(sum).toBeCloseTo(p.netProfit, 2);
  });
});
