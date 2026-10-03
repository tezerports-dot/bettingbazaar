// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The other side of a platform↔team token trade, through a real database.
 *
 * ── What was missing, and what still writes it ──────────────────────────────
 * The treasury records that tokens moved. Nothing recorded what they moved
 * FOR, so the books balanced in tokens and said nothing about money: every
 * profit-and-loss reading of the platform's own token trade was missing its
 * revenue side. `admin_token_considerations` is that side — one row per
 * movement, keyed BY the movement (§2).
 *
 * It used to be written by the admin's top-up and deduction of a merchant's
 * wallet. Those are gone (PROJECT_STATUS §3.10, 2c): merchants hold no tokens.
 * The ONE writer now is the fulfilment of a supervisor's pool request
 * (`POST /api/admin/team-pool-requests/:id/fulfil` → `teamPools.fulfilRequest`),
 * which moves TOKEN_SUPPLY ↔ TEAM_FLOAT, the team's pool, the request's status
 * and this row in one transaction, with `team_id` set and the supervisor as
 * the merchant.
 *
 * Asserted here, in both directions: the money is recorded when it should be,
 * NOTHING moves when the request is refused, the USDT figure is valued at a
 * frozen rate rather than summed as rupees (trap 15), and a redelivered
 * fulfilment books one trade rather than two. The doors and the pool's own
 * arithmetic are teamPoolRoutesPg's and teamPoolsPg's.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pgConfigured, applySchema, closePg, pgQuery } from '#db/client.js';
import { db } from '#db';
import { getTreasuryBalances, ACCOUNTS } from '#db/repositories/treasury.js';
import { createRequest, getPool, getRequest } from '#db/repositories/teamPools.js';
import { teamFixture } from '../teamFixture.js';
import { mountRouter, actor, as } from './_harness.js';
import teamAdminRouter from '../../domains/team/team.admin.routes.js';
import analyticsRouter from '../../domains/analytics/analytics.admin.routes.js';

const describePg = pgConfigured() ? describe : describe.skip;
const T = (tokens) => tokens * 100;

