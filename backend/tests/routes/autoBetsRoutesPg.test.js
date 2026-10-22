// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Player auto bets (owner, 2026-10-22), through a real database: the routes
 * that start and stop a plan, and the cycle generator's runner that places
 * one bet per plan per round through the player's own bet admission.
 *
 * Money is asserted on both sides: the stake leaves the wallet when the
 * runner bets, and a win's payout arrives. The step is counted from the
 * plan's bets, so a loss moves the next stake up the ladder and a win
 * starts it again; a repeated tick places nothing twice; a stop is reached
 * before a bet, never after one.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomInt } from 'node:crypto';
import { pgConfigured, applySchema, closePg, pgQuery } from '#db/client.js';
import { ensureCycle } from '#db/repositories/markets.js';
import { listBoards } from '#db/repositories/boards.js';
import { listSettleableBets, loseBet, winBet } from '#db/repositories/bets.core.js';
import * as promo from '#db/repositories/promo.js';
import { getBalances } from '../../domains/wallet/walletAuthority.service.js';
import { fundWallet } from '#db/tests/_funding.js';
import { actor, mountRouter, as } from './_harness.js';
import { linkTelegram } from '../miniAppFixture.js';

const describePg = pgConfigured() ? describe : describe.skip;
const BOARD = '30_MIN';

