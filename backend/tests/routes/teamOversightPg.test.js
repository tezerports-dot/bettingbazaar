// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Team oversight (PROJECT_STATUS §3.10, Step 2f), through the real order
 * paths, the real routers and a real database.
 *
 * What is pinned:
 *   · the Online switch is logged, one stretch per spell, closed once;
 *   · the daily red flags, once per day: a member below the team's average in
 *     BOTH completed orders and online time is flagged, and one below in only
 *     one is not; a sell settled by the hold sweep counts as a completed order;
 *   · who sees what: the supervisor their own teams' flags and every member's
 *     figures; a member the team's totals and their own figures, never a
 *     teammate's row; an admin every team's flags;
 *   · a supervisor reads only their own APPROVED members' logs, from when they
 *     joined, and speaks in only their own members' open disputes (at most
 *     `SUPERVISOR_MESSAGES_PER_DISPUTE` times), shown nothing of the player:
 *     no mobile, UPI handle or reference, no player message, no staff notice;
 *   · no name other people see (username, team name) carries a mobile.
 *
 * Built the way production builds it (§32 S16): orders routed to members of
 * working teams, completed on the member's panel and the hold sweep's
 * settler; the switch through its writer.
 *
 * Trap 10: the day this suite evaluates is its own to clean — the day's row
 * and every flag it produced are removed in `afterAll`, with the orders of
 * this suite's players.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pgConfigured, applySchema, closePg, withTransaction, pgQuery } from '#db/client.js';
import { createOrderRecord, getOrderRecord } from '#db/repositories/orders.record.js';
import { updateUser } from '#db/repositories/users.js';
import { setOnline } from '#db/repositories/merchants.js';
import { evaluateRedFlags, redFlagSettings } from '#db/repositories/teamOversight.js';
import { createTeam, addMember } from '#db/repositories/teams.js';
import { postMessage, SUPERVISOR_MESSAGES_PER_DISPUTE } from '#db/repositories/chat.js';
import { SUPERVISOR_ORDER_FIELDS } from '../../domains/merchant/merchantOrderView.js';
import { creditWinnings } from '../../domains/wallet/walletAuthority.service.js';
import {
  tryAssignMerchant, markOrderPaid, createWithdrawalOrder,
} from '../../domains/payment/paymentProcessing.service.js';
import { settleHold } from '../../domains/payment/withdrawalHold.service.js';
import { teamFixture, readyToPay } from '../teamFixture.js';
import request from 'supertest';
import { mountRouter, actor, merchantActor, as } from './_harness.js';

const describePg = pgConfigured() ? describe : describe.skip;
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

