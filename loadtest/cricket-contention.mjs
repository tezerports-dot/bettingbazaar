// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * loadtest/cricket-contention.mjs — many players, and bots firing as fast as
 * they can, on ONE cricket poll at once (owner, 2026-10-18: "will our system
 * be safe from double spend or misuse by millisecond bots?").
 *
 * It runs the real repository writers (`placeBet`, `claimPositions`) against a
 * real PostgreSQL, the same calls the routes make once their in-play delay has
 * passed, so it measures the poll lock and the wallet lock, not HTTP. Three
 * waves, all concurrent:
 *
 *   crowd    PLAYERS players, each BETS bets on random options and stakes
 *   bot      one player firing BOT_BETS bets in the same instant, more than
 *            their wallet covers; another pressing one bet id BOT_DUPES times
 *   claimers every crowd player pressing Claim all at once, twice each
 *
 * Then it asks the rows, not the counters it kept:
 *   - every option's book ≥ −seed × options (the house's worst case);
 *   - the poll's stakes = the sum of its bets' stakes, claims paid = the sum of
 *     what claimed bets were paid (nothing counted twice);
 *   - the bot's wallet never went below zero and paid for exactly the bets it
 *     has; a repeated bet id made one bet;
 *   - no bet was claimed twice.
 * Token conservation itself is the database's, checked at every COMMIT.
 *
 * It prints p50/p95/max per operation and the throughput. On a shared 4-core
 * container the client and the server compete for the same cores, so read the
 * latencies as a floor for lock contention, not a capacity figure (§29).
 *
 *   DATABASE_URL=postgresql://…/bb_test node loadtest/cricket-contention.mjs
 *   PLAYERS=300 BETS=5 node loadtest/cricket-contention.mjs
 */
import { performance } from 'node:perf_hooks';
import { pgQuery, applySchema, closePg } from '#db/client.js';
import * as cricket from '#db/repositories/cricket.js';
import { fundWallet } from '../database/tests/_funding.js';
import { optionsFor, pollIdFor, POLL_KINDS } from '../backend/domains/cricket/cricketPolls.js';

const db = new URL(process.env.DATABASE_URL || 'postgresql://localhost/none').pathname.slice(1);
if (!/^bb_(test|load|drive)/.test(db)) {
  console.error(`Refusing to run against database "${db}": use a bb_test or bb_load database.`);
  process.exit(1);
}

const PLAYERS = Number(process.env.PLAYERS || 200);
const BETS = Number(process.env.BETS || 5);
const BOT_BETS = Number(process.env.BOT_BETS || 100);
const BOT_DUPES = Number(process.env.BOT_DUPES || 20);
const RUN = Math.random().toString(36).slice(2, 8);
const FEE_BP = 100;
const MARGIN_BP = 500;

const timings = {};
async function timed(kind, fn) {
  const t = performance.now();
  try { return await fn(); } finally { (timings[kind] ??= []).push(performance.now() - t); }
}
const pct = (xs, p) => xs.slice().sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))];
const pick = (xs) => xs[Math.floor(Math.random() * xs.length)];
const failures = [];
const expectThat = (ok, what) => { if (!ok) failures.push(what); console.log(`${ok ? '  ✓' : '  ✗'} ${what}`); };

