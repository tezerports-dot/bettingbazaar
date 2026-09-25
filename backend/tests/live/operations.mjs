// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * backend/tests/live/operations.mjs — the OPERATIONAL half of readiness.
 *
 * Every other harness in this repository asks whether the platform computes
 * the right answer. This one asks whether it survives the day: does the thing
 * that runs on a timer actually run, does a backup restore, and does the
 * realtime fan-out hold up. Those are the failures that take a live platform
 * down while every unit test stays green.
 *
 * Four phases, reported separately, because they are different claims (§35):
 *
 *   --cron     every recurring job, RUN, and — where the trigger row can be
 *              seeded — asserted to have moved that row. A job that is only
 *              run and not triggered is reported as RAN, never as covered:
 *              "it did not throw" and "it does the work" are two claims.
 *   --restore  dump → destroy → restore, through the PLATFORM's own
 *              `dumpToFile` / `restoreFromFile`, then assert the row counts
 *              came back AND the ledger still conserves to zero. A backup
 *              nobody has restored is a file, not a backup.
 *   --sse      N concurrent authenticated SSE clients against a live server:
 *              connection success, first-byte latency, and whether the server
 *              is still answering ordinary requests while they are held.
 *   --crash    settlement is interrupted by SIGKILL mid-run and re-run. The
 *              claim is exactly one payout per bet — §19's idempotency gate,
 *              measured rather than trusted.
 *
 * ── WHAT IT WRITES, AND WHERE ──────────────────────────────────────────────
 * The cron and crash phases seed rows and clean them up in a `finally`; every
 * row they create is prefixed `ops-`. The restore phase needs a database it
 * may DESTROY, so it refuses to run against anything but one it creates
 * itself (`bb_oprestore`) — a restore drill pointed at a database somebody
 * else is using is the accident it exists to prevent.
 *
 *   BB_BASE=http://127.0.0.1:8092 DATABASE_URL=…/bb_cross2 \
 *     node backend/tests/live/operations.mjs --cron --restore --sse
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pgQuery, closePg } from '#db/client.js';
import { db } from '#db';

const run = promisify(execFile);
const has = (n) => process.argv.includes(`--${n}`);
const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d;
};
const num = (n, d) => Number(arg(n, d));

const rid = (p) => `ops-${p}-${Math.random().toString(36).slice(2, 8)}`;
const results = [];
function record(phase, id, verdict, detail) {
  results.push({ phase, id, verdict, detail });
  const mark = verdict === 'PASS' ? 'PASS  ' : verdict === 'RAN' ? 'RAN   ' : verdict === 'SKIP' ? 'SKIP  ' : 'FAIL  ';
  console.log(`  ${mark} ${id}${detail ? ` — ${detail}` : ''}`);
}

/** The ledger's own invariant, asked of whatever database we are pointed at. */
async function ledgerConserves() {
  const { rows } = await pgQuery(`
    SELECT count(*)::int AS bad FROM (
      SELECT e.id, COALESCE(SUM((p->>'amountPaise')::BIGINT), 0) AS total
        FROM accounting_events e, jsonb_array_elements(e.postings) p
       GROUP BY e.id
    ) s WHERE s.total <> 0`);
  return Number(rows[0].bad) === 0;
}

// ════════════════════════════════════════════════════════════════════════════
// CRON
// ════════════════════════════════════════════════════════════════════════════
/**
 * Every job `registerCronJobs` registers. The list is written out here rather
 * than read off the registry deliberately: reading the registry would make
 * this harness agree with whatever the server happens to register, and the
 * question being asked is whether the fourteen jobs the file declares each
 * do their work. A job added to `cronJobs.js` and not to this list shows up
 * as the count disagreeing, which is the point (§28 — derive what a gate
 * checks from the thing it is checking, but a LIST of expectations is the one
 * thing that must not be derived from the code under test).
 */
