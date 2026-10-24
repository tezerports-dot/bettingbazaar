// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Order commission (owner, 2026-10-21), through the real order paths, the
 * real routers and a real database.
 *
 * The rule: every COMPLETED order a team served pays the admin's percent of
 * its tokens (`orderCommission.depositPercent` for a buy, `withdrawalPercent`
 * for a sell; 5 and 5 by default) into the team's pool straight out of
 * platform revenue; 16% of each payment is recorded to the supervisor and 84%
 * to the members in equal parts.
 *
 * What is pinned:
 *   · a completion pays at once, on a buy and on a sell alike;
 *   · the shares add up to the payment, 16 / 84 equally;
 *   · replays and races pay once per order (§32 S6);
 *   · a rate of 0 pays nothing and leaves nothing owed; the rate is the one
 *     at completion, recorded on the row;
 *   · tokens move TOKEN_SUPPLY → TEAM_FLOAT, booked as a cost against platform
 *     revenue: there is no commission pool to fund, so nothing waits on one;
 *   · a member's screen carries their own share and nobody else's.
 *
 * Completed the way production completes (§32 S16): a buy routed to the
 * member, paid with a claimed reference and confirmed on the member's panel; a
 * sell routed, accepted, paid out with a UTR and settled by the hold sweep's
 * own settler.
 *
 * Trap 10: platform revenue is a SHARED balance, so the cases assert its
 * DELTA, and in `afterAll`, outside any assertion, the commission paid to the
 * suite's own teams, whose rows `cleanup()` deletes, is reversed by one
 * ADJUSTMENT (the ledger is append-only).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pgConfigured, applySchema, closePg, withTransaction, pgQuery } from '#db/client.js';
import { createOrderRecord, getOrderRecord } from '#db/repositories/orders.record.js';
import { updateUser } from '#db/repositories/users.js';
import { getPool } from '#db/repositories/teamPools.js';
import { recordEvent } from '#db/repositories/ledger.core.js';
import {
  payOrderCommission, teamSummary, listShares, ordersOwed,
} from '#db/repositories/teamCommission.js';
import { db } from '#db';
import { merchantEarnings } from '#db/repositories/stats.js';
import { creditWinnings } from '../../domains/wallet/walletAuthority.service.js';
import {
  tryAssignMerchant, markOrderPaid, createWithdrawalOrder,
} from '../../domains/payment/paymentProcessing.service.js';
import { settleHold } from '../../domains/payment/withdrawalHold.service.js';
import { teamFixture, readyToPay } from '../teamFixture.js';
import { mountRouter, actor, merchantActor, as } from './_harness.js';

const describePg = pgConfigured() ? describe : describe.skip;


/** Raw (signed) balance of a ledger account. */
async function raw(account) {
  const { rows } = await pgQuery(
    `SELECT COALESCE(SUM((p->>'amountPaise')::BIGINT), 0) AS v
       FROM accounting_events, jsonb_array_elements(postings) p WHERE p->>'account' = $1`, [account]);
  return Number(rows[0].v);
}
/** Platform revenue as reported (credit-normal: the negated raw sum). */
const revenuePaise = async () => 0 - (await raw('PLATFORM_REVENUE'));

