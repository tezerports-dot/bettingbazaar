// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Every team pool movement balances, checked by the database at the moment it
 * happens — against a REAL PostgreSQL (owner, 2026-10-04).
 *
 * The owner asked for the check to be event-based: when a team's pool and its
 * orders move, check it then, so no token can be spent twice. At the COMMIT of
 * every transaction that writes a pool, a pool entry or an order's hold
 * (`bb_team_pool_must_balance`, schema.sql):
 *   held     = the sum of the holds on the team's orders;
 *   the pool = its own latest ledger entry.
 * Anything else is refused (SQLSTATE BB001) and rolls back, whoever wrote it.
 *
 * What this proves: (1) each way the books could break is refused, with
 * nothing moved; (2) the opposite — every real path still commits and leaves
 * the team balanced; (3) a pool already out of balance (only reachable by a
 * write with triggers off) refuses the next movement as `pool_out_of_balance`
 * rather than a crash, and the hold sweep's finder lists it; (4) two buys
 * racing for one pool still produce one hold and a balanced team.
 * Trap 10: everything is this run's own and removed in `afterAll`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes } from 'node:crypto';
import { pgConfigured, pgQuery, applySchema, closePg, withTransaction } from '../client.js';
import {
  createMerchant, updateMerchant, newMerchantId, generateMerchantPublicRef,
} from '../repositories/merchants.js';
import { setSupervisorRole, createTeam, addMember, approveMember } from '../repositories/teams.js';
import {
  createRequest, fulfilRequest, getPool, releaseBuyHold, spendForBuy, creditSellToPool,
  findUnbalancedPools,
} from '../repositories/teamPools.js';
import { assignToTeam } from '../repositories/teamRouting.js';
import { createOrderRecord, getOrderRecord } from '../repositories/orders.record.js';
import { POOL_OUT_OF_BALANCE, POOL_OUT_OF_BALANCE_REASON } from '../repositories/poolBalance.js';

const describePg = pgConfigured() ? describe : describe.skip;
const T = (tokens) => tokens * 100;
const BUY = 50_000;   // a UPI_BANK size: the rail follows the size

