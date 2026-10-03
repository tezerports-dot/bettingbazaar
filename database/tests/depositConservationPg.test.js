// GOVERNANCE: Read CLAUDE.md before editing this file.
/**
 * A confirmed deposit MOVES tokens. It never creates them.
 *
 * The team's pool parts with exactly what the player receives, whatever the
 * deposit/reserve policy splits it into. The unit suite asserts that pairing by
 * observing the amounts each writer is ASKED for; this one runs the real
 * writers — `moveDepositMoney` over the real pool spend and the real wallet
 * credits — against a real database and checks the money afterwards, on both
 * sides and in the treasury that summarises them.
 *
 * Both exist deliberately. A stub makes the amounts visible; only the real
 * writers prove they move. A suite that mocked the settlement writer once
 * reported settlement working while the real function threw on every call.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pgConfigured, pgQuery, applySchema, closePg } from '../client.js';
import { creditDeposit, creditReserve, getBalances } from '../repositories/wallets.js';
import { createOrderRecord, getOrderRecord } from '../repositories/orders.record.js';
import { assignToTeam } from '../repositories/teamRouting.js';
import { getPool, releaseBuyHold } from '../repositories/teamPools.js';
import { getTreasuryBalances, ACCOUNTS } from '../repositories/treasury.js';
import { teamFixture } from '../../backend/tests/teamFixture.js';
import { moveDepositMoney } from '../../backend/domains/payment/depositCredit.js';

const describePg = pgConfigured() ? describe : describe.skip;

// Globally-unique ledger keys, so a fixed id would collide across runs.
const RUN = Math.random().toString(36).slice(2, 8);
let n = 0;
const next = () => (n += 1);

/** The pool's whole holding, in tokens. */
const poolTokens = async (teamId) => {
  const p = await getPool(teamId);
  return (p.availablePaise + p.heldPaise) / 100;
};

