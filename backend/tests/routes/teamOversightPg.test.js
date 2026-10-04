// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Team oversight (PROJECT_STATUS §3.10, Step 2f), through the real order
 * paths, the real routers and a real database.
 *
 * What is pinned:
 *   · the Online switch is logged, one stretch per spell, closed once;
 *   · the daily red flags, once per day: a member below the team's average in
 *     BOTH completed orders and online time is flagged, and one below in only
 *     one is not; a team whose own buyer and seller (or one customer on both
 *     sides) bet against each other is flagged for commission farming, and a
 *     pair under the rounds or the hedged share is not;
 *   · who sees what: the supervisor their teams' low-activity flags and every
 *     member's figures, never a farming flag; a member the team's totals and
 *     their own figures, never a teammate's row; an admin everything;
 *   · a supervisor reads only their own members' logs, and speaks in only their
 *     own members' open disputes, with no mobile number either way.
 *
 * Built the way production builds it (§32 S16): orders routed to members of
 * working teams, completed on the member's panel and the hold sweep's
 * settler; bets placed through the bet writer; the switch through its writer.
 *
 * Trap 10: the day this suite evaluates is its own to clean — the day's row
 * and every flag it produced are removed in `afterAll`, with the orders and
 * the bets (refunded through the bet writer) of this suite's players.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pgConfigured, applySchema, closePg, withTransaction, pgQuery } from '#db/client.js';
import { createOrderRecord, getOrderRecord } from '#db/repositories/orders.record.js';
import { updateUser } from '#db/repositories/users.js';
import { setOnline } from '#db/repositories/merchants.js';
import { placeBet, refundPlacedBet } from '#db/repositories/bets.js';
import { evaluateRedFlags, redFlagSettings } from '#db/repositories/teamOversight.js';
import { SUPERVISOR_ORDER_FIELDS } from '../../domains/merchant/merchantOrderView.js';
import { creditWinnings } from '../../domains/wallet/walletAuthority.service.js';
import {
  tryAssignMerchant, markOrderPaid, createWithdrawalOrder,
} from '../../domains/payment/paymentProcessing.service.js';
import { settleHold } from '../../domains/payment/withdrawalHold.service.js';
import { teamFixture, readyToPay } from '../teamFixture.js';
import { mountRouter, actor, merchantActor, as } from './_harness.js';

const describePg = pgConfigured() ? describe : describe.skip;
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

