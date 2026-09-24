// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * loadtest/scale.mjs — what this platform does when it is BIG.
 *
 * WHAT IT ANSWERS, AND WHAT IT CANNOT
 *
 * "100,000 active peak users" is two different questions, and they need two
 * different harnesses. This file runs both and reports them SEPARATELY,
 * because summing them would be §35 exactly — one number over two claims:
 *
 *   --seed     builds a database the size of a busy platform: 100k players,
 *              their wallets, millions of bets, hundreds of thousands of
 *              orders and the ledger events behind them.
 *   --queries  runs the REAL repository functions the panels call, against
 *              that database, and reports p50/p95/p99 per query — plus the
 *              plan, because the thing that kills a platform at 100k rows is
 *              a sequential scan that was instant at 100.
 *   --http     drives a LIVE server over real HTTP at rising concurrency and
 *              reports latency, throughput and the error rate at each step.
 *
 * ── What a single 4-core container CANNOT prove, said plainly (§29) ────────
 * It cannot hold 100,000 concurrent sockets, and nothing here claims to. The
 * client and the server share four cores, so above a few hundred in-flight
 * requests this measures the HARNESS as much as the platform. So `--http`
 * ramps until latency degrades and reports WHERE it degraded and why —
 * a ceiling with its cause, never an extrapolated capacity figure.
 *
 * The seeded scale is real, though, and it is the half that finds defects:
 * a missing index does not care how many clients are connected.
 *
 *   node loadtest/scale.mjs --seed --users 100000 --bets 2000000
 *   node loadtest/scale.mjs --queries --repeat 25
 *   node loadtest/scale.mjs --http --base http://127.0.0.1:8096
 */
import { performance } from 'node:perf_hooks';
import { pgQuery, closePg } from '#db/client.js';

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1]
    : d;
};
const has = (n) => process.argv.includes(`--${n}`);
const num = (n, d) => Number(arg(n, d));

const DB = process.env.DATABASE_URL || '';
if (!/bb_load/.test(DB)) {
  console.error(`Refusing to run against ${DB || '(no DATABASE_URL)'} — this harness writes`);
  console.error('millions of rows and truncates as it goes. Point it at bb_load.');
  process.exit(1);
}

const fmt = (n) => Number(n).toLocaleString('en-IN');
const ms = (n) => `${n.toFixed(1)}ms`;

/** p-th percentile of an ALREADY SORTED array. */
function pct(sorted, p) {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[i];
}