describePg('team commission', () => {
  let panel; let teamRoutes; let seq = 0;
  const teams = teamFixture();
  const players = [];
  const teamIds = [];
  const oid = () => `tcm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}-${seq += 1}`;
  const utr = () => String(580000000000 + (seq * 7919) + Math.floor(Math.random() * 7000));

  beforeAll(async () => {
    await applySchema();
    panel = mountRouter((await import('../../domains/merchant/merchant.routes.js')).default);
    teamRoutes = mountRouter((await import('../../domains/team/team.merchant.routes.js')).default);
  }, 60_000);

  afterAll(async () => {
    const { rows: caused } = await pgQuery(
      `SELECT postings FROM accounting_events
        WHERE ref_model = 'Team' AND ref_id = ANY($1)`,
      [teamIds]);
    const net = {};
    for (const p of caused.flatMap((r) => r.postings)) {
      net[p.account] = (net[p.account] ?? 0) + Number(p.amountPaise);
    }
    const legs = Object.entries(net).filter(([, v]) => v).map(([account, v]) => ({ account, amountPaise: 0 - v }));
    if (legs.length) {
      await recordEvent({
        eventType: 'ADJUSTMENT', idempotencyKey: `tcm-test-undo-${oid()}`, postings: legs,
        refModel: 'Test', refId: 'teamCommissionPg', description: 'teamCommissionPg: reverse what the suite posted',
      });
    }
    await withTransaction(async (c) => {
      await c.query('SET LOCAL session_replication_role = replica');
      await c.query(
        'DELETE FROM order_transitions WHERE order_id IN (SELECT order_id FROM order_states WHERE user_id = ANY($1))',
        [players]);
      await c.query('DELETE FROM order_states WHERE user_id = ANY($1)', [players]);
    });
    await teams.cleanup();
    await closePg();
  });

  const player = async () => {
    const who = await actor({});
    players.push(who.userId);
    return who;
  };

  /** A member of a working UPI/bank team, the only one online. */
  const member = async () => {
    const m = await merchantActor();
    const team = await teams.workingTeam({ rail: 'UPI_BANK', poolTokens: 500_000, include: [m.merchantId] });
    teamIds.push(team.teamId);
    return { ...m, team };
  };

  const completedBuy = async (m, tokens) => {
    const who = await player();
    const orderId = oid();
    const order = await createOrderRecord({
      orderId, userId: who.userId, type: 'DEPOSIT',
      tokenAmountRupees: tokens, fiatAmountRupees: tokens, depositAllocation: tokens, reserveAllocation: 0,
    });
    await teams.onlyOnline([m.merchantId]);
    expect(await tryAssignMerchant(order), 'the buy was not routed').toBe(true);
    await readyToPay(orderId);
    expect((await markOrderPaid(who.userId, orderId, utr())).status).toBe('PAID');
    const res = await as(panel, m).post(`/confirm/${orderId}`);
    expect(res.status, res.body.message).toBe(200);
    expect((await getOrderRecord(orderId)).state).toBe('COMPLETED');
    return orderId;
  };

  const completedSell = async (m, tokens) => {
    const who = await player();
    await updateUser(who.userId, {
      bankDetails: { accountNumber: '000111222333', ifscCode: 'HDFC0000001', bankName: 'HDFC Bank', accountHolderName: 'Test Player' },
    });
    await creditWinnings(who.userId, tokens, 'commission suite float', 'Test', `seed_${who.userId}`, `tcm_seed_${who.userId}_${seq += 1}`);
    await teams.onlyOnline([m.merchantId]);
    const { order } = await createWithdrawalOrder(who.userId, tokens);
    const orderId = order.orderId ?? order._id;
    expect((await getOrderRecord(orderId)).merchantId, 'the sell was not routed').toBe(String(m.merchantId));
    const paid = await as(panel, m).post(`/confirm/${orderId}`).send({ utrNumber: utr() });
    expect(paid.status, paid.body.message).toBe(200);
    // The hold sweep's own settler, for this order: the sell completes there.
    expect(await settleHold(orderId)).toBe(true);
    expect((await getOrderRecord(orderId)).state).toBe('COMPLETED');
    return orderId;
  };

  const rows = async (teamId) => (await pgQuery(
    'SELECT * FROM team_commissions WHERE team_id = $1 ORDER BY created_at, commission_id', [teamId])).rows;
  const owedIds = async () => (await ordersOwed({ limit: 1000 })).map((o) => o.orderId);

  let m; // the member the payment cases share
  let other; // a second team's member: the race and the rate cases
  let mBuy;

  /** Every rate at 0 while `fn` runs, so an order completes owed nothing; restored after. */
  async function withRatesOff(fn) {
    const stored = (await db.config.getSystemConfig())?.orderCommission ?? {};
    try {
      await db.config.applyConfig({ scope: 'system', actor: 'test', patch: { orderCommission: { depositPercent: 0, withdrawalPercent: 0 } } });
      return await fn();
    } finally {
      await db.config.applyConfig({
        scope: 'system', actor: 'test',
        patch: { orderCommission: { depositPercent: stored.depositPercent ?? 5, withdrawalPercent: stored.withdrawalPercent ?? 5 } }, // schema default: 5
      });
    }
  }

  it('a completed buy pays at once, straight out of platform revenue, with nothing to fund first', async () => {
    m = await member();
    const rev = await revenuePaise();
    mBuy = await completedBuy(m, 50_000);
    const [paid] = await rows(m.team.teamId);
    expect(paid).toMatchObject({
      commission_id: `tcm~${mBuy}`, order_id: mBuy, order_type: 'DEPOSIT',
      base_paise: '5000000', commission_bp: 500, commission_paise: '250000',
    });
    // What was bought into the pool, less the buy paid out, plus the commission.
    expect((await getPool(m.team.teamId)).availablePaise).toBe(45_250_000);
    // A cost against revenue, whatever revenue stood at.
    expect(await revenuePaise()).toBe(rev - 250_000);
    expect(await teamSummary(m.team.teamId)).toMatchObject({
      buysPaise: 5_000_000, sellsPaise: 0, paidPaise: 250_000, owedPaise: 0, depositPercent: 5, withdrawalPercent: 5,
    });
    expect(await owedIds()).not.toContain(mBuy);
  });

  it('a completed sell pays once its hold is released, as well', async () => {
    const before = (await getPool(m.team.teamId)).availablePaise;
    const rev = await revenuePaise();
    const sell = await completedSell(m, 50_000);
    const all = await rows(m.team.teamId);
    expect(all).toHaveLength(2);
    expect(all[1]).toMatchObject({ order_id: sell, order_type: 'WITHDRAWAL', commission_bp: 500, commission_paise: '250000' });
    expect((await getPool(m.team.teamId)).availablePaise - before).toBe(5_000_000 + 250_000);
    expect(await revenuePaise()).toBe(rev - 250_000);
    expect(await teamSummary(m.team.teamId)).toMatchObject({ buysPaise: 5_000_000, sellsPaise: 5_000_000, paidPaise: 500_000, owedPaise: 0 });
  });

  it('records 16% to the supervisor and 84% equally to the members, adding up to the payment', async () => {
    const [, second] = await rows(m.team.teamId);
    const shares = await listShares(second.commission_id);
    expect(shares).toHaveLength(11);
    expect(shares.find((s) => s.role === 'SUPERVISOR')).toEqual(
      { merchantId: m.team.supervisorId, role: 'SUPERVISOR', sharePaise: 40_000 });
    const members = shares.filter((s) => s.role === 'MEMBER');
    expect(members.map((s) => s.merchantId).sort()).toEqual([...m.team.members].sort());
    expect(members.every((s) => s.sharePaise === 21_000)).toBe(true);
    expect(shares.reduce((sum, s) => sum + s.sharePaise, 0)).toBe(250_000);
    // What the member's earnings tile reads: two payments, 210 each.
    expect((await merchantEarnings(m.merchantId)).lifetime.totalEarnings).toBe(420);
  });

  it('moves the tokens out of the platform holding and books the cost against platform revenue', async () => {
    const [, second] = await rows(m.team.teamId);
    const { rows: legs } = await pgQuery(
      'SELECT account, amount_paise FROM treasury_entries WHERE movement_id = $1 ORDER BY account',
      [`team_commission_${second.commission_id}`]);
    expect(legs.map((l) => [l.account, Number(l.amount_paise)])).toEqual([['TEAM_FLOAT', 250_000], ['TOKEN_SUPPLY', -250_000]]);
    const { rows: [event] } = await pgQuery(
      'SELECT event_type, ref_model, ref_id, postings FROM accounting_events WHERE idempotency_key = $1',
      [`acct_${second.commission_id}`]);
    expect(event).toMatchObject({ event_type: 'MERCHANT_BONUS_ISSUED', ref_model: 'Team', ref_id: m.team.teamId });
    expect(event.postings).toEqual([
      { account: 'PLATFORM_REVENUE', amountPaise: 250_000 },
      { account: 'MERCHANT_FUNDS', amountPaise: -250_000 },
    ]);
    const { rows: [pe] } = await pgQuery(
      `SELECT kind, available_delta_paise FROM team_pool_entries WHERE tx_id = $1`, [`pool_commission_${second.commission_id}`]);
    expect(pe).toMatchObject({ kind: 'COMMISSION', available_delta_paise: '250000' });
  });

  it('pays once however many ask at once, and nothing for an order already paid', async () => {
    other = await member();
    // Completed while the rate was 0, so nothing was paid; at 5% it is owed now.
    const buy = await withRatesOff(() => completedBuy(other, 50_000));
    expect(await owedIds()).toContain(buy);
    const rev = await revenuePaise();
    const before = (await getPool(other.team.teamId)).availablePaise;
    const outcomes = await Promise.all(Array.from({ length: 6 }, () => payOrderCommission(buy)));
    expect(outcomes.filter((o) => o.paid)).toHaveLength(1);
    expect(outcomes.filter((o) => !o.paid).every((o) => o.ok && o.reason === 'already_paid')).toBe(true);
    expect(await rows(other.team.teamId)).toHaveLength(1);
    expect((await getPool(other.team.teamId)).availablePaise - before).toBe(250_000);
    expect(await revenuePaise()).toBe(rev - 250_000);
    // The first team, a bystander here, was not touched.
    expect(await rows(m.team.teamId)).toHaveLength(2);
    expect(await payOrderCommission(mBuy)).toMatchObject({ ok: true, paid: false, reason: 'already_paid' });
  });

  it('pays the rate in force at completion, and a rate of 0 pays nothing and owes nothing', async () => {
    const stored = (await db.config.getSystemConfig())?.orderCommission ?? {};
    try {
      await db.config.applyConfig({
        scope: 'system', actor: 'test', patch: { orderCommission: { depositPercent: 2.5, withdrawalPercent: 0 } },
      });
      const sell = await completedSell(other, 50_000);
      expect(await payOrderCommission(sell)).toMatchObject({ ok: true, paid: false, reason: 'rate_zero' });
      expect(await owedIds()).not.toContain(sell);
      const buy = await completedBuy(other, 50_000);
      const [row] = (await rows(other.team.teamId)).filter((r) => r.order_id === buy);
      expect(row).toMatchObject({ commission_bp: 250, commission_paise: '125000' });
      expect(await rows(other.team.teamId)).toHaveLength(2);
    } finally {
      await db.config.applyConfig({
        scope: 'system', actor: 'test',
        patch: { orderCommission: { depositPercent: stored.depositPercent ?? 5, withdrawalPercent: stored.withdrawalPercent ?? 5 } }, // schema default: 5
      });
    }
  });

  it('the row holds every writer to the rate it records', async () => {
    const [row] = await rows(m.team.teamId);
    await expect(pgQuery(
      `INSERT INTO team_commissions (commission_id, team_id, order_id, order_type, base_paise, commission_bp, commission_paise)
       VALUES ($1, $2, $3, 'DEPOSIT', 5000000, 500, 250001)`, [`tcm~probe-${row.commission_id}`, m.team.teamId, `probe-${oid()}`]))
      .rejects.toMatchObject({ code: '23514' });
    // And one order, one row, by any writer.
    await expect(pgQuery(
      `INSERT INTO team_commissions (commission_id, team_id, order_id, order_type, base_paise, commission_bp, commission_paise)
       VALUES ($1, $2, $3, 'DEPOSIT', 5000000, 500, 250000)`, [`tcm~again-${oid()}`, m.team.teamId, mBuy]))
      .rejects.toMatchObject({ code: '23505' });
  });

  it("a member's screen carries their own share of each payment, never anyone else's", async () => {
    const res = await as(teamRoutes, m).get('/team');
    expect(res.status, res.body.message).toBe(200);
    expect(res.body.role).toBe('MEMBER');
    expect(res.body.myCommissionPaise).toBe(42_000);
    expect(res.body.commissions).toHaveLength(2);
    for (const c of res.body.commissions) {
      expect(Object.keys(c).sort()).toEqual(
        ['basePaise', 'commissionId', 'commissionPaise', 'commissionPercent', 'createdAt', 'mySharePaise', 'orderId', 'orderType', 'teamId']);
      expect(c.mySharePaise).toBe(21_000);
    }
    expect(res.body.team.commission).toMatchObject({ buysPaise: 5_000_000, sellsPaise: 5_000_000, paidPaise: 500_000, owedPaise: 0 });
    expect(JSON.stringify(res.body)).not.toContain('sharePaise":40000');
  });
});
