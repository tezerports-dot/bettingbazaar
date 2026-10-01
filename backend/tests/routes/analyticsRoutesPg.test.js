// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The admin analytics ROUTES, against the rows they claim to count.
 *
 * `database/tests/analyticsPg.test.js` proves the repository aggregates. It
 * cannot see the route, which assembles those aggregates into the fields the
 * dashboard reads — and a field wired to the wrong aggregate is invisible below
 * the route. Measured 2026-10-01: `cycles.totalBets`, the figure behind the
 * "Bets Today" tile, counted the house's PHANTOM bets while every money figure
 * left them out.
 *
 * Every assertion is a DELTA (trap 10): take the figures, create known rows,
 * take them again. The database is shared, so the absolute numbers belong to
 * every suite that ever ran; the change belongs to this one.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pgConfigured, applySchema, closePg, pgQuery } from '#db/client.js';
import router from '../../domains/analytics/analytics.admin.routes.js';
import { mountRouter, actor, as } from './_harness.js';

const describePg = pgConfigured() ? describe : describe.skip;
const tag = `an-${Date.now().toString(36)}`;

async function bet({ id, stake, payout = 0, status = 'PENDING', phantom = false }) {
  await pgQuery(
    `INSERT INTO bets (bet_id, user_id, cycle_id, side, stake_paise, payout_paise,
                       status, is_phantom, placed_at, settled_at)
     VALUES ($1, $2, $3, 'DELHI', $4, $5, $6, $7, now(), CASE WHEN $6 = 'WON' THEN now() END)`,
    [`${tag}-${id}`, `${tag}-player`, `${tag}-cycle`, stake, payout, status, phantom],
  );
}

describePg('admin analytics routes', () => {
  let app;
  let analyst;

  beforeAll(async () => {
    await applySchema();
    app = mountRouter(router);
    analyst = await actor({ isSubAdmin: true, permissions: { canViewAnalytics: true } });
  });

  afterAll(async () => {
    await pgQuery('DELETE FROM bets WHERE bet_id LIKE $1', [`${tag}-%`]).catch(() => {});
    await closePg();
  });

  const dashboard = async () => {
    const res = await as(app, analyst).get('/analytics/dashboard');
    expect(res.status).toBe(200);
    return res.body.metrics;
  };
  const financials = async () => {
    const res = await as(app, analyst).get('/analytics/financials');
    expect(res.status).toBe(200);
    return res.body.data;
  };

  it('moves every bet figure by exactly the PLAYER bets placed, and not by a phantom bet', async () => {
    const d0 = await dashboard();
    const f0 = await financials();

    await bet({ id: 'p1', stake: 123_00 });
    await bet({ id: 'p2', stake: 50_00, payout: 95_00, status: 'WON' });
    // The house's liquidity: on the board, never from a wallet, never paid.
    await bet({ id: 'ph', stake: 999_00, phantom: true });

    const d1 = await dashboard();
    const f1 = await financials();

    // Dashboard — all time.
    expect(d1.finance.totalBets - d0.finance.totalBets).toBeCloseTo(173, 2);
    expect(d1.finance.totalPayouts - d0.finance.totalPayouts).toBeCloseTo(95, 2);
    expect(d1.finance.netProfit - d0.finance.netProfit).toBeCloseTo(78, 2);
    expect(d1.cycles.totalBets - d0.cycles.totalBets, 'the bet count includes the phantom bet').toBe(2);
    // Dashboard — today, the figures the KPI row shows.
    expect(d1.finance.today.betCount - d0.finance.today.betCount).toBe(2);
    expect(d1.finance.today.bets - d0.finance.today.bets).toBeCloseTo(173, 2);
    expect(d1.finance.today.payouts - d0.finance.today.payouts).toBeCloseTo(95, 2);
    expect(d1.finance.today.netProfit - d0.finance.today.netProfit).toBeCloseTo(78, 2);

    // Profit & Loss.
    expect(f1.bets.amount - f0.bets.amount).toBeCloseTo(173, 2);
    expect(f1.bets.count - f0.bets.count).toBe(2);
    expect(f1.payouts.amount - f0.payouts.amount).toBeCloseTo(95, 2);
    expect(f1.netProfit - f0.netProfit).toBeCloseTo(78, 2);
    expect(f1.totalRevenue - f0.totalRevenue).toBeCloseTo(173, 2);
    expect(f1.totalExpenses - f0.totalExpenses).toBeCloseTo(95, 2);
  });

  it('refuses a sub-admin who was not given analytics (the opposite case)', async () => {
    const other = await actor({ isSubAdmin: true, permissions: { canManageContent: true } });
    expect((await as(app, other).get('/analytics/dashboard')).status).toBe(403);
    expect((await as(app, other).get('/analytics/financials')).status).toBe(403);
  });
});