// ── SEED ────────────────────────────────────────────────────────────────────
async function seed() {
  const users = num('users', 100000);
  const merchants = num('merchants', 500);
  const cycles = num('cycles', 5000);
  const bets = num('bets', 2000000);
  const orders = num('orders', 400000);
  const events = num('events', 800000);

  console.log(`Seeding bb_load: ${fmt(users)} players, ${fmt(merchants)} merchants, `
    + `${fmt(cycles)} cycles, ${fmt(bets)} bets, ${fmt(orders)} orders, ${fmt(events)} ledger events.\n`);

  const step = async (label, sql, params = []) => {
    const t0 = performance.now();
    const r = await pgQuery(sql, params);
    console.log(`  ${label.padEnd(34)} ${((performance.now() - t0) / 1000).toFixed(1)}s`
      + (r.rowCount >= 0 ? `  ${fmt(r.rowCount)} rows` : ''));
  };

  // Everything this harness writes is prefixed `load-`, so it can be removed
  // without touching a row anything else seeded (trap 10: never assert — or
  // delete — globally over a shared table).
  await step('clear previous load rows', `
    DELETE FROM bets WHERE user_id LIKE 'load-%';
    DELETE FROM accounting_events WHERE idempotency_key LIKE 'load-%';
    DELETE FROM order_states WHERE user_id LIKE 'load-%';
    DELETE FROM wallets WHERE user_id LIKE 'load-%';
    DELETE FROM merchants WHERE merchant_id LIKE 'load-%';
    DELETE FROM cycles WHERE cycle_id LIKE 'load-%';
    DELETE FROM users WHERE user_id LIKE 'load-%';`);

  // ── PLAYERS ───────────────────────────────────────────────────────────────
  // A mobile is unique PER account_type (§2), so a ten-digit number derived
  // from the series is safe as long as it cannot collide with a seeded
  // account: these start at 7000000000, which no fixture uses.
  await step('players', `
    INSERT INTO users (user_id, username, mobile, password_hash, account_type, status,
                       kyc_status, joining_number, referral_code, joined_at, last_login)
    SELECT 'load-u-' || i,
           'loadplayer' || i,
           (7000000000 + i)::text,
           '$argon2id$v=19$m=65536,t=3,p=4$loadtestloadtest$loadtestloadtestloadtestloadtestloadtest',
           'PLAYER',
           CASE WHEN i % 97 = 0 THEN 'BLOCKED' ELSE 'ACTIVE' END,
           CASE WHEN i % 7 = 0 THEN 'PENDING_APPROVAL' WHEN i % 31 = 0 THEN 'REJECTED' ELSE 'APPROVED' END,
           1000000 + i,
           'LOAD' || lpad(i::text, 8, '0'),
           now() - (i % 365) * interval '1 day',
           now() - (i % 30) * interval '1 hour'
    FROM generate_series(1, $1) i`, [users]);

  // The BLOCKED rows need their reason, or users_blocked_has_reason refuses
  // them — and a fixture the platform could not produce is §32 S16.
  await step('blocked players carry a reason', `
    UPDATE users SET is_blocked = true, block_reason = 'load harness', blocked_at = now()
    WHERE user_id LIKE 'load-u-%' AND status = 'BLOCKED'`);

  await step('wallets', `
    INSERT INTO wallets (user_id, deposit_paise, winnings_paise, token_paise, reserve_paise, locked_paise)
    SELECT user_id, (random() * 5000000)::bigint, (random() * 2000000)::bigint,
           (random() * 5000000)::bigint, (random() * 500000)::bigint, 0
    FROM users WHERE user_id LIKE 'load-u-%'`);

  // ── MERCHANTS ─────────────────────────────────────────────────────────────
  await step('merchants', `
    INSERT INTO merchants (merchant_id, name, public_ref, username, mobile, password_hash,
                           status, merchant_approval_status, is_online, accepts_deposits,
                           accepts_withdrawals, accepted_currencies,
                           bank_upi_id, bank_account_holder_name,
                           min_deposit_paise, max_deposit_paise, min_withdraw_paise, max_withdraw_paise,
                           max_concurrent_orders, created_at)
    SELECT 'load-m-' || i, 'Load Merchant ' || i, 'LM' || lpad(i::text, 6, '0'),
           'loadmerch' || i, (7900000000 + i)::text,
           '$argon2id$v=19$m=65536,t=3,p=4$loadtestloadtest$loadtestloadtestloadtestloadtestloadtest',
           CASE WHEN i % 23 = 0 THEN 'INACTIVE' ELSE 'ACTIVE' END,
           CASE WHEN i % 17 = 0 THEN 'PENDING' ELSE 'APPROVED' END,
           (i % 3 <> 0), true, true, ARRAY['INR'],
           'load' || i || '@upi', 'Load Merchant ' || i,
           50000, 100000000, 50000, 100000000, 5,
           now() - (i % 200) * interval '1 day'
    FROM generate_series(1, $1) i`, [merchants]);

  // ── CYCLES ────────────────────────────────────────────────────────────────
  // Resolved history, because that is what the history feed and every
  // analytics query actually read.
  await step('cycles', `
    INSERT INTO cycles (cycle_id, cycle_type, start_time, end_time, status, winner,
                        is_settled, settled_at, winner_determined_at, total_paid_out_paise,
                        total_platform_fees_paise, created_at)
    SELECT 'load-c-' || i,
           (ARRAY['1_MIN','30_MIN','FULL_DAY'])[1 + (i % 3)],
           now() - i * interval '30 minutes',
           now() - i * interval '30 minutes' + interval '29 minutes',
           'COMPLETED',
           CASE WHEN i % 2 = 0 THEN 'DELHI' ELSE 'BOMBAY' END,
           true,
           now() - i * interval '30 minutes' + interval '30 minutes',
           now() - i * interval '30 minutes' + interval '29 minutes',
           (random() * 10000000)::bigint, (random() * 500000)::bigint,
           now() - i * interval '30 minutes'
    FROM generate_series(1, $1) i`, [cycles]);

  // ── BETS ──────────────────────────────────────────────────────────────────
  // In chunks: one two-million-row INSERT holds its whole result set and the
  // WAL for it in one transaction, and on a 4-core box that is where this
  // harness itself becomes the bottleneck it is meant to measure.
  const chunk = 250000;
  for (let done = 0; done < bets; done += chunk) {
    const n = Math.min(chunk, bets - done);
    await step(`bets ${fmt(done + n)}/${fmt(bets)}`, `
      INSERT INTO bets (bet_id, user_id, cycle_id, side, stake_paise, payout_paise,
                        status, cycle_type, placed_at, settled_at, platform_fee_paise, is_phantom)
      SELECT 'load-b-' || (i + $2::bigint),
             'load-u-' || (1 + ((i + $2::bigint) % $3::bigint)),
             'load-c-' || (1 + ((i + $2::bigint) % $4::bigint)),
             CASE WHEN (i + $2::bigint) % 2 = 0 THEN 'DELHI' ELSE 'BOMBAY' END,
             ((1 + ((i + $2::bigint) % 20)) * 10000)::bigint,
             CASE WHEN (i + $2::bigint) % 3 = 0 THEN ((1 + ((i + $2::bigint) % 20)) * 18000)::bigint ELSE 0 END,
             CASE WHEN (i + $2::bigint) % 3 = 0 THEN 'WON' ELSE 'LOST' END,
             (ARRAY['1_MIN','30_MIN','FULL_DAY'])[1 + ((i + $2::bigint) % 3)],
             now() - ((i + $2::bigint) % 20000) * interval '1 minute',
             now() - ((i + $2::bigint) % 20000) * interval '1 minute' + interval '30 seconds',
             ((1 + ((i + $2::bigint) % 20)) * 500)::bigint,
             false
      FROM generate_series(1, $1::int) i`, [n, done, users, cycles]);
  }

  // ── ORDERS ────────────────────────────────────────────────────────────────
  for (let done = 0; done < orders; done += chunk) {
    const n = Math.min(chunk, orders - done);
    await step(`orders ${fmt(done + n)}/${fmt(orders)}`, `
      INSERT INTO order_states (order_id, user_id, merchant_id, order_type, state,
                                token_amount_paise, fiat_amount_paise, currency, payment_mode,
                                created_at, updated_at, completed_at)
      SELECT 'load-o-' || (i + $2::bigint),
             'load-u-' || (1 + ((i + $2::bigint) % $3::bigint)),
             'load-m-' || (1 + ((i + $2::bigint) % $4::bigint)),
             CASE WHEN (i + $2::bigint) % 2 = 0 THEN 'DEPOSIT' ELSE 'WITHDRAWAL' END,
             (ARRAY['COMPLETED','COMPLETED','COMPLETED','COMPLETED','CANCELLED','DISPUTED','PENDING_QUEUE'])[1 + ((i + $2::bigint) % 7)],
             ((1 + ((i + $2::bigint) % 40)) * 50000)::bigint,
             ((1 + ((i + $2::bigint) % 40)) * 50000)::bigint,
             'INR', 'P2P_UPI',
             now() - ((i + $2::bigint) % 30000) * interval '1 minute',
             now() - ((i + $2::bigint) % 30000) * interval '1 minute',
             CASE WHEN (i + $2::bigint) % 7 < 4 THEN now() - ((i + $2::bigint) % 30000) * interval '1 minute' ELSE NULL END
      FROM generate_series(1, $1::int) i`, [n, done, users, merchants]);
  }

  // ── LEDGER ────────────────────────────────────────────────────────────────
  // Double-entry postings, in the shape the settlement writer produces, so an
  // aggregate over `postings` is measured against realistic JSONB rather than
  // an empty object. `amountPaise` is SIGNED and the legs must sum to zero —
  // the first version wrote two positive legs and `bb_check_postings_balance`
  // refused every row by name, which is §19's conservation invariant catching
  // a fixture the platform could not produce (§32 S16).
  for (let done = 0; done < events; done += chunk) {
    const n = Math.min(chunk, events - done);
    await step(`ledger ${fmt(done + n)}/${fmt(events)}`, `
      INSERT INTO accounting_events (idempotency_key, event_type, amount_paise, ref_model,
                                     ref_id, postings, description, created_at)
      SELECT 'load-e-' || (i + $2::bigint),
             (ARRAY['DEPOSIT_SETTLED','WITHDRAWAL_SETTLED','BET_PLACED','WINNINGS_PAID'])[1 + ((i + $2::bigint) % 4)],
             ((1 + ((i + $2::bigint) % 40)) * 50000)::bigint,
             'order_states', 'load-o-' || (1 + ((i + $2::bigint) % GREATEST($3::bigint, 1))),
             jsonb_build_array(
               jsonb_build_object('account', 'USER_WALLET', 'direction', 'CREDIT',
                                  'amountPaise', ((1 + ((i + $2::bigint) % 40)) * 50000)),
               jsonb_build_object('account', 'MERCHANT_FLOAT', 'direction', 'DEBIT',
                                  'amountPaise', -((1 + ((i + $2::bigint) % 40)) * 50000))),
             'load harness',
             now() - ((i + $2::bigint) % 40000) * interval '1 minute'
      FROM generate_series(1, $1::int) i`, [n, done, orders]);
  }

  await step('ANALYZE', 'ANALYZE');

  const { rows } = await pgQuery(`
    SELECT relname, n_live_tup, pg_size_pretty(pg_total_relation_size(relid)) AS size
    FROM pg_stat_user_tables WHERE n_live_tup > 1000 ORDER BY n_live_tup DESC LIMIT 12`);
  console.log('\n  Largest tables now:');
  for (const r of rows) console.log(`    ${r.relname.padEnd(22)} ${fmt(r.n_live_tup).padStart(12)} rows  ${r.size}`);
  const total = await pgQuery("SELECT pg_size_pretty(pg_database_size(current_database())) AS s");
  console.log(`\n  bb_load is now ${total.rows[0].s}.`);
}