describePg('what the platform got, or gave, for a team\'s tokens', () => {
  const teams = teamFixture();
  let app; let analytics; let admin; let team; let restoreRate;

  /** A supervisor's request, made the way their Team page makes it. */
  const ask = async (t, direction, tokens) => {
    const r = await createRequest({ teamId: t.teamId, supervisorId: t.supervisorId, direction, tokenAmountPaise: T(tokens) });
    expect(r.ok, r.reason).toBe(true);
    return r.requestId;
  };
  const fulfil = (requestId, body) => as(app, admin).post(`/api/team-pool-requests/${requestId}/fulfil`).send(body);
  const recorded = (requestId) => db.adminTokenConsiderations.considerationFor(`team_pool_${requestId}`);

  /** Everything a refused fulfilment must leave exactly as it was. */
  const snapshot = async (t, requestId) => ({
    treasury: await getTreasuryBalances(),
    pool: await getPool(t.teamId),
    status: (await getRequest(requestId)).status,
    row: await recorded(requestId),
  });
  const expectNothingMoved = async (t, requestId, before) => {
    const after = await snapshot(t, requestId);
    // Both legs, not just one: a version that took tokens out of the
    // platform's holding without crediting the pool — or the reverse — would
    // pass a one-sided assertion.
    expect(after.treasury[ACCOUNTS.TOKEN_SUPPLY]).toBe(before.treasury[ACCOUNTS.TOKEN_SUPPLY]);
    expect(after.treasury[ACCOUNTS.TEAM_FLOAT]).toBe(before.treasury[ACCOUNTS.TEAM_FLOAT]);
    expect(after.pool).toEqual(before.pool);
    expect(after.status, 'a refused fulfilment still decided the request').toBe('PENDING');
    expect(after.row, 'a refused fulfilment still recorded a payment').toBeNull();
  };

  beforeAll(async () => {
    await applySchema();
    app = mountRouter(teamAdminRouter, { prefix: '/api' });
    analytics = mountRouter(analyticsRouter, { prefix: '/api' });
    admin = await actor({ isAdmin: true });
    // Nobody routes orders in this file, so nobody needs to be online.
    team = await teams.workingTeam({ rail: 'UPI_BANK', online: [] });

    // Trap 10 / S19: `config_documents` is ONE row holding the platform's live
    // rules, so a suite that writes one changes the rules for every suite after
    // it in the same process. Take the baseline, put it back in `afterAll`, and
    // SET what this suite needs rather than reading whatever the database
    // happened to hold — a USDT assertion that passes only on a database
    // somebody had already priced is asserting nothing.
    const before = await db.config.getSystemConfig();
    restoreRate = before?.usdtPricing?.merchantAdminBuyInr ?? 0; // schema default: 0 (unset)
    await db.config.applyConfig({
      scope: 'system', actor: 'test', patch: { usdtPricing: { merchantAdminBuyInr: 90 } },
    });
  }, 120_000);

  afterAll(async () => {
    // Outside any assertion: a restore that only runs when the suite passed is
    // the one that matters least.
    await db.config.applyConfig({
      scope: 'system', actor: 'test', patch: { usdtPricing: { merchantAdminBuyInr: restoreRate } },
    }).catch(() => {});
    await teams.cleanup();
    await closePg();
  });

  // ── Refusing costs nothing ───────────────────────────────────────────────

  it('moves NOTHING for a request that does not exist', async () => {
    const before = await getTreasuryBalances();
    const res = await fulfil('tpr_not_a_real_request', { settlementCurrency: 'INR', settlementAmount: 777 });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('request_not_found');
    const after = await getTreasuryBalances();
    expect(after[ACCOUNTS.TOKEN_SUPPLY]).toBe(before[ACCOUNTS.TOKEN_SUPPLY]);
    expect(after[ACCOUNTS.TEAM_FLOAT]).toBe(before[ACCOUNTS.TEAM_FLOAT]);
  });

  it('refuses a sale that does not say what the platform received', async () => {
    const requestId = await ask(team, 'BUY', 1000);
    const before = await snapshot(team, requestId);

    const res = await fulfil(requestId, {});
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/received/i);
    // §32 S14: the operator must be able to act on it. "Enter 0" is the instruction.
    expect(res.body.message).toMatch(/0 if no money changed hands/i);
    await expectNothingMoved(team, requestId, before);

    // And the same request is still there to fulfil properly.
    expect((await fulfil(requestId, { settlementAmount: 1000 })).status).toBe(200);
  });

  it('refuses a buyback that does not say what the platform paid', async () => {
    const requestId = await ask(team, 'SELL', 100);
    const before = await snapshot(team, requestId);

    const res = await fulfil(requestId, { settlementCurrency: 'INR' });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/paid/i);
    await expectNothingMoved(team, requestId, before);
    await as(app, admin).post(`/api/team-pool-requests/${requestId}/reject`).send({ reason: 'test over' });
  });

  it('takes ZERO as a real answer — tokens moved for no money, and the row says so', async () => {
    const requestId = await ask(team, 'BUY', 100);
    const before = await getPool(team.teamId);
    const res = await fulfil(requestId, { settlementAmount: 0, settlementCurrency: 'INR' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.settlement).toMatchObject({ currency: 'INR', amount: 0, inrValue: 0 });
    expect((await getPool(team.teamId)).availablePaise - before.availablePaise).toBe(T(100));
    // Zero and absent are different facts: the row EXISTS, and says nothing was paid.
    expect(await recorded(requestId)).toMatchObject({ fiatAmountMinor: 0, inrEquivalentPaise: 0 });
  });

  // ── The money is recorded, both directions, with the tokens it paid for ──

  it('records what came in for a rupee sale, against the same movement as the tokens', async () => {
    const requestId = await ask(team, 'BUY', 1000);
    const treasury = await getTreasuryBalances();
    const pool = await getPool(team.teamId);

    const res = await fulfil(requestId, { settlementAmount: 950, settlementCurrency: 'INR' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    expect(await recorded(requestId)).toMatchObject({
      direction: 'RECEIVED', currency: 'INR',
      fiatAmountMinor: 95000, inrEquivalentPaise: 95000,
      tokenAmountPaise: T(1000), rateUsed: null,
      // The supervisor asked and the TEAM holds the tokens: both are on the row.
      merchantId: team.supervisorId, teamId: team.teamId,
      recordedBy: admin.userId,
    });
    // The tokens it paid for: out of the platform's holding, into the pool.
    const after = await getTreasuryBalances();
    expect(after[ACCOUNTS.TOKEN_SUPPLY] - treasury[ACCOUNTS.TOKEN_SUPPLY]).toBe(-T(1000));
    expect(after[ACCOUNTS.TEAM_FLOAT] - treasury[ACCOUNTS.TEAM_FLOAT]).toBe(T(1000));
    expect((await getPool(team.teamId)).availablePaise - pool.availablePaise).toBe(T(1000));
  });

  it('records what went out for a rupee buyback', async () => {
    const requestId = await ask(team, 'SELL', 500);
    const treasury = await getTreasuryBalances();
    const pool = await getPool(team.teamId);

    const res = await fulfil(requestId, { settlementAmount: 500 });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    expect(await recorded(requestId)).toMatchObject({
      direction: 'PAID', currency: 'INR',
      fiatAmountMinor: 50000, inrEquivalentPaise: 50000, rateUsed: null,
      tokenAmountPaise: T(500), teamId: team.teamId,
    });
    const after = await getTreasuryBalances();
    expect(after[ACCOUNTS.TEAM_FLOAT] - treasury[ACCOUNTS.TEAM_FLOAT]).toBe(-T(500));
    expect(after[ACCOUNTS.TOKEN_SUPPLY] - treasury[ACCOUNTS.TOKEN_SUPPLY]).toBe(T(500));
    expect((await getPool(team.teamId)).availablePaise - pool.availablePaise).toBe(-T(500));
  });

  // ── Trap 15, which is the whole reason there are two amount columns ──────

  it('values a USDT receipt at the frozen rate, and never as rupees', async () => {
    const requestId = await ask(team, 'BUY', 9000);
    const res = await fulfil(requestId, { settlementAmount: 100, settlementCurrency: 'USDT' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const row = await recorded(requestId);
    // 100 USDT is 10,000 hundredths; at ₹90 that is 900,000 paise = ₹9,000.
    expect(row.fiatAmountMinor).toBe(10000);
    expect(row.inrEquivalentPaise).toBe(900000);
    // The figure a human is shown must NOT be the figure anything sums: booking
    // 100 USDT as ₹100 is the hundredfold understatement trap 15 records.
    expect(row.inrEquivalentPaise).not.toBe(row.fiatAmountMinor);
    expect(row.rateUsed).toBe(90);
    expect(res.body.settlement).toMatchObject({ currency: 'USDT', amount: 100, inrValue: 9000, rateUsed: 90 });
  });

  it('freezes the rate, so a later config edit cannot restate a settled trade', async () => {
    const requestId = await ask(team, 'BUY', 900);
    expect((await fulfil(requestId, { settlementAmount: 10, settlementCurrency: 'USDT' })).status).toBe(200);
    const at90 = await recorded(requestId);

    await db.config.applyConfig({
      scope: 'system', actor: 'test', patch: { usdtPricing: { merchantAdminBuyInr: 50 } },
    });
    try {
      const reread = await recorded(requestId);
      expect(reread.rateUsed).toBe(at90.rateUsed);
      expect(reread.inrEquivalentPaise).toBe(at90.inrEquivalentPaise);
    } finally {
      await db.config.applyConfig({
        scope: 'system', actor: 'test', patch: { usdtPricing: { merchantAdminBuyInr: 90 } },
      });
    }
  });

  it.each([
    ['unset (0, the schema default)', 0],
    ['1, which used to mean unset', 1],
    ['outside the band, written past the route (a misplaced decimal)', 9000],
  ])('refuses a USDT receipt BY NAME when the rate is %s, rather than pricing it', async (_label, rate) => {
    // §25's precedent: a purchase that cannot be priced is refused by name,
    // because the fallback is worse than the refusal. The band is the one
    // `tokenRates.js` owns; the reader enforces it as well as the route.
    const requestId = await ask(team, 'BUY', 1000);
    const before = await snapshot(team, requestId);
    await db.config.applyConfig({
      scope: 'system', actor: 'test', patch: { usdtPricing: { merchantAdminBuyInr: rate } },
    });
    try {
      const res = await fulfil(requestId, { settlementAmount: 11, settlementCurrency: 'USDT' });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/USDT buy rate is not set/i);
      // And it says what to do about it, both ways out (§32 S14).
      expect(res.body.message).toMatch(/System Settings/);
      expect(res.body.message).toMatch(/record this settlement in INR/i);
      await expectNothingMoved(team, requestId, before);
    } finally {
      await db.config.applyConfig({
        scope: 'system', actor: 'test', patch: { usdtPricing: { merchantAdminBuyInr: 90 } },
      });
    }
    // The way out the message names actually works.
    expect((await fulfil(requestId, { settlementAmount: 1000, settlementCurrency: 'INR' })).status).toBe(200);
  });

  it('refuses a USDT PAYOUT — the platform buys its tokens back in rupees', async () => {
    const requestId = await ask(team, 'SELL', 100);
    const before = await snapshot(team, requestId);
    const res = await fulfil(requestId, { settlementAmount: 1, settlementCurrency: 'USDT' });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/pays merchants back in INR/i);
    await expectNothingMoved(team, requestId, before);
    await as(app, admin).post(`/api/team-pool-requests/${requestId}/reject`).send({ reason: 'test over' });
  });

  // ── One movement, one trade ──────────────────────────────────────────────

  it('books ONE trade for a redelivered fulfilment, not two', async () => {
    const requestId = await ask(team, 'BUY', 200);
    const first = await fulfil(requestId, { settlementAmount: 190 });
    const pool = await getPool(team.teamId);
    const treasury = await getTreasuryBalances();
    const second = await fulfil(requestId, { settlementAmount: 190 });

    expect(first.status).toBe(200);
    // Not a silent 200: the second admin is told the request was already decided.
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('request_not_pending');
    expect(await getPool(team.teamId)).toEqual(pool);
    expect((await getTreasuryBalances())[ACCOUNTS.TEAM_FLOAT]).toBe(treasury[ACCOUNTS.TEAM_FLOAT]);

    const { rows } = await pgQuery(
      'SELECT count(*)::int AS n FROM admin_token_considerations WHERE movement_id = $1', [`team_pool_${requestId}`]);
    expect(rows[0].n).toBe(1);
  });

  it('survives four fulfilments racing each other', async () => {
    // The status flip is the once-only guard, and it is a WRITE (§32 S6): four
    // admins pressing at once serialise on the request row.
    const requestId = await ask(team, 'BUY', 300);
    const treasury = await getTreasuryBalances();
    const pool = await getPool(team.teamId);

    const results = await Promise.all(
      Array.from({ length: 4 }, () => fulfil(requestId, { settlementAmount: 300 })),
    );
    expect(results.filter((r) => r.status === 200), 'not exactly one fulfilment landed').toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(3);

    expect((await getPool(team.teamId)).availablePaise - pool.availablePaise).toBe(T(300));
    const after = await getTreasuryBalances();
    expect(after[ACCOUNTS.TEAM_FLOAT] - treasury[ACCOUNTS.TEAM_FLOAT]).toBe(T(300));
    expect(after[ACCOUNTS.TOKEN_SUPPLY] - treasury[ACCOUNTS.TOKEN_SUPPLY]).toBe(-T(300));
    const { rows } = await pgQuery(
      'SELECT count(*)::int AS n FROM admin_token_considerations WHERE movement_id = $1', [`team_pool_${requestId}`]);
    expect(rows[0].n).toBe(1);
  });

  // ── What the P&L reads ───────────────────────────────────────────────────

  it('adds the trades up in rupees, and keeps the settled currencies apart', async () => {
    // Own rows only, against a supervisor nobody else in this suite touches —
    // trap 10: never assert a global invariant over a shared table.
    const solo = await teams.workingTeam({ rail: 'UPI_BANK', online: [] });

    expect((await fulfil(await ask(solo, 'BUY', 1000), { settlementAmount: 950 })).status).toBe(200);
    expect((await fulfil(await ask(solo, 'BUY', 9000), { settlementAmount: 100, settlementCurrency: 'USDT' })).status).toBe(200);
    expect((await fulfil(await ask(solo, 'SELL', 500), { settlementAmount: 480 })).status).toBe(200);

    const t = await db.adminTokenConsiderations.merchantConsiderationTotals(solo.supervisorId);
    // ₹950 + (100 USDT × 90 = ₹9,000) = ₹9,950 in; ₹480 out.
    expect(t.receivedInrPaise).toBe(95000 + 900000);
    expect(t.paidInrPaise).toBe(48000);
    expect(t.netInrPaise).toBe(95000 + 900000 - 48000);
    expect(t.tokensSoldPaise).toBe(T(10000));
    expect(t.tokensBoughtBackPaise).toBe(T(500));
    // The settled figures stay apart, because only apart do they mean anything.
    expect(t.byCurrency.INR.receivedMinor).toBe(95000);
    expect(t.byCurrency.USDT.receivedMinor).toBe(10000);
    expect(t.byCurrency.INR.paidMinor).toBe(48000);
  });

  it('serves those figures to the screen that shows them', async () => {
    // The Merchant Funding analytics card. Platform-wide, so asserted as the
    // DELTA this case caused rather than as a total (trap 10).
    const read = async () => {
      const res = await as(analytics, admin).get('/api/analytics/merchant-funding');
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      return res.body.data.tokenTrade;
    };
    const before = await read();
    expect((await fulfil(await ask(team, 'BUY', 2000), { settlementAmount: 100, settlementCurrency: 'USDT' })).status).toBe(200);
    const after = await read();

    // Rupees, not paise — the panel renders these straight.
    expect(after.receivedInr - before.receivedInr).toBe(9000);
    expect(after.tokensSold - before.tokensSold).toBe(2000);
    expect(after.netInr).toBe(after.receivedInr - after.paidInr);
    expect(after.movements - before.movements).toBe(1);
    // USDT stays USDT on the screen: 100, not 9,000.
    expect((after.byCurrency.USDT?.received ?? 0) - (before.byCurrency.USDT?.received ?? 0)).toBe(100);
  });

  // ── Append-only, because this is what the books reconcile from ───────────

  it('cannot be edited after the fact', async () => {
    const requestId = await ask(team, 'BUY', 100);
    expect((await fulfil(requestId, { settlementAmount: 100 })).status).toBe(200);
    await expect(pgQuery(
      'UPDATE admin_token_considerations SET inr_equivalent_paise = 1 WHERE movement_id = $1',
      [`team_pool_${requestId}`],
    )).rejects.toThrow();
    await expect(pgQuery(
      'DELETE FROM admin_token_considerations WHERE movement_id = $1', [`team_pool_${requestId}`],
    )).rejects.toThrow();
  });
});