async function main() {
  await applySchema();
  const feedId = `load${RUN}`;
  await cricket.upsertFixtures([{
    feedId, seriesId: null, seriesName: 'Load', format: 'T20', teamA: { id: '1', name: 'Alpha' }, teamB: { id: '2', name: 'Bravo' },
    venue: null, startsAt: new Date(Date.now() + 3600_000).toISOString(),
  }]);
  const matchId = cricket.matchIdFor(feedId);
  await cricket.publishMatch(matchId, 'loadtest');
  const m = await cricket.getMatch(matchId);
  const pollId = pollIdFor(matchId, POLL_KINDS.MATCH_RESULT, {});
  const options = optionsFor(POLL_KINDS.MATCH_RESULT, m);
  await cricket.openPoll({ pollId, matchId, kind: POLL_KINDS.MATCH_RESULT, title: 'Match result', spreadBp: 1000, seedPaise: 50_000, options });
  const keys = options.map((o) => o.key);

  const players = Array.from({ length: PLAYERS }, (_, i) => `load-crk-${RUN}-${i}`);
  const bot = `load-crk-${RUN}-bot`;
  const twin = `load-crk-${RUN}-twin`; // presses one bet id many times
  for (const u of players) await fundWallet(u, 1_000_000, `load-crk-fund-${u}`);
  await fundWallet(bot, 100_000, `load-crk-fund-${bot}`); // ₹1,000: covers 10 bets of ₹100, not 100
  await fundWallet(twin, 100_000, `load-crk-fund-${twin}`);

  let seq = 0;
  const place = (userId, stakePaise, betId = `lc-${RUN}-${++seq}`) => timed('bet', () => cricket.placeBet({
    betId, userId, pollId, optionKey: pick(keys), stakePaise, minOddsX100: 101,
    requestedAt: new Date().toISOString(), reserveBp: 0,
  }));

  console.log(`cricket contention: ${PLAYERS} players × ${BETS} bets, a bot firing ${BOT_BETS} + ${BOT_DUPES} duplicates, then Claim all ×2 each`);
  const t0 = performance.now();
  const dupeId = `lc-${RUN}-dupe`;
  const results = await Promise.all([
    ...players.flatMap((u) => Array.from({ length: BETS }, () => place(u, (1 + Math.floor(Math.random() * 20)) * 1000))),
    ...Array.from({ length: BOT_BETS }, () => place(bot, 10_000)),
    ...Array.from({ length: BOT_DUPES }, () => place(twin, 10_000, dupeId)),
  ]);
  const betSecs = (performance.now() - t0) / 1000;
  const placed = results.filter((r) => r.ok).length;

  // Hold passed for everyone: press Claim all twice per player, all at once.
  const later = new Date(Date.now() + 5000).toISOString();
  const t1 = performance.now();
  const claims = await Promise.all(players.flatMap((u) => [0, 1].map(() => timed('claim', () => cricket.claimPositions({
    userId: u, matchId, minTotalNetPaise: 0, requestedAt: later, holdSec: 2, claimMarginBp: MARGIN_BP, feeBp: FEE_BP,
  })))));
  const claimSecs = (performance.now() - t1) / 1000;

  console.log(`\n  bets: ${results.length} pressed, ${placed} placed in ${betSecs.toFixed(1)} s (${(results.length / betSecs).toFixed(0)}/s)`);
  console.log(`  claims: ${claims.length} pressed, ${claims.filter((c) => c.ok).length} paid in ${claimSecs.toFixed(1)} s`);
  for (const [k, xs] of Object.entries(timings)) {
    console.log(`  ${k.padEnd(6)} p50 ${pct(xs, 0.5).toFixed(0)} ms · p95 ${pct(xs, 0.95).toFixed(0)} ms · max ${Math.max(...xs).toFixed(0)} ms`);
  }
  const reasons = {};
  for (const r of [...results, ...claims]) if (!r.ok) reasons[r.reason] = (reasons[r.reason] ?? 0) + 1;
  console.log(`  refusals: ${JSON.stringify(reasons)}\n`);

  // ── Ask the rows ───────────────────────────────────────────────────────────
  const { rows: [p] } = await pgQuery('SELECT * FROM cricket_polls WHERE poll_id = $1', [pollId]);
  const { rows: opts } = await pgQuery('SELECT * FROM cricket_poll_options WHERE poll_id = $1', [pollId]);
  const { rows: [sums] } = await pgQuery(
    `SELECT COALESCE(SUM(stake_paise), 0) AS stakes,
            COALESCE(SUM(paid_paise) FILTER (WHERE status = 'CLAIMED'), 0) AS claimed,
            COUNT(*) FILTER (WHERE status = 'OPEN') AS open
       FROM cricket_bets WHERE poll_id = $1`, [pollId]);
  const net = Number(p.stakes_paise) - Number(p.claims_paid_paise);
  const worst = Math.min(...opts.map((o) => net - Number(o.liability_paise)));
  const bound = -Number(p.seed_paise) * Number(p.option_count);
  expectThat(worst >= bound, `house worst case ${worst} ≥ bound ${bound} (−seed × options)`);
  expectThat(Number(p.stakes_paise) === Number(sums.stakes), `poll stakes ${p.stakes_paise} = sum of its bets ${sums.stakes}`);
  expectThat(Number(p.claims_paid_paise) === Number(sums.claimed), `claims paid ${p.claims_paid_paise} = sum paid to claimed bets ${sums.claimed}`);
  const openPools = opts.reduce((t, o) => t + Number(o.pool_paise), 0);
  const { rows: [openSum] } = await pgQuery(`SELECT COALESCE(SUM(stake_paise), 0) AS s FROM cricket_bets WHERE poll_id = $1 AND status = 'OPEN'`, [pollId]);
  expectThat(openPools === Number(openSum.s), `option pools ${openPools} = open stakes ${openSum.s}`);

  const { rows: botBets } = await pgQuery(`SELECT bet_id FROM cricket_bets WHERE user_id = $1`, [bot]);
  const { rows: [botWallet] } = await pgQuery(`SELECT deposit_paise, winnings_paise, reserve_paise FROM wallets WHERE user_id = $1`, [bot]);
  const botLeft = Number(botWallet.deposit_paise) + Number(botWallet.winnings_paise) + Number(botWallet.reserve_paise);
  expectThat(botLeft >= 0 && botLeft + botBets.length * 10_000 === 100_000, `bot paid for exactly its ${botBets.length} bets (₹${botLeft / 100} left of ₹1,000)`);
  const { rows: twinBets } = await pgQuery(`SELECT bet_id FROM cricket_bets WHERE user_id = $1`, [twin]);
  const { rows: [tw] } = await pgQuery(`SELECT deposit_paise + winnings_paise + reserve_paise AS left FROM wallets WHERE user_id = $1`, [twin]);
  expectThat(twinBets.length === 1 && Number(tw.left) === 90_000, `${BOT_DUPES} presses of one bet id made one bet and took ₹100 once (₹${Number(tw.left) / 100} left)`);
  const { rows: [credited] } = await pgQuery(
    `SELECT COALESCE(SUM(amount_paise), 0) AS paid FROM wallet_ledger WHERE tx_id LIKE $1`, [`cricket_claim_lc-${RUN}-%`]);
  expectThat(Number(credited.paid) === Number(p.claims_paid_paise), `wallets were credited ${credited.paid} for claims, exactly what the poll paid (no claim paid twice)`);

  await closePg();
  if (failures.length) { console.error(`\n${failures.length} invariant(s) broken.`); process.exit(1); }
  console.log('\nEvery invariant held.');
}

main().catch(async (e) => { console.error(e); await closePg().catch(() => {}); process.exit(1); });
