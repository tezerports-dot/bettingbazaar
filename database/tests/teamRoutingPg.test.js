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
} from '../repositories/merchants.js';
import { setSupervisorRole, createTeam, addMember, approveMember, removeMember } from '../repositories/teams.js';
import {
  createRequest, fulfilRequest, getPool, releaseBuyHold, spendForBuy,
  creditSellToPool, reverseSellFromPool, findStrandedBuyHolds, findCompletedUnspentBuys,
} from '../repositories/teamPools.js';
import { assignToTeam, routingCandidates, railOf, setCashReady, routingSettings } from '../repositories/teamRouting.js';
import { createOrderRecord, getOrderRecord } from '../repositories/orders.record.js';
import { transitionOrder, reassignOrder } from '../repositories/orders.js';
import { getTreasuryBalances, ACCOUNTS } from '../repositories/treasury.js';

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

  /** A WORKING team of ten on `rail`, every member online, with `pool` tokens. */
  const workingTeam = async (rail = 'UPI_BANK', pool = 0) => {
    const sup = await merchant();
    expect(await setSupervisorRole(sup, { rail })).toEqual({ ok: true });
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
    return createOrderRecord({
      orderId, userId: `u_${orderId}`, type, tokenAmountRupees: tokens, currency, usdtChain,
    });
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
      concurrency: { CASH: 1, UPI_BANK: 3, USDT: 3 },
      assignmentWaitSeconds: 1500,
      processingWindowSeconds: { CASH: 900, UPI_BANK: 900, USDT: 900 },
      utrSubmitSeconds: 60,
    });
    const s = routingSettings({ teamRouting: { concurrency: { UPI_BANK: '5' }, utrSubmitSeconds: 90 } });
    expect(s.concurrency).toEqual({ CASH: 1, UPI_BANK: 5, USDT: 3 });
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
    expect(row).toMatchObject({ status: 'ASSIGNED', teamId: t.teamId, poolHeldPaise: T(50000), merchantId: out.merchantId });
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

  it('a team below ten that has never been full takes nothing', async () => {
    const sup = await merchant();
    await setSupervisorRole(sup, { rail: 'UPI_BANK' });
    const { teamId } = await createTeam({ supervisorId: sup, name: 'Short' });
    teams.push(teamId);
    const m = await merchant();
    await addMember({ teamId, supervisorId: sup, merchantRef: m, actor: sup });
    await approveMember({ merchantId: m, actor: 'a' });
    await online([m]);
    const o = await order('WITHDRAWAL', 100000);
    const cands = await routingCandidates(await getOrderRecord(o.orderId), { cap: 3 });
    expect(cands.map((c) => c.merchantId)).not.toContain(m);
    expect(cands.every((c) => c.teamId !== teamId)).toBe(true);
  });

  it('a team that drops below ten keeps working today (grace)', async () => {
    const t = await workingTeam('UPI_BANK', 0);
    expect((await removeMember({ merchantId: t.members[0], supervisorId: t.sup })).ok).toBe(true);
    const cands = await routingCandidates(await order('WITHDRAWAL', 70000), { cap: 3, limit: 500 });
    expect(cands.some((c) => c.teamId === t.teamId)).toBe(true);
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
    const t = await workingTeam('UPI_BANK', 100000);
    const o = await order('DEPOSIT', 100000);
    const got = await assign(o);
    expect(got.teamId).toBe(t.teamId);
    const first = got.merchantId;
    const second = t.members.find((m) => m !== first);
    expect((await reassignOrder(o.orderId, { set: { merchantId: second }, actor: 'admin-1' })).ok).toBe(true);

    // The first member's accept, decline and red flag all read the order as
    // theirs a moment ago. None of them may move it now.
    for (const to of ['PROCESSING', 'PENDING_QUEUE']) {
      expect(await transitionOrder(o.orderId, to, { expectMerchant: first, set: { merchantId: first } }), to)
        .toMatchObject({ ok: false, reason: 'merchant_changed' });
    }
    expect(await getOrderRecord(o.orderId)).toMatchObject({ status: 'ASSIGNED', merchantId: second });

    // The member who holds it may (the opposite behaviour)…
    expect((await transitionOrder(o.orderId, 'PROCESSING', { expectMerchant: second, set: { merchantId: second } })).ok).toBe(true);
    // …and a late accept by the first is refused, NOT answered "already
    // there" — which wrote its `set` and took the order back.
    expect(await transitionOrder(o.orderId, 'PROCESSING', { expectMerchant: first, set: { merchantId: first } }))
      .toMatchObject({ ok: false, reason: 'merchant_changed' });
    expect(await getOrderRecord(o.orderId)).toMatchObject({ status: 'PROCESSING', merchantId: second });
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

    expect((await reverseSellFromPool(o.orderId)).ok).toBe(true);
    expect(await reverseSellFromPool(o.orderId)).toEqual({ ok: true, alreadyReversed: true });
    expect((await getPool(t.teamId)).availablePaise).toBe(0);
    expect((await getTreasuryBalances())[ACCOUNTS.TEAM_FLOAT]).toBe(before[ACCOUNTS.TEAM_FLOAT]);
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
  });

  it('a USDT order reaches only a member holding an address on ITS chain (§25)', async () => {
    const t = await workingTeam('USDT', 200000);
    const [tron, bsc] = t.members;
    await pgQuery('UPDATE merchants SET usdt_address_trc20 = $2 WHERE merchant_id = $1', [tron, `T${'A'.repeat(33)}`]);
    await pgQuery('UPDATE merchants SET usdt_address_bep20 = $2 WHERE merchant_id = $1', [bsc, `0x${'b'.repeat(40)}`]);

    const onTron = await order('DEPOSIT', 50000, { currency: 'USDT', usdtChain: 'TRC20' });
    expect(await assign(onTron)).toMatchObject({ ok: true, merchantId: tron, teamId: t.teamId });
    const onBsc = await order('DEPOSIT', 50000, { currency: 'USDT', usdtChain: 'BEP20' });
    expect(await assign(onBsc)).toMatchObject({ ok: true, merchantId: bsc, teamId: t.teamId });

    // Nobody else holds a Tron address, and the one who does is still free
    // (cap 3): the next Tron order goes to them again, never to a member who
    // would show the player nothing to send to.
    const again = await order('DEPOSIT', 50000, { currency: 'USDT', usdtChain: 'TRC20' });
    expect(await assign(again)).toMatchObject({ ok: true, merchantId: tron });
  });

  it('an unknown chain is a throw, never an empty list that reads as "nobody is free"', async () => {
    await expect(routingCandidates(
      { orderId: 'x', type: 'DEPOSIT', currency: 'USDT', paymentMode: 'P2P_UPI', usdtChain: 'ERC20', tokenAmountPaise: T(50000) },
      { cap: 3 },
    )).rejects.toThrow(/unknown usdtChain 'ERC20'/);
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
      .toEqual({ ok: true, covered: true, teamId: t.teamId });
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
