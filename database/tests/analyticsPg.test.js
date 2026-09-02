// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file.
/**
 * analyticsPg.test.js — the admin dashboard's figures, against real rows.
 *
 * Every assertion here corresponds to a number the dashboard displayed wrongly
 * before this pass. The old aggregates read a transaction collection nothing
 * writes to any more, so they could not have failed a test — they returned a
 * consistent, frozen, entirely fictional zero. These read the rows that carry
 * the money.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { applySchema, closePg, pgQuery } from '../client.js';
import {
  platformFinance, dailyFinance, tokenFlow, providerRevenue, cycleAndQueueCounts,
} from '../repositories/stats.js';
import { feed, adminActivity, recordDetailed } from '../repositories/audit.js';

/** Rupees, as every figure in this module is reported. */
const R = (paise) => paise / 100;

async function order({ id, user, type, state, fiat, tokens, completedAt }) {
  await pgQuery(
    `INSERT INTO order_states
       (order_id, user_id, order_type, state, token_amount_paise, fiat_amount_paise, completed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [id, user, type, state, tokens, fiat, completedAt ?? null],
  );
}

async function bet({ id, user, cycle, stake, payout = 0, status = 'PENDING', phantom = false, placedAt = null, settledAt = null }) {
  await pgQuery(
    `INSERT INTO bets (bet_id, user_id, cycle_id, side, stake_paise, payout_paise,
                       status, is_phantom, placed_at, settled_at)
     VALUES ($1,$2,$3,'DELHI',$4,$5,$6,$7,COALESCE($8, now()),$9)`,
    [id, user, cycle, stake, payout, status, phantom, placedAt, settledAt],
  );
}

describe('admin analytics', () => {
  beforeAll(async () => { await applySchema(); });
  afterAll(async () => { await closePg(); });
  beforeEach(async () => {
    // TRUNCATE rather than DELETE: order_transitions, game_transactions and
    // enhanced_audit_logs all carry the append-only trigger, which refuses a
    // row delete on purpose. TRUNCATE is a table operation and does not fire
    // per-row triggers, so it is the only way to reset an append-only table.
    await pgQuery(`TRUNCATE bets, bet_transitions, order_transitions, order_states,
                            game_transactions, enhanced_audit_logs, cycles
                   RESTART IDENTITY CASCADE`);
  });

  // ── Platform finance ──────────────────────────────────────────────────────
  it('counts deposits and withdrawals from completed orders only', async () => {
    await order({ id: 'o1', user: 'u1', type: 'DEPOSIT',    state: 'COMPLETED', fiat: 100_00, tokens: 100_00, completedAt: new Date() });
    await order({ id: 'o2', user: 'u2', type: 'DEPOSIT',    state: 'PENDING_QUEUE', fiat: 500_00, tokens: 500_00 });
    await order({ id: 'o3', user: 'u1', type: 'WITHDRAWAL', state: 'COMPLETED', fiat: 40_00, tokens: 40_00, completedAt: new Date() });

    const f = await platformFinance({});
    expect(f.deposits).toEqual({ amount: R(100_00), count: 1 });
    expect(f.withdrawals).toEqual({ amount: R(40_00), count: 1 });
  });

  it('leaves phantom bets out of profit', async () => {
    await bet({ id: 'b1', user: 'u1', cycle: 'c1', stake: 100_00 });
    await bet({ id: 'b2', user: 'house', cycle: 'c1', stake: 900_00, phantom: true });

    const f = await platformFinance({});
    // Counting the phantom stake would show the house earning its own
    // liquidity — a ten-fold overstatement of profit on this data.
    expect(f.bets).toEqual({ amount: R(100_00), count: 1 });
    expect(f.netProfit).toBe(R(100_00));
  });

  it('is profit staked minus paid out, not the cycles row', async () => {
    await bet({ id: 'b1', user: 'u1', cycle: 'c1', stake: 100_00, payout: 190_00, status: 'WON', settledAt: new Date() });
    await bet({ id: 'b2', user: 'u2', cycle: 'c1', stake: 150_00, status: 'LOST' });

    const f = await platformFinance({});
    expect(f.payouts).toEqual({ amount: R(190_00), count: 1 });
    expect(f.netProfit).toBe(R(250_00 - 190_00));
  });

  it('does not count a payout on a bet that has not been settled', async () => {
    // A PENDING bet with a payout column set is a bet mid-settlement. Counting
    // it pays the house's profit down before the money has actually left.
    await bet({ id: 'b1', user: 'u1', cycle: 'c1', stake: 100_00, payout: 190_00, status: 'PENDING' });
    expect((await platformFinance({})).payouts.amount).toBe(0);
  });

  // ── The daily series ──────────────────────────────────────────────────────
  it('emits every day in the window, including the ones with no activity', async () => {
    await bet({ id: 'b1', user: 'u1', cycle: 'c1', stake: 100_00 });
    const days = await dailyFinance({ days: 7 });
    // A gapped series drawn as a chart joins Monday to Thursday as though the
    // days between had not happened.
    expect(days).toHaveLength(7);
    expect(days.every((d) => typeof d.date === 'string' && d.date.length === 10)).toBe(true);
    expect(days[days.length - 1].bets).toBe(R(100_00));
    expect(days[0].bets).toBe(0);
  });

  it('buckets a payout on the day it settled, not the day the bet was placed', async () => {
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    await bet({
      id: 'b1', user: 'u1', cycle: 'c1', stake: 100_00, payout: 190_00,
      status: 'WON', placedAt: threeDaysAgo, settledAt: new Date(),
    });

    const days = await dailyFinance({ days: 7 });
    const today = days[days.length - 1];
    const placedDay = days.find((d) => Number(d.bets) > 0);

    expect(placedDay.payouts).toBe(0);       // staked here, paid later
    expect(today.payouts).toBe(R(190_00));   // paid here, staked earlier
  });

  // ── Token flow ────────────────────────────────────────────────────────────
  it('counts distinct depositors rather than deposits', async () => {
    const now = new Date();
    await order({ id: 'o1', user: 'u1', type: 'DEPOSIT', state: 'COMPLETED', fiat: 100_00, tokens: 100_00, completedAt: now });
    await order({ id: 'o2', user: 'u1', type: 'DEPOSIT', state: 'COMPLETED', fiat: 200_00, tokens: 200_00, completedAt: now });
    await order({ id: 'o3', user: 'u2', type: 'DEPOSIT', state: 'COMPLETED', fiat: 50_00,  tokens: 50_00,  completedAt: now });

    const flow = await tokenFlow({ direction: 'DEPOSIT' });
    expect(flow.parties).toBe(2);
    expect(flow.orders).toBe(3);
    expect(flow.fiat).toBe(R(350_00));
  });

  it('keeps the two directions apart', async () => {
    const now = new Date();
    await order({ id: 'o1', user: 'u1', type: 'DEPOSIT',    state: 'COMPLETED', fiat: 100_00, tokens: 100_00, completedAt: now });
    await order({ id: 'o2', user: 'u1', type: 'WITHDRAWAL', state: 'COMPLETED', fiat: 30_00,  tokens: 30_00,  completedAt: now });

    expect((await tokenFlow({ direction: 'DEPOSIT' })).fiat).toBe(R(100_00));
    expect((await tokenFlow({ direction: 'WITHDRAWAL' })).fiat).toBe(R(30_00));
  });

  // ── Provider revenue ──────────────────────────────────────────────────────
  it('reports a provider that had wins but no bets in the window', async () => {
    await pgQuery(
      `INSERT INTO game_transactions (tx_id, user_id, provider_key, tx_type, amount_paise)
       VALUES ('t1','u1','evo','WIN',500_00), ('t2','u1','pragmatic','BET',100_00)`, [],
    );
    const rows = await providerRevenue({});
    const keys = rows.map((r) => r.key).sort();
    // The JavaScript join this replaced iterated the BET aggregate, so a
    // provider with wins and no bets vanished — the one a reviewer most wants.
    expect(keys).toEqual(['evo', 'pragmatic']);
    expect(rows.find((r) => r.key === 'evo').ggr).toBe(R(-500_00));
  });

  it('treats a refund as revenue the house does not keep', async () => {
    await pgQuery(
      `INSERT INTO game_transactions (tx_id, user_id, provider_key, tx_type, amount_paise)
       VALUES ('t1','u1','evo','BET',100_00), ('t2','u1','evo','REFUND',100_00)`, [],
    );
    const [evo] = await providerRevenue({});
    expect(evo.ggr).toBe(0);
  });

  // ── Cycle and queue counts ────────────────────────────────────────────────
  it('counts a cycle as active through every live status, not just OPEN', async () => {
    // RESULT_DECLARED needs a winner: cycles_completed_has_winner refuses a
    // declared cycle with no result, which is trap 3 written into the row.
    const cycles = [
      ['c1', 'OPEN', null], ['c2', 'MERGED', null], ['c3', 'CLOSED', null],
      ['c4', 'RESULT_DECLARED', 'DELHI'], ['c5', 'PAUSED', null], ['c6', 'CANCELLED', null],
    ];
    for (const [id, status, winner] of cycles) {
      await pgQuery(
        `INSERT INTO cycles (cycle_id, cycle_type, status, winner, start_time, end_time)
         VALUES ($1, '30_MIN', $2, $3, now() + ($4 || ' minutes')::interval,
                 now() + ($4 || ' minutes')::interval + interval '30 minutes')`,
        [id, status, winner, String(cycles.findIndex((c) => c[0] === id) * 30)],
      );
    }
    const counts = await cycleAndQueueCounts({});
    expect(counts.cycles.activeCount).toBe(5);   // everything but CANCELLED
  });

  it('separates queued orders from ones a merchant already holds', async () => {
    await order({ id: 'o1', user: 'u1', type: 'DEPOSIT', state: 'PENDING_QUEUE', fiat: 10_00, tokens: 10_00 });
    await order({ id: 'o2', user: 'u1', type: 'DEPOSIT', state: 'ASSIGNED',      fiat: 10_00, tokens: 10_00 });
    await order({ id: 'o3', user: 'u1', type: 'DEPOSIT', state: 'DISPUTED',      fiat: 10_00, tokens: 10_00 });

    const { queue } = await cycleAndQueueCounts({});
    expect(queue).toEqual({ pendingOrders: 1, inFlightOrders: 1, disputedOrders: 1 });
  });

  // ── The audit feed ────────────────────────────────────────────────────────
  it('returns a page and a total that describe the same instant', async () => {
    for (let i = 0; i < 12; i += 1) {
      await recordDetailed({
        performedBy: 'admin1', performedByName: 'Admin One', performedByRole: 'admin',
        action: `ACTION_${i}`, category: 'CONTENT',
      });
    }
    const page = await feed({ limit: 5, page: 1 });
    expect(page.entries).toHaveLength(5);
    expect(page.total).toBe(12);
    expect(page.pages).toBe(3);

    const last = await feed({ limit: 5, page: 3 });
    expect(last.entries).toHaveLength(2);
  });

  it('filters the feed without losing the total for that filter', async () => {
    await recordDetailed({ performedBy: 'a', action: 'X', category: 'CONTENT' });
    await recordDetailed({ performedBy: 'a', action: 'Y', category: 'SECURITY' });
    const page = await feed({ category: 'SECURITY' });
    expect(page.total).toBe(1);
    expect(page.entries[0].action).toBe('Y');
  });

  it('says when a page landed past the end rather than reporting no matches', async () => {
    await recordDetailed({ performedBy: 'a', action: 'X', category: 'CONTENT' });
    const page = await feed({ page: 9 });
    expect(page.entries).toHaveLength(0);
    expect(page.beyondEnd).toBe(true);
  });

  // ── Admin activity ────────────────────────────────────────────────────────
  it('counts every action in the window but returns only the last ten', async () => {
    for (let i = 0; i < 14; i += 1) {
      await recordDetailed({
        performedBy: 'admin1', performedByName: 'Admin One', performedByRole: 'admin',
        action: `A${i}`, category: 'GENERAL',
      });
    }
    const [row] = await adminActivity({ hours: 24 });
    expect(row.adminId).toBe('admin1');
    expect(row.actions).toBe(14);       // the whole window, not the slice
    expect(row.recent).toHaveLength(10);
    expect(row.recent[0].action).toBe('A13');   // newest first
  });

  it('leaves out actors who are not admins', async () => {
    await recordDetailed({ performedBy: 'u1', performedByRole: 'user', action: 'LOGIN', category: 'AUTH' });
    await recordDetailed({ performedBy: 'a1', performedByRole: 'subadmin', action: 'EDIT', category: 'CONTENT' });
    const rows = await adminActivity({ hours: 24 });
    expect(rows.map((r) => r.adminId)).toEqual(['a1']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The player timeline and the phantom report — both merged in the database.
// ─────────────────────────────────────────────────────────────────────────────
import { userTimeline, phantomBetsByCycle } from '../repositories/stats.js';

describe('a player history', () => {
  beforeAll(async () => { await applySchema(); });
  afterAll(async () => { await closePg(); });
  beforeEach(async () => {
    await pgQuery(`TRUNCATE bets, bet_transitions, order_transitions, order_states,
                            wallet_ledger, cycles, merchants
                   RESTART IDENTITY CASCADE`);
  });

  it('merges wallet movement, bets and orders into one ordered page', async () => {
    const t = (minutesAgo) => new Date(Date.now() - minutesAgo * 60_000);

    await pgQuery(
      `INSERT INTO wallet_ledger (tx_id, user_id, field, amount_paise,
                                  balance_after_paise, tx_type, description, created_at)
       VALUES ('t1','u1','depositBalance',100_00,100_00,'CREDIT','Deposit',$1)`,
      [t(30)],
    );
    await pgQuery(
      `INSERT INTO bets (bet_id, user_id, cycle_id, side, stake_paise, status, placed_at)
       VALUES ('b1','u1','c1','DELHI',50_00,'PENDING',$1)`, [t(20)],
    );
    await pgQuery(
      `INSERT INTO order_states (order_id, user_id, order_type, state,
                                 token_amount_paise, fiat_amount_paise, created_at)
       VALUES ('o1','u1','DEPOSIT','COMPLETED',100_00,100_00,$1)`, [t(10)],
    );

    const page = await userTimeline('u1', { limit: 10 });
    expect(page.total).toBe(3);
    // Newest first, across all three sources — the ordering the JavaScript
    // merge had to pull every row of every table to produce.
    expect(page.entries.map((e) => e.source)).toEqual(['p2p_order', 'bet', 'transaction']);
  });

  it('leaves phantom bets out of a player history', async () => {
    await pgQuery(
      `INSERT INTO bets (bet_id, user_id, cycle_id, side, stake_paise, status, is_phantom)
       VALUES ('b1','u1','c1','DELHI',50_00,'PENDING',FALSE),
              ('b2','u1','c1','BOMBAY',900_00,'PENDING',TRUE)`, [],
    );
    const page = await userTimeline('u1', {});
    // A house figure is not something the player did; showing it on their own
    // history would be a lie about their account.
    expect(page.total).toBe(1);
    expect(page.entries[0]._id).toBe('b1');
  });

  it('names the merchant on a funding order without a per-row lookup', async () => {
    await pgQuery(
      // merchant_type is GENERATED from accepted_currencies[1] — it cannot be
      // inserted directly, which is the schema making one field the owner.
      `INSERT INTO merchants (merchant_id, name, public_ref, mobile, accepted_currencies)
       VALUES ('m1','Ravi Payments','MER-0001','9990001111', ARRAY['INR'])`, [],
    );
    await pgQuery(
      `INSERT INTO order_states (order_id, user_id, merchant_id, order_type, state,
                                 token_amount_paise, fiat_amount_paise)
       VALUES ('o1','u1','m1','DEPOSIT','COMPLETED',100_00,100_00)`, [],
    );
    const page = await userTimeline('u1', {});
    expect(page.entries[0].merchantName).toBe('Ravi Payments');
  });

  it('pages without re-sorting the whole history', async () => {
    for (let i = 0; i < 7; i += 1) {
      await pgQuery(
        `INSERT INTO bets (bet_id, user_id, cycle_id, side, stake_paise, status, placed_at)
         VALUES ($1,'u1','c1','DELHI',10_00,'PENDING', now() - ($2 || ' minutes')::interval)`,
        [`b${i}`, String(i)],
      );
    }
    const first = await userTimeline('u1', { page: 1, limit: 3 });
    const last  = await userTimeline('u1', { page: 3, limit: 3 });
    expect(first.total).toBe(7);
    expect(first.pages).toBe(3);
    expect(first.entries).toHaveLength(3);
    expect(last.entries).toHaveLength(1);
  });

  it('reports phantom stakes per cycle, newest cycle first', async () => {
    for (const [id, minutes] of [['c-old', 120], ['c-new', 5]]) {
      await pgQuery(
        `INSERT INTO cycles (cycle_id, cycle_type, status, start_time, end_time)
         VALUES ($1, '30_MIN', 'OPEN', now() - ($2 || ' minutes')::interval,
                 now() - ($2 || ' minutes')::interval + interval '30 minutes')`,
        [id, String(minutes)],
      );
      await pgQuery(
        `INSERT INTO bets (bet_id, user_id, cycle_id, side, stake_paise, status, is_phantom)
         VALUES ($1 || '_d','house',$1,'DELHI',400_00,'PENDING',TRUE),
                ($1 || '_b','house',$1,'BOMBAY',600_00,'PENDING',TRUE)`,
        [id],
      );
    }
    const stats = await phantomBetsByCycle({ limit: 10 });
    // By start time, not by id sorted as a string.
    expect(stats.map((s) => s.cycleId)).toEqual(['c-new', 'c-old']);
    expect(stats[0].delhiPhantom).toBe(400);
    expect(stats[0].bombayPhantom).toBe(600);
    expect(stats[0].totalPhantomBets).toBe(2);
  });
});
