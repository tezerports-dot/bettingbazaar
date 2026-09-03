// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * loadtest/bet-contention.js — find where one cycle stops scaling.
 *
 * WHAT THIS MEASURES, AND WHY IT IS THE ONLY TEST THAT MATTERS HERE
 *
 * Every bet on a cycle contends for the SAME cycle row. A placement takes
 * `FOR SHARE` on it — enough to guarantee the cycle is still open while the
 * stake moves, and deliberately not more: an `UPDATE` of a running total on
 * that row would make two concurrent bets block on each other and deadlock
 * (40P01), which is why the real pools are DERIVED from `bets` and only the
 * phantom figures are stored.
 *
 * So the contention here is a shared row lock plus the per-user wallet lock
 * each bet takes, not a queue behind one exclusive writer. Whether that ceiling
 * is high enough is UNMEASURED, and this is what measures it —
 * docs/governance/LATENCY.md, "horizontal scaling".
 *
 * So every VU here targets ONE cycleId on purpose. Spreading load across
 * cycles would produce a flattering number that says nothing about the real
 * constraint: a live 30-minute cycle is exactly this — thousands of users
 * hitting one document inside one window.
 *
 * WHY LATENCY, NOT ERRORS
 * A row lock makes the loser of a race WAIT rather than fail. Contention
 * therefore does not surface as failed requests. It surfaces as p99 latency,
 * and only past a threshold. A run with 0% errors can still be past the knee.
 *
 * READING THE RESULT
 * Plot p99 against achieved bets/sec across the stages. Flat, then a knee —
 * the knee is the ceiling. Then run again with two app instances behind the
 * load balancer:
 *
 *   - throughput roughly DOUBLES  -> the bottleneck is the app tier. There is
 *     no contention problem yet; do not rewrite the bet path.
 *   - throughput barely moves     -> the bottleneck is the cycle row and the
 *     locks taken around it (LATENCY.md, "horizontal scaling").
 *
 * That second comparison is the actual experiment. A single-instance number
 * on its own cannot distinguish "the database is the limit" from "one Node
 * process is the limit", and those have opposite fixes.
 *
 * USAGE
 *   BASE_URL=https://staging.example.com \
 *   CYCLE_ID=<an OPEN cycle> \
 *   TOKENS=tok1,tok2,tok3 \
 *   k6 run loadtest/bet-contention.js
 *
 * Never point this at production: it places real bets against a real cycle.
 * `npm run loadtest:seed` mints throwaway funded users and prints TOKENS.
 */
import http from 'k6/http';
import { check } from 'k6';
import { Trend, Rate, Counter } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:5000';
const CYCLE_ID = __ENV.CYCLE_ID;
const TOKENS = (__ENV.TOKENS || '').split(',').map((t) => t.trim()).filter(Boolean);
const SIDE_SPLIT = Number(__ENV.SIDE_SPLIT || 0.5);
const STAKE = Number(__ENV.STAKE || 10);

// Latency of the bet write specifically — the number the knee shows up in.
const betLatency = new Trend('bb_bet_duration', true);
const betOk = new Rate('bb_bet_success');
const cycleClosed = new Counter('bb_cycle_closed');
const insufficient = new Counter('bb_insufficient_balance');

export const options = {
  scenarios: {
    // Ramping ARRIVAL RATE, not VUs: we are looking for the throughput at
    // which latency breaks, so the offered load must be the independent
    // variable. With fixed VUs the system would self-throttle as it slowed —
    // latency would rise, throughput would fall, and the knee would hide.
    contention: {
      executor: 'ramping-arrival-rate',
      startRate: 10,
      timeUnit: '1s',
      preAllocatedVUs: 50,
      maxVUs: 1500,
      stages: [
        { target: 25,   duration: '1m' },
        { target: 50,   duration: '1m' },
        { target: 100,  duration: '2m' },
        { target: 200,  duration: '2m' },
        { target: 400,  duration: '2m' },
        { target: 800,  duration: '2m' },
        { target: 0,    duration: '30s' },
      ],
    },
  },
  thresholds: {
    // Not pass/fail gates so much as markers on the graph: k6 reports which
    // stage first crossed them, which is the knee.
    'bb_bet_duration': ['p(95)<500', 'p(99)<1000'],
    'bb_bet_success': ['rate>0.95'],
  },
};

export function setup() {
  if (!CYCLE_ID) throw new Error('CYCLE_ID is required — point this at ONE open cycle.');
  if (!TOKENS.length) throw new Error('TOKENS is required — run `npm run loadtest:seed` first.');
  console.log(`Targeting cycle ${CYCLE_ID} at ${BASE_URL} with ${TOKENS.length} funded accounts`);
  return {};
}

export default function () {
  // Round-robin the funded accounts. Distinct users matter: the per-user
  // wallet row is a DIFFERENT contention point from the shared cycle
  // document, and reusing one account would measure that instead.
  const token = TOKENS[__VU % TOKENS.length];
  const side = Math.random() < SIDE_SPLIT ? 'DELHI' : 'BOMBAY';

  const res = http.post(
    `${BASE_URL}/api/bet`,
    JSON.stringify({ cycleId: CYCLE_ID, side, amount: STAKE }),
    {
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      tags: { name: 'POST /api/bet' },
    },
  );

  betLatency.add(res.timings.duration);
  const ok = res.status === 200 || res.status === 201;
  betOk.add(ok);

  if (!ok) {
    const body = String(res.body || '');
    // Distinguish the two benign failures from real ones, so a run that ran
    // out of cycle or out of money is not mistaken for a contention finding.
    if (/window just closed|Betting closed/i.test(body)) cycleClosed.add(1);
    else if (/Insufficient balance/i.test(body)) insufficient.add(1);
  }

  check(res, {
    'bet accepted': () => ok,
    'not rate limited': () => res.status !== 429,   // a 429 means the limiter
                                                    // is the ceiling, not the DB
  });
}

export function handleSummary(data) {
  const m = data.metrics;
  const p = (k, s) => m[k]?.values?.[s]?.toFixed?.(1) ?? 'n/a';
  const lines = [
    '',
    '════ BET PATH CONTENTION ════',
    `  requests        ${m.http_reqs?.values?.count ?? 0}`,
    `  achieved rate   ${m.http_reqs?.values?.rate?.toFixed(1) ?? 'n/a'}/s`,
    `  bet p50/p95/p99 ${p('bb_bet_duration', 'med')} / ${p('bb_bet_duration', 'p(95)')} / ${p('bb_bet_duration', 'p(99)')} ms`,
    `  success rate    ${((m.bb_bet_success?.values?.rate ?? 0) * 100).toFixed(2)}%`,
    `  cycle closed    ${m.bb_cycle_closed?.values?.count ?? 0}   (benign — cycle ended mid-run)`,
    `  insufficient    ${m.bb_insufficient_balance?.values?.count ?? 0}   (benign — seed more funds)`,
    '',
    '  Now re-run with TWO app instances behind the balancer.',
    '  Throughput roughly doubles -> app tier is the limit, the DB is fine.',
    '  Throughput barely moves    -> the cycle row and its locks are the ceiling.',
    '',
  ];
  return { stdout: lines.join('\n') };
}