describePg('every team pool movement balances, at its own commit (PostgreSQL)', () => {
  const made = [];
  const teams = [];
  const orders = [];
  let seq = 0;

  const merchant = async () => {
    const merchantId = newMerchantId();
    seq += 1;
    await createMerchant({
      merchantId, name: `PB ${merchantId.slice(-6)}`, publicRef: generateMerchantPublicRef(),
      mobile: `4${String(Date.now()).slice(-6)}${String(seq).padStart(3, '0')}`, status: 'ACTIVE',
      bankDetails: { accountHolderName: `PB Holder ${seq}`, bankName: 'Test Bank', accountNo: `4030${String(Date.now()).slice(-6)}${seq}`, ifsc: 'TEST0000001' },
    });
    await updateMerchant(merchantId, { merchantApprovalStatus: 'APPROVED' });
    made.push(merchantId);
    return merchantId;
  };

  /** A WORKING UPI_BANK team of ten, all online, with `pool` tokens; every other team of this run offline. */
  const workingTeam = async (pool) => {
    const sup = await merchant();
    expect(await setSupervisorRole(sup, { rail: 'UPI_BANK' })).toEqual({ ok: true });
    const { teamId } = await createTeam({ supervisorId: sup, name: 'Balance' });
    teams.push(teamId);
    const members = [];
    for (let i = 0; i < 10; i += 1) {
      const m = await merchant();
      expect((await addMember({ teamId, supervisorId: sup, merchantRef: m, actor: sup })).ok).toBe(true);
      expect((await approveMember({ merchantId: m, actor: 'admin-1' })).ok).toBe(true);
      members.push(m);
    }
    await pgQuery('UPDATE merchants SET is_online = (merchant_id = ANY($2)) WHERE merchant_id = ANY($1)', [made, members]);
    // Every OTHER team on the rail goes offline too, so this test routes among its own.
    await pgQuery(
      `UPDATE merchants SET is_online = FALSE
        WHERE is_online AND NOT (merchant_id = ANY($1)) AND merchant_id IN (
          SELECT tm.merchant_id FROM team_members tm JOIN teams t ON t.team_id = tm.team_id
            JOIN merchants s ON s.merchant_id = t.supervisor_id WHERE s.supervisor_rail = 'UPI_BANK')`,
      [members]);
    if (pool > 0) {
      const r = await createRequest({ teamId, supervisorId: sup, direction: 'BUY', tokenAmountPaise: T(pool) });
      expect((await fulfilRequest({
        requestId: r.requestId, actor: 'admin-1',
        consideration: { currency: 'INR', fiatAmountMinor: T(pool), rateUsed: null },
      })).ok).toBe(true);
    }
    return { sup, teamId, members };
  };

  const order = async (type, tokens) => {
    const orderId = `PB_${randomBytes(6).toString('hex')}`;
    orders.push(orderId);
    return createOrderRecord({ orderId, userId: `u_${orderId}`, type, tokenAmountRupees: tokens, currency: 'INR' });
  };
  const assign = (o) => assignToTeam(o, { cap: 3, barredMerchantIds: [], buildSet: async () => ({ assignedAt: new Date() }) });
  const balanced = async (teamId) =>
    (await pgQuery('SELECT bb_team_pool_imbalance($1) AS why', [teamId])).rows[0].why;
  /** A write as somebody's bug would make it: one transaction, nothing else. */
  const raw = (sql, params) => withTransaction((c) => c.query(sql, params));
  /** A write with the checks switched off — a manual repair. Never a path the platform takes. */
  const unchecked = (sql, params) => withTransaction(async (c) => {
    await c.query('SET LOCAL session_replication_role = replica');
    await c.query(sql, params);
  });

  beforeAll(async () => { await applySchema(); }, 60_000);
  afterAll(async () => {
    await withTransaction(async (c) => {
      await c.query('SET LOCAL session_replication_role = replica');
      await c.query('DELETE FROM order_transitions WHERE order_id = ANY($1)', [orders]);
      await c.query('DELETE FROM order_states WHERE order_id = ANY($1)', [orders]);
      await c.query('DELETE FROM admin_token_considerations WHERE team_id = ANY($1)', [teams]);
      await c.query('DELETE FROM team_pool_entries WHERE team_id = ANY($1)', [teams]);
      await c.query('DELETE FROM team_pool_requests WHERE team_id = ANY($1)', [teams]);
      await c.query('DELETE FROM team_pools WHERE team_id = ANY($1)', [teams]);
      await c.query('DELETE FROM team_members WHERE team_id = ANY($1)', [teams]);
      await c.query('DELETE FROM teams WHERE team_id = ANY($1)', [teams]);
      await c.query('DELETE FROM merchants WHERE merchant_id = ANY($1)', [made]);
    });
    await closePg();
  });

  // ── (2) The opposite: every real path commits, and the team balances ─────
  it('lets every real movement through, and the team balances after each', async () => {
    const { teamId } = await workingTeam(BUY);
    expect(await balanced(teamId)).toBeNull();

    const buy = await order('DEPOSIT', BUY);
    const held = await assign(buy);
    expect(held.ok).toBe(true);
    expect((await getPool(teamId)).heldPaise).toBe(T(BUY));
    expect(await balanced(teamId)).toBeNull();

    expect((await releaseBuyHold(buy.orderId)).ok).toBe(true);
    expect(await balanced(teamId)).toBeNull();

    // Held again (a new buy), then paid out to the player.
    const buy2 = await order('DEPOSIT', BUY);
    expect((await assign(buy2)).ok).toBe(true);
    expect((await spendForBuy(buy2.orderId)).ok).toBe(true);
    expect(await getPool(teamId)).toMatchObject({ availablePaise: 0, heldPaise: 0 });
    expect(await balanced(teamId)).toBeNull();

    // A sell settles into the pool.
    const sell = await order('WITHDRAWAL', BUY);
    expect((await assign(sell)).ok).toBe(true);
    expect((await creditSellToPool(sell.orderId)).ok).toBe(true);
    expect((await getPool(teamId)).availablePaise).toBe(T(BUY));
    expect(await balanced(teamId)).toBeNull();
  });

  // ── (1) Each way the books could break is refused, and nothing moves ──────
  it('refuses an order hold the pool does not carry', async () => {
    const { teamId } = await workingTeam(BUY);
    const o = await order('DEPOSIT', BUY);
    await expect(raw('UPDATE order_states SET team_id = $2, pool_held_paise = $3 WHERE order_id = $1',
      [o.orderId, teamId, T(BUY)])).rejects.toMatchObject({ code: POOL_OUT_OF_BALANCE });
    expect((await getOrderRecord(o.orderId)).poolHeldPaise ?? 0).toBe(0);
    expect(await getPool(teamId)).toMatchObject({ availablePaise: T(BUY), heldPaise: 0 });
  });

  it('refuses one pool hold promised to two orders (the double spend)', async () => {
    const { teamId } = await workingTeam(BUY);
    const a = await order('DEPOSIT', BUY);
    const b = await order('DEPOSIT', BUY);
    // The pool moves once, and two orders each claim the whole of it.
    await expect(withTransaction(async (c) => {
      await c.query('UPDATE team_pools SET available_paise = available_paise - $2, held_paise = held_paise + $2 WHERE team_id = $1', [teamId, T(BUY)]);
      await c.query('UPDATE order_states SET team_id = $2, pool_held_paise = $3 WHERE order_id = ANY($1)', [[a.orderId, b.orderId], teamId, T(BUY)]);
    })).rejects.toMatchObject({ code: POOL_OUT_OF_BALANCE });
    expect(await getPool(teamId)).toMatchObject({ availablePaise: T(BUY), heldPaise: 0 });
  });

  it('refuses a pool change with no ledger entry, and an entry with no pool change', async () => {
    const { teamId } = await workingTeam(BUY);
    await expect(raw('UPDATE team_pools SET available_paise = available_paise + 100 WHERE team_id = $1', [teamId]))
      .rejects.toMatchObject({ code: POOL_OUT_OF_BALANCE });
    await expect(raw(
      `INSERT INTO team_pool_entries (tx_id, team_id, kind, available_delta_paise, held_delta_paise,
         available_after_paise, held_after_paise, actor, ref_id)
       VALUES ($1, $2, 'ADMIN_SALE', 100, 0, $3, 0, 'test', 'test')`,
      [`pb_${randomBytes(6).toString('hex')}`, teamId, T(BUY) + 100],
    )).rejects.toMatchObject({ code: POOL_OUT_OF_BALANCE });
    expect(await getPool(teamId)).toMatchObject({ availablePaise: T(BUY), heldPaise: 0 });
  });

  // ── (3) A pool already out of balance refuses the next movement, cleanly ──
  it('refuses the next movement on a pool out of balance, and the sweep finds it', async () => {
    const { teamId, sup } = await workingTeam(BUY);
    await unchecked('UPDATE team_pools SET available_paise = available_paise + 100 WHERE team_id = $1', [teamId]);
    try {
      expect((await findUnbalancedPools()).map((p) => p.teamId)).toContain(teamId);

      // Routing: the hold is refused at commit, as a refusal, and the buy stays queued.
      const buy = await order('DEPOSIT', BUY);
      const out = await assign(buy);
      expect(out).toMatchObject({ ok: false, reason: POOL_OUT_OF_BALANCE_REASON });
      const row = await getOrderRecord(buy.orderId);
      expect(row.status).toBe('PENDING_QUEUE');
      expect(row.poolHeldPaise ?? 0).toBe(0);

      // The pool writer's own transactions: a sale into the pool is refused too.
      const r = await createRequest({ teamId, supervisorId: sup, direction: 'BUY', tokenAmountPaise: T(500) });
      expect(await fulfilRequest({
        requestId: r.requestId, actor: 'admin-1',
        consideration: { currency: 'INR', fiatAmountMinor: T(500), rateUsed: null },
      })).toMatchObject({ ok: false, reason: POOL_OUT_OF_BALANCE_REASON });
    } finally {
      await unchecked('UPDATE team_pools SET available_paise = available_paise - 100 WHERE team_id = $1', [teamId]);
    }
    expect(await balanced(teamId)).toBeNull();
    expect((await findUnbalancedPools()).map((p) => p.teamId)).not.toContain(teamId);
  });

  // ── (4) Two buys racing for one pool: one hold, and the team balances ─────
  it('lets one of two racing buys hold a pool that covers one, and stays balanced', async () => {
    const { teamId } = await workingTeam(BUY);
    const a = await order('DEPOSIT', BUY);
    const b = await order('DEPOSIT', BUY);
    const results = await Promise.all([assign(a), assign(b)]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(await getPool(teamId)).toMatchObject({ availablePaise: 0, heldPaise: T(BUY) });
    expect(await balanced(teamId)).toBeNull();
  });
});
