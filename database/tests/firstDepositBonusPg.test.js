// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The first deposit bonus, against a real database (owner, 2026-10-15: "on
 * first deposit ... admin can set how much they will receive ... that bonus
 * will go in general not in vip").
 *
 * Driven through the real confirm (`moveDepositMoney` → `completeBuy` →
 * `teamPools.spendForBuy`), because the bonus is paid inside the buy's own
 * transaction and that pairing is the claim.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pgConfigured, pgQuery, applySchema, closePg } from '../client.js';
import { getBalancesPaise } from '../repositories/wallets.core.js';
import { createOrderRecord, getOrderRecord } from '../repositories/orders.record.js';
import { assignToTeam } from '../repositories/teamRouting.js';
import { getTreasuryBalances, ACCOUNTS } from '../repositories/treasury.js';
import { getSystemConfig, setConfigPath } from '../repositories/config.js';
import * as promo from '../repositories/promo.js';
import { teamFixture } from '../../backend/tests/teamFixture.js';
import { moveDepositMoney } from '../../backend/domains/payment/depositCredit.js';

const describePg = pgConfigured() ? describe : describe.skip;
const RUN = Math.random().toString(36).slice(2, 8);
let n = 0;
const next = () => (n += 1);
const newPlayer = () => `fdb-u-${RUN}-${next()}`;