describePg('player auto bets', () => {
  let app;
  let gen;
  let board;
  const made = [];

  const fundedPlayer = async (rupees, opts = {}) => {
    const p = await actor(opts);
    await linkTelegram(p.userId);
    if (rupees) await fundWallet(p.userId, rupees * 100, `rt-auto-fund-${p.userId}`);
    return p;
  };
  const openRound = async (audience = 'VIP') => {
    const start = new Date(Date.now() - 60_000 - randomInt(0, 50_000_000));
    const { cycle } = await ensureCycle({
      cycleId: `rt-auto-${start.getTime()}-${randomInt(0, 1e6)}`, cycleType: BOARD, audience,
      startTime: start, endTime: new Date(Date.now() + 25 * 60_000),
    });
    made.push(cycle.cycleId);
    return { cycleId: cycle.cycleId, type: BOARD, audience, status: 'OPEN' };
  };
  /** One tick of the runner on one round. */
  const tick = async (round) => {
    const plans = await gen.loadPlayerAutoPlans([round]);
    await gen.runPlayerAutoBets(round, plans);
  };
  /** Settle a round: `winner` wins, everything else loses. */
  const settle = async (round, winner) => {
    for (const b of await listSettleableBets(round.cycleId)) {
      if (b.side === winner) await winBet({ betId: b.betId, userId: b.userId, slices: b.slices, payoutPaise: b.stakePaise * 2 });
      else await loseBet({ betId: b.betId, userId: b.userId, slices: b.slices });
    }
    await pgQuery(`UPDATE cycles SET status = 'CLOSED' WHERE cycle_id = $1 AND status IN ('OPEN','MERGED')`, [round.cycleId]);
  };
  const betsOf = async (planId) => (await pgQuery(
    'SELECT cycle_id, side, stake_paise, status FROM bets WHERE auto_plan_id = $1 ORDER BY placed_at', [planId],
  )).rows.map((r) => ({ ...r, stake: Number(r.stake_paise) / 100 }));
  const spendable = async (userId) => {
    const b = await getBalances(userId);
    return (b.depositBalance || 0) + (b.winningsBalance || 0) + (b.reserveBalance || 0);
  };
  const start = (who, body) => as(app, who).post('/auto').send({ boardKey: BOARD, audience: 'VIP', side: 'DELHI', ...body });

  beforeAll(async () => {
    await applySchema();
    const router = (await import('../../domains/markets/bet.routes.js')).default;
    app = mountRouter(router);
    const CycleGenerator = (await import('../../domains/markets/cycleGenerator.service.js')).default;
    gen = new CycleGenerator(null, null);
    board = (await listBoards()).find((b) => b.key === BOARD);
  }, 60_000);

  afterAll(async () => {
    if (made.length) {
      await pgQuery(`UPDATE cycles SET status = 'CLOSED' WHERE cycle_id = ANY($1) AND status IN ('OPEN','MERGED')`, [made]).catch(() => {});
    }
    await pgQuery(`UPDATE player_auto_bets SET stopped_at = now(), stop_reason = 'PLAYER' WHERE stopped_at IS NULL`).catch(() => {});
    await closePg();
  });

  // The first bet: this board's smallest, on the bet step.
  const first = () => Math.max(10, Math.ceil(board.minBet / 10) * 10);

  describe('starting and stopping a plan', () => {
    it('starts a plan with its ladder worked out, and lists it', async () => {
      const p = await fundedPlayer(10_000);
      const res = await start(p, { start: first(), factor: 2, steps: 3, budget: 5_000, stopLoss: 1_000, takeProfit: 500 });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.plan).toMatchObject({
        running: true, side: 'DELHI', stakes: [first(), first() * 2, first() * 4], budget: 5_000,
        stopLoss: 1_000, takeProfit: 500, step: 0, nextStake: first(), net: 0, played: 0,
      });
      const list = await as(app, p).get('/auto');
      expect(list.body.plans.map((x) => x.planId)).toEqual([res.body.plan.planId]);
      expect(list.body.limits).toMatchObject({ maxSteps: 12, minFactor: 1, maxFactor: 10 });
    });

    it('refuses a second running plan on the same board and profile', async () => {
      const p = await fundedPlayer(10_000);
      expect((await start(p, { start: first(), factor: 2, steps: 2, budget: 1_000 })).status).toBe(200);
      const again = await start(p, { start: first(), factor: 3, steps: 2, budget: 1_000 });
      expect(again.status).toBe(409);
      expect(again.body.code).toBe('AUTO_BETS_RUNNING');
    });

    it('refuses what it could not run, saying why', async () => {
      const p = await fundedPlayer(10_000);
      const tooBig = await start(p, { start: first(), factor: 10, steps: 12, budget: 1_000 });
      expect(tooBig.status).toBe(400);
      expect(tooBig.body.message).toMatch(/above this board's largest bet/);
      const noBudget = await start(p, { start: first(), factor: 2, steps: 2 });
      expect(noBudget.status).toBe(400);
      const short = await start(p, { start: first() * 2, factor: 2, steps: 2, budget: first() });
      expect(short.body.message).toMatch(/budget must cover at least the first bet/);
      const offStep = await start(p, { start: first() + 5, factor: 2, steps: 2, budget: 1_000 });
      expect(offStep.status).toBe(400);
    });

    it('refuses a plan for the profile the player is not playing, and before the rules are accepted', async () => {
      const p = await fundedPlayer(10_000);
      const general = await start(p, { audience: 'GENERAL', start: first(), factor: 2, steps: 2, budget: 1_000 });
      expect(general.status).toBe(409);
      expect(general.body.code).toBe('WRONG_PROFILE_FOR_CYCLE');
      const fresh = await fundedPlayer(10_000, { boardRules: false });
      const res = await start(fresh, { start: first(), factor: 2, steps: 2, budget: 1_000 });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('BOARD_RULES_NOT_ACCEPTED');
    });

    it('stops only for its own player, once, and the database keeps it stopped', async () => {
      const p = await fundedPlayer(10_000);
      const other = await fundedPlayer(0);
      const { planId } = (await start(p, { start: first(), factor: 2, steps: 2, budget: 1_000 })).body.plan;
      const theirs = await as(app, other).post(`/auto/${planId}/stop`).send({});
      expect(theirs.status).toBe(404);
      expect((await as(app, p).get('/auto')).body.plans[0].running).toBe(true);

      const mine = await as(app, p).post(`/auto/${planId}/stop`).send({});
      expect(mine.status).toBe(200);
      expect(mine.body.plan).toMatchObject({ running: false, stopReason: 'PLAYER', stopText: 'You stopped it.' });
      await expect(pgQuery(`UPDATE player_auto_bets SET stop_reason = 'STOP_LOSS' WHERE plan_id = $1`, [planId]))
        .rejects.toThrow(/only ever stopped, once/);
      await expect(pgQuery(`DELETE FROM player_auto_bets WHERE plan_id = $1`, [planId])).rejects.toThrow(/never deleted/);
    });
  });

  describe('the runner', () => {
    it('bets the ladder: up a step after a loss, back to the first after a win, money moved each time', async () => {
      const p = await fundedPlayer(10_000);
      const s = first();
      const { planId } = (await start(p, { start: s, factor: 2, steps: 3, budget: 5_000 })).body.plan;

      const r1 = await openRound();
      const before = await spendable(p.userId);
      await tick(r1);
      await tick(r1); // a repeated tick places nothing twice
      expect((await betsOf(planId)).map((b) => [b.cycle_id, b.side, b.stake, b.status])).toEqual([[r1.cycleId, 'DELHI', s, 'PENDING']]);
      expect(await spendable(p.userId)).toBe(before - s);

      // A second round before the first settles waits for its result.
      const r2 = await openRound();
      await tick(r2);
      expect(await betsOf(planId)).toHaveLength(1);

      await settle(r1, 'BOMBAY'); // lost: next is step 2
      gen.autoBetsTried.clear();
      await tick(r2);
      expect((await betsOf(planId)).map((b) => b.stake)).toEqual([s, s * 2]);

      const beforeWin = await spendable(p.userId);
      await settle(r2, 'DELHI'); // won: payout 2× arrives, next is step 1 again
      expect(await spendable(p.userId)).toBe(beforeWin + s * 2 * 2);
      const r3 = await openRound();
      await tick(r3);
      expect((await betsOf(planId)).map((b) => b.stake)).toEqual([s, s * 2, s]);

      const plan = (await as(app, p).get('/auto')).body.plans.find((x) => x.planId === planId);
      // −s (lost) −2s +4s (won) −s (pending) = 0
      expect(plan).toMatchObject({ played: 2, won: 1, pending: 1, net: 0, step: 0 });
    });

    it('stops before the bet that the stop-loss reaches, and tells why', async () => {
      const p = await fundedPlayer(10_000);
      const s = first();
      const { planId } = (await start(p, { start: s, factor: 1, steps: 5, budget: 5_000, stopLoss: s })).body.plan;
      const r1 = await openRound();
      await tick(r1);
      await settle(r1, 'BOMBAY'); // net = −s: the stop-loss
      const r2 = await openRound();
      await tick(r2);
      expect(await betsOf(planId)).toHaveLength(1);
      const plan = (await as(app, p).get('/auto')).body.plans.find((x) => x.planId === planId);
      expect(plan).toMatchObject({ running: false, stopReason: 'STOP_LOSS', net: -s });
    });

    it('stops when the budget left cannot cover the next stake', async () => {
      const p = await fundedPlayer(10_000);
      const s = first();
      const { planId } = (await start(p, { start: s, factor: 2, steps: 3, budget: s * 2 })).body.plan;
      const r1 = await openRound();
      await tick(r1);
      await settle(r1, 'BOMBAY'); // budget left = s, next stake 2s
      const r2 = await openRound();
      await tick(r2);
      expect(await betsOf(planId)).toHaveLength(1);
      expect((await as(app, p).get('/auto')).body.plans.find((x) => x.planId === planId).stopReason).toBe('BUDGET_USED');
    });

    it('stops when the take-profit is reached', async () => {
      const p = await fundedPlayer(10_000);
      const s = first();
      const { planId } = (await start(p, { start: s, factor: 2, steps: 3, budget: 1_000, takeProfit: s })).body.plan;
      const r1 = await openRound();
      await tick(r1);
      await settle(r1, 'DELHI'); // net = +s
      await tick(await openRound());
      expect((await as(app, p).get('/auto')).body.plans.find((x) => x.planId === planId).stopReason).toBe('TAKE_PROFIT');
    });

    it('is refused for what a tapped bet is refused for: a short balance stops it, with no bet and no money moved', async () => {
      const s = first();
      const p = await fundedPlayer(s - 10 > 0 ? s - 10 : 0);
      const { planId } = (await start(p, { start: s, factor: 2, steps: 2, budget: 1_000 })).body.plan;
      const before = await spendable(p.userId);
      await tick(await openRound());
      expect(await betsOf(planId)).toHaveLength(0);
      expect(await spendable(p.userId)).toBe(before);
      expect((await as(app, p).get('/auto')).body.plans.find((x) => x.planId === planId).stopReason).toBe('BALANCE_SHORT');
    });

    it('a switched profile stops a plan instead of betting the other profile', async () => {
      const p = await fundedPlayer(10_000);
      const { planId } = (await start(p, { start: first(), factor: 2, steps: 2, budget: 1_000 })).body.plan;
      await promo.setPlayProfile(p.userId, 'GENERAL');
      await tick(await openRound('VIP'));
      expect(await betsOf(planId)).toHaveLength(0);
      expect((await as(app, p).get('/auto')).body.plans.find((x) => x.planId === planId).stopReason).toBe('PROFILE_SWITCHED');
    });

    it('a VIP plan never bets a General round, and a blocked player\'s plan bets nothing', async () => {
      const p = await fundedPlayer(10_000);
      const { planId } = (await start(p, { start: first(), factor: 2, steps: 2, budget: 1_000 })).body.plan;
      await tick(await openRound('GENERAL'));
      expect(await betsOf(planId)).toHaveLength(0);
      await pgQuery(`UPDATE users SET is_blocked = TRUE, block_reason = 'test', blocked_at = now() WHERE user_id = $1`, [p.userId]);
      await tick(await openRound('VIP'));
      expect(await betsOf(planId)).toHaveLength(0);
      await pgQuery(`UPDATE users SET is_blocked = FALSE, block_reason = NULL, blocked_at = NULL WHERE user_id = $1`, [p.userId]);
    });

    it('the database refuses a bet naming another player\'s plan', async () => {
      const p = await fundedPlayer(10_000);
      const other = await fundedPlayer(0);
      const { planId } = (await start(p, { start: first(), factor: 2, steps: 2, budget: 1_000 })).body.plan;
      await expect(pgQuery(
        `INSERT INTO bets (bet_id, user_id, cycle_id, side, stake_paise, status, auto_plan_id)
         VALUES ('rt-auto-forged', $1, 'x', 'DELHI', 1000, 'PENDING', $2)`,
        [other.userId, planId],
      )).rejects.toMatchObject({ constraint: 'bets_auto_plan_owner' });
    });
  });
});