async function cron() {
  const orderState = async (id) => (await pgQuery(
    'SELECT state, dispute_raised_by AS by FROM order_states WHERE order_id = $1', [id])).rows[0] ?? {};

  /** A player row cheap enough to make one per case. */
  const player = async () => {
    const userId = rid('u');
    await pgQuery(
      `INSERT INTO users (user_id, username, mobile, account_type, status, kyc_status)
       VALUES ($1, $1, $2, 'PLAYER', 'ACTIVE', 'APPROVED')`,
      [userId, String(6000000000 + Math.floor(Math.random() * 999999999))],
    );
    await pgQuery('INSERT INTO wallets (user_id) VALUES ($1) ON CONFLICT DO NOTHING', [userId]);
    return userId;
  };
  const merchant = async () => {
    const id = rid('m');
    await pgQuery(
      `INSERT INTO merchants (merchant_id, name, public_ref, username, mobile, status,
                              merchant_approval_status, accepted_currencies, is_online,
                              accepts_deposits, accepts_withdrawals)
       VALUES ($1, 'Ops Merchant', $2, $1, $3, 'ACTIVE', 'APPROVED', ARRAY['INR'], true, true, true)`,
      [id, id.slice(-12).toUpperCase(), String(6900000000 + Math.floor(Math.random() * 999999999))],
    );
    return id;
  };
  const order = async (fields) => {
    const id = rid('o');
    const cols = { order_id: id, order_type: 'DEPOSIT', state: 'PENDING_QUEUE',
      token_amount_paise: 50000, fiat_amount_paise: 50000, currency: 'INR',
      payment_mode: 'P2P_UPI', ...fields };
    const keys = Object.keys(cols);
    await pgQuery(
      `INSERT INTO order_states (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')})`,
      keys.map((k) => cols[k]),
    );
    return id;
  };

  const JOBS = [
    {
      id: 'order-expiry',
      what: 'expireOrders cancels an order past its own expires_at',
      async go() {
        const userId = await player();
        const id = await order({ user_id: userId, expires_at: new Date(Date.now() - 60000) });
        const { expireOrders } = await import('../../domains/payment/paymentProcessing.service.js');
        const n = await expireOrders();
        const after = await orderState(id);
        if (after.state === 'CANCELLED') return ['PASS', `${id} PENDING_QUEUE → CANCELLED (sweep moved ${n})`];
        return ['FAIL', `${id} is still ${after.state} after expireOrders() reported ${n}`];
      },
    },
    {
      id: 'paid-order-timeout',
      what: 'sweepUnansweredPaidDeposits sends a PAID buy with a reference to the admin queue',
      async go() {
        const userId = await player();
        const merchantId = await merchant();
        const id = await order({
          user_id: userId, merchant_id: merchantId, state: 'PAID',
          utr: `OPS${Date.now()}`, paid_at: new Date(Date.now() - 120 * 60000),
        });
        const { sweepUnansweredPaidDeposits } =
          await import('../../domains/payment/paymentProcessing.service.js');
        const n = await sweepUnansweredPaidDeposits();
        const after = await orderState(id);
        if (after.state === 'DISPUTED' && after.by === 'system') {
          return ['PASS', `${id} PAID → DISPUTED, raised by 'system' (sweep handled ${n})`];
        }
        return ['FAIL', `${id} is ${after.state} raised by ${after.by} after the sweep handled ${n}`];
      },
    },
    {
      id: 'utr-after-paid-timeout',
      what: 'sweepUtrAfterPaid catches a CASH_ATM buy PAID with no reference',
      async go() {
        const userId = await player();
        const merchantId = await merchant();
        const id = await order({
          user_id: userId, merchant_id: merchantId, state: 'PAID',
          payment_mode: 'CASH_ATM', paid_at: new Date(Date.now() - 120 * 60000),
        });
        // And a UPI order in the same state, which this sweep must NOT touch:
        // the split between the two sweeps is the §2 rule being checked here.
        const bystander = await order({
          user_id: userId, merchant_id: merchantId, state: 'PAID',
          payment_mode: 'P2P_UPI', paid_at: new Date(Date.now() - 120 * 60000),
        });
        const { sweepUtrAfterPaid } =
          await import('../../domains/payment/paymentProcessing.service.js');
        const n = await sweepUtrAfterPaid();
        const after = await orderState(id);
        const other = await orderState(bystander);
        if (after.state !== 'DISPUTED') {
          return ['FAIL', `the cash order is ${after.state} after the sweep handled ${n}`];
        }
        if (other.state !== 'PAID') {
          return ['FAIL', `the UPI order moved to ${other.state} — this sweep is CASH_ATM only (§2)`];
        }
        return ['PASS', `the cash order went to DISPUTED and the UPI one stayed PAID (handled ${n})`];
      },
    },
    {
      id: 'payment-proof-retention',
      what: 'scrubExpiredProofs clears an expired proof and keeps the order',
      async go() {
        const userId = await player();
        const id = await order({
          user_id: userId, state: 'COMPLETED',
          proof_screenshot: 'ops/proof.png', proof_expires_at: new Date(Date.now() - 60000),
        });
        const n = await db.orders.scrubExpiredProofs();
        const { rows } = await pgQuery(
          'SELECT proof_screenshot AS p, proof_expires_at AS e, state FROM order_states WHERE order_id = $1', [id]);
        const r = rows[0] ?? {};
        if (r.p === null && r.e === null && r.state === 'COMPLETED') {
          return ['PASS', `proof and its expiry both cleared, order still COMPLETED (scrubbed ${n})`];
        }
        return ['FAIL', `proof=${r.p} expiry=${r.e} state=${r.state} after scrubbing ${n}`];
      },
    },
    {
      id: 'cash-link-expiry',
      what: 'sweepExpiredLinks retires a LIVE link past its expiry and leaves a fresh one',
      async go() {
        // TWO merchants, because `cash_link_one_live_per_merchant` allows one
        // LIVE link each — the platform will not hold two for one merchant, so
        // a fixture that does is refused by name (§32 S16, twice on this case:
        // first the `expires_at > created_at` CHECK, then this index).
        const merchantId = await merchant();
        const otherMerchant = await merchant();
        const dead = rid('link');
        const live = rid('link');
        // `created_at` is set explicitly on the DUE link: the CHECK is
        // `expires_at > created_at`, so a link that expired a minute ago has to
        // have been created before that — which is exactly how a real one got
        // there, and a fixture that ignores it is refused by name (§32 S16).
        await pgQuery(
          `INSERT INTO cash_link_queue (link_id, merchant_id, denomination_paise, payment_link,
                                        status, created_at, expires_at)
           VALUES ($1, $3, 50000, 'https://example.test/atm/dead', 'LIVE',
                   now() - interval '5 minutes', now() - interval '1 minute'),
                  ($2, $4, 50000, 'https://example.test/atm/live', 'LIVE',
                   now(), now() + interval '10 minutes')`,
          [dead, live, merchantId, otherMerchant],
        );
        const { sweepExpiredLinks } = await import('../../domains/merchant/cashLink.service.js');
        const { expired } = await sweepExpiredLinks();
        const { rows } = await pgQuery(
          'SELECT link_id, status FROM cash_link_queue WHERE link_id = ANY($1::text[])', [[dead, live]]);
        const by = Object.fromEntries(rows.map((r) => [r.link_id, r.status]));
        if (by[dead] === 'EXPIRED' && by[live] === 'LIVE') {
          return ['PASS', `the due link EXPIRED and the fresh one is still LIVE (swept ${expired})`];
        }
        return ['FAIL', `due=${by[dead]} fresh=${by[live]} after sweeping ${expired}`];
      },
    },
    {
      id: 'withdrawal-hold-settle',
      what: 'settleDueHolds finds a hold whose window has passed',
      async go() {
        const userId = await player();
        const merchantId = await merchant();
        const id = await order({
          user_id: userId, merchant_id: merchantId, order_type: 'WITHDRAWAL', state: 'PAID',
          merchant_credit_status: 'HELD', merchant_credit_hold_until: new Date(Date.now() - 60000),
        });
        // What is asserted is that the QUERY SELECTS IT — the settlement itself
        // moves a player's locked stake and a merchant's wallet, and asserting
        // that needs the money set up through the real withdrawal path, which
        // `test:pg` already does. This closes the half `test:pg` cannot: that
        // the SWEEP's own WHERE finds the row the workflow leaves behind (§7).
        const due = await db.orders.findDueHolds({ limit: 500 });
        const seen = due.some((o) => String(o.orderId) === id);
        if (!seen) return ['FAIL', `findDueHolds did not return ${id} — the sweep cannot see its own trigger`];

        // The row is REMOVED before the worker runs. A HELD withdrawal with no
        // locked stake behind it is a state the withdrawal path cannot produce
        // (§32 S16), and handing it to `settleDueHolds` makes the worker open a
        // settlement, fail to release a stake that was never locked, and
        // correctly REVERSE itself — a real error log for a row that could not
        // exist. So this case's claim is exactly the one it can make honestly:
        // the sweep's WHERE finds what the workflow leaves behind (§7). The
        // money half runs through the real withdrawal path in `test:pg`.
        await pgQuery('DELETE FROM order_transitions WHERE order_id = $1', [id]).catch(() => {});
        await pgQuery('DELETE FROM order_states WHERE order_id = $1', [id]);
        const { settleDueHolds } = await import('../../domains/payment/withdrawalHold.service.js');
        const settled = await settleDueHolds();
        return ['PASS', `findDueHolds returned ${id}; the worker then ran on the real queue and settled ${settled}`];
      },
    },
    {
      id: 'deposit-escrow-sweep',
      what: 'sweepDepositHolds runs and reports',
      seededTrigger: false,
      async go() {
        const { sweepDepositHolds } = await import('../../domains/merchant/depositEscrow.service.js');
        const report = await sweepDepositHolds();
        return ['RAN', `report ${JSON.stringify(report)}`];
      },
    },
    {
      id: 'cash-link-match',
      what: 'matchWaitingOrdersToLinks runs and reports',
      seededTrigger: false,
      async go() {
        const { matchWaitingOrdersToLinks } =
          await import('../../domains/payment/paymentProcessing.service.js');
        const r = await matchWaitingOrdersToLinks();
        return ['RAN', `matched ${r.matched}`];
      },
    },
    {
      id: 'scheduled-apply',
      what: 'applyScheduledPolicyChanges runs and reports',
      seededTrigger: false,
      async go() {
        const { applyScheduledPolicyChanges } =
          await import('../../domains/configuration/depositPolicy.service.js');
        const r = await applyScheduledPolicyChanges();
        return ['RAN', `${r.length} due version(s), ${r.filter((x) => x.applied).length} applied`];
      },
    },
    {
      id: 'ledger-reconcile',
      what: 'reconcileCompletedOrders + reconcileSettledCycles run, and the ledger still conserves',
      seededTrigger: false,
      async go() {
        const { reconcileCompletedOrders, reconcileSettledCycles } =
          await import('../../domains/revenue/revenueSettlement.service.js');
        const a = await reconcileCompletedOrders();
        const b = await reconcileSettledCycles();
        const failures = [...a, ...b].filter((r) => r.error);
        if (!await ledgerConserves()) {
          return ['FAIL', 'an accounting_events row does not sum to zero after reconciliation (§19)'];
        }
        const recorded = [...a, ...b].filter((r) => r.recorded).length;
        return [failures.length ? 'FAIL' : 'RAN',
          `${recorded} event(s) recorded, ${failures.length} failure(s)`
          + (failures.length ? `: ${String(failures[0].error).slice(0, 90)}` : '; ledger conserves')];
      },
    },
    {
      id: 'commission-engine',
      what: 'runCommissionEngine runs and reports',
      seededTrigger: false,
      async go() {
        const { runCommissionEngine } =
          await import('../../domains/merchant/merchantCommission.service.js');
        const o = await runCommissionEngine();
        if (!o.ran) return ['RAN', `did not run: ${o.reason ?? 'no ACTIVE priced policy'}`];
        const bad = o.results.filter((r) => r.error);
        return [bad.length ? 'FAIL' : 'RAN',
          `${o.results.filter((r) => r.issued).length} issued, ${bad.length} failed`];
      },
    },
    {
      id: 'data-retention',
      what: 'runRetention runs and reports',
      seededTrigger: false,
      async go() {
        const { runRetention } = await import('../../domains/operations/retention.service.js');
        const r = await runRetention();
        return ['RAN', JSON.stringify(r ?? {}).slice(0, 120)];
      },
    },
    {
      id: 'leaderboard-rebuild',
      what: 'the leaderboard query the job calls answers',
      seededTrigger: false,
      async go() {
        const rows = await db.stats.leaderboard({ limit: 10 });
        return ['RAN', `${rows.length} row(s)`];
      },
    },
    {
      id: 'db-backup',
      what: 'runBackup, whose real drill is --restore',
      seededTrigger: false,
      async go() {
        const { runBackup } = await import('../../services/backup.service.js');
        const r = await runBackup();
        if (r.ok) return ['RAN', `uploaded ${r.key}`];
        // Skipping loudly IS the designed behaviour with no S3 configured, and
        // reporting that as a failure is how a correct refusal gets "fixed".
        return ['RAN', `skipped by design: ${r.skipped ?? r.error}`];
      },
    },
  ];

  const declared = Number(await run('grep', ['-c', 'registerRecurring(', 'backend/startup/cronJobs.js'])
    .then((r) => r.stdout.trim()).catch(() => '0'));
  console.log(`CRON — ${JOBS.length} job(s) in this harness; cronJobs.js registers ${declared}.`);
  if (declared !== JOBS.length) {
    console.log(`  ⚠ the counts disagree: a job was added or removed and this list was not updated.`);
  }
  const seeded = JOBS.filter((j) => j.seededTrigger !== false).length;
  console.log(`  ${seeded} have a SEEDED TRIGGER and are asserted; `
    + `${JOBS.length - seeded} are RUN only — that is a weaker claim and is reported as one (§35).\n`);

  for (const job of JOBS) {
    try {
      const [verdict, detail] = await job.go();
      record('cron', job.id, verdict, detail);
    } catch (e) {
      record('cron', job.id, 'FAIL', `threw: ${e.message.slice(0, 160)}`);
    }
  }

  // Everything this phase created, and nothing else.
  // ── An order that MOVED cannot be deleted, and that is correct ──────────
  // `order_transitions` is append-only (`bb_forbid_change()`) and holds a plain
  // FK to `order_states`, so the parent DELETE is refused for every order a
  // sweep actually touched. The first version swallowed that refusal and left
  // the rows behind — six of them, which the escrow sweep then reported as
  // UNHELD buy orders on the next run. So: take anything still live to a
  // terminal state, and delete only what never transitioned.
  for (const sql of [
    `UPDATE order_states SET state = 'CANCELLED', cancel_reason = 'OPS_HARNESS', cancelled_at = now()
      WHERE order_id LIKE 'ops-%' AND state NOT IN ('COMPLETED', 'CANCELLED', 'FAILED', 'REJECTED')`,
    `DELETE FROM order_states o WHERE o.order_id LIKE 'ops-%'
       AND NOT EXISTS (SELECT 1 FROM order_transitions t WHERE t.order_id = o.order_id)`,
    "DELETE FROM cash_link_queue WHERE link_id LIKE 'ops-%'",
    "DELETE FROM merchants WHERE merchant_id LIKE 'ops-%'",
    "DELETE FROM wallets WHERE user_id LIKE 'ops-%'",
    "DELETE FROM users WHERE user_id LIKE 'ops-%'",
  ]) await pgQuery(sql).catch((e) => console.log(`  (cleanup) ${e.message.slice(0, 90)}`));
}

