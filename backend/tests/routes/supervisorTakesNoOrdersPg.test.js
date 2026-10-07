// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * A supervisor is never a member (§2), so a supervisor has no online switch and
 * no order directions.
 *
 * ── The defect this holds ─────────────────────────────────────────────────
 * Driving the merchant panel AS a supervisor (`BB_PROFILE=merchant-supervisor
 * npm run test:drive`) pressed "Go online" on their Dashboard, and the server
 * took it: `PUT /api/merchant/online-status` switched the supervisor online and
 * the switch's trigger opened a `merchant_online_sessions` stretch for them —
 * "a member's online time" (§2) recorded for somebody who is not a member. The
 * Profile's "Accept deposit/withdrawal orders" switches were the same: offered
 * and written. Routing never reads a supervisor, so nothing was misrouted; the
 * log and the screens said something untrue.
 *
 * INVARIANT: a supervisor's row is never online. Held by the row
 * (`merchants_supervisor_never_online`), and by the writes' WHERE (`setOnline`,
 * `setOrderPreferences` in merchants.js) so the route can say why rather than
 * fail on the constraint and no read acted on later decides it (trap 18); and
 * the one write that MAKES a supervisor (`setSupervisorRole`) switches them off
 * in the same statement, so a member who was online when promoted does not
 * stay online as a supervisor. `setOnline` is the switch's one writer: the
 * generic `updateMerchant` no longer accepts it (merchantPg).
 *
 * The opposite behaviour, which must still hold: a member goes online and
 * offline and sets their directions exactly as before; a supervisor may always
 * go OFFLINE (a refusal there would strand a row).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pgConfigured, applySchema, closePg, pgQuery } from '#db/client.js';
import { getMerchant, setOnline } from '#db/repositories/merchants.js';
import { setSupervisorRole } from '#db/repositories/teams.js';
import { teamFixture } from '../teamFixture.js';
import { mountRouter, actor, merchantActor, as } from './_harness.js';

const describePg = pgConfigured() ? describe : describe.skip;