describePg('team oversight', () => {
  let panel; let teamApp; let teamAdmin; let playerApp; let disputeApp; let admin; let seq = 0;
  const teams = teamFixture();
  const players = [];
  const placed = [];
  let today;
  const run = `tov${Date.now().toString(36)}`;
  const oid = () => `${run}-${Math.random().toString(36).slice(2, 7)}-${seq += 1}`;
  const utr = () => String(570000000000 + (seq * 7919) + Math.floor(Math.random() * 7000));
  const payoutUtr = () => `UTRTO${String(Date.now()).slice(-7)}${String(seq += 1).padStart(4, '0')}`;
  const cycle = (n) => `${run}-c${n}`;

  beforeAll(async () => {
    await applySchema();
    panel = mountRouter((await import('../../domains/merchant/merchant.routes.js')).default);
    teamApp = mountRouter((await import('../../domains/team/team.merchant.routes.js')).default);
    teamAdmin = mountRouter((await import('../../domains/team/team.admin.routes.js')).default);
    playerApp = mountRouter((await import('../../domains/payment/payment.routes.js')).default);
    disputeApp = mountRouter((await import('../../domains/disputes/disputeResolution.admin.routes.js')).default);
    admin = await actor({ isSubAdmin: true, permissions: { canManageTeams: true, canResolveDisputes: true } });
    today = (await pgQuery(`SELECT to_char((now() AT TIME ZONE 'Asia/Kolkata')::date, 'YYYY-MM-DD') AS d`)).rows[0].d;
    // A run that died before its cleanup left today claimed; this suite owns it.
    await forgetDay();
  }, 60_000);

  async function forgetDay() {
    await withTransaction(async (c) => {
      await c.query('SET LOCAL session_replication_role = replica');
      await c.query('DELETE FROM team_red_flags WHERE flag_day = $1', [today]);
      await c.query('DELETE FROM team_red_flag_days WHERE flag_day = $1', [today]);
    });
  }

  afterAll(async () => {
    for (const b of placed) {
      await refundPlacedBet({ ...b, reason: 'teamOversightPg cleanup' }).catch(() => {});
    }
    await forgetDay();
    await withTransaction(async (c) => {
      await c.query('SET LOCAL session_replication_role = replica');
      await c.query('DELETE FROM chat_messages WHERE order_id IN (SELECT order_id FROM order_states WHERE user_id = ANY($1))', [players]);
      await c.query('DELETE FROM dispute_faults WHERE order_id IN (SELECT order_id FROM order_states WHERE user_id = ANY($1))', [players]);
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
    await updateUser(who.userId, {
      bankDetails: { accountNumber: '000111222333', ifscCode: 'HDFC0000001', bankName: 'HDFC Bank', accountHolderName: 'Oversight Player' },
    });
    return who;
  };

  /** A 50,000-token buy by `who`, routed to `m` and confirmed on the member's panel. */
  const completedBuy = async (who, m) => {
    const orderId = oid();
    const order = await createOrderRecord({
      orderId, userId: who.userId, type: 'DEPOSIT',
      tokenAmountRupees: 50_000, fiatAmountRupees: 50_000, depositAllocation: 50_000, reserveAllocation: 0,
    });
    await teams.onlyOnline([m.merchantId]);
    expect(await tryAssignMerchant(order), 'the buy was not routed').toBe(true);
    expect((await getOrderRecord(orderId)).merchantId).toBe(String(m.merchantId));
    await readyToPay(orderId);
    expect((await markOrderPaid(who.userId, orderId, utr())).status).toBe('PAID');
    const res = await as(panel, m).post(`/confirm/${orderId}`);
    expect(res.status, res.body.message).toBe(200);
    expect((await getOrderRecord(orderId)).state).toBe('COMPLETED');
    return orderId;
  };

  /** A 50,000-token sell by `who` (paid from `winnings` seeded first), routed to `m`, paid out. */
  const paidSell = async (who, m, winnings) => {
    await creditWinnings(who.userId, winnings, 'oversight suite float', 'Test', `seed_${who.userId}`, `tov_seed_${who.userId}_${seq += 1}`);
    await teams.onlyOnline([m.merchantId]);
    const { order } = await createWithdrawalOrder(who.userId, 50_000);
    const orderId = order.orderId ?? order._id;
    expect((await getOrderRecord(orderId)).merchantId, 'the sell was not routed').toBe(String(m.merchantId));
    expect((await as(panel, m).post(`/accept/${orderId}`).send({})).status).toBe(200);
    const paid = await as(panel, m).post(`/confirm/${orderId}`).send({ utrNumber: payoutUtr() });
    expect(paid.status, paid.body.message).toBe(200);
    return orderId;
  };
  const completedSell = async (who, m, winnings) => {
    const orderId = await paidSell(who, m, winnings);
    expect(await settleHold(orderId)).toBe(true);
    expect((await getOrderRecord(orderId)).state).toBe('COMPLETED');
    return orderId;
  };

  /** Stakes through the bet writer: `[cycleNo, side, tokens]`, from the given pocket. */
  const bet = async (who, field, stakes) => {
    for (const [n, side, amount] of stakes) {
      const b = { betId: `${run}-b${seq += 1}`, userId: who.userId, cycleId: cycle(n), side, slices: [{ field, amount }] };
      const out = await placeBet({ ...b, amount });
      expect(out.ok, JSON.stringify(out)).toBe(true);
      placed.push(b);
    }
  };

  const supervisorFlags = (body) => body.redFlags.map((f) => `${f.kind}:${f.merchantId}`);

  let supL; let supT; let a; let b; let x; let t1; let teamL; let teamT;
  let farmers = {};

  it('logs the Online switch: one stretch per spell, closed once and never edited', async () => {
    const m = await merchantActor();
    const stretches = async () => (await pgQuery(
      'SELECT id, ended_at FROM merchant_online_sessions WHERE merchant_id = $1 ORDER BY id', [m.merchantId])).rows;
    await setOnline(m.merchantId, true);
    await setOnline(m.merchantId, true);
    expect(await stretches()).toHaveLength(1);
    expect((await stretches())[0].ended_at).toBeNull();
    await setOnline(m.merchantId, false);
    await setOnline(m.merchantId, false);
    const closed = await stretches();
    expect(closed).toHaveLength(1);
    expect(closed[0].ended_at).not.toBeNull();
    await setOnline(m.merchantId, true);
    expect((await stretches()).map((s) => s.ended_at === null)).toEqual([false, true]);
    await expect(pgQuery('UPDATE merchant_online_sessions SET ended_at = now() WHERE id = $1', [closed[0].id]))
      .rejects.toThrow(/closed once/);
    await setOnline(m.merchantId, false);
  });

  it('flags, once a day, the members below the team in BOTH orders and online time, and the farming team', async () => {
    supL = await merchantActor(); supT = await merchantActor();
    a = await merchantActor(); b = await merchantActor(); x = await merchantActor(); t1 = await merchantActor();
    teamL = await teams.workingTeam({ rail: 'UPI_BANK', poolTokens: 200_000, supervisorId: supL.merchantId, include: [a.merchantId, b.merchantId, x.merchantId] });
    teamT = await teams.workingTeam({ rail: 'UPI_BANK', poolTokens: 500_000, supervisorId: supT.merchantId, include: [t1.merchantId] });

    // ── Team T: its customers bet against each other ────────────────────────
    const [pa, pb, pc, pd, pe, pf, pg, ph] = [
      await player(), await player(), await player(), await player(), await player(), await player(), await player(), await player()];
    farmers = { pa, pb, pg };
    await completedBuy(pa, t1);            // A bought from the team…
    await completedSell(pb, t1, 70_000);   // …B sold to it…
    await completedBuy(pc, t1);
    await completedSell(pd, t1, 80_000);
    await completedBuy(pe, t1);
    await completedSell(pf, t1, 60_000);
    await completedBuy(pg, t1);            // G did both.
    await completedSell(pg, t1, 50_000);
    await completedBuy(ph, t1);
    // A and B: 5,000 on opposite sides of three rounds — all of their stake.
    await bet(pa, 'depositBalance', [[1, 'DELHI', 5000], [2, 'DELHI', 5000], [3, 'DELHI', 5000]]);
    await bet(pb, 'winningsBalance', [[1, 'BOMBAY', 5000], [2, 'BOMBAY', 5000], [3, 'BOMBAY', 5000]]);
    // C and D: against each other in three rounds, but D bets far more alone.
    await bet(pc, 'depositBalance', [[1, 'DELHI', 1000], [2, 'DELHI', 1000], [3, 'DELHI', 1000]]);
    await bet(pd, 'winningsBalance', [[1, 'BOMBAY', 1000], [2, 'BOMBAY', 1000], [3, 'BOMBAY', 1000], [9, 'DELHI', 20000]]);
    // E and F: all of their stake against each other, in only two rounds.
    await bet(pe, 'depositBalance', [[4, 'DELHI', 2000], [5, 'DELHI', 2000]]);
    await bet(pf, 'winningsBalance', [[4, 'BOMBAY', 2000], [5, 'BOMBAY', 2000]]);
    // C and H: all of their stake against each other in three rounds, but both
    // only BOUGHT — no sell brings the stake back as matched volume.
    await bet(ph, 'depositBalance', [[1, 'BOMBAY', 1000], [2, 'BOMBAY', 1000], [3, 'BOMBAY', 1000]]);
    // G: both sides of three rounds.
    await bet(pg, 'depositBalance', [[6, 'DELHI', 3000], [6, 'BOMBAY', 3000], [7, 'DELHI', 3000], [7, 'BOMBAY', 3000], [8, 'DELHI', 3000], [8, 'BOMBAY', 3000]]);

    // ── Team L: two members complete an order each, X is online and idle ────
    const [p1, p2] = [await player(), await player()];
    await completedBuy(p1, a);
    await completedBuy(p2, b);
    await teams.onlyOnline([a.merchantId, b.merchantId, x.merchantId]);
    await sleep(400);

    const out = await evaluateRedFlags(today, redFlagSettings({}));
    expect(out.evaluated).toBe(true);
    const { rows: flags } = await pgQuery(
      'SELECT kind, team_id, merchant_id, details FROM team_red_flags WHERE flag_day = $1 AND team_id = ANY($2)',
      [today, [teamL.teamId, teamT.teamId]]);

    const lowL = flags.filter((f) => f.team_id === teamL.teamId && f.kind === 'LOW_ACTIVITY').map((f) => f.merchant_id).sort();
    const idle = teamL.members.filter((id) => ![a.merchantId, b.merchantId, x.merchantId].includes(id)).sort();
    // X did no orders but was online above the cut: below in ONE, so not flagged.
    expect(lowL).toEqual(idle);
    expect(flags.find((f) => f.merchant_id === idle[0]).details).toMatchObject({ completedOrders: 0, onlineSeconds: 0, members: 10, percent: 25 });
    expect(flags.filter((f) => f.team_id === teamL.teamId && f.kind === 'COMMISSION_FARMING')).toHaveLength(0);

    const farming = flags.filter((f) => f.team_id === teamT.teamId && f.kind === 'COMMISSION_FARMING');
    expect(farming).toHaveLength(1);
    const pair = (u, v) => [u.userId, v.userId].sort().join('|');
    const got = farming[0].details.pairs.map((p) => [p.playerA, p.playerB].sort().join('|')).sort();
    expect(got).toEqual([pair(pa, pb), pair(pg, pg)].sort());
    expect(farming[0].details).toMatchObject({ pairCount: 2, buysPaise: 25_000_000, sellsPaise: 20_000_000, minRounds: 3, hedgePercent: 80 });
    const ab = farming[0].details.pairs.find((p) => !p.sameAccount);
    expect(ab).toMatchObject({ rounds: 3, hedgedPaise: 3_000_000, stakedPaise: 3_000_000 });
    // Team T's other nine never worked.
    expect(flags.filter((f) => f.team_id === teamT.teamId && f.kind === 'LOW_ACTIVITY')).toHaveLength(9);

    // Once a day: a second evaluation is a no-op.
    expect(await evaluateRedFlags(today, redFlagSettings({}))).toEqual({ evaluated: false });
    const { rows: again } = await pgQuery('SELECT count(*)::int AS n FROM team_red_flags WHERE flag_day = $1 AND team_id = ANY($2)',
      [today, [teamL.teamId, teamT.teamId]]);
    expect(again[0].n).toBe(flags.length);
  });

  it('shows the supervisor their teams\' low-activity flags and every member\'s figures, never a farming flag', async () => {
    const seenL = await as(teamApp, supL).get('/team');
    expect(seenL.status, JSON.stringify(seenL.body)).toBe(200);
    const idle = teamL.members.filter((id) => ![a.merchantId, b.merchantId, x.merchantId].includes(id));
    expect(supervisorFlags(seenL.body).sort()).toEqual(idle.map((id) => `LOW_ACTIVITY:${id}`).sort());
    const row = (id) => seenL.body.activity.today.find((r) => r.merchantId === id);
    expect(row(a.merchantId)).toMatchObject({ teamId: teamL.teamId, completedOrders: 1, completedTokens: 50_000 });
    expect(row(x.merchantId).completedOrders).toBe(0);
    expect(seenL.body.activity.week.filter((r) => r.teamId === teamL.teamId)).toHaveLength(10);

    const seenT = await as(teamApp, supT).get('/team');
    expect(seenT.body.redFlags.every((f) => f.kind === 'LOW_ACTIVITY' && f.teamId === teamT.teamId)).toBe(true);
    expect(seenT.body.redFlags).toHaveLength(9);
    expect(JSON.stringify(seenT.body)).not.toContain(farmers.pa.userId);

    const seenAdmin = await as(teamAdmin, admin).get('/team-red-flags');
    expect(seenAdmin.status).toBe(200);
    const farming = seenAdmin.body.flags.find((f) => f.kind === 'COMMISSION_FARMING' && f.teamId === teamT.teamId);
    expect(farming.details.pairCount).toBe(2);
    expect(seenAdmin.body.flags.filter((f) => f.teamId === teamL.teamId)).toHaveLength(7);
  });

  it('shows a member the team\'s totals and their own figures, never a teammate\'s row', async () => {
    const seen = await as(teamApp, a).get('/team');
    expect(seen.status).toBe(200);
    expect(seen.body.performance).toMatchObject({
      days: 7, members: 10,
      team: { completedOrders: 2, completedTokens: 100_000, averageOrders: 0.2 },
      me: { completedOrders: 1, completedTokens: 50_000 },
    });
    expect(seen.body.performance.me.onlineSeconds).toBeGreaterThan(0);
    const text = JSON.stringify(seen.body);
    expect(text).not.toContain(b.merchantId);
    expect(text).not.toContain(x.merchantId);
    expect(seen.body.redFlags).toBeUndefined();
    expect(seen.body.activity).toBeUndefined();
  });

  it('lets a supervisor read their own member\'s log — orders without the player, online stretches — and nobody else\'s', async () => {
    const log = await as(teamApp, supL).get(`/supervisor/members/${a.merchantId}/log`);
    expect(log.status, JSON.stringify(log.body)).toBe(200);
    expect(log.body.member).toMatchObject({ merchantId: a.merchantId, teamId: teamL.teamId });
    expect(log.body.orders).toHaveLength(1);
    expect(log.body.orders[0]).toMatchObject({ type: 'DEPOSIT', status: 'COMPLETED', tokenAmount: 50_000 });
    for (const o of log.body.orders) {
      expect(Object.keys(o).every((k) => SUPERVISOR_ORDER_FIELDS.includes(k)), Object.keys(o).join()).toBe(true);
    }
    expect(log.body.sessions.length).toBeGreaterThan(0);

    const other = await as(teamApp, supT).get(`/supervisor/members/${a.merchantId}/log`);
    expect(other.status).toBe(404);
    expect(other.body.code).toBe('member_not_found');
    const loose = await merchantActor();
    expect((await as(teamApp, supL).get(`/supervisor/members/${loose.merchantId}/log`)).status).toBe(404);
    expect((await as(teamApp, a).get(`/supervisor/members/${b.merchantId}/log`)).status).toBe(403);
  });

  it('lets a supervisor speak in their member\'s open dispute, with no mobile number either way', async () => {
    const who = await player();
    const orderId = await paidSell(who, a, 50_000);
    await pgQuery(`UPDATE order_states SET paid_at = now() - interval '11 minutes' WHERE order_id = $1`, [orderId]);
    const disputed = await as(playerApp, who).post(`/order/${orderId}/dispute`).send({ reason: 'Nothing reached my bank, call 98765 43210' });
    expect(disputed.status, JSON.stringify(disputed.body)).toBe(200);

    const list = await as(teamApp, supL).get('/supervisor/disputes');
    expect(list.status).toBe(200);
    const mine = list.body.disputes.find((d) => d.orderId === orderId);
    expect(mine).toMatchObject({ status: 'DISPUTED', merchantId: a.merchantId, disputeReason: 'Nothing reached my bank, call [number hidden]' });
    expect((await as(teamApp, supT).get('/supervisor/disputes')).body.disputes.map((d) => d.orderId)).not.toContain(orderId);

    const said = await as(teamApp, supL).post(`/supervisor/disputes/${orderId}/chat`).send({ message: 'My member paid at 14:02; the UTR is on the order.' });
    expect(said.status, JSON.stringify(said.body)).toBe(201);
    const thread = await as(disputeApp, admin).get(`/dispute-orders/${orderId}/chat`);
    const fromSupervisor = thread.body.messages.filter((m) => m.senderType === 'SUPERVISOR');
    expect(fromSupervisor).toHaveLength(1);
    expect(fromSupervisor[0]).toMatchObject({ senderName: 'Supervisor', senderId: supL.merchantId });

    const withNumber = await as(teamApp, supL).post(`/supervisor/disputes/${orderId}/chat`).send({ message: 'Call my member on +91 98765-43210' });
    expect(withNumber.status).toBe(400);
    expect(withNumber.body.code).toBe('message_has_mobile');
    expect((await as(teamApp, supT).post(`/supervisor/disputes/${orderId}/chat`).send({ message: 'Not my team' })).status).toBe(404);
    const seen = await as(teamApp, supL).get(`/supervisor/disputes/${orderId}/chat`);
    expect(seen.status).toBe(200);
    expect(seen.body.messages.filter((m) => m.senderType === 'SUPERVISOR')).toHaveLength(1);
    expect(seen.body.messages.every((m) => m.senderId === undefined)).toBe(true);
    expect((await as(teamApp, supT).get(`/supervisor/disputes/${orderId}/chat`)).status).toBe(404);

    // Decided: the thread is closed to the supervisor.
    const decided = await as(disputeApp, admin).post(`/dispute-orders/${orderId}/resolve`)
      .send({ decision: 'RELEASE_TO_MERCHANT', resolution: 'statement shows the transfer' });
    expect(decided.status, JSON.stringify(decided.body)).toBe(200);
    const late = await as(teamApp, supL).post(`/supervisor/disputes/${orderId}/chat`).send({ message: 'One more thing' });
    expect(late.status).toBe(409);
    expect(late.body.code).toBe('dispute_closed');
  });
});