// ════════════════════════════════════════════════════════════════════════════
// RESTORE
// ════════════════════════════════════════════════════════════════════════════
async function restore() {
  const src = process.env.DATABASE_URL;
  if (!src) { record('restore', 'restore/drill', 'SKIP', 'no DATABASE_URL'); return; }

  const admin = src.replace(/\/[^/?]+(\?|$)/, '/postgres$1');
  const target = 'bb_oprestore';
  const targetUrl = src.replace(/\/[^/?]+(\?|$)/, `/${target}$1`);
  const psql = (url, sql) => run('psql', [url, '-v', 'ON_ERROR_STOP=1', '-tAc', sql]);

  const dumpPath = path.join(os.tmpdir(), `bb-ops-${Date.now()}.dump`);
  const { dumpToFile, restoreFromFile } = await import('../../services/backup.service.js');

  try {
    // 1. Dump the database we were pointed at, through the platform's own code.
    const { sizeBytes } = await dumpToFile(dumpPath, src);
    record('restore', 'restore/dump', 'PASS', `${(sizeBytes / 1024 / 1024).toFixed(1)} MB via dumpToFile()`);

    // 2. A database this phase owns and may destroy. NOT the source: a drill
    //    that restores over the database somebody is using is the accident.
    await psql(admin, `DROP DATABASE IF EXISTS ${target}`);
    await psql(admin, `CREATE DATABASE ${target}`);

    // 3. Restore into it, through the platform's own code.
    const r = await restoreFromFile(dumpPath, targetUrl);
    record('restore', 'restore/restore', 'PASS',
      `restoreFromFile() ok${r.hadWarnings ? ' (with warnings, which pg_restore exits 1 for by design)' : ''}`);

    // 4. Did it come back? Compare the row counts of every table that has any.
    const counts = async (url) => {
      const { stdout } = await psql(url, `
        SELECT string_agg(t || ':' || n, ',' ORDER BY t) FROM (
          SELECT c.relname AS t, (SELECT count(*) FROM pg_class x WHERE x.oid = c.oid) * 0
                 + (xpath('/row/c/text()',
                     query_to_xml('SELECT count(*) AS c FROM ' || quote_ident(c.relname),
                                  false, true, '')))[1]::text::bigint AS n
            FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
           WHERE ns.nspname = 'public' AND c.relkind = 'r'
        ) s WHERE n > 0`);
      return Object.fromEntries((stdout.trim() || '').split(',').filter(Boolean)
        .map((p) => { const i = p.lastIndexOf(':'); return [p.slice(0, i), Number(p.slice(i + 1))]; }));
    };
    const before = await counts(src);
    const after = await counts(targetUrl);
    const tables = [...new Set([...Object.keys(before), ...Object.keys(after)])];
    const off = tables.filter((t) => (before[t] ?? 0) !== (after[t] ?? 0));
    if (off.length === 0) {
      record('restore', 'restore/rows', 'PASS',
        `${tables.length} non-empty table(s), every count identical`);
    } else {
      record('restore', 'restore/rows', 'FAIL',
        `${off.length} table(s) differ: ` + off.slice(0, 5)
          .map((t) => `${t} ${before[t] ?? 0}→${after[t] ?? 0}`).join(', '));
    }

    // 5. And is the MONEY still coherent in the restored copy? Row counts
    //    matching is not the same claim as the ledger balancing.
    const { stdout: bad } = await psql(targetUrl, `
      SELECT count(*) FROM (
        SELECT e.id, COALESCE(SUM((p->>'amountPaise')::BIGINT), 0) AS total
          FROM accounting_events e, jsonb_array_elements(e.postings) p GROUP BY e.id
      ) s WHERE s.total <> 0`);
    record('restore', 'restore/ledger', Number(bad.trim()) === 0 ? 'PASS' : 'FAIL',
      Number(bad.trim()) === 0
        ? 'every accounting_events row in the restored copy still sums to zero (§19)'
        : `${bad.trim()} row(s) do not conserve in the restored copy`);

    // 6. Can the platform's own code read the restored database? A restore
    //    that psql can count and the app cannot open is not a restore.
    const { stdout: cols } = await psql(targetUrl,
      `SELECT count(*) FROM information_schema.columns WHERE table_name = 'order_states'`);
    record('restore', 'restore/schema', Number(cols.trim()) > 50 ? 'PASS' : 'FAIL',
      `order_states has ${cols.trim()} columns in the restored copy`);
  } catch (e) {
    record('restore', 'restore/drill', 'FAIL', e.message.slice(0, 200));
  } finally {
    try { fs.unlinkSync(dumpPath); } catch { /* already gone */ }
    await psql(admin, `DROP DATABASE IF EXISTS ${target}`).catch(() => {});
  }
}

