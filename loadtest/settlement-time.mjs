// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * loadtest/settlement-time.mjs — how long ONE round takes to settle.
 *
 * WHY THIS EXISTS (owner, 2026-10-10; DECISION_LOG "The player app opens no
 * socket … Ledger writes are NOT moved to a queue")
 *
 * Settlement does not burst thousands of writes at once: the engine settles
 * one cycle at a time, in sequence (gameEngine.js), the losing side a page
 * per transaction and the winning side a bet per transaction, and every
 * settlement locks the house-reserve row. So the risk at scale is not
 * contention, it is DURATION: a 1-minute board whose round takes longer than a
 * minute to settle falls further behind every round. This measures that
 * duration on the real engine and the real money path, nothing mocked but the
 * socket, and says whether it fits inside the round.
 *
 *   DATABASE_URL=postgresql://…/bb_load node loadtest/settlement-time.mjs \
 *     --bets 10000 --players 10000 --round-seconds 60
 *
 * It TRUNCATES the betting, wallet, ledger and treasury tables, so it refuses
 * any database whose URL does not name bb_load (the same guard as scale.mjs).
 * The figure is for THIS machine and THIS PostgreSQL; quote it with both.
 */
import { performance } from 'node:perf_hooks';
import { pgQuery, applySchema, closePg } from '#db/client.js';
import { placeBet } from '#db/repositories/bets.core.js';
import { applyDeltaPaise } from '#db/repositories/wallets.core.js';
import { TEST_FUNDING } from '../database/tests/_funding.js';
import GameEngine from '../backend/domains/markets/gameEngine.js';

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d;
};
const BETS = Number(arg('bets', 10000));
const PLAYERS = Math.min(Number(arg('players', BETS)), BETS);
const ROUND_SECONDS = Number(arg('round-seconds', 60));
const SETUP_CONCURRENCY = Number(arg('setup-concurrency', 16));
const STAKE_PAISE = 100_00;

const DB = process.env.DATABASE_URL || '';
if (!/bb_load/.test(DB)) {
  console.error(`Refusing to run against ${DB || '(no DATABASE_URL)'} — this harness truncates`);
  console.error('the betting, wallet, ledger and treasury tables. Point it at bb_load.');
  process.exit(1);
}

/** Run `fn` over 0..n-1 with at most `k` in flight (setup only — never the measurement). */
async function pool(n, k, fn) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(k, n) }, async () => {
    while (next < n) { const i = next++; await fn(i); }
  }));
}

async function main() {
  await applySchema();
  await pgQuery(`TRUNCATE bets, bet_transitions, wallet_ledger, wallets, cycles,
                          cycle_settlements, accounting_events,
                          treasury_entries, treasury_accounts RESTART IDENTITY CASCADE`);

  const cycleId = `load-settle-${Date.now().toString(36)}`;
  await pgQuery(
    `INSERT INTO cycles (cycle_id, cycle_type, status, winner, winner_determined_at, start_time, end_time)
     VALUES ($1, '30_MIN', 'RESULT_DECLARED', 'DELHI', now(), now() - interval '35 minutes', now() - interval '5 minutes')`,
    [cycleId],
  );

  console.log(`Setting up ${BETS.toLocaleString('en-IN')} bets from ${PLAYERS.toLocaleString('en-IN')} players …`);
  const perPlayer = Math.ceil(BETS / PLAYERS);
  const t0 = performance.now();
  await pool(PLAYERS, SETUP_CONCURRENCY, (p) => applyDeltaPaise({
    userId: `lp${p}`, field: 'depositBalance', deltaPaise: STAKE_PAISE * perPlayer,
    txId: `lf-${cycleId}-${p}`, type: 'CREDIT', reason: 'settlement load funding', counterparty: TEST_FUNDING,
  }));
  // Every player bets on ONE side: the engine's rule refuses no second side
  // here, and a one-sided player is the common case.
  await pool(BETS, SETUP_CONCURRENCY, async (b) => {
    const p = b % PLAYERS;
    const r = await placeBet({
      betId: `lb-${cycleId}-${b}`, userId: `lp${p}`, cycleId, side: p % 2 ? 'BOMBAY' : 'DELHI',
      slices: [{ field: 'depositBalance', amountPaise: STAKE_PAISE }],
    });
    if (!r?.ok) throw new Error(`bet ${b} refused: ${r?.reason}`);
  });
  console.log(`  setup ${((performance.now() - t0) / 1000).toFixed(1)}s (not measured)\n`);

  // The measurement: the real engine, one tick, the whole cycle.
  const engine = new GameEngine({ emit() {}, to: () => ({ emit() {} }) });
  engine.stop();
  const s0 = performance.now();
  await engine.tick();
  const seconds = (performance.now() - s0) / 1000;

  const { rows: [left] } = await pgQuery(
    `SELECT count(*) FILTER (WHERE status = 'PENDING')::int AS pending,
            count(*) FILTER (WHERE status IN ('WON','LOST'))::int AS settled
       FROM bets WHERE cycle_id = $1`, [cycleId]);

  console.log(`Settled ${left.settled.toLocaleString('en-IN')} bets in ${seconds.toFixed(1)}s`
    + ` (${((seconds * 1000) / Math.max(1, left.settled)).toFixed(2)} ms per bet); ${left.pending} still PENDING.`);
  const fits = seconds < ROUND_SECONDS && left.pending === 0;
  console.log(fits
    ? `FITS: inside a ${ROUND_SECONDS}s round with ${(ROUND_SECONDS - seconds).toFixed(1)}s to spare.`
    : `DOES NOT FIT a ${ROUND_SECONDS}s round: settlement would fall behind every round at this volume.`);
  await closePg();
  process.exit(fits ? 0 : 2);
}

main().catch(async (e) => { console.error(e); await closePg().catch(() => {}); process.exit(1); });