describePg('a confirmed deposit conserves tokens', () => {
  const teams = teamFixture();
  const orders = [];

  beforeAll(async () => { await applySchema(); }, 60_000);
  afterAll(async () => {
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

  /**
   * A UPI buy (above the 10,000-token cash ceiling) assigned to the team, so
   * its tokens are HELD in the pool — the position every confirm starts from.
   */
  async function heldBuy(team, tokens, split = {}) {
    const orderId = `DC_${RUN}_${next()}`;
    orders.push(orderId);
    const order = await createOrderRecord({
      orderId, userId: `dc-u-${RUN}-${next()}`, type: 'DEPOSIT', tokenAmountRupees: tokens, currency: 'INR',
      ...split,
    });
    const got = await assignToTeam(order, { cap: 3, buildSet: async () => ({}) });
    expect(got, JSON.stringify(got)).toMatchObject({ ok: true, teamId: team.teamId });
    return getOrderRecord(orderId);
  }

  /** The confirm, with the real writers, exactly as every completing route calls it. */
  const confirm = (order) => moveDepositMoney(order, {
    creditDeposit, creditReserve, releaseUTR: async () => {}, requireState: order.status,
  });

  for (const [label, depositAllocation, reserveAllocation] of [
    ['a 90/10 policy', 18000, 2000],
    ['a 50/50 policy', 10000, 10000],
    ['the whole deposit to reserve', 0, 20000],
    ['no reserve share at all', 20000, 0],
    ['an awkward split', 18621, 1379],
  ]) {
    it(`moves exactly what it takes, under ${label}`, async () => {
      const total = depositAllocation + reserveAllocation;
      const team = await teams.workingTeam({ rail: 'UPI_BANK', poolTokens: 100_000 });
      const order = await heldBuy(team, total, { depositAllocation, reserveAllocation });

      const poolBefore = await poolTokens(team.teamId);
      const before = await getTreasuryBalances();
      expect(await confirm(order)).toMatchObject({ ok: true });

      const poolAfter = await poolTokens(team.teamId);
      const after = await getTreasuryBalances();
      const player = await getBalances(order.userId);

      // The team parted with the total…
      expect(poolBefore - poolAfter).toBe(total);
      // …the player received it, across whichever pockets the policy chose…
      expect(player.depositBalance).toBe(depositAllocation);
      expect(player.reserveBalance).toBe(reserveAllocation);
      // …and the two figures are the same number. One route once debited
      // `depositAllocation` and credited `depositAllocation + reserveAllocation`,
      // so every deposit with a reserve share created tokens out of nothing.
      expect(player.depositBalance + player.reserveBalance).toBe(poolBefore - poolAfter);
      // The treasury records the same transfer, team float to user float.
      expect(after[ACCOUNTS.TEAM_FLOAT] - before[ACCOUNTS.TEAM_FLOAT]).toBe(-total * 100);
      expect(after[ACCOUNTS.USER_FLOAT] - before[ACCOUNTS.USER_FLOAT]).toBe(total * 100);
    });
  }

  it('refuses before anything moves when the pool cannot cover it', async () => {
    // The one way a paid buy can find nothing to spend: its hold was released
    // (it expired, then a dispute found the player had paid) and the team has
    // since committed the tokens to another buy.
    const team = await teams.workingTeam({ rail: 'UPI_BANK', poolTokens: 20_000 });
    const first = await heldBuy(team, 20_000);
    expect((await releaseBuyHold(first.orderId)).ok).toBe(true);
    await heldBuy(team, 20_000);                      // takes the whole pool
    const stale = await getOrderRecord(first.orderId);

    const before = await getTreasuryBalances();
    expect(await confirm(stale)).toMatchObject({ ok: false, reason: 'pool_short' });

    // The team's side is taken FIRST for exactly this reason: a refusal must
    // leave the player uncredited, not credited from a pool that could not fund it.
    expect(await getPool(team.teamId)).toMatchObject({ availablePaise: 0, heldPaise: 2_000_000 });
    const player = await getBalances(stale.userId);
    expect(player.depositBalance).toBe(0);
    expect(player.reserveBalance).toBe(0);
    expect(await getTreasuryBalances()).toEqual(before);
  });

  it('moves once when the same confirm is delivered twice', async () => {
    const team = await teams.workingTeam({ rail: 'UPI_BANK', poolTokens: 100_000 });
    const order = await heldBuy(team, 20_000, { depositAllocation: 18_000, reserveAllocation: 2_000 });

    // A member clicking while an admin force-approves is the real case. Every
    // movement is keyed on the order, so the second delivery is a no-op rather
    // than a second dispensation.
    await Promise.all([confirm(order), confirm(order)]);
    await confirm(order);

    expect(await poolTokens(team.teamId)).toBe(80_000);
    const player = await getBalances(order.userId);
    expect(player.depositBalance).toBe(18_000);
    expect(player.reserveBalance).toBe(2_000);
  });

  it('conserves across concurrent deposits from one team', async () => {
    const team = await teams.workingTeam({ rail: 'UPI_BANK', poolTokens: 150_000 });
    const buys = [];
    for (let i = 0; i < 8; i += 1) {
      buys.push(await heldBuy(team, 15_000, { depositAllocation: 13_500, reserveAllocation: 1_500 }));
    }
    const before = await getTreasuryBalances();

    await Promise.all(buys.map(confirm));

    const credited = (await Promise.all(buys.map((o) => getBalances(o.userId))))
      .reduce((sum, b) => sum + b.depositBalance + b.reserveBalance, 0);
    const after = await getTreasuryBalances();

    // Eight × 15,000 against a 150,000 pool: all eight fit. What is asserted is
    // that the team's loss equals the players' gain to the paisa, whatever
    // order the eight interleaved in — and that the treasury says so too.
    expect(150_000 - await poolTokens(team.teamId)).toBe(credited);
    expect(credited).toBe(120_000);
    expect(after[ACCOUNTS.USER_FLOAT] - before[ACCOUNTS.USER_FLOAT]).toBe(credited * 100);
  });
});