describePg('the first deposit bonus', () => {
  const teams = teamFixture();
  const orders = [];
  let savedRupees;
  let savedMultiplier;

  beforeAll(async () => {
    await applySchema();
    const cfg = await getSystemConfig();
    savedRupees = cfg.firstDepositBonus?.rupees ?? 0;
    savedMultiplier = cfg.referralRewards.turnoverMultiplier;
    await setConfigPath('system', 'referralRewards.turnoverMultiplier', 10);
  }, 60_000);
  afterAll(async () => {
    await setConfigPath('system', 'firstDepositBonus.rupees', savedRupees);
    await setConfigPath('system', 'referralRewards.turnoverMultiplier', savedMultiplier);
    await pgQuery('SET session_replication_role = replica');
    try {
      await pgQuery('DELETE FROM order_transitions WHERE order_id = ANY($1)', [orders]);
      await pgQuery('DELETE FROM order_states WHERE order_id = ANY($1)', [orders]);
    } finally {
      await pgQuery('SET session_replication_role = DEFAULT');
    }
    await teams.cleanup();
    await closePg();
  });

  const bonus = (rupees) => setConfigPath('system', 'firstDepositBonus.rupees', rupees);

  /** A UPI buy held in the team's pool, then confirmed exactly as every route does. */
  async function buy(team, userId, tokens) {
    const orderId = `FDB_${RUN}_${next()}`;
    orders.push(orderId);
    const order = await createOrderRecord({ orderId, userId, type: 'DEPOSIT', tokenAmountRupees: tokens, currency: 'INR' });
    const got = await assignToTeam(order, { cap: 3, buildSet: async () => ({}) });
    expect(got, JSON.stringify(got)).toMatchObject({ ok: true, teamId: team.teamId });
    const held = await getOrderRecord(orderId);
    return moveDepositMoney(held, { releaseUTR: async () => {}, requireState: held.status });
  }

  it('pays the admin amount into GENERAL with the first buy, never into VIP, with a 10× requirement', async () => {
    await bonus(200);
    const team = await teams.workingTeam({ rail: 'UPI_BANK', poolTokens: 100_000 });
    const u = newPlayer();
    const before = await getTreasuryBalances();

    expect(await buy(team, u, 20_000)).toMatchObject({ ok: true });

    const b = await getBalancesPaise(u);
    expect(b.promoBalance).toBe(20_000);                       // ₹200 in GENERAL
    expect(b.depositBalance + b.reserveBalance).toBe(2_000_000); // the buy, untouched
    expect(b.winningsBalance).toBe(0);
    const s = await promo.promoSummary(u);
    expect(s.grants).toHaveLength(1);
    expect(s.grants[0]).toMatchObject({ source: 'FIRST_DEPOSIT', amountPaise: 20_000, requiredTurnoverPaise: 200_000 });
    expect(s.outstandingTurnoverPaise).toBe(200_000);

    // The bonus came out of the platform's holding; the buy out of the team's.
    const after = await getTreasuryBalances();
    expect(after[ACCOUNTS.TOKEN_SUPPLY] - before[ACCOUNTS.TOKEN_SUPPLY]).toBe(-20_000);
    expect(after[ACCOUNTS.TEAM_FLOAT] - before[ACCOUNTS.TEAM_FLOAT]).toBe(-2_000_000);
    expect(after[ACCOUNTS.USER_FLOAT] - before[ACCOUNTS.USER_FLOAT]).toBe(2_020_000);
  });

  it('a second buy pays no second bonus', async () => {
    await bonus(200);
    const team = await teams.workingTeam({ rail: 'UPI_BANK', poolTokens: 100_000 });
    const u = newPlayer();
    await buy(team, u, 20_000);
    expect(await buy(team, u, 20_000)).toMatchObject({ ok: true });
    expect((await getBalancesPaise(u)).promoBalance).toBe(20_000);
    expect((await promo.promoSummary(u)).grants).toHaveLength(1);
  });

  it('a player who bought before the bonus was switched on gets none', async () => {
    await bonus(0);
    const team = await teams.workingTeam({ rail: 'UPI_BANK', poolTokens: 100_000 });
    const u = newPlayer();
    await buy(team, u, 20_000);
    await bonus(200);
    await buy(team, u, 20_000);
    expect((await getBalancesPaise(u)).promoBalance).toBe(0);
  });

  it('pays nothing while the amount is 0', async () => {
    await bonus(0);
    const team = await teams.workingTeam({ rail: 'UPI_BANK', poolTokens: 100_000 });
    const u = newPlayer();
    const before = await getTreasuryBalances();
    expect(await buy(team, u, 20_000)).toMatchObject({ ok: true });
    expect((await getBalancesPaise(u)).promoBalance).toBe(0);
    expect((await promo.promoSummary(u)).grants).toHaveLength(0);
    expect((await getTreasuryBalances())[ACCOUNTS.TOKEN_SUPPLY]).toBe(before[ACCOUNTS.TOKEN_SUPPLY]);
  });

  it('concurrent first buys of one player pay exactly one bonus', async () => {
    await bonus(150);
    const team = await teams.workingTeam({ rail: 'UPI_BANK', poolTokens: 200_000 });
    const u = newPlayer();
    const results = await Promise.all([1, 2, 3, 4].map(() => buy(team, u, 20_000)));
    expect(results.every((r) => r.ok)).toBe(true);
    const b = await getBalancesPaise(u);
    expect(b.promoBalance).toBe(15_000);
    expect(b.depositBalance + b.reserveBalance).toBe(8_000_000);
    expect((await promo.promoSummary(u)).grants).toHaveLength(1);
  });

  it('a bonus that fails is unwound alone: the buy still completes', async () => {
    // Make the grant's insert fail for this one player, after the bonus tokens
    // moved: the savepoint must take the tokens back too, and the buy stand.
    await bonus(200);
    const team = await teams.workingTeam({ rail: 'UPI_BANK', poolTokens: 100_000 });
    const u = newPlayer();
    const fn = `fdb_fail_${RUN}`;
    await pgQuery(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.user_id = '${u}' THEN RAISE EXCEPTION 'test: grant refused'; END IF; RETURN NEW; END $$`);
    await pgQuery(`CREATE TRIGGER ${fn} BEFORE INSERT ON promo_grants FOR EACH ROW EXECUTE FUNCTION ${fn}()`);
    try {
      const before = await getTreasuryBalances();
      const done = await buy(team, u, 20_000);
      expect(done).toMatchObject({ ok: true });
      expect((await promo.promoSummary(u)).grants).toHaveLength(0);
      const b = await getBalancesPaise(u);
      expect(b.depositBalance + b.reserveBalance).toBe(2_000_000);
      expect(b.promoBalance).toBe(0);
      const after = await getTreasuryBalances();
      expect(after[ACCOUNTS.TOKEN_SUPPLY]).toBe(before[ACCOUNTS.TOKEN_SUPPLY]);
      expect(after[ACCOUNTS.USER_FLOAT] - before[ACCOUNTS.USER_FLOAT]).toBe(2_000_000);
    } finally {
      await pgQuery(`DROP TRIGGER IF EXISTS ${fn} ON promo_grants`);
      await pgQuery(`DROP FUNCTION IF EXISTS ${fn}()`);
    }
  });

  it('the bonus unlocks into winnings once 10× is bet from GENERAL', async () => {
    await bonus(100);
    const team = await teams.workingTeam({ rail: 'UPI_BANK', poolTokens: 100_000 });
    const u = newPlayer();
    await buy(team, u, 20_000);
    const r = await promo.recordTurnover({ userId: u, stakeRef: `${u}-stake`, amountPaise: 100_000 });
    expect(r.completedGrants).toEqual([`fdb_${orders.at(-1)}`]);
    const b = await getBalancesPaise(u);
    expect(b.promoBalance).toBe(0);
    expect(b.winningsBalance).toBe(10_000);
  });
});