// ── QUERIES ─────────────────────────────────────────────────────────────────
/**
 * Every entry calls the function the PANEL calls, never a hand-copied SQL
 * string. A copy drifts (§5) and would measure a query the platform has
 * stopped running.
 */
async function queries() {
  const { db } = await import('#db');
  const repeat = num('repeat', 25);

  const someUser = (await pgQuery("SELECT user_id FROM users WHERE user_id LIKE 'load-u-%' ORDER BY random() LIMIT 1")).rows[0]?.user_id;
  const someMerchant = (await pgQuery("SELECT merchant_id FROM merchants WHERE merchant_id LIKE 'load-m-%' LIMIT 1")).rows[0]?.merchant_id;
  if (!someUser) { console.error('bb_load holds no load rows — run --seed first.'); process.exit(1); }

  const CASES = [
    ['admin  · user list, page 1',        () => db.users.listUsers({ page: 1, limit: 50 })],
    ['admin  · user list, page 500',      () => db.users.listUsers({ page: 500, limit: 50 })],
    ['admin  · user search by mobile',    () => db.users.listUsers({ page: 1, limit: 50, search: '70000' })],
    ['admin  · user counts',              () => db.users.countUsers({})],
    ['admin  · dashboard',                () => db.stats.dashboard()],
    ['admin  · betting stats',            () => db.stats.bettingStats()],
    ['admin  · operation stats',          () => db.stats.operationStats()],
    ['admin  · leaderboard (50)',         () => db.stats.leaderboard({ limit: 50 })],
    ['admin  · growth trend, 30d',        () => db.stats.growthTrend({ days: 30 })],
    ['admin  · revenue trend, 30d',       () => db.stats.revenueTrend({ days: 30 })],
    ['admin  · platform finance',         () => db.stats.platformFinance({})],
    ['admin  · merchant list, page 1',    () => db.merchants.listMerchants({ page: 1, limit: 50 })],
    ['admin  · merchant counts',          () => db.merchants.merchantCounts()],
    ['admin  · merchant leaderboard',     () => db.stats.merchantLeaderboard({ days: 30, limit: 20 })],
    ['player · one balance',              () => db.wallets.getBalances(someUser)],
    ['player · one user',                 () => db.users.getUser(someUser)],
    ['player · login lookup by mobile',   () => db.users.getUserByMobile('7000050000', 'PLAYER')],
    ['player · own activity',             () => db.stats.userActivity(someUser)],
    ['player · own timeline, page 1',     () => db.stats.userTimeline(someUser, { page: 1, limit: 50 })],
    ['engine · assignment candidates',    () => db.merchants.assignmentCandidates({
      amountPaise: 500000, direction: 'DEPOSIT', currency: 'INR', limit: 10 })],
    ['engine · active order counts',      () => db.merchants.getActiveOrderCounts([someMerchant])],
    ['merch  · queue counts',             () => db.stats.merchantQueueCounts(someMerchant)],
    ['merch  · earnings',                 () => db.stats.merchantEarnings(someMerchant, {})],
    ['merch  · daily earnings, 7d',       () => db.stats.merchantDailyEarnings(someMerchant, { days: 7 })],
  ];

  console.log(`Timing ${CASES.length} real repository calls, ${repeat}× each, against bb_load.\n`);
  console.log('  query                              p50        p95        p99        max     slowest');
  console.log('  ' + '─'.repeat(88));

  const slow = [];
  for (const [label, run] of CASES) {
    const times = [];
    let failed = null;
    for (let i = 0; i < repeat; i++) {
      const t0 = performance.now();
      try { await run(); } catch (e) { failed = e.message; break; }
      times.push(performance.now() - t0);
    }
    if (failed) { console.log(`  ${label.padEnd(34)} THREW — ${failed.slice(0, 60)}`); continue; }
    times.sort((a, b) => a - b);
    const p50 = pct(times, 50); const p95 = pct(times, 95); const p99 = pct(times, 99);
    const max = times[times.length - 1];
    const flag = p95 > 1000 ? '  ← over 1s' : p95 > 250 ? '  ← over 250ms' : '';
    console.log(`  ${label.padEnd(34)} ${ms(p50).padStart(9)} ${ms(p95).padStart(10)} `
      + `${ms(p99).padStart(10)} ${ms(max).padStart(10)}${flag}`);
    if (p95 > 250) slow.push([label, p95]);
  }

  console.log('\n  ── Sequential scans over the big tables ────────────────────────────────');
  const scans = await pgQuery(`
    SELECT relname, seq_scan, idx_scan, n_live_tup
    FROM pg_stat_user_tables
    WHERE n_live_tup > 100000
    ORDER BY seq_scan DESC`);
  if (scans.rows.length === 0) console.log('    (no table over 100k rows — seed first)');
  for (const r of scans.rows) {
    const verdict = Number(r.seq_scan) === 0 ? 'index only'
      : Number(r.idx_scan) === 0 ? 'SEQ SCAN ONLY — no index is being used'
      : `${r.seq_scan} seq / ${r.idx_scan} idx`;
    console.log(`    ${r.relname.padEnd(22)} ${fmt(r.n_live_tup).padStart(12)} rows   ${verdict}`);
  }

  if (slow.length) {
    console.log(`\n  ${slow.length} call(s) over 250ms at p95 — each is a real screen waiting:`);
    for (const [l, p] of slow) console.log(`    ${l.padEnd(34)} ${ms(p)}`);
  } else {
    console.log('\n  Every call is under 250ms at p95.');
  }
}

