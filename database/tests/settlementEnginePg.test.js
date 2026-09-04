// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file.
/**
 * settlementEnginePg.test.js — the settlement engine, end to end, against a
 * real PostgreSQL.
 *
 * ── Why this suite exists in this shape ─────────────────────────────────────
 * CLAUDE.md: "Do not mock the boundary that carries money. A suite that mocked
 * the settlement writer and asserted on its arguments once reported settlement
 * working while the real function threw on every call."
 *
 * So nothing here is mocked except the socket (`io`), which carries no money.
 * The engine runs against real rows, and every assertion is about what the
 * database holds afterwards — balances, bet statuses, ledger rows, the cycle's
 * recorded totals — not about which functions were called with what.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { pgConfigured, pgQuery, applySchema, closePg } from '../client.js';
import { placeBet, getBet } from '../repositories/bets.core.js';
import { getBalancesPaise, applyDeltaPaise } from '../repositories/wallets.core.js';
import { getCycle } from '../repositories/markets.js';
import { getCycleSettlement } from '../repositories/settlements.js';
import GameEngine from '../../backend/domains/markets/gameEngine.js';

const hasPg = pgConfigured();
const describePg = hasPg ? describe : describe.skip;

/** A socket that records rather than emits. It carries no money. */
function fakeIo() {
  const emitted = [];
  const io = {
    emit: (event, payload) => emitted.push({ room: null, event, payload }),
    to: (room) => ({ emit: (event, payload) => emitted.push({ room, event, payload }) }),
  };
  return { io, emitted };
}

/**
 * An engine with its timers stopped.
 *
 * The constructor starts a 1s tick and a 5m recovery sweep. Left running they
 * would settle cycles out from under the assertions and keep the process alive
 * after the suite finished.
 */
function engineFor(io) {
  const engine = new GameEngine(io);
  engine.stop();
  return engine;
}

const fund = (userId, field, paise, key) =>
  applyDeltaPaise({ userId, field, deltaPaise: paise, txId: key, type: 'CREDIT', reason: 'test funding' });

const declareCycle = (cycleId, winner, { endedMinutesAgo = 5 } = {}) => pgQuery(
  `INSERT INTO cycles (cycle_id, cycle_type, status, winner, winner_determined_at,
                       start_time, end_time)
   VALUES ($1, '30_MIN', 'RESULT_DECLARED', $2, now(),
           now() - ($3 || ' minutes')::interval - interval '30 minutes',
           now() - ($3 || ' minutes')::interval)`,
  [cycleId, winner, String(endedMinutesAgo)],
);

const bet = (betId, userId, cycleId, side, stakePaise, field = 'depositBalance') =>
  placeBet({
    betId, userId, cycleId, side,
    slices: [{ field, amountPaise: stakePaise }],
  });

