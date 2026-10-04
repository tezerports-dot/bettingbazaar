// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Team commission (PROJECT_STATUS §3.10, Step 2e), through the real order
 * paths, the real routers and a real database.
 *
 * The rule (owner): a team's matched volume is min(completed buys, completed
 * sells). Each time it rises above the team's high-water mark, 10% of the rise
 * is paid as tokens into the team's pool from the platform's commission pool;
 * 16% of each payment is recorded to the supervisor and 84% to the members in
 * equal parts.
 *
 * What is pinned:
 *   · nothing is paid while the commission pool cannot cover ALL of it, and
 *     the mark does not move (§26: never partial);
 *   · an admin's top-up pays what was waiting, at once;
 *   · a completion pays at once, on the smaller side only;
 *   · the shares add up to the payment, 16 / 84 equally;
 *   · replays and races pay once (§32 S6);
 *   · tokens move TOKEN_SUPPLY → TEAM_FLOAT, the ledger's pool pays for them;
 *   · a member's screen carries their own share and nobody else's.
 *
 * Completed the way production completes (§32 S16): a buy routed to the
 * member, paid with a claimed reference and confirmed on the member's panel; a
 * sell routed, accepted, paid out with a UTR and settled by the hold sweep's
 * own settler.
 *
 * Trap 10: the platform's commission pool is a SHARED balance. It is set for
 * this suite against platform revenue, and in `afterAll`, outside any
 * assertion, everything this suite posted to the ledger for it — the set-up
 * adjustments, the admin's funding and the commission paid to the suite's own
 * teams, whose rows `cleanup()` deletes — is reversed by one ADJUSTMENT (the
 * ledger is append-only).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pgConfigured, applySchema, closePg, withTransaction, pgQuery } from '#db/client.js';
import { createOrderRecord, getOrderRecord } from '#db/repositories/orders.record.js';
import { updateUser } from '#db/repositories/users.js';
import { getPool } from '#db/repositories/teamPools.js';
import { recordEvent } from '#db/repositories/ledger.core.js';
import {
  payTeamCommission, teamSummary, listShares, teamsOwed,
} from '#db/repositories/teamCommission.js';
import { merchantEarnings } from '#db/repositories/stats.js';
import { creditWinnings } from '../../domains/wallet/walletAuthority.service.js';
import {
  tryAssignMerchant, markOrderPaid, createWithdrawalOrder,
} from '../../domains/payment/paymentProcessing.service.js';
import { settleHold } from '../../domains/payment/withdrawalHold.service.js';
import { teamFixture, readyToPay } from '../teamFixture.js';
import { mountRouter, actor, merchantActor, as } from './_harness.js';

const describePg = pgConfigured() ? describe : describe.skip;

const POOL = 'MERCHANT_BONUS_POOL';

/** Raw (signed) balance of a ledger account. */
async function raw(account) {
  const { rows } = await pgQuery(
    `SELECT COALESCE(SUM((p->>'amountPaise')::BIGINT), 0) AS v
       FROM accounting_events, jsonb_array_elements(postings) p WHERE p->>'account' = $1`, [account]);
  return Number(rows[0].v);
}
/** What the commission pool holds (it is credit-normal: the reported balance is the negated raw sum). */
const poolPaise = async () => 0 - (await raw(POOL));

