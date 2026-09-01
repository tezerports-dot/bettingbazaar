// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file.
/**
 * Mutation harness — break the code, confirm a test FAILS, restore.
 *
 * A passing test suite proves nothing about a test that would pass anyway. Each
 * entry below names one behaviour this branch relies on, the smallest edit that
 * removes it, and the test that must go red when it does. A mutation that
 * survives is a hole in the suite, reported as SURVIVED rather than skipped.
 *
 *   node scripts/mutation-check.mjs            all mutations
 *   node scripts/mutation-check.mjs unit       only the ones whose test is a unit test
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';

const UNIT = 'vitest.config.ts';
const PG = 'vitest.pg.config.ts';

const MUTATIONS = [
  // ── The fee, in the store that decides it ─────────────────────────────────
  {
    id: 'M15', file: 'backend/postgres/betPg.js', config: PG,
    test: 'backend/tests/postgres/betSettlementPg.test.js',
    why: 'the settling UPDATE does not write the fee',
    from: `      \`UPDATE bets SET status = $2, payout_paise = $3, platform_fee_paise = $5,
                       settled_at = now(), updated_at = now()
        WHERE bet_id = $1 AND status = $4
        RETURNING updated_at\`,
      [ctx.bid, spec.to, payoutPaise, spec.expect, platformFeePaise],`,
    to: `      \`UPDATE bets SET status = $2, payout_paise = $3,
                       settled_at = now(), updated_at = now()
        WHERE bet_id = $1 AND status = $4
        RETURNING updated_at\`,
      [ctx.bid, spec.to, payoutPaise, spec.expect],`,
  },
  {
    id: 'M16', file: 'backend/postgres/betPg.js', config: PG,
    test: 'backend/tests/postgres/betSettlementPg.test.js',
    why: 'a fractional or negative fee is accepted and silently truncated',
    from: `  if (!Number.isInteger(platformFeePaise) || platformFeePaise < 0) {
    throw new TypeError(\`\${spec.name}Bet: platformFeePaise must be a non-negative integer, got \${platformFeePaise}\`);
  }`,
    to: '',
  },
  // ── A deposit moves tokens; it must not create or destroy them ────────────
  {
    id: 'M22', file: 'backend/domains/payment/payment.routes.js', config: UNIT,
    test: 'backend/tests/unit/depositCreditConservation.test.js',
    why: 'the merchant is debited the DEPOSIT SHARE while the user is credited the whole amount',
    from: `      merchantId: order.merchantId, amount: total,`,
    to: `      merchantId: order.merchantId, amount: depositCredit,`,
  },
  {
    id: 'M23', file: 'backend/domains/payment/depositCredit.js', config: UNIT,
    test: 'backend/tests/unit/depositCreditSplit.test.js',
    why: 'the `||` fallback is back — a legal 0 deposit share reads as absent',
    from: `  if (!usable) return { depositCredit: total, reserveCredit: 0, total, split: false };
  return { depositCredit: deposit, reserveCredit: reserve, total, split: true };`,
    to: `  if (!usable) return { depositCredit: total, reserveCredit: 0, total, split: false };
  return { depositCredit: deposit || total, reserveCredit: reserve, total, split: true };`,
  },
  {
    id: 'M24', file: 'backend/domains/payment/depositCredit.js', config: UNIT,
    test: 'backend/tests/unit/depositCreditSplit.test.js',
    why: 'a partial split is accepted, so part of the deposit goes unaccounted for',
    from: `    && Math.abs((deposit + reserve) - total) < 1e-9;`,
    to: `    && true;`,
  },
  {
    id: 'M25', file: 'backend/domains/payment/depositCredit.js', config: UNIT,
    test: 'backend/tests/unit/depositCreditConservation.test.js',
    why: 'the fallback credits nothing instead of the whole amount — tokens burned',
    from: `  if (!usable) return { depositCredit: total, reserveCredit: 0, total, split: false };`,
    to: `  if (!usable) return { depositCredit: 0, reserveCredit: 0, total, split: false };`,
  },
  {
    id: 'M30', file: 'backend/postgres/betPg.js', config: PG,
    test: 'backend/tests/postgres/betSettlementPg.test.js',
    why: 'resolveBetId stops looking at mongo_id, so a placed bet is unreachable',
    from: `    \`SELECT bet_id FROM bets WHERE bet_id = $1 OR mongo_id = $1 LIMIT 1\`,`,
    to: `    \`SELECT bet_id FROM bets WHERE bet_id = $1 LIMIT 1\`,`,
  },
  // ── Money-domain READS follow authority (docs/MONEY_READS_MIGRATION.md) ───
  {
    id: 'M31', file: 'backend/postgres/merchantWalletPgAuthority.js', config: UNIT,
    test: 'backend/tests/unit/merchantEligibilityReads.test.js',
    why: 'the eligibility reader ignores the resolver and reads a mirror that may be empty',
    from: `  if (!isPostgresAuthoritative(MONEY_PATHS.MERCHANT_WALLET)) {`,
    to: `  if (false) {`,
  },
  {
    id: 'M32', file: 'backend/domains/merchant/merchant.assignment.routes.js', config: UNIT,
    test: 'backend/tests/unit/merchantEligibilityReads.test.js',
    why: 'an eligibility gate goes back to reading the Mongo document directly',
    from: `    const balance_pa = await getMerchantTokenBalance(merchant._id);
    if (balance_pa < order.tokenAmount) {`,
    to: `    const balance_pa = merchant.tokenBalance;
    if (merchant.tokenBalance < order.tokenAmount) {`,
  },
  // ── The accounts table: four properties, each verified to be load-bearing ──
  {
    id: 'M43', file: 'backend/postgres/userPg.js', config: PG,
    test: 'backend/tests/postgres/userPg.test.js',
    why: 'a racing signup on one mobile creates two accounts',
    from: `     ON CONFLICT (mobile) DO NOTHING\n`,
    to: '',
  },
  {
    id: 'M44', file: 'backend/postgres/userPg.js', config: PG,
    test: 'backend/tests/postgres/userPg.test.js',
    why: 'a write to an unknown column is silently discarded again',
    from: `  if (unknown.length) {`,
    to: `  if (false) {`,
  },
  {
    id: 'M45', file: 'backend/postgres/userPg.js', config: PG,
    test: 'backend/tests/postgres/userPg.test.js',
    why: "BIGINT stays a string, so '900' >= 1000 is true",
    from: `const toInt = (v) => (v == null ? null : Number(v));`,
    to: `const toInt = (v) => v;`,
  },
  {
    id: 'M46', file: 'backend/postgres/userPg.js', config: PG,
    test: 'backend/tests/postgres/userPg.test.js',
    why: 'the denormalised kyc_status can be written outside the decision transaction',
    from: `  if (!client) throw new Error('setKycStatus must run inside the transaction that records the decision');`,
    to: `  if (!client) return null;`,
  },
];

// A mutation naming a file or test that no longer exists is not a mutation that
// passed — it is one that never ran. The harness previously reported only what
// it managed to execute, so entries left behind by a refactor quietly reduced
// the coverage this script claims to measure. Refuse to run instead.
const dead = MUTATIONS.filter((m) => !existsSync(m.file) || !existsSync(m.test));
if (dead.length) {
  console.error(`${dead.length} mutation(s) name a file or test that no longer exists:`);
  for (const m of dead) {
    const missing = [!existsSync(m.file) && m.file, !existsSync(m.test) && m.test].filter(Boolean);
    console.error(`  ${m.id}: ${missing.join(', ')}`);
  }
  console.error('\nDelete them, or repoint them at what replaced the behaviour.');
  process.exit(1);
}

// A suite that SKIPS is not a suite that passed. The Postgres suites gate
// themselves on DATABASE_URL (`describePg = pgConfigured() ? describe :
// describe.skip`) and vitest exits 0 when every test in a file is skipped — so
// running a PG mutation without a database reported SURVIVED for a mutation
// that was never executed. That is worse than not running it: it manufactures
// a hole in a suite that does not have one, and the three betPg entries were
// being reported that way for however long DATABASE_URL has been unset here.
const needsPg = MUTATIONS.some((m) => m.config === PG);
if (needsPg && !process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set, and some mutations run against a real PostgreSQL.');
  console.error('Those suites would SKIP, exit 0, and be reported as SURVIVED — a hole that');
  console.error('does not exist. Set DATABASE_URL, or run `node scripts/mutation-check.mjs unit`.');
  process.exit(1);
}

const only = process.argv[2];
const selected = MUTATIONS.filter((m) => !only
  || (only === 'unit' && m.config === UNIT)
  || (only === 'pg' && m.config === PG)
  || m.id === only);

const results = [];

for (const m of selected) {
  const original = readFileSync(m.file, 'utf8');
  if (!original.includes(m.from)) {
    results.push({ ...m, outcome: 'ANCHOR-MISSING' });
    console.log(`❓ ${m.id}  anchor not found in ${m.file} — mutation could not be applied`);
    continue;
  }
  writeFileSync(m.file, original.replace(m.from, m.to));
  let outcome;
  try {
    const out = execSync(`npx vitest run --config ${m.config} ${m.test}`,
      { stdio: 'pipe', env: process.env }).toString();
    // Exit 0 is only evidence of survival if tests actually RAN. A file whose
    // every test skipped also exits 0, and calling that SURVIVED reports a hole
    // in a suite nobody measured.
    outcome = /Tests\s+\d+\s+passed/.test(out) ? 'SURVIVED' : 'NOT-MEASURED';
  } catch {
    outcome = 'KILLED';
  } finally {
    writeFileSync(m.file, original);
  }
  results.push({ ...m, outcome });
  const mark = { KILLED: '✅', SURVIVED: '❌', 'NOT-MEASURED': '❓' }[outcome];
  console.log(`${mark} ${m.id}  ${outcome.padEnd(12)} ${m.why}`);
}

const survived = results.filter((r) => r.outcome === 'SURVIVED');
const unmeasured = results.filter((r) => r.outcome === 'NOT-MEASURED');
console.log(`\n${results.filter((r) => r.outcome === 'KILLED').length}/${results.length} mutations killed.`);
if (unmeasured.length) {
  console.log('NOT MEASURED (the suite ran no tests — do not read these as passes):');
  for (const s of unmeasured) console.log(`  ${s.id} ${s.test}`);
}
if (survived.length) {
  console.log('SURVIVED (a hole in the suite):');
  for (const s of survived) console.log(`  ${s.id} ${s.file} — ${s.why}`);
}
if (survived.length || unmeasured.length) process.exit(1);