describePg('the settlement engine', () => {
  beforeAll(async () => { await applySchema(); });
  afterAll(async () => { await closePg(); });
  beforeEach(async () => {
    await pgQuery(`TRUNCATE bets, bet_transitions, wallet_ledger, wallets, cycles,
                            cycle_settlements, accounting_events
                   RESTART IDENTITY CASCADE`);
    vi.restoreAllMocks();
  });

  // ── The whole pass ────────────────────────────────────────────────────────
  it('pays the winners, consumes the losers, and settles the cycle', async () => {
    await fund('w1', 'depositBalance', 100_00, 'f-w1');
    await fund('l1', 'depositBalance', 100_00, 'f-l1');
    await declareCycle('c-happy', 'DELHI');
    await bet('b-win',  'w1', 'c-happy', 'DELHI',  100_00);
    await bet('b-lose', 'l1', 'c-happy', 'BOMBAY', 100_00);

    const { io } = fakeIo();
    await engineFor(io).tick();

    // The winner: stake consumed out of locked, payout credited to winnings.
    // Default rules are 2x with no fee unless the platform sets one, so the
    // assertion is on the RELATIONSHIP rather than a hardcoded number — the
    // fee is admin-editable and a literal here would encode today's setting.
    const winner = await getBet('b-win');
    expect(winner.status).toBe('WON');
    expect(winner.payoutPaise).toBeGreaterThan(0);

    const wBal = await getBalancesPaise('w1');
    expect(wBal.lockedBalance).toBe(0);
    expect(wBal.winningsBalance).toBe(winner.payoutPaise);
    expect(wBal.depositBalance).toBe(0);      // staked, and the stake is consumed

    // The loser: stake consumed, nothing credited, nothing left locked.
    expect((await getBet('b-lose')).status).toBe('LOST');
    const lBal = await getBalancesPaise('l1');
    expect(lBal.lockedBalance).toBe(0);
    expect(lBal.winningsBalance).toBe(0);
    expect(lBal.depositBalance).toBe(0);

    // The cycle records what it paid, and the run is closed.
    const cycle = await getCycle('c-happy');
    expect(cycle.isSettled).toBe(true);
    expect(cycle.settledAt).toBeInstanceOf(Date);
    expect(cycle.totalPaidOut).toBeCloseTo(winner.payoutPaise / 100, 2);
    expect((await getCycleSettlement('c-happy')).status).toBe('COMPLETED');
  });

  it('records net profit as the real pool minus what it paid', async () => {
    await fund('w1', 'depositBalance', 100_00, 'f-w1');
    await fund('l1', 'depositBalance', 300_00, 'f-l1');
    await declareCycle('c-profit', 'DELHI');
    await bet('b-win',  'w1', 'c-profit', 'DELHI',  100_00);
    await bet('b-lose', 'l1', 'c-profit', 'BOMBAY', 300_00);

    await engineFor(fakeIo().io).tick();

    const cycle = await getCycle('c-profit');
    // The pool is DERIVED from the bets — never read off the cycle row, which
    // is trap 4. 400 staked, the winner paid ~200, so the house keeps ~200.
    expect(cycle.netProfit).toBeCloseTo(400 - cycle.totalPaidOut, 2);
    expect(cycle.netProfit).toBeGreaterThan(0);
  });

  // ── Trap 3: no result, no settlement ──────────────────────────────────────
  it('will not settle a cycle that has no result', async () => {
    await fund('u1', 'depositBalance', 100_00, 'f1');
    await pgQuery(
      `INSERT INTO cycles (cycle_id, cycle_type, status, start_time, end_time)
       VALUES ('c-undeclared', '30_MIN', 'CLOSED',
               now() - interval '35 minutes', now() - interval '5 minutes')`, [],
    );
    await bet('b1', 'u1', 'c-undeclared', 'DELHI', 100_00);

    await engineFor(fakeIo().io).tick();

    // A cycle with no winner must never be offered for settlement, whatever
    // its status column says — the stake stays locked and nothing is paid.
    expect((await getBet('b1')).status).toBe('PENDING');
    expect((await getCycle('c-undeclared')).isSettled).toBe(false);
    expect((await getBalancesPaise('u1')).lockedBalance).toBe(100_00);
  });

  it('will not settle a cycle whose betting window is still open', async () => {
    await pgQuery(
      `INSERT INTO cycles (cycle_id, cycle_type, status, winner, start_time, end_time)
       VALUES ('c-future', '30_MIN', 'RESULT_DECLARED', 'DELHI',
               now(), now() + interval '30 minutes')`, [],
    );
    await engineFor(fakeIo().io).tick();
    expect((await getCycle('c-future')).isSettled).toBe(false);
  });

  // ── Trap 6: totals from rows, not accumulators ────────────────────────────
  it('reports what the CYCLE paid, not what this pass paid', async () => {
    await fund('w1', 'depositBalance', 200_00, 'f-w1');
    await declareCycle('c-resume', 'DELHI');
    await bet('b-1', 'w1', 'c-resume', 'DELHI', 100_00);
    await bet('b-2', 'w1', 'c-resume', 'DELHI', 100_00);

    // Simulate a pass that died after settling one bet: settle b-1 directly,
    // then let the engine finish. Its in-memory accumulator will only ever see
    // b-2, so a cycle total taken from it would report HALF what was paid —
    // permanently wrong, with the money itself correct and no way afterwards
    // to tell which number lied.
    const { winBet } = await import('../repositories/bets.core.js');
    await winBet({
      betId: 'b-1', userId: 'w1',
      slices: [{ field: 'depositBalance', amountPaise: 100_00 }],
      payoutPaise: 200_00, actor: 'test',
    });

    await engineFor(fakeIo().io).tick();

    const cycle = await getCycle('c-resume');
    const b2 = await getBet('b-2');
    // Both bets' payouts, summed from the rows.
    expect(cycle.totalPaidOut).toBeCloseTo((200_00 + b2.payoutPaise) / 100, 2);
  });

  // ── The claim ─────────────────────────────────────────────────────────────
  it('lets only one worker settle a cycle', async () => {
    await fund('w1', 'depositBalance', 100_00, 'f-w1');
    await declareCycle('c-race', 'DELHI');
    await bet('b1', 'w1', 'c-race', 'DELHI', 100_00);

    // Two ticks at once. The claim is a guarded UPDATE, so exactly one of them
    // gets the cycle; the other finds nothing claimable and does nothing.
    await Promise.all([
      engineFor(fakeIo().io).tick(),
      engineFor(fakeIo().io).tick(),
    ]);

    const winner = await getBet('b1');
    expect(winner.status).toBe('WON');
    // Paid ONCE. A second payout would show up here as double the credit.
    expect((await getBalancesPaise('w1')).winningsBalance).toBe(winner.payoutPaise);

    const { rows } = await pgQuery(
      `SELECT COUNT(*)::int AS n FROM wallet_ledger
        WHERE ref_id = 'b1' AND tx_id LIKE '%payout%'`, [],
    );
    expect(rows[0].n).toBe(1);
  });

  it('is idempotent: a second pass over a settled cycle pays nothing more', async () => {
    await fund('w1', 'depositBalance', 100_00, 'f-w1');
    await declareCycle('c-twice', 'DELHI');
    await bet('b1', 'w1', 'c-twice', 'DELHI', 100_00);

    const engine = engineFor(fakeIo().io);
    await engine.tick();
    const after = await getBalancesPaise('w1');

    // The cycle is settled now, so claimSettleable will not offer it again —
    // but force the pass anyway to prove the guards below it hold too.
    await engine.settleCycle(await getCycle('c-twice'));
    expect(await getBalancesPaise('w1')).toEqual(after);
  });

  // ── Phantom bets ──────────────────────────────────────────────────────────
  it('closes phantom bets without moving money for them', async () => {
    await fund('w1', 'depositBalance', 100_00, 'f-w1');
    await declareCycle('c-phantom', 'DELHI');
    await bet('b-real', 'w1', 'c-phantom', 'DELHI', 100_00);
    await pgQuery(
      `INSERT INTO bets (bet_id, user_id, cycle_id, side, stake_paise, status, is_phantom)
       VALUES ('b-ph','house','c-phantom','DELHI',900_00,'PENDING',TRUE)`, [],
    );

    await engineFor(fakeIo().io).tick();

    // Stamped, so the history does not leave synthetic bets at PENDING — but
    // it moved no money, because it never had a stake to consume.
    expect((await getBet('b-ph')).status).toBe('LOST');
    const { rows } = await pgQuery(
      "SELECT COUNT(*)::int AS n FROM wallet_ledger WHERE ref_id = 'b-ph'", [],
    );
    expect(rows[0].n).toBe(0);

    // And it stays out of the pool the profit is computed from.
    const cycle = await getCycle('c-phantom');
    expect(cycle.netProfit).toBeCloseTo(100 - cycle.totalPaidOut, 2);
  });

  // ── Refusals ──────────────────────────────────────────────────────────────
  it('settles what it can and leaves a bet with no funding record alone', async () => {
    await fund('w1', 'depositBalance', 100_00, 'f-w1');
    await declareCycle('c-refuse', 'DELHI');
    await bet('b-good', 'w1', 'c-refuse', 'DELHI', 100_00);
    // A bet with no placement ledger: its funding split cannot be
    // reconstructed, so settling it would have to GUESS which pocket to return
    // the stake to. It is refused and left for a human.
    await pgQuery(
      `INSERT INTO bets (bet_id, user_id, cycle_id, side, stake_paise, status)
       VALUES ('b-orphan','w2','c-refuse','DELHI',50_00,'PENDING')`, [],
    );

    await engineFor(fakeIo().io).tick();

    expect((await getBet('b-good')).status).toBe('WON');
    // Refused, not silently skipped and not guessed at.
    expect((await getBet('b-orphan')).status).toBe('PENDING');
    // The pass still completed for the bets it could settle: failing the whole
    // cycle would strand the ones that succeeded alongside the one that did not.
    expect((await getCycle('c-refuse')).isSettled).toBe(true);
  });

  // ── The realtime notification ─────────────────────────────────────────────
  it('tells each winner the balance they actually have', async () => {
    await fund('w1', 'depositBalance', 100_00, 'f-w1');
    await declareCycle('c-emit', 'DELHI');
    await bet('b1', 'w1', 'c-emit', 'DELHI', 100_00);

    const { io, emitted } = fakeIo();
    await engineFor(io).tick();

    const complete = emitted.find((e) => e.event === 'payout_complete');
    expect(complete).toBeDefined();
    expect(complete.payload.cycleId).toBe('c-emit');
    expect(complete.payload.winners).toBe(1);
    // The figure broadcast is the one the cycle recorded, so the admin
    // dashboard and the cycle row cannot disagree.
    expect(complete.payload.totalPaidOut).toBeCloseTo((await getCycle('c-emit')).totalPaidOut, 2);
  });

  // ── The game state a client renders ───────────────────────────────────────
  it('derives the live cycle pools from the bets', async () => {
    await fund('u1', 'depositBalance', 300_00, 'f1');
    await pgQuery(
      `INSERT INTO cycles (cycle_id, cycle_type, status, start_time, end_time,
                           phantom_delhi_paise, phantom_bombay_paise)
       VALUES ('c-live', '30_MIN', 'OPEN',
               now(), now() + interval '30 minutes', 500_00, 400_00)`, [],
    );
    await bet('b1', 'u1', 'c-live', 'DELHI',  200_00);
    await bet('b2', 'u1', 'c-live', 'BOMBAY', 100_00);

    const state = await engineFor(fakeIo().io).getGameState();

    // Real halves from the bets, phantom halves off the row — trap 4. The
    // version this replaced read `realDelhi` as a document field; it is not a
    // column, so every figure fell through to `|| 0` and a live cycle showed
    // no real volume at all.
    expect(state.realDelhiPool).toBe(200);
    expect(state.realBombayPool).toBe(100);
    // Display pools include phantom, so the client sees the balanced view.
    expect(state.delhiPool).toBe(700);
    expect(state.bombayPool).toBe(500);
    expect(state.totalPool).toBe(1200);
  });

  it('says so plainly when there is no live cycle', async () => {
    const state = await engineFor(fakeIo().io).getGameState();
    expect(state.status).toBe('NO_ACTIVE_CYCLE');
  });
});