describePg('team commission', () => {
  let panel; let teamRoutes; let revenue; let admin; let seq = 0;
  const teams = teamFixture();
  const players = [];
  const teamIds = [];
  const posted = []; // every set-up posting, to reverse
  const oid = () => `tcm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}-${seq += 1}`;
  const utr = () => String(580000000000 + (seq * 7919) + Math.floor(Math.random() * 7000));

  async function adjust(postings) {
    posted.push(...postings);
    await recordEvent({
      eventType: 'ADJUSTMENT', idempotencyKey: `tcm-test-adj-${oid()}`, postings,
      refModel: 'Test', refId: 'teamCommissionPg', description: 'teamCommissionPg: set up the commission pool',
    });
  }
  /** The platform's commission pool, set to exactly `paise` against platform revenue. */
  async function setPool(paise) {
    const d = (await poolPaise()) - paise;
    if (d) await adjust([{ account: POOL, amountPaise: d }, { account: 'PLATFORM_REVENUE', amountPaise: -d }]);
  }

  beforeAll(async () => {
    await applySchema();
    panel = mountRouter((await import('../../domains/merchant/merchant.routes.js')).default);
    teamRoutes = mountRouter((await import('../../domains/team/team.merchant.routes.js')).default);
    revenue = mountRouter((await import('../../domains/revenue/revenue.admin.routes.js')).default);
    admin = await actor({ isSubAdmin: true, permissions: { canManageCommission: true } });
  }, 60_000);

  afterAll(async () => {
    const { rows: caused } = await pgQuery(
      `SELECT postings FROM accounting_events
        WHERE (ref_model = 'Team' AND ref_id = ANY($1))
           OR (event_type = 'MERCHANT_BONUS_FUNDED' AND ref_id = $2)`,
      [teamIds, String(admin.userId)]);
    const net = {};
    for (const p of [...posted, ...caused.flatMap((r) => r.postings)]) {
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
    expect((await as(panel, m).post(`/accept/${orderId}`).send({})).status).toBe(200);
    const paid = await as(panel, m).post(`/confirm/${orderId}`).send({ utrNumber: utr() });
    expect(paid.status, paid.body.message).toBe(200);
    // The hold sweep's own settler, for this order: the sell completes there.
    expect(await settleHold(orderId)).toBe(true);
    expect((await getOrderRecord(orderId)).state).toBe('COMPLETED');
  };

  const rows = async (teamId) => (await pgQuery(
    'SELECT * FROM team_commissions WHERE team_id = $1 ORDER BY to_high_paise', [teamId])).rows;

  let m; // the member the payment cases share
  let other; // a second team's member: the race, and a buy that completes the match

  it('pays nothing while the commission pool cannot cover it all, and says what is waiting', async () => {
    m = await member();
    await setPool(400_000); // 4,000 tokens — the 5,000 earned below does not fit
    await completedBuy(m, 50_000);
    await completedSell(m, 50_000);
    expect(await teamSummary(m.team.teamId)).toMatchObject({
      buysPaise: 5_000_000, sellsPaise: 5_000_000, matchedPaise: 5_000_000,
      highPaise: 0, paidPaise: 0, owedPaise: 500_000,
    });
    expect(await rows(m.team.teamId)).toHaveLength(0);
    // The pool holds what was bought into it, the buy paid out, the sell paid in — no commission.
    expect((await getPool(m.team.teamId)).availablePaise).toBe(50_000_000);
    expect(await payTeamCommission(m.team.teamId)).toMatchObject({ ok: false, reason: 'pool_short', owedPaise: 500_000 });
    expect(await poolPaise()).toBe(400_000);
    expect(await teamsOwed({ limit: 1000 })).toContain(m.team.teamId);
  });

  it("an admin's top-up pays what was waiting, at once, into the team's pool", async () => {
    // Revenue to fund from, as a settled cycle's profit would leave it.
    await adjust([{ account: 'USER_FUNDS', amountPaise: 100_000_000 }, { account: 'PLATFORM_REVENUE', amountPaise: -100_000_000 }]);
    const owedElsewhere = (await teamsOwed({ limit: 1000 })).filter((t) => t !== m.team.teamId);
    expect(owedElsewhere, 'another suite left a team owed commission; this case funds exactly ours').toEqual([]);
    const res = await as(revenue, admin).post('/revenue/bonus-pool/fund')
      .send({ amount: 1_000, justification: 'teamCommissionPg top-up' });
    expect(res.status, res.body.message).toBe(200);
    expect(res.body.commissionsPaid).toBe(1);
    const [paid] = await rows(m.team.teamId);
    expect(paid).toMatchObject({ from_high_paise: '0', to_high_paise: '5000000', commission_paise: '500000' });
    expect((await getPool(m.team.teamId)).availablePaise).toBe(50_500_000);
    // 4,000 + 1,000 funded, 5,000 paid.
    expect(await poolPaise()).toBe(0);
    expect((await teamSummary(m.team.teamId)).owedPaise).toBe(0);
  });

  it('a completion pays at once, on the smaller side only', async () => {
    await setPool(10_000_000);
    // More buys than sells: the matched volume does not move, nothing is paid.
    await completedBuy(m, 50_000);
    expect(await rows(m.team.teamId)).toHaveLength(1);
    // And every screen is told so: the matched side is the smaller one, nothing is owed.
    expect(await teamSummary(m.team.teamId)).toMatchObject({
      buysPaise: 10_000_000, sellsPaise: 5_000_000, matchedPaise: 5_000_000, owedPaise: 0,
    });
    const before = (await getPool(m.team.teamId)).availablePaise;
    // The sell matches it: the rise of 50,000 pays 5,000 the moment the sell completes.
    await completedSell(m, 50_000);
    const all = await rows(m.team.teamId);
    expect(all).toHaveLength(2);
    expect(all[1]).toMatchObject({ from_high_paise: '5000000', to_high_paise: '10000000', commission_paise: '500000' });
    expect((await getPool(m.team.teamId)).availablePaise - before).toBe(5_000_000 + 500_000);
    expect(await poolPaise()).toBe(9_500_000);
  });

  it('records 16% to the supervisor and 84% equally to the members, adding up to the payment', async () => {
    const [, second] = await rows(m.team.teamId);
    const shares = await listShares(second.commission_id);
    expect(shares).toHaveLength(11);
    expect(shares.find((s) => s.role === 'SUPERVISOR')).toEqual(
      { merchantId: m.team.supervisorId, role: 'SUPERVISOR', sharePaise: 80_000 });
    const members = shares.filter((s) => s.role === 'MEMBER');
    expect(members.map((s) => s.merchantId).sort()).toEqual([...m.team.members].sort());
    expect(members.every((s) => s.sharePaise === 42_000)).toBe(true);
    expect(shares.reduce((sum, s) => sum + s.sharePaise, 0)).toBe(500_000);
    // What the member's earnings tile reads: two payments, 420 each.
    expect((await merchantEarnings(m.merchantId)).lifetime.totalEarnings).toBe(840);
  });

  it('moves the tokens out of the platform holding and the cost out of the ledger pool', async () => {
    const [, second] = await rows(m.team.teamId);
    const { rows: legs } = await pgQuery(
      'SELECT account, amount_paise FROM treasury_entries WHERE movement_id = $1 ORDER BY account',
      [`team_commission_${second.commission_id}`]);
    expect(legs.map((l) => [l.account, Number(l.amount_paise)])).toEqual([['TEAM_FLOAT', 500_000], ['TOKEN_SUPPLY', -500_000]]);
    const { rows: [event] } = await pgQuery(
      'SELECT event_type, ref_model, ref_id, postings FROM accounting_events WHERE idempotency_key = $1',
      [`acct_${second.commission_id}`]);
    expect(event).toMatchObject({ event_type: 'MERCHANT_BONUS_ISSUED', ref_model: 'Team', ref_id: m.team.teamId });
    expect(event.postings).toEqual([
      { account: 'MERCHANT_BONUS_POOL', amountPaise: 500_000 },
      { account: 'MERCHANT_FUNDS', amountPaise: -500_000 },
    ]);
    const { rows: [pe] } = await pgQuery(
      `SELECT kind, available_delta_paise FROM team_pool_entries WHERE tx_id = $1`, [`pool_commission_${second.commission_id}`]);
    expect(pe).toMatchObject({ kind: 'COMMISSION', available_delta_paise: '500000' });
  });

  it('pays once however many ask at once, and nothing when nothing rose', async () => {
    other = await member();
    await setPool(0);
    await completedBuy(other, 50_000);
    await completedSell(other, 50_000); // owed, and waiting
    await setPool(10_000_000);
    const before = (await getPool(other.team.teamId)).availablePaise;
    const outcomes = await Promise.all(Array.from({ length: 6 }, () => payTeamCommission(other.team.teamId)));
    expect(outcomes.filter((o) => o.paid)).toHaveLength(1);
    expect(outcomes.filter((o) => !o.paid).every((o) => o.ok && ['no_rise', 'already_paid'].includes(o.reason))).toBe(true);
    expect(await rows(other.team.teamId)).toHaveLength(1);
    expect((await getPool(other.team.teamId)).availablePaise - before).toBe(500_000);
    expect(await poolPaise()).toBe(9_500_000);
    // The first team, a bystander here, was not touched.
    expect(await rows(m.team.teamId)).toHaveLength(2);
    expect(await payTeamCommission(m.team.teamId)).toMatchObject({ ok: true, paid: false, reason: 'no_rise' });
  });

  it('a BUY that completes the match pays at once as well', async () => {
    await setPool(10_000_000);
    // A sell first: more sells than buys, so nothing rises.
    await completedSell(other, 50_000);
    expect(await rows(other.team.teamId)).toHaveLength(1);
    // The buy that matches it is completed on the member's panel, and pays there.
    await completedBuy(other, 50_000);
    const all = await rows(other.team.teamId);
    expect(all).toHaveLength(2);
    expect(all[1]).toMatchObject({ from_high_paise: '5000000', to_high_paise: '10000000', commission_paise: '500000' });
  });

  it("a member's screen carries their own share of each payment, never anyone else's", async () => {
    const res = await as(teamRoutes, m).get('/team');
    expect(res.status, res.body.message).toBe(200);
    expect(res.body.role).toBe('MEMBER');
    expect(res.body.myCommissionPaise).toBe(84_000);
    expect(res.body.commissions).toHaveLength(2);
    for (const c of res.body.commissions) {
      expect(Object.keys(c).sort()).toEqual(
        ['commissionId', 'commissionPaise', 'createdAt', 'fromHighPaise', 'mySharePaise', 'teamId', 'toHighPaise']);
      expect(c.mySharePaise).toBe(42_000);
    }
    expect(res.body.team.commission).toMatchObject({ matchedPaise: 10_000_000, paidPaise: 1_000_000, owedPaise: 0 });
    expect(JSON.stringify(res.body)).not.toContain('sharePaise":80000');
  });
});
