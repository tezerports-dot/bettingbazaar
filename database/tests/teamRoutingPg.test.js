// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Team routing and the pool hold, against a REAL PostgreSQL (Step 2c).
 *
 * What needs a database: the member's concurrency and the pool's cover are
 * guarded by writes under row locks, so they are RACED here; the hold is
 * taken in the same transaction as the assignment, so a refused hold must
 * leave the order queued; and every pool movement must move TEAM_FLOAT with it.
 *
 * Trap 10: every merchant, team and order is this run's own, removed after.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes } from 'node:crypto';
import { pgConfigured, pgQuery, applySchema, closePg } from '../client.js';
import {
  createMerchant, updateMerchant, newMerchantId, generateMerchantPublicRef, getMerchant,
  setRoutingPriority, recordCompletedOrder, ROUTING_PRIORITY,
} from '../repositories/merchants.js';
import { setSupervisorRole, createTeam, addMember, approveMember, removeMember } from '../repositories/teams.js';
import {
  createRequest, fulfilRequest, getPool, releaseBuyHold, spendForBuy, detachFromTeamWithin,
  creditSellToPool, reverseSellFromPool, findStrandedBuyHolds, findCompletedUnspentBuys, poolStanding,
} from '../repositories/teamPools.js';
import { assignToTeam, routingCandidates, railOf, setCashReady, routingSettings } from '../repositories/teamRouting.js';
import { createOrderRecord, getOrderRecord } from '../repositories/orders.record.js';
import { transitionOrder } from '../repositories/orders.js';
import { getTreasuryBalances, ACCOUNTS } from '../repositories/treasury.js';
import { debitWinningsForWithdrawal, getBalances } from '../repositories/wallets.js';
import { fundWallet } from './_funding.js';

const describePg = pgConfigured() ? describe : describe.skip;
const T = (tokens) => tokens * 100;