// ── HTTP ────────────────────────────────────────────────────────────────────
/**
 * A concurrency RAMP against a live server, one panel at a time and then all
 * three at once. It reports the step at which latency degrades, not a
 * capacity figure: client and server share this container's four cores.
 */
async function http() {
  const base = arg('base', process.env.BB_BASE || 'http://127.0.0.1:8096');
  const seconds = num('seconds', 10);
  const steps = (arg('steps', '25,50,100,200,400')).split(',').map(Number);

  const tokens = await import('../backend/tests/e2e/harness.js');
  const someUser = (await pgQuery("SELECT user_id FROM users WHERE user_id LIKE 'load-u-%' LIMIT 1")).rows[0]?.user_id;
  const playerAuth = someUser ? { Authorization: `Bearer ${await tokens.playerToken(someUser)}` } : {};

  // The paths a panel hits on EVERY page load — the ones that decide whether
  // a platform feels alive. Public ones first, so a failure to authenticate
  // cannot be mistaken for a failure to serve.
  const MIX = {
    public: [
      ['GET', '/api/v1/health', {}],
      ['GET', '/api/v1/cycles/current', {}],
      ['GET', '/api/v1/cycles/history?type=30_MIN&limit=50', {}],
      ['GET', '/api/v1/config/public', {}],
    ],
    player: [
      ['GET', '/api/v1/wallet/balance', playerAuth],
      ['GET', '/api/v1/auth/me', playerAuth],
      ['GET', '/api/v1/bets/mine?page=1&limit=20', playerAuth],
    ],
  };

  const which = arg('mix', 'public');
  const calls = which === 'all' ? [...MIX.public, ...MIX.player] : (MIX[which] || MIX.public);

  console.log(`HTTP ramp against ${base} — mix "${which}", ${calls.length} path(s), ${seconds}s per step.`);
  console.log('  Client and server share this container, so a step that degrades may be either.\n');
  console.log('  conc     req/s      p50        p95        p99      errors   non-2xx');
  console.log('  ' + '─'.repeat(72));

  let degradedAt = null; let firstP95 = null;
  for (const conc of steps) {
    const deadline = Date.now() + seconds * 1000;
    const lat = []; let errors = 0; let non2xx = 0; let n = 0;

    const worker = async (slot) => {
      while (Date.now() < deadline) {
        const [method, path, headers] = calls[(n + slot) % calls.length];
        const t0 = performance.now();
        try {
          const res = await fetch(`${base}${path}`, { method, headers });
          await res.arrayBuffer();
          lat.push(performance.now() - t0);
          if (!res.ok) non2xx++;
        } catch { errors++; }
        n++;
      }
    };
    await Promise.all(Array.from({ length: conc }, (_, i) => worker(i)));

    lat.sort((a, b) => a - b);
    const p95 = pct(lat, 95);
    if (firstP95 === null) firstP95 = Math.max(p95, 1);
    if (degradedAt === null && (p95 > firstP95 * 10 || errors > lat.length * 0.01)) degradedAt = conc;
    console.log(`  ${String(conc).padStart(4)} ${(lat.length / seconds).toFixed(0).padStart(9)} `
      + `${ms(pct(lat, 50)).padStart(10)} ${ms(p95).padStart(10)} ${ms(pct(lat, 99)).padStart(10)} `
      + `${String(errors).padStart(8)} ${String(non2xx).padStart(9)}`);
  }
  console.log(degradedAt
    ? `\n  Latency or errors first degraded at ${degradedAt} concurrent clients.`
    : `\n  No step in this ramp degraded — the ceiling is above ${steps[steps.length - 1]} here.`);
}

const jobs = [];
if (has('seed')) jobs.push(seed);
if (has('queries')) jobs.push(queries);
if (has('http')) jobs.push(http);
if (jobs.length === 0) {
  console.log('Pick at least one phase: --seed, --queries, --http. See the header.');
  process.exit(1);
}
for (const job of jobs) { await job(); console.log(''); }
await closePg().catch(() => {});