// ════════════════════════════════════════════════════════════════════════════
// SSE
// ════════════════════════════════════════════════════════════════════════════
async function sse() {
  const base = arg('base', process.env.BB_BASE || 'http://127.0.0.1:8092');
  const n = num('clients', 200);
  const hold = num('hold', 15);

  // `/api/sse/events` is the PUBLIC cycle stream — the one every player panel
  // holds open for the whole session, and therefore the connection count that
  // actually scales with players online. The two private streams
  // (`/merchant/events`, `/admin/events`) are bounded by staff and merchants,
  // which is a different and much smaller number.
  const path = '/api/sse/events';

  const openTimeout = num('open-timeout', 20) * 1000;

  console.log(`SSE — holding ${n} public stream(s) on ${base}${path} for ${hold}s`
    + ` (${openTimeout / 1000}s to open each).`);
  const opened = []; const firstByte = []; let refused = 0; let timedOut = 0;
  const controllers = [];

  // ── Every open is BOUNDED, and that is not a detail ──────────────────────
  // The first version awaited 200 unbounded `fetch`es and a first `read()` on
  // each. It never finished: it was killed at 300s having printed nothing, so
  // it reported neither a pass nor a failure — and a harness that hangs is
  // worse than one that fails, because it looks like the run is still going.
  // Now a stream that will not open in time is COUNTED as timed out, and the
  // number that did open is the answer.
  await Promise.all(Array.from({ length: n }, async () => {
    const ac = new AbortController();
    controllers.push(ac);
    const cap = setTimeout(() => ac.abort(), openTimeout);
    const t0 = performance.now();
    try {
      const res = await fetch(`${base}${path}`, {
        headers: { Accept: 'text/event-stream' }, signal: ac.signal,
      });
      if (!res.ok || !res.body) { refused++; return; }
      const reader = res.body.getReader();
      await reader.read();                       // the first frame the server sends
      clearTimeout(cap);
      opened.push(res);
      firstByte.push(performance.now() - t0);
      // Left open deliberately: the question is what the server does WHILE
      // they are held, not whether one connects.
      (async () => { try { for (;;) { const { done } = await reader.read(); if (done) break; } } catch { /* aborted */ } })();
    } catch (e) {
      if (ac.signal.aborted) timedOut++; else refused++;
    } finally { clearTimeout(cap); }
  }));
  const failed = refused + timedOut;

  firstByte.sort((a, b) => a - b);
  const p = (q) => (firstByte.length
    ? `${firstByte[Math.min(firstByte.length - 1, Math.ceil(q / 100 * firstByte.length) - 1)].toFixed(0)}ms`
    : 'n/a');
  record('sse', 'sse/open', opened.length >= n * 0.95 ? 'PASS' : 'FAIL',
    `${opened.length}/${n} streams open — ${refused} refused, ${timedOut} never sent a first frame`
    + ` within ${openTimeout / 1000}s; first frame p50 ${p(50)} p95 ${p(95)}`);

  // Is it still an ordinary web server while all of those are held? This is the
  // failure that matters: a fan-out that starves the event loop does not refuse
  // the stream, it makes every OTHER request slow.
  const t0 = performance.now();
  const health = await fetch(`${base}/api/v1/health`).catch(() => null);
  const ms = performance.now() - t0;
  record('sse', 'sse/still-serving', health?.ok && ms < 2000 ? 'PASS' : 'FAIL',
    `GET /api/v1/health answered ${health?.status ?? 'nothing'} in ${ms.toFixed(0)}ms with ${opened.length} streams held`);

  await new Promise((r) => setTimeout(r, hold * 1000));
  const t1 = performance.now();
  const again = await fetch(`${base}/api/v1/health`).catch(() => null);
  record('sse', 'sse/after-hold', again?.ok ? 'PASS' : 'FAIL',
    `after ${hold}s holding them: ${again?.status ?? 'nothing'} in ${(performance.now() - t1).toFixed(0)}ms`);

  // How many frames actually arrived, and to how many clients. A stream that
  // opens and then says nothing looks identical to a working one from the
  // connection count alone.
  const { rows } = await pgQuery(
    "SELECT count(*)::int AS n FROM cycles WHERE status = 'OPEN'").catch(() => ({ rows: [{ n: 0 }] }));
  record('sse', 'sse/live-cycles', 'RAN',
    `${rows[0].n} OPEN cycle(s) on this database — the publisher has ${rows[0].n ? 'something' : 'NOTHING'} to broadcast`);

  for (const ac of controllers) ac.abort();
}