describePg('team routing and pool holds (PostgreSQL)', () => {
  const made = [];
  const teams = [];
  const orders = [];
  let seq = 0;

  // With the bank account a UPI/bank buy is paid into (owner, 2026-10-03).
  const merchant = async () => {
    const merchantId = newMerchantId();
    seq += 1;
    await createMerchant({
      merchantId, name: `TR ${merchantId.slice(-6)}`, publicRef: generateMerchantPublicRef(),
      mobile: `5${String(Date.now()).slice(-6)}${String(seq).padStart(3, '0')}`, status: 'ACTIVE',
      bankDetails: { accountHolderName: `TR Holder ${seq}`, bankName: 'Test Bank', accountNo: `5030${String(Date.now()).slice(-6)}${seq}`, ifsc: 'TEST0000001' },
    });
    await updateMerchant(merchantId, { merchantApprovalStatus: 'APPROVED' });
    made.push(merchantId);
    return merchantId;
  };
  const online = (ids, on = true) => pgQuery('UPDATE merchants SET is_online = $2 WHERE merchant_id = ANY($1)', [ids, on]);

  /** A full team of ten on `rail`, every member online, with `pool` tokens. */
  const workingTeam = async (rail = 'UPI_BANK', pool = 0) => {
    const sup = await merchant();
    expect(await setSupervisorRole(sup, { rail })).toEqual({ ok: true, merchantId: sup });
    const { teamId } = await createTeam({ supervisorId: sup, name: 'Route' });
    teams.push(teamId);
    const members = [];
    for (let i = 0; i < 10; i += 1) {
      const m = await merchant();
      expect((await addMember({ teamId, supervisorId: sup, merchantRef: m, actor: sup })).ok).toBe(true);
      expect((await approveMember({ merchantId: m, actor: 'admin-1' })).ok).toBe(true);
      members.push(m);
    }
    await online(members);
    // Each test routes among ITS team only: every earlier team of this run goes offline.
    await pgQuery('UPDATE merchants SET is_online = FALSE WHERE merchant_id = ANY($1) AND NOT (merchant_id = ANY($2))', [made, members]);
    if (pool > 0) {
      const r = await createRequest({ teamId, supervisorId: sup, direction: 'BUY', tokenAmountPaise: T(pool) });
      expect((await fulfilRequest({ requestId: r.requestId, actor: 'admin-1', consideration: { currency: 'INR', fiatAmountMinor: T(pool), rateUsed: null } })).ok).toBe(true);
    }
    return { sup, teamId, members };
  };

  // The rail is derived from the size (`paymentModeFor`): up to 10,000 tokens
  // is CASH, above it UPI_BANK. The UPI cases below therefore use amounts
  // above 10,000.
  const order = async (type, tokens, { currency = 'INR', usdtChain = null } = {}) => {
    const orderId = `TR_${randomBytes(6).toString('hex')}`;
    orders.push(orderId);
    const userId = `u_${orderId}`;
    const record = await createOrderRecord({
      orderId, userId, type, tokenAmountRupees: tokens, currency, usdtChain,
    });
    // A SELL's tokens are the PLAYER's, locked with the order. The settlement
    // consumes that lock in the same transaction as the pool credit, so a sell
    // whose stake was never locked is refused — and a fixture that skipped it
    // would be testing a state the platform cannot produce (§32 S16).
    if (type === 'WITHDRAWAL') {
      await fundWallet(userId, T(tokens), `tr_seed_${orderId}`, 'winningsBalance');
      await debitWinningsForWithdrawal(userId, tokens, orderId);
    }
    return record;
  };
  const assign = (o, cap = 3, barred = []) => assignToTeam(o, {
    cap, barredMerchantIds: barred, buildSet: async () => ({ assignedAt: new Date() }),
  });

  beforeAll(async () => { await applySchema(); }, 60_000);
  afterAll(async () => {
    await pgQuery('SET session_replication_role = replica');
    try {
      await pgQuery('DELETE FROM order_transitions WHERE order_id = ANY($1)', [orders]);
      await pgQuery('DELETE FROM order_states WHERE order_id = ANY($1)', [orders]);
      await pgQuery('DELETE FROM admin_token_considerations WHERE team_id = ANY($1)', [teams]);
      await pgQuery('DELETE FROM team_pool_entries WHERE team_id = ANY($1)', [teams]);
      await pgQuery('DELETE FROM team_pool_requests WHERE team_id = ANY($1)', [teams]);
      await pgQuery('DELETE FROM team_pools WHERE team_id = ANY($1)', [teams]);
      await pgQuery('DELETE FROM team_members WHERE team_id = ANY($1)', [teams]);
      await pgQuery('DELETE FROM teams WHERE team_id = ANY($1)', [teams]);
      await pgQuery('DELETE FROM merchants WHERE merchant_id = ANY($1)', [made]);
    } finally {
      await pgQuery('SET session_replication_role = DEFAULT');
    }
    await closePg();
  });

  it('names the rail from the order itself', () => {
    expect(railOf({ currency: 'USDT', paymentMode: 'P2P_UPI' })).toBe('USDT');
    expect(railOf({ currency: 'INR', paymentMode: 'CASH_ATM' })).toBe('CASH');
    expect(railOf({ currency: 'INR', paymentMode: 'P2P_UPI' })).toBe('UPI_BANK');
  });

  it('routing settings fall back to the schema defaults, key by key', () => {
    expect(routingSettings(null)).toEqual({
      concurrency: { CASH: 1, UPI_BANK: 3 },
      assignmentWaitSeconds: 1500,
      processingWindowSeconds: { CASH: 900, UPI_BANK: 900 },
      utrSubmitSeconds: 60,
    });
    const s = routingSettings({ teamRouting: { concurrency: { UPI_BANK: '5' }, utrSubmitSeconds: 90 } });
    expect(s.concurrency).toEqual({ CASH: 1, UPI_BANK: 5 });
    expect(s.utrSubmitSeconds).toBe(90);
  });

  // ── Who is eligible ──────────────────────────────────────────────────────
  it('a buy goes to a member of a working team on its rail, holding the tokens in the pool', async () => {
    const t = await workingTeam('UPI_BANK', 100000);
    const o = await order('DEPOSIT', 50000);
    const before = await getTreasuryBalances();
    const out = await assign(o);
    expect(out.ok).toBe(true);
    expect(t.members).toContain(out.merchantId);
    const row = await getOrderRecord(o.orderId);
    expect(row).toMatchObject({ status: 'PROCESSING', teamId: t.teamId, poolHeldPaise: T(50000), merchantId: out.merchantId });
    expect(await getPool(t.teamId)).toMatchObject({ availablePaise: T(50000), heldPaise: T(50000) });
    // A hold moves nothing between accounts: the tokens are still the team's.
    expect((await getTreasuryBalances())[ACCOUNTS.TEAM_FLOAT]).toBe(before[ACCOUNTS.TEAM_FLOAT]);
  });

  it('a bank-transfer buy is never routed to a member with no bank account on file', async () => {
    // The player would be shown nowhere to pay, and take the expiry for it.
    const t = await workingTeam('UPI_BANK', 100000);
    await pgQuery(
      `UPDATE merchants SET bank_account_no = NULL WHERE merchant_id = ANY($1)`, [t.members.slice(1)]);
    const o = await order('DEPOSIT', 50000);
    const cands = await routingCandidates(await getOrderRecord(o.orderId), { cap: 3, limit: 50 });
    const inTeam = cands.filter((c) => c.teamId === t.teamId).map((c) => c.merchantId);
    expect(inTeam).toEqual([t.members[0]]);
    // The opposite case: a SELL is paid by the member, so their own account is
    // not what it needs, and every member of the team is still a candidate.
    const sell = await order('WITHDRAWAL', 50000);
    const sellers = (await routingCandidates(await getOrderRecord(sell.orderId), { cap: 3, limit: 50 }))
      .filter((c) => c.teamId === t.teamId);
    expect(sellers.length).toBe(t.members.length);
  });

  // A team works with any number of approved members, one to ten (owner,
  // Phase A). There is no team-level gate: the member's own APPROVED is it.
  it('a team of ONE approved member takes orders', async () => {
    const sup = await merchant();
    await setSupervisorRole(sup, { rail: 'UPI_BANK' });
    const { teamId } = await createTeam({ supervisorId: sup, name: 'Solo' });
    teams.push(teamId);
    const m = await merchant();
    await addMember({ teamId, supervisorId: sup, merchantRef: m, actor: sup });
    await approveMember({ merchantId: m, actor: 'a' });
    await online([m]);
    const o = await order('WITHDRAWAL', 100000);
    const cands = await routingCandidates(await getOrderRecord(o.orderId), { cap: 3, limit: 500 });
    expect(cands.filter((c) => c.teamId === teamId)).toEqual([{ merchantId: m, teamId, openOrders: 0 }]);
    // Everyone else barred, so the assignment has one place to go.
    const others = cands.map((c) => c.merchantId).filter((id) => id !== m);
    expect(await assign(o, 3, others)).toMatchObject({ ok: true, merchantId: m, teamId });
  });

  it('a team whose only member is still PENDING takes nothing (the opposite case)', async () => {
    const sup = await merchant();
    await setSupervisorRole(sup, { rail: 'UPI_BANK' });
    const { teamId } = await createTeam({ supervisorId: sup, name: 'Waiting' });
    teams.push(teamId);
    const m = await merchant();
    await addMember({ teamId, supervisorId: sup, merchantRef: m, actor: sup });
    await online([m]);
    const o = await order('WITHDRAWAL', 100000);
    const cands = await routingCandidates(await getOrderRecord(o.orderId), { cap: 3, limit: 500 });
    expect(cands.map((c) => c.merchantId)).not.toContain(m);
  });

  it('a team that drops below ten keeps working, with no grace day to run out', async () => {
    const t = await workingTeam('UPI_BANK', 0);
    for (const m of t.members.slice(0, 9)) {
      expect((await removeMember({ merchantId: m, supervisorId: t.sup })).ok).toBe(true);
    }
    const cands = await routingCandidates(await order('WITHDRAWAL', 70000), { cap: 3, limit: 500 });
    expect(cands.filter((c) => c.teamId === t.teamId).map((c) => c.merchantId)).toEqual([t.members[9]]);
  });

  it('a buy is not routed to a team whose pool cannot cover it, and stays queued', async () => {
    const t = await workingTeam('UPI_BANK', 100000);
    const o = await order('DEPOSIT', 100100);
    const cands = await routingCandidates(o, { cap: 3, limit: 500 });
    expect(cands.some((c) => c.teamId === t.teamId)).toBe(false);
  });

  it('only teams on the order\'s rail are candidates', async () => {
    const cash = await workingTeam('CASH', 100000);
    const o = await order('WITHDRAWAL', 50000);  // UPI_BANK rail
    const cands = await routingCandidates(o, { cap: 3, limit: 500 });
    expect(cands.some((c) => c.teamId === cash.teamId)).toBe(false);
  });

  it('a CASH buy needs a member who pressed Ready, and the assignment switches it off', async () => {
    const t = await workingTeam('CASH', 10000);
    const o = await order('DEPOSIT', 500);
    const none = await routingCandidates(o, { cap: 1, limit: 500 });
    expect(none.some((c) => c.teamId === t.teamId)).toBe(false);
    expect(await setCashReady(t.members[3], true)).toEqual({ ok: true, ready: true });
    const out = await assign(o, 1);
    expect(out).toMatchObject({ ok: true, merchantId: t.members[3], teamId: t.teamId });
    const { rows } = await pgQuery('SELECT cash_ready FROM merchants WHERE merchant_id = $1', [t.members[3]]);
    expect(rows[0].cash_ready).toBe(false);
  });

  it('the merchant read carries Ready, so the panel shows what routing sees (S36)', async () => {
    const t = await workingTeam('CASH', 0);
    expect((await getMerchant(t.members[0])).cashReady).toBe(false);
    await setCashReady(t.members[0], true);
    expect((await getMerchant(t.members[0])).cashReady).toBe(true);
  });

  it('Ready is refused to a merchant who is not in a CASH team', async () => {
    const t = await workingTeam('UPI_BANK', 0);
    expect(await setCashReady(t.members[0], true)).toEqual({ ok: false, reason: 'not_cash_member' });
  });

  it('a CASH member holding an open buy is not given a sell', async () => {
    const t = await workingTeam('CASH', 10000);
    for (const m of t.members) await setCashReady(m, true);
    const buy = await order('DEPOSIT', 500);
    const got = await assign(buy, 1);
    expect(got.ok).toBe(true);
    const sell = await order('WITHDRAWAL', 500);
    const cands = await routingCandidates(sell, { cap: 5, limit: 500 });
    expect(cands.map((c) => c.merchantId)).not.toContain(got.merchantId);
  });

  it('the fewest open orders wins; ties go to whoever was assigned least recently', async () => {
    const t = await workingTeam('UPI_BANK', 0);
    // Take everyone else offline but two.
    await online(t.members.slice(2), false);
    const [a, b] = t.members;
    const first = await assign(await order('WITHDRAWAL', 60000), 3);
    const second = await assign(await order('WITHDRAWAL', 60000), 3);
    expect(new Set([first.merchantId, second.merchantId])).toEqual(new Set([a, b]));
    // Both hold one; the next goes to whoever was assigned FIRST (least recently).
    const third = await assign(await order('WITHDRAWAL', 60000), 3);
    expect(third.merchantId).toBe(first.merchantId);
  });

  // ── Who goes first (owner, Phase A) ──────────────────────────────────────
  // The highest priority, then the fastest average response, then the fewest
  // open orders, then whoever has waited longest.
  const rankedIn = async (teamId) => (await routingCandidates(await order('WITHDRAWAL', 60000), { cap: 3, limit: 500 }))
    .filter((c) => c.teamId === teamId).map((c) => c.merchantId);

  it('the higher priority wins over a faster responder; at equal priority the faster responder wins', async () => {
    const t = await workingTeam('UPI_BANK', 0);
    await online(t.members.slice(3), false);
    const [a, b, c] = t.members;
    // Averages through their one writer: a 1 minute, c 4, b 9.
    await recordCompletedOrder(a, { direction: 'WITHDRAWAL', responseMinutes: 1 });
    await recordCompletedOrder(b, { direction: 'WITHDRAWAL', responseMinutes: 9 });
    await recordCompletedOrder(c, { direction: 'WITHDRAWAL', responseMinutes: 4 });
    expect((await getMerchant(a)).routingPriority).toBe(ROUTING_PRIORITY.DEFAULT);

    // Equal priority (the default, 3): the fastest first.
    expect(await rankedIn(t.teamId)).toEqual([a, c, b]);

    // The slowest, given priority 5, goes first; the rest keep their order.
    expect((await setRoutingPriority(b, 5)).ok).toBe(true);
    expect(await rankedIn(t.teamId)).toEqual([b, a, c]);
    // And a lower priority than the default goes last, however fast.
    expect((await setRoutingPriority(a, 1)).ok).toBe(true);
    expect(await rankedIn(t.teamId)).toEqual([b, c, a]);

    // The assignment takes the first, and priority still beats the open order
    // it now holds.
    const got = await assign(await order('WITHDRAWAL', 60000), 3);
    expect(got.merchantId).toBe(b);
    expect((await rankedIn(t.teamId))[0]).toBe(b);
  });

  it('at equal priority and equal response, the member with fewer open orders wins', async () => {
    const t = await workingTeam('UPI_BANK', 0);
    await online(t.members.slice(2), false);
    const [a, b] = t.members;
    await recordCompletedOrder(a, { direction: 'WITHDRAWAL', responseMinutes: 4 });
    await recordCompletedOrder(b, { direction: 'WITHDRAWAL', responseMinutes: 4 });
    const first = await assign(await order('WITHDRAWAL', 60000), 3);
    const other = first.merchantId === a ? b : a;
    // One open order against none: the one without goes first.
    expect(await rankedIn(t.teamId)).toEqual([other, first.merchantId]);
    // A faster response beats an open order (the key above it).
    await recordCompletedOrder(first.merchantId, { direction: 'WITHDRAWAL', responseMinutes: 0 });
    expect(await rankedIn(t.teamId)).toEqual([first.merchantId, other]);
  });

  // ── By the pool (owner, 2026-10-21) ──────────────────────────────────────
  // A buy to the team with the most of its pool left; a sell to the team whose
  // cash from buys covers it; speed only between pools equally placed.
  it('a buy goes to the fuller pool and a sell to the pool whose buys left cash to pay it, over a faster member', async () => {
    const drained = await workingTeam('UPI_BANK', 200000);
    const full = await workingTeam('UPI_BANK', 200000);
    // One member of each online; the drained team's is the faster.
    const [d] = drained.members;
    const [f] = full.members;
    await pgQuery('UPDATE merchants SET is_online = (merchant_id = ANY($2)) WHERE merchant_id = ANY($1)', [made, [d, f]]);
    await recordCompletedOrder(d, { direction: 'DEPOSIT', responseMinutes: 1 });
    await recordCompletedOrder(f, { direction: 'DEPOSIT', responseMinutes: 9 });

    // The drained team sells 150,000 tokens to a player: a quarter of its pool is left.
    const sold = await order('DEPOSIT', 150000);
    expect((await assignToTeam(sold, { cap: 3, barredMerchantIds: [f], buildSet: async () => ({ assignedAt: new Date() }) })).merchantId).toBe(d);
    expect(await spendForBuy(sold.orderId)).toMatchObject({ ok: true });
    expect(await poolStanding(drained.teamId)).toEqual({
      sizePaise: T(200000), leftPaise: T(50000), heldPaise: 0, consumedPaise: T(150000),
      sellsOwedPaise: 0, sellRoomPaise: T(150000), leftPercent: 25,
    });
    expect(await poolStanding(full.teamId)).toMatchObject({ sizePaise: T(200000), leftPercent: 100, sellRoomPaise: 0 });

    const buyFirst = (await routingCandidates(await order('DEPOSIT', 40000), { cap: 3, limit: 500 })).map((c) => c.merchantId);
    expect(buyFirst.slice(0, 2)).toEqual([f, d]);
    const sell = await order('WITHDRAWAL', 60000);
    const sellFirst = (await routingCandidates(sell, { cap: 3, limit: 500 })).map((c) => c.merchantId);
    expect(sellFirst.slice(0, 2)).toEqual([d, f]);

    // The sell it takes is owed from that cash, so the room shrinks by it.
    expect((await assign(sell)).merchantId).toBe(d);
    expect(await poolStanding(drained.teamId)).toMatchObject({ sellsOwedPaise: T(60000), sellRoomPaise: T(90000) });
    // A sell larger than what is left of the room no longer prefers that pool:
    // neither covers it, so the faster member is first again by speed alone.
    const big = (await routingCandidates(await order('WITHDRAWAL', 100000), { cap: 3, limit: 500 })).map((c) => c.merchantId);
    expect(big.slice(0, 2)).toEqual([d, f]);
    // Now the full team's member is the faster (an average the writer could reach).
    await pgQuery('UPDATE merchants SET avg_response_minutes = 0.5 WHERE merchant_id = $1', [f]);
    const faster = (await routingCandidates(await order('WITHDRAWAL', 100000), { cap: 3, limit: 500 })).map((c) => c.merchantId);
    expect(faster.slice(0, 2)).toEqual([f, d]);
  });

  it('priority is a whole number from 1 to 5, a member\'s only, and the row holds the range for every writer', async () => {
    const t = await workingTeam('UPI_BANK', 0);
    const [a] = t.members;
    for (const bad of [0, 6, 2.5, 'x', null, undefined]) {
      await expect(setRoutingPriority(a, bad)).rejects.toMatchObject({ status: 400, code: 'BAD_PRIORITY' });
    }
    expect((await getMerchant(a)).routingPriority).toBe(ROUTING_PRIORITY.DEFAULT);
    for (const good of [1, 5, '4']) {
      const out = await setRoutingPriority(a, good);
      expect(out.ok).toBe(true);
      expect(out.merchant.routingPriority).toBe(Number(good));
    }
    // A supervisor takes no orders, so has no priority to set.
    expect(await setRoutingPriority(t.sup, 5)).toEqual({ ok: false, reason: 'supervisor_no_priority' });
    expect(await setRoutingPriority('no-such-merchant', 5)).toEqual({ ok: false, reason: 'not_found' });
    // The generic patch cannot reach it (one writer), nor the average.
    await expect(updateMerchant(a, { routingPriority: 5 })).rejects.toThrow();
    await expect(updateMerchant(a, { avgResponseMinutes: 0 })).rejects.toThrow();
    // The CHECK, for a writer that skips the repository.
    await expect(pgQuery('UPDATE merchants SET routing_priority = 6 WHERE merchant_id = $1', [a]))
      .rejects.toMatchObject({ constraint: 'merchants_routing_priority_range' });
  });

  it('a barred merchant is never chosen', async () => {
    const t = await workingTeam('UPI_BANK', 0);
    await online(t.members.slice(1), false);
    const o = await order('WITHDRAWAL', 60000);
    expect(await assign(o, 3, [t.members[0]])).toMatchObject({ ok: false });
    expect((await getOrderRecord(o.orderId)).status).toBe('PENDING_QUEUE');
  });

  // ── Races ────────────────────────────────────────────────────────────────
  it('12 buys racing for a team with room for 5 hold exactly 5, and the pool never goes negative', async () => {
    const t = await workingTeam('UPI_BANK', 500000);
    const os = await Promise.all(Array.from({ length: 12 }, () => order('DEPOSIT', 100000)));
    const results = await Promise.all(os.map((o) => assign(o, 3)));
    // Other suites' teams may also take some; count only this team's.
    const ours = results.filter((r) => r.ok && r.teamId === t.teamId);
    expect(ours).toHaveLength(5);
    expect(await getPool(t.teamId)).toMatchObject({ availablePaise: 0, heldPaise: T(500000) });
  });

  it('a member with cap 1 is given one of two racing orders, never both', async () => {
    const t = await workingTeam('UPI_BANK', 0);
    await online(t.members.slice(1), false);
    const os = await Promise.all([order('WITHDRAWAL', 50000), order('WITHDRAWAL', 50000)]);
    const results = await Promise.all(os.map((o) => assign(o, 1)));
    const toHer = results.filter((r) => r.ok && r.merchantId === t.members[0]);
    expect(toHer).toHaveLength(1);
  });

  // ── Ending a buy ─────────────────────────────────────────────────────────
  it('a cancelled buy releases its hold once, however many paths release it', async () => {
    const t = await workingTeam('UPI_BANK', 300000);
    const o = await order('DEPOSIT', 300000);
    expect((await assign(o)).teamId).toBe(t.teamId);
    await transitionOrder(o.orderId, 'CANCELLED', { actor: 'test' });
    const results = await Promise.all([releaseBuyHold(o.orderId), releaseBuyHold(o.orderId), releaseBuyHold(o.orderId)]);
    expect(results.filter((r) => r.releasedPaise > 0)).toHaveLength(1);
    expect(await getPool(t.teamId)).toMatchObject({ availablePaise: T(300000), heldPaise: 0 });
  });

  it('a confirmed buy spends the hold: pool and TEAM_FLOAT down, USER_FLOAT up, once', async () => {
    const t = await workingTeam('UPI_BANK', 200000);
    const o = await order('DEPOSIT', 200000);
    expect((await assign(o)).teamId).toBe(t.teamId);
    const before = await getTreasuryBalances();
    expect(await spendForBuy(o.orderId)).toMatchObject({ ok: true, taken: 'hold' });
    expect(await spendForBuy(o.orderId)).toEqual({ ok: true, alreadyTaken: true });
    const after = await getTreasuryBalances();
    expect(after[ACCOUNTS.TEAM_FLOAT] - before[ACCOUNTS.TEAM_FLOAT]).toBe(-T(200000));
    expect(after[ACCOUNTS.USER_FLOAT] - before[ACCOUNTS.USER_FLOAT]).toBe(T(200000));
    expect(await getPool(t.teamId)).toMatchObject({ availablePaise: 0, heldPaise: 0 });
    expect((await getOrderRecord(o.orderId)).poolHeldPaise).toBe(0);
    // Spent, so a late release finds nothing.
    expect(await releaseBuyHold(o.orderId)).toEqual({ ok: true, releasedPaise: 0 });
  });

  it('a buy whose hold was released is paid from available, or refused if the pool is short', async () => {
    const t = await workingTeam('UPI_BANK', 100000);
    const o = await order('DEPOSIT', 100000);
    expect((await assign(o)).teamId).toBe(t.teamId);
    await releaseBuyHold(o.orderId);
    // Another order takes the tokens back out.
    const other = await order('DEPOSIT', 100000);
    expect((await assign(other)).teamId).toBe(t.teamId);
    expect(await spendForBuy(o.orderId)).toEqual({ ok: false, reason: 'pool_short' });
    await releaseBuyHold(other.orderId);
    expect(await spendForBuy(o.orderId)).toMatchObject({ ok: true, taken: 'available' });
  });

  // ── Security review, 2026-10-03: the money moved before the state did ─────
  /** As the player's mark-paid leaves a buy: PROCESSING, then PAID. */
  const paid = async (o) => {
    expect((await transitionOrder(o.orderId, 'PROCESSING', { actor: 'test' })).ok).toBe(true);
    expect((await transitionOrder(o.orderId, 'PAID', { actor: 'test' })).ok).toBe(true);
  };
  it('a spend asked for one state refuses an order that has moved on, and moves nothing', async () => {
    const t = await workingTeam('UPI_BANK', 100000);
    const o = await order('DEPOSIT', 100000);
    expect((await assign(o)).teamId).toBe(t.teamId);
    await paid(o);
    // Cancelled since the confirm read it as PAID (a member's reject, an expiry).
    expect((await transitionOrder(o.orderId, 'CANCELLED', { actor: 'test' })).ok).toBe(true);
    const pool = await getPool(t.teamId);
    const before = await getTreasuryBalances();

    expect(await spendForBuy(o.orderId, { requireState: 'PAID' })).toEqual({ ok: false, reason: 'order_state' });

    expect(await getPool(t.teamId)).toEqual(pool);
    const after = await getTreasuryBalances();
    expect(after[ACCOUNTS.USER_FLOAT]).toBe(before[ACCOUNTS.USER_FLOAT]);
    expect((await getOrderRecord(o.orderId)).poolPaidAt).toBeNull();
  });

  it('a spend in the state the caller named goes through, and marks the buy paid out', async () => {
    // The opposite behaviour: the check must not refuse the ordinary confirm.
    const t = await workingTeam('UPI_BANK', 100000);
    const o = await order('DEPOSIT', 100000);
    expect((await assign(o)).teamId).toBe(t.teamId);
    await paid(o);
    expect(await spendForBuy(o.orderId, { requireState: ['DISPUTED', 'PAID'] })).toMatchObject({ ok: true, taken: 'hold' });
    expect((await getOrderRecord(o.orderId)).poolPaidAt).not.toBeNull();
  });

  it('once its tokens are paid out, a buy may only go on to COMPLETED', async () => {
    const t = await workingTeam('UPI_BANK', 100000);
    const o = await order('DEPOSIT', 100000);
    expect((await assign(o)).teamId).toBe(t.teamId);
    await paid(o);
    expect(await spendForBuy(o.orderId, { requireState: 'PAID' })).toMatchObject({ ok: true });

    // A reject, a cancel or a dispute landing between the spend and the
    // completion would leave a REJECTED, CANCELLED or open buy whose player
    // was paid anyway.
    for (const to of ['REJECTED', 'CANCELLED', 'FAILED', 'DISPUTED']) {
      expect(await transitionOrder(o.orderId, to, { actor: 'test' }), to).toMatchObject({ ok: false, reason: 'pool_paid' });
    }
    expect((await getOrderRecord(o.orderId)).status).toBe('PAID');

    expect((await transitionOrder(o.orderId, 'COMPLETED', { actor: 'test' })).ok).toBe(true);
    // A COMPLETED buy can still be disputed, and that dispute can only end
    // COMPLETED again: no cancel can take delivered tokens back.
    expect((await transitionOrder(o.orderId, 'DISPUTED', { actor: 'test' })).ok).toBe(true);
    expect(await transitionOrder(o.orderId, 'CANCELLED', { actor: 'test' })).toMatchObject({ ok: false, reason: 'pool_paid' });
    expect((await getOrderRecord(o.orderId)).status).toBe('DISPUTED');
  });

  // ── Security review, 2026-10-03, F3: a member acting on an order an admin
  //    handed to somebody else ──────────────────────────────────────────────
  it('a member cannot move an order that was handed to another member since they read it', async () => {
    // A sell may change hands while started (its member has paid nothing):
    // the first member declines it, it goes back to the queue, and routing
    // hands it to another. Everything the first member does afterwards on
    // what they read a moment ago is refused.
    const t = await workingTeam('UPI_BANK', 0);
    const o = await order('WITHDRAWAL', 50000);
    const got = await assign(o);
    expect(got.teamId).toBe(t.teamId);
    expect((await getOrderRecord(o.orderId)).status).toBe('PROCESSING');
    const first = got.merchantId;
    expect((await transitionOrder(o.orderId, 'PENDING_QUEUE', {
      expectFrom: 'PROCESSING', expectMerchant: first, set: { merchantId: null }, actor: first, reason: 'declined',
      within: (client) => detachFromTeamWithin(client, o.orderId, { actor: first }),
    })).ok).toBe(true);
    const again = await assign(await getOrderRecord(o.orderId), 3, [first]);
    const second = again.merchantId;
    expect(second).toBeTruthy();
    expect(second).not.toBe(first);

    // The first member's payout, decline and red flag all read the order as
    // theirs a moment ago. None of them may move it now.
    for (const to of ['PAID', 'PENDING_QUEUE', 'DISPUTED']) {
      expect(await transitionOrder(o.orderId, to, { expectMerchant: first, set: { merchantId: first } }), to)
        .toMatchObject({ ok: false, reason: 'merchant_changed' });
    }
    expect(await getOrderRecord(o.orderId)).toMatchObject({ status: 'PROCESSING', merchantId: second });

    // The member who holds it may (the opposite behaviour).
    expect((await transitionOrder(o.orderId, 'PAID', { expectMerchant: second })).ok).toBe(true);
    expect(await getOrderRecord(o.orderId)).toMatchObject({ status: 'PAID', merchantId: second });
  });

  it('the sweep finds a hold left on a cancelled order, and not one on a live order', async () => {
    const t = await workingTeam('UPI_BANK', 200000);
    const live = await order('DEPOSIT', 100000);
    const dead = await order('DEPOSIT', 100000);
    await assign(live); await assign(dead);
    await transitionOrder(dead.orderId, 'CANCELLED', { actor: 'test' });
    const stranded = await findStrandedBuyHolds({ limit: 1000 });
    expect(stranded.find((s) => s.orderId === dead.orderId)).toMatchObject({ teamId: t.teamId, heldPaise: T(100000), state: 'CANCELLED' });
    expect(stranded.map((s) => s.orderId)).not.toContain(live.orderId);
  });

  it('a COMPLETED buy still holding is reported for a person, never treated as stranded', async () => {
    const t = await workingTeam('UPI_BANK', 70000);
    const o = await order('DEPOSIT', 70000);
    expect((await assign(o)).teamId).toBe(t.teamId);
    expect((await transitionOrder(o.orderId, 'PAID', { actor: 'test', set: { utr: `UTR${Date.now()}` } })).ok).toBe(true);
    expect((await transitionOrder(o.orderId, 'COMPLETED', { actor: 'test' })).ok).toBe(true);
    expect((await findCompletedUnspentBuys({ limit: 1000 })).map((r) => r.orderId)).toContain(o.orderId);
    expect((await findStrandedBuyHolds({ limit: 1000 })).map((r) => r.orderId)).not.toContain(o.orderId);
  });

  // ── Sells ────────────────────────────────────────────────────────────────
  it('a settled sell credits the pool once; a refund takes it back only while the pool holds it', async () => {
    const t = await workingTeam('UPI_BANK', 0);
    const o = await order('WITHDRAWAL', 80000);
    const a = await assign(o);
    expect(a.teamId).toBe(t.teamId);
    expect((await getOrderRecord(o.orderId)).poolHeldPaise).toBe(0);
    const before = await getTreasuryBalances();
    expect((await creditSellToPool(o.orderId)).ok).toBe(true);
    expect(await creditSellToPool(o.orderId)).toEqual({ ok: true, alreadyCredited: true });
    expect((await getPool(t.teamId)).availablePaise).toBe(T(80000));
    const mid = await getTreasuryBalances();
    expect(mid[ACCOUNTS.TEAM_FLOAT] - before[ACCOUNTS.TEAM_FLOAT]).toBe(T(80000));
    expect(mid[ACCOUNTS.USER_FLOAT] - before[ACCOUNTS.USER_FLOAT]).toBe(-T(80000));
    // The player's stake left `locked` in the SAME transaction: never in both
    // places, never in neither.
    expect(await getBalances(`u_${o.orderId}`)).toMatchObject({ lockedBalance: 0, winningsBalance: 0 });

    expect((await reverseSellFromPool(o.orderId)).ok).toBe(true);
    expect(await reverseSellFromPool(o.orderId)).toEqual({ ok: true, alreadyReversed: true });
    expect((await getPool(t.teamId)).availablePaise).toBe(0);
    expect((await getTreasuryBalances())[ACCOUNTS.TEAM_FLOAT]).toBe(before[ACCOUNTS.TEAM_FLOAT]);
    // …and the stake came back as winnings, with the tokens the pool returned.
    expect(await getBalances(`u_${o.orderId}`)).toMatchObject({ winningsBalance: 80000, lockedBalance: 0 });
  });

  it('a refund of a sell the team already used is refused, and nothing moves', async () => {
    const t = await workingTeam('UPI_BANK', 0);
    const sell = await order('WITHDRAWAL', 60000);
    await assign(sell);
    await creditSellToPool(sell.orderId);
    const buy = await order('DEPOSIT', 60000);
    expect((await assign(buy)).teamId).toBe(t.teamId);  // holds the 60,000
    expect(await reverseSellFromPool(sell.orderId)).toEqual({ ok: false, reason: 'pool_short' });
    expect(await getPool(t.teamId)).toMatchObject({ availablePaise: 0, heldPaise: T(60000) });
    // Nothing moved on the player's side either: the refund is one transaction.
    expect(await getBalances(`u_${sell.orderId}`)).toMatchObject({ winningsBalance: 0, lockedBalance: 0 });
  });

  it('never routes a USDT buy to a member: it is paid to the platform (owner, 2026-10-18)', async () => {
    await expect(routingCandidates(
      { orderId: 'x', type: 'DEPOSIT', currency: 'USDT', paymentMode: 'P2P_UPI', usdtChain: 'BEP20', tokenAmountPaise: T(50000) },
      { cap: 3 },
    )).rejects.toThrow(/USDT buy, which no member serves/);
  });

  it('a REFUND the team cannot fund is covered by the platform, once, and the pool is never taken twice', async () => {
    const t = await workingTeam('UPI_BANK', 0);
    const sell = await order('WITHDRAWAL', 60000);
    await assign(sell);
    await creditSellToPool(sell.orderId);
    const buy = await order('DEPOSIT', 60000);
    expect((await assign(buy)).teamId).toBe(t.teamId);  // the team has used the 60,000

    const before = await getTreasuryBalances();
    expect(await reverseSellFromPool(sell.orderId, { coverShortfall: true }))
      .toMatchObject({ ok: true, covered: true, teamId: t.teamId, userId: `u_${sell.orderId}` });
    expect(await getBalances(`u_${sell.orderId}`)).toMatchObject({ winningsBalance: 60000 });
    const after = await getTreasuryBalances();
    // From the platform's own holding to the user side: the player's refund is
    // backed by a movement, and the team's pool is untouched.
    expect(after[ACCOUNTS.TOKEN_SUPPLY] - before[ACCOUNTS.TOKEN_SUPPLY]).toBe(-T(60000));
    expect(after[ACCOUNTS.USER_FLOAT] - before[ACCOUNTS.USER_FLOAT]).toBe(T(60000));
    expect(after[ACCOUNTS.TEAM_FLOAT]).toBe(before[ACCOUNTS.TEAM_FLOAT]);
    expect(await getPool(t.teamId)).toMatchObject({ availablePaise: 0, heldPaise: T(60000) });

    // The buy is released and the pool can pay again. A retried refund must
    // still not take the tokens from it: they already went back once.
    expect((await releaseBuyHold(buy.orderId)).ok).toBe(true);
    expect(await reverseSellFromPool(sell.orderId, { coverShortfall: true }))
      .toEqual({ ok: true, covered: true, alreadyCovered: true });
    expect(await reverseSellFromPool(sell.orderId))
      .toEqual({ ok: true, covered: true, alreadyCovered: true });
    expect(await getPool(t.teamId)).toMatchObject({ availablePaise: T(60000), heldPaise: 0 });
    expect(await getTreasuryBalances()).toEqual(after);
  });
});