describePg('team oversight', () => {
  let panel; let teamApp; let teamAdmin; let playerApp; let disputeApp; let admin; let seq = 0;
  const teams = teamFixture();
  const ownTeams = [];
  const players = [];
  let today;
  const run = `tov${Date.now().toString(36)}`;
  const oid = () => `${run}-${Math.random().toString(36).slice(2, 7)}-${seq += 1}`;
  // Twelve digits, unique to this run: the UTR registry keeps every claim for good.
  const utr = () => `57${String(Date.now()).slice(-7)}${String(seq += 1).padStart(3, '0')}`;
  const payoutUtr = () => `UTRTO${String(Date.now()).slice(-7)}${String(seq += 1).padStart(4, '0')}`;

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
    await withTransaction(async (c) => {
      await c.query('SET LOCAL session_replication_role = replica');
      await c.query('DELETE FROM team_members WHERE team_id = ANY($1)', [ownTeams]);
      await c.query('DELETE FROM teams WHERE team_id = ANY($1)', [ownTeams]);
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

  const supervisorFlags = (body) => body.redFlags.map((f) => `${f.kind}:${f.merchantId}`);

  let supL; let supT; let a; let b; let x; let t1; let teamL; let teamT;

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

    // A stretch opened by a statement that began after this one's clock (two
    // taps, two tabs): switching off still works, and never ends it before it began.
    const late = await merchantActor();
    await pgQuery(`INSERT INTO merchant_online_sessions (merchant_id, started_at) VALUES ($1, now() + interval '1 minute')`, [late.merchantId]);
    await pgQuery('UPDATE merchants SET is_online = true WHERE merchant_id = $1', [late.merchantId]);
    await setOnline(late.merchantId, false);
    const { rows: [s] } = await pgQuery('SELECT started_at, ended_at FROM merchant_online_sessions WHERE merchant_id = $1', [late.merchantId]);
    expect(s.ended_at).not.toBeNull();
    expect(new Date(s.ended_at) >= new Date(s.started_at)).toBe(true);
  });

  it('flags, once a day, the members below the team in BOTH orders and online time', async () => {
    supL = await merchantActor(); supT = await merchantActor();
    a = await merchantActor(); b = await merchantActor(); x = await merchantActor(); t1 = await merchantActor();
    teamL = await teams.workingTeam({ rail: 'UPI_BANK', poolTokens: 200_000, supervisorId: supL.merchantId, include: [a.merchantId, b.merchantId, x.merchantId] });
    teamT = await teams.workingTeam({ rail: 'UPI_BANK', poolTokens: 200_000, supervisorId: supT.merchantId, include: [t1.merchantId] });

    // ── Team T: one member completes a buy and a sell the hold sweep settles ─
    const [pa, pb] = [await player(), await player()];
    await completedBuy(pa, t1);
    await completedSell(pb, t1, 50_000);

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
    // Team T's other nine never worked.
    expect(flags.filter((f) => f.team_id === teamT.teamId).map((f) => f.merchant_id).sort())
      .toEqual(teamT.members.filter((id) => id !== t1.merchantId).sort());

    // Once a day: a second evaluation is a no-op.
    expect(await evaluateRedFlags(today, redFlagSettings({}))).toEqual({ evaluated: false });
    const { rows: again } = await pgQuery('SELECT count(*)::int AS n FROM team_red_flags WHERE flag_day = $1 AND team_id = ANY($2)',
      [today, [teamL.teamId, teamT.teamId]]);
    expect(again[0].n).toBe(flags.length);
  });

  it('shows the supervisor their own teams\' flags and every member\'s figures; an admin every team\'s', async () => {
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
    // The sell the hold sweep settled is a completed order like the buy.
    expect(seenT.body.activity.today.find((r) => r.merchantId === t1.merchantId))
      .toMatchObject({ completedOrders: 2, completedTokens: 100_000 });

    const seenAdmin = await as(teamAdmin, admin).get('/team-red-flags');
    expect(seenAdmin.status).toBe(200);
    expect(seenAdmin.body.flags.filter((f) => f.teamId === teamT.teamId)).toHaveLength(9);
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

    // Proposed but not approved: not yet one of the team, so shown none of it,
    // and the supervisor cannot open their log by proposing them.
    const proposed = await merchantActor();
    const extra = await createTeam({ supervisorId: supL.merchantId, name: `Extra ${run}` });
    ownTeams.push(extra.teamId);
    expect((await addMember({ teamId: extra.teamId, supervisorId: supL.merchantId, merchantRef: proposed.merchantId, actor: supL.merchantId })).ok).toBe(true);
    const pending = await as(teamApp, proposed).get('/team');
    expect(pending.body).toMatchObject({ role: 'MEMBER', status: 'PENDING', performance: null });
    const log = await as(teamApp, supL).get(`/supervisor/members/${proposed.merchantId}/log`);
    expect(log.status).toBe(404);
    expect(log.body.code).toBe('member_not_found');
  });

  it('refuses a mobile number in a name other people see: a merchant username, a team name', async () => {
    const mobile = `9${String(Date.now()).slice(-9)}`;
    try {
      const signup = await request(panel).post('/auth/signup')
        .send({ username: `raj ${mobile}`, mobile, password: 'Correct-Horse-Battery-9!' });
      expect(signup.status, JSON.stringify(signup.body)).toBe(400);
      expect(signup.body.code).toBe('NAME_IS_A_MOBILE');
      expect((await pgQuery("SELECT 1 FROM users WHERE mobile = $1 AND account_type = 'MERCHANT'", [mobile])).rowCount).toBe(0);
    } finally {
      // A broken rule lets the account in, and a row the restored CHECK would
      // refuse stops the next schema apply: remove whatever got through.
      await withTransaction(async (c) => {
        await c.query('SET LOCAL session_replication_role = replica');
        await c.query('DELETE FROM merchants WHERE mobile = $1', [mobile]);
        await c.query("DELETE FROM users WHERE mobile = $1 AND account_type = 'MERCHANT'", [mobile]);
      });
    }

    const named = await as(teamApp, supL).put(`/supervisor/teams/${ownTeams[0]}`).send({ name: 'Call 98765 43210' });
    expect(named.status).toBe(400);
    expect(named.body.message).toMatch(/phone number/);
    await expect(pgQuery('UPDATE teams SET name = $2 WHERE team_id = $1', [ownTeams[0], '९८७६५४३२१०']))
      .rejects.toMatchObject({ constraint: 'teams_name_not_a_mobile' });
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
    // Online time from before they joined the team is not the team's.
    const { rows: [joined] } = await pgQuery('SELECT approved_at FROM team_members WHERE merchant_id = $1', [a.merchantId]);
    expect(log.body.member.approvedAt).toBeTruthy();
    await pgQuery(`INSERT INTO merchant_online_sessions (merchant_id, started_at, ended_at)
                   VALUES ($1, $2::timestamptz - interval '3 hours', $2::timestamptz - interval '2 hours')`, [a.merchantId, joined.approved_at]);
    const after = await as(teamApp, supL).get(`/supervisor/members/${a.merchantId}/log`);
    expect(after.body.sessions).toHaveLength(log.body.sessions.length);
    expect(after.body.sessions.every((s) => new Date(s.startedAt) >= new Date(joined.approved_at))).toBe(true);

    const other = await as(teamApp, supT).get(`/supervisor/members/${a.merchantId}/log`);
    expect(other.status).toBe(404);
    expect(other.body.code).toBe('member_not_found');
    const loose = await merchantActor();
    expect((await as(teamApp, supL).get(`/supervisor/members/${loose.merchantId}/log`)).status).toBe(404);
    expect((await as(teamApp, a).get(`/supervisor/members/${b.merchantId}/log`)).status).toBe(403);
  });

  it('lets a supervisor speak in their member\'s open dispute, with nothing of the player either way', async () => {
    const who = await player();
    const orderId = await paidSell(who, a, 50_000);
    await pgQuery(`UPDATE order_states SET paid_at = now() - interval '11 minutes' WHERE order_id = $1`, [orderId]);
    const disputed = await as(playerApp, who).post(`/order/${orderId}/dispute`)
      .send({ reason: 'Nothing reached my bank, call 98765  43210, I paid from rahul.k@okaxis, UTR 4123 4567 8901' });
    expect(disputed.status, JSON.stringify(disputed.body)).toBe(200);

    const list = await as(teamApp, supL).get('/supervisor/disputes');
    expect(list.status).toBe(200);
    const mine = list.body.disputes.find((d) => d.orderId === orderId);
    expect(mine).toMatchObject({
      status: 'DISPUTED', merchantId: a.merchantId,
      disputeReason: 'Nothing reached my bank, call [number hidden], I paid from [handle hidden], UTR [number hidden]',
    });
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
    // The player's own words and system notices stay out of the supervisor's
    // view; the dispute manager's reach it with the player's detail hidden.
    await postMessage({ orderId, senderId: who.userId, senderType: 'USER', message: 'My UPI is rahul.k@okaxis' });
    const asked = await as(disputeApp, admin).post(`/dispute-orders/${orderId}/chat`)
      .send({ message: 'Member, the player says UTR 412345678901 from rahul.k@okaxis. Send your statement.' });
    expect(asked.status, JSON.stringify(asked.body)).toBe(200);
    const seen = await as(teamApp, supL).get(`/supervisor/disputes/${orderId}/chat`);
    expect(seen.status).toBe(200);
    expect(seen.body.messages.map((m) => m.senderType).sort()).toEqual(['ADMIN', 'SUPERVISOR']);
    expect(seen.body.messages.find((m) => m.senderType === 'ADMIN').message)
      .toBe('Member, the player says UTR [number hidden] from [handle hidden]. Send your statement.');
    expect(seen.body.messages.every((m) => m.senderId === undefined)).toBe(true);
    expect(JSON.stringify(seen.body)).not.toContain('okaxis');
    expect((await as(teamApp, supT).get(`/supervisor/disputes/${orderId}/chat`)).status).toBe(404);

    // A bounded voice: past the cap, nothing more lands.
    await pgQuery(
      `INSERT INTO chat_messages (order_id, sender_id, sender_type, message)
       SELECT $1, $2, 'SUPERVISOR', 'filler ' || g FROM generate_series(2, $3) g`,
      [orderId, supL.merchantId, SUPERVISOR_MESSAGES_PER_DISPUTE]);
    const over = await as(teamApp, supL).post(`/supervisor/disputes/${orderId}/chat`).send({ message: 'And another' });
    expect(over.status).toBe(409);
    expect(over.body.code).toBe('too_many_messages');
    await pgQuery(`DELETE FROM chat_messages WHERE order_id = $1 AND message LIKE 'filler %'`, [orderId]);

    // Decided: the thread is closed to the supervisor.
    const decided = await as(disputeApp, admin).post(`/dispute-orders/${orderId}/resolve`)
      .send({ decision: 'RELEASE_TO_MERCHANT', resolution: 'statement shows the transfer' });
    expect(decided.status, JSON.stringify(decided.body)).toBe(200);
    const late = await as(teamApp, supL).post(`/supervisor/disputes/${orderId}/chat`).send({ message: 'One more thing' });
    expect(late.status).toBe(409);
    expect(late.body.code).toBe('dispute_closed');
    // The resolution notice names the staff member: written for staff, not shown.
    const after = await as(teamApp, supL).get(`/supervisor/disputes/${orderId}/chat`);
    expect(after.body.order.disputeDecision).toBe('RELEASE_TO_MERCHANT');
    expect(JSON.stringify(after.body.messages)).not.toMatch(/RESOLVED/);
  });
});