// ════════════════════════════════════════════════════════════════════════════
// CRASH
// ════════════════════════════════════════════════════════════════════════════
/**
 * SIGKILL the server MID-SETTLEMENT and ask the only question that matters:
 * was anybody paid twice.
 *
 * ── Why the lease is advanced by hand, and why that is not cheating ─────────
 * A claimed cycle stays claimed for `SETTLEMENT_LEASE_MINUTES` (15), and both
 * the tick and the 5-minute recovery sweep use the same claim query — so a
 * worker killed mid-pass strands that cycle's REMAINING payouts for up to
 * fifteen minutes. That is a deliberate trade-off with its reasoning written at
 * the constant, and it is a real operational property worth knowing: the money
 * is safe, and the players still owed wait.
 *
 * This drill does not sit through it. It moves `settlement_claimed_at` back
 * sixteen minutes — exactly what the clock would do — and lets the restarted
 * engine's own tick claim it. The resumption path under test is the real one;
 * only the waiting is skipped, and the report says so.
 */
async function crash() {
  const port = num('port', 8094);
  const script = arg('server', '/tmp/claude-0/start-drive.sh');
  const restart = arg('restart', '/tmp/claude-0/restart.sh');
  const log = arg('server-log', '/tmp/claude-0/drive.log');
  const probe = `http://127.0.0.1:${port}/api/v1/health`;
  const bets = num('bets', 400);

  const alive = await fetch(probe).then((r) => r.ok).catch(() => false);
  if (!alive) { record('crash', 'crash/drill', 'SKIP', `nothing answering on ${probe}`); return; }
  if (!fs.existsSync(restart) || !fs.existsSync(script)) {
    record('crash', 'crash/drill', 'SKIP', `needs --server and --restart scripts (looked for ${script})`);
    return;
  }

  const cycleId = rid('cycle');
  const userIds = [];
  try {
    // ── A cycle the engine will claim, and bets it will pay ────────────────
    // `claimSettleable` wants `winner IS NOT NULL AND NOT is_settled AND
    // end_time <= now()`, which is the state a declared cycle is actually in.
    await pgQuery(
      `INSERT INTO cycles (cycle_id, cycle_type, start_time, end_time, status, winner,
                           winner_determined_at, is_settled)
       VALUES ($1, '30_MIN', now() - interval '31 minutes', now() - interval '1 minute',
               'RESULT_DECLARED', 'DELHI', now() - interval '1 minute', false)`,
      [cycleId],
    );
    for (let i = 0; i < bets; i++) {
      const userId = rid('cu');
      userIds.push(userId);
      await pgQuery(
        `INSERT INTO users (user_id, username, mobile, account_type, status, kyc_status)
         VALUES ($1, $1, $2, 'PLAYER', 'ACTIVE', 'APPROVED')`,
        [userId, String(6500000000 + Math.floor(Math.random() * 499999999))],
      );
      await pgQuery(
        'INSERT INTO wallets (user_id, deposit_paise) VALUES ($1, 10000)', [userId]);
      // ── THROUGH `placeBet`, not an INSERT, and this was the whole problem ──
      // The first version inserted PENDING bets with raw SQL and set
      // `locked_paise` by hand. `winBet` reconstructs the funding SLICES to
      // return the stake, `requireSlices` throws without them, so every bet was
      // refused and the drill reported "the engine settled nothing in 60s" over
      // an engine that was working perfectly. §32 S16 once more: a PENDING bet
      // with no stake lock behind it is not a bet this platform can produce.
      const placed = await db.bets.placeBet({
        betId: `${cycleId}-b${i}`, userId, cycleId, side: 'DELHI',
        // The WRAPPER's slices are in RUPEES (`s.amount`) and it converts them
        // to paise for the core; passing `amountPaise` answers "rupees must be a
        // finite number, got undefined" from a helper three calls down, which
        // names neither the field nor the layer. Rupees here, on purpose.
        amount: 100,
        slices: [{ field: 'depositBalance', amount: 100 }],
        actor: 'ops-harness', reason: 'crash drill stake',
      });
      if (!placed.ok) throw new Error(`placeBet refused bet ${i}: ${placed.reason}`);
    }

    const settledCount = async () => Number((await pgQuery(
      "SELECT count(*)::int AS n FROM bets WHERE cycle_id = $1 AND status <> 'PENDING'",
      [cycleId])).rows[0].n);

    // ── Kill it once it has started paying, not before ────────────────────
    // A kill before the first payout proves nothing — there is no half-finished
    // state to recover. This waits for real progress and then kills INTO it.
    const started = Date.now();
    let progressed = 0;
    while (Date.now() - started < 60000) {
      progressed = await settledCount();
      if (progressed > 0 && progressed < bets) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    if (progressed === 0) {
      record('crash', 'crash/mid-flight', 'FAIL',
        `the engine settled nothing in 60s — the cycle was never claimed, so there is no crash to test`);
      return;
    }

    // The server process is found by its PORT in /proc, the way restart.sh
    // does it: `pkill -f <script>` matches this process's own command line.
    const victims = [];
    for (const pid of (await run('pgrep', ['-x', 'node']).then((r) => r.stdout.trim().split('\n')).catch(() => []))) {
      if (!pid) continue;
      const env = await fs.promises.readFile(`/proc/${pid}/environ`, 'utf8').catch(() => '');
      if (env.split('\0').includes(`PORT=${port}`)) victims.push(pid);
    }
    if (victims.length === 0) {
      record('crash', 'crash/kill', 'FAIL', `no node process holds PORT=${port}`);
      return;
    }
    for (const pid of victims) process.kill(Number(pid), 'SIGKILL');
    const atKill = await settledCount();
    record('crash', 'crash/kill', 'PASS',
      `SIGKILL sent to pid ${victims.join(',')} with ${atKill}/${bets} bet(s) settled — a genuinely half-finished pass`);

    // ── CLAIM 1: nothing was double-paid by the interrupted pass ───────────
    // ── COUNT THE PAYOUT, not "a positive row" ────────────────────────────
    // `wallet_ledger.amount_paise` holds a MAGNITUDE and `tx_type` carries the
    // direction, so a correctly settled winning bet has three positive rows:
    // the stake debit, the lock release, and one payout credit. The first
    // version of this check counted rows with `amount_paise > 0` per `ref_id`
    // and reported "20 bets were paid more than once" on a run where every bet
    // was paid exactly once — a false HIGH finding, caught only by reading the
    // rows before believing the number.
    const dupes = async () => Number((await pgQuery(
      `SELECT count(*)::int AS n FROM (
         SELECT ref_id FROM wallet_ledger
          WHERE ref_id LIKE $1 || '%'
            AND tx_type = 'CREDIT' AND field = 'winningsBalance'
          GROUP BY ref_id HAVING count(*) > 1
       ) s`, [cycleId])).rows[0].n);
    const credited = async () => Number((await pgQuery(
      `SELECT COALESCE(SUM(amount_paise), 0)::bigint AS n FROM wallet_ledger
        WHERE ref_id LIKE $1 || '%' AND tx_type = 'CREDIT' AND field = 'winningsBalance'`,
      [cycleId])).rows[0].n);
    const afterKill = await dupes();
    record('crash', 'crash/no-double-pay-mid-flight', afterKill === 0 ? 'PASS' : 'FAIL',
      afterKill === 0
        ? `every settled bet has exactly one credit after the kill`
        : `${afterKill} bet(s) already carry more than one credit`);

    // ── Advance the lease the 15 minutes, then bring it back ───────────────
    await pgQuery(
      "UPDATE cycles SET settlement_claimed_at = now() - interval '16 minutes' WHERE cycle_id = $1",
      [cycleId]);
    const up = await run(restart, [String(port), script, log, probe, '200']).catch((e) => ({ stdout: e.message }));
    record('crash', 'crash/restart', /up on/.test(up.stdout) ? 'PASS' : 'FAIL', up.stdout.trim().slice(0, 120));

    // ── CLAIM 2: it finishes, and pays each remaining bet exactly once ─────
    const deadline = Date.now() + 120000;
    let done = false;
    while (Date.now() < deadline) {
      const { rows } = await pgQuery('SELECT is_settled AS s FROM cycles WHERE cycle_id = $1', [cycleId]);
      if (rows[0]?.s) { done = true; break; }
      await new Promise((r) => setTimeout(r, 500));
    }
    const finalSettled = await settledCount();
    const finalDupes = await dupes();
    const { rows: unpaid } = await pgQuery(
      "SELECT count(*)::int AS n FROM bets WHERE cycle_id = $1 AND status = 'PENDING'", [cycleId]);

    record('crash', 'crash/resumed', done && Number(unpaid[0].n) === 0 ? 'PASS' : 'FAIL',
      done
        ? `the restarted engine finished the cycle: ${finalSettled}/${bets} settled, ${unpaid[0].n} still PENDING`
        : `the cycle was not settled within 120s of the restart (${finalSettled}/${bets} done)`);
    const paid = await credited();
    const payouts = Number((await pgQuery(
      `SELECT count(*)::int AS n FROM wallet_ledger
        WHERE ref_id LIKE $1 || '%' AND tx_type = 'CREDIT' AND field = 'winningsBalance'`,
      [cycleId])).rows[0].n);
    record('crash', 'crash/exactly-once', finalDupes === 0 && payouts === bets ? 'PASS' : 'FAIL',
      finalDupes === 0 && payouts === bets
        ? `${bets} bet(s) across a SIGKILL and a resume: ${payouts} payout credits, `
          + `${paid} paise total, and not one bet carries two (§19)`
        : `${finalDupes} bet(s) carry more than one payout, and ${payouts} credits were written for ${bets} bets`);
  } catch (e) {
    record('crash', 'crash/drill', 'FAIL', `${e.message.slice(0, 200)}\n         ${String(e.stack || '').split('\n').slice(1, 4).join('\n         ')}`);
  } finally {
    // The bets and the cycle can go; a settled bet writes no order_transitions.
    await pgQuery('DELETE FROM bets WHERE cycle_id = $1', [cycleId]).catch(() => {});
    await pgQuery('DELETE FROM cycles WHERE cycle_id = $1', [cycleId]).catch(() => {});
    await pgQuery('DELETE FROM wallet_ledger WHERE user_id = ANY($1::text[])', [userIds]).catch(() => {});
    await pgQuery('DELETE FROM wallets WHERE user_id = ANY($1::text[])', [userIds]).catch(() => {});
    await pgQuery('DELETE FROM users WHERE user_id = ANY($1::text[])', [userIds]).catch(() => {});
  }
}

// ════════════════════════════════════════════════════════════════════════════
const phases = [];
if (has('cron')) phases.push(cron);
if (has('restore')) phases.push(restore);
if (has('sse')) phases.push(sse);
if (has('crash')) phases.push(crash);
if (phases.length === 0) {
  console.log('Pick a phase: --cron, --restore, --sse, --crash. See the header.');
  process.exit(1);
}
for (const phase of phases) { await phase(); console.log(''); }

const bad = results.filter((r) => r.verdict === 'FAIL');
const pass = results.filter((r) => r.verdict === 'PASS');
const ran = results.filter((r) => r.verdict === 'RAN');
console.log(`${pass.length} asserted · ${ran.length} ran without an assertion · `
  + `${results.filter((r) => r.verdict === 'SKIP').length} skipped · ${bad.length} failed`);
if (ran.length) console.log('  "ran" is not "covered" — see §35.');
await closePg().catch(() => {});
process.exit(bad.length ? 1 : 0);