describePg('a supervisor takes no orders, so has no online switch', () => {
  let merchantApp; let teamAdminApp;
  let admin; let supervisor; let member;
  const teams = teamFixture();

  const sessions = async (merchantId) => (await pgQuery(
    'SELECT started_at, ended_at FROM merchant_online_sessions WHERE merchant_id = $1 ORDER BY id', [merchantId])).rows;
  const row = async (merchantId) => (await pgQuery(
    'SELECT is_online, accepts_deposits, accepts_withdrawals FROM merchants WHERE merchant_id = $1', [merchantId])).rows[0];

  beforeAll(async () => {
    await applySchema();
    merchantApp = mountRouter((await import('../../domains/merchant/merchant.routes.js')).default);
    teamAdminApp = mountRouter((await import('../../domains/team/team.admin.routes.js')).default);
    admin = await actor({ isAdmin: true });
    supervisor = await merchantActor();
    member = await merchantActor();
    // A real team: the supervisor runs it, the member is in it (§32 S16).
    await teams.workingTeam({ rail: 'CASH', supervisorId: supervisor.merchantId, include: [member.merchantId], online: [] });
  }, 60_000);

  afterAll(async () => {
    await teams.cleanup();
    await closePg();
  });

  it('a supervisor pressing "Go online" is refused by name, and nothing is written', async () => {
    const res = await as(merchantApp, supervisor).put('/online-status').send({ isOnline: true });
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.code).toBe('SUPERVISOR_TAKES_NO_ORDERS');
    // Something they can act on: what they are, and who goes online instead.
    expect(res.body.message).toMatch(/supervisor/i);
    expect(res.body.message).toMatch(/members/i);
    expect((await row(supervisor.merchantId)).is_online).toBe(false);
    expect(await sessions(supervisor.merchantId)).toEqual([]);
    // The write itself refuses, not only the route in front of it (trap 18).
    expect(await setOnline(supervisor.merchantId, true)).toBeNull();
    expect((await row(supervisor.merchantId)).is_online).toBe(false);
    // And the row refuses any other path to it (`merchants_supervisor_never_online`).
    await expect(pgQuery('UPDATE merchants SET is_online = TRUE WHERE merchant_id = $1', [supervisor.merchantId]))
      .rejects.toThrow(/merchants_supervisor_never_online/);
    expect(await sessions(supervisor.merchantId)).toEqual([]);
  });

  it('a supervisor may always go offline', async () => {
    const res = await as(merchantApp, supervisor).put('/online-status').send({ isOnline: false });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.merchant.isOnline).toBe(false);
  });

  it('a member still goes online and offline, and the stretch is logged (the opposite)', async () => {
    const on = await as(merchantApp, member).put('/online-status').send({ isOnline: true });
    expect(on.status, JSON.stringify(on.body)).toBe(200);
    expect((await row(member.merchantId)).is_online).toBe(true);
    expect((await sessions(member.merchantId)).filter((s) => s.ended_at === null)).toHaveLength(1);
    const off = await as(merchantApp, member).put('/online-status').send({ isOnline: false });
    expect(off.status).toBe(200);
    expect((await sessions(member.merchantId)).every((s) => s.ended_at !== null)).toBe(true);
  });

  it('a supervisor cannot switch order directions; a member still can', async () => {
    const before = await row(supervisor.merchantId);
    const refused = await as(merchantApp, supervisor).put('/preferences').send({ acceptsDeposits: !before.accepts_deposits });
    expect(refused.status, JSON.stringify(refused.body)).toBe(403);
    expect(refused.body.code).toBe('SUPERVISOR_TAKES_NO_ORDERS');
    expect(await row(supervisor.merchantId)).toEqual(before);

    const was = await row(member.merchantId);
    try {
      const ok = await as(merchantApp, member).put('/preferences').send({ acceptsWithdrawals: !was.accepts_withdrawals });
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
      expect((await row(member.merchantId)).accepts_withdrawals).toBe(!was.accepts_withdrawals);
      expect((await row(member.merchantId)).accepts_deposits).toBe(was.accepts_deposits);
    } finally {
      await as(merchantApp, member).put('/preferences').send({ acceptsWithdrawals: was.accepts_withdrawals });
    }
  });

  it('becoming a supervisor ends the online stretch in the same write', async () => {
    // An approved merchant, online, in no team — then made a supervisor by an admin.
    const promoted = await merchantActor();
    expect((await as(merchantApp, promoted).put('/online-status').send({ isOnline: true })).status).toBe(200);
    expect((await sessions(promoted.merchantId)).filter((s) => s.ended_at === null)).toHaveLength(1);

    const res = await as(teamAdminApp, admin).put(`/merchants/${promoted.merchantId}/supervisor`).send({ rail: 'UPI_BANK' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await row(promoted.merchantId)).is_online).toBe(false);
    expect((await sessions(promoted.merchantId)).every((s) => s.ended_at !== null)).toBe(true);
    expect((await getMerchant(promoted.merchantId)).isSupervisor).toBe(true);

    // And taking the role away leaves them offline, free to go online as anyone else.
    expect((await as(teamAdminApp, admin).put(`/merchants/${promoted.merchantId}/supervisor`).send({ rail: null })).status).toBe(200);
    expect((await as(merchantApp, promoted).put('/online-status').send({ isOnline: true })).status).toBe(200);
    await as(merchantApp, promoted).put('/online-status').send({ isOnline: false });
  });

  it('going online and being made a supervisor, at the same moment, never leave a supervisor online', async () => {
    // §37.1 first/concurrent: whichever statement takes the row second
    // re-reads it — the switch's WHERE then refuses a supervisor, or the
    // promotion switches the member off — so the row's CHECK is never what
    // answers, and neither caller sees a constraint error.
    const racer = await merchantActor();
    for (let round = 0; round < 8; round += 1) {
      const [role, online] = await Promise.all([
        setSupervisorRole(racer.merchantId, { rail: 'CASH' }),
        setOnline(racer.merchantId, true),
      ]);
      expect(role).toEqual({ ok: true });
      const now = await pgQuery('SELECT is_supervisor, is_online FROM merchants WHERE merchant_id = $1', [racer.merchantId]);
      expect(now.rows[0]).toEqual({ is_supervisor: true, is_online: false });
      // The switch either went on before the promotion (and the promotion
      // turned it off) or was refused after it.
      if (online) expect(online.isSupervisor).toBe(false);
      expect((await sessions(racer.merchantId)).every((s) => s.ended_at !== null)).toBe(true);
      expect((await setSupervisorRole(racer.merchantId, { rail: null })).ok).toBe(true);
    }
  });

  it('an existing database with a supervisor online converges: switched off, the stretch closed, the row guarded', async () => {
    // §37.1 new/existing database (§32 S31): a row written before the rule.
    // Recreate it the only way it could exist — without the constraint — and
    // apply the schema again.
    const old = await merchantActor();
    await pgQuery('ALTER TABLE merchants DROP CONSTRAINT merchants_supervisor_never_online');
    try {
      expect((await setOnline(old.merchantId, true))?.isOnline).toBe(true);
      await pgQuery(`UPDATE merchants SET is_supervisor = TRUE, supervisor_rail = 'UPI_BANK' WHERE merchant_id = $1`, [old.merchantId]);
      expect((await row(old.merchantId)).is_online).toBe(true);
    } finally {
      await applySchema();
    }
    expect((await row(old.merchantId)).is_online).toBe(false);
    expect((await sessions(old.merchantId)).every((s) => s.ended_at !== null)).toBe(true);
    await expect(pgQuery('UPDATE merchants SET is_online = TRUE WHERE merchant_id = $1', [old.merchantId]))
      .rejects.toThrow(/merchants_supervisor_never_online/);
    expect((await setSupervisorRole(old.merchantId, { rail: null })).ok).toBe(true);
  });

  it('the profile tells the panel which kind of account it is', async () => {
    const sup = await as(merchantApp, supervisor).get('/profile');
    expect(sup.status).toBe(200);
    expect(sup.body.merchant.isSupervisor).toBe(true);
    const mem = await as(merchantApp, member).get('/profile');
    expect(mem.body.merchant.isSupervisor).toBe(false);
  });
});
