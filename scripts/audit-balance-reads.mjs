#!/usr/bin/env node
/**
 * audit-balance-reads.mjs — every place a balance is read, and from where.
 *
 * Trap 7, made mechanical: "classify every balance read as display or
 * decision." A display read may render a stale number. A DECISION read — one
 * whose value gates a transfer, an admission or an assignment — may not, and
 * must come from the same rows the write will lock.
 *
 * Three money decisions were once made from the wrong store: bet-placement
 * affordability, withdrawal admission, and merchant assignment. None of them
 * looked wrong at the call site; each was a plain property access on an object
 * that happened to come from somewhere else. Finding them took reading a
 * hundred call sites by hand. This does that pass in a second, and keeps doing
 * it.
 *
 *   node scripts/audit-balance-reads.mjs            summary + per-file counts
 *   node scripts/audit-balance-reads.mjs --list     every site with its line
 *   node scripts/audit-balance-reads.mjs --decisions   only the ones that gate money
 *
 * Exit 1 when a DECISION read does not come from the wallet. Display reads are
 * reported, never fatal.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', 'coverage']);

/** The balance fields. Reading any of these is what this audit is about. */
const BALANCE_FIELDS = [
  'depositBalance', 'winningsBalance', 'lockedBalance', 'reserveBalance',
  'lockedDepositAmount', 'lockedWinningsAmount', 'tokenBalance',
];
const READ = new RegExp(`\\.(${BALANCE_FIELDS.join('|')})\\b`);

/**
 * A read is SAFE when the object it reads from came from the wallet — the rows
 * the write will lock. `getBalances`, `getBalancesPaise`, `getBalancesRupees`
 * and the walletPg/walletAuthority modules are the sanctioned sources.
 */
const SAFE_SOURCE = /getBalances|walletPg|walletAuthority|merchantWalletPg|getAvailablePaise/;

/**
 * Verbs that mean the number is about to gate something.
 *
 * Deliberately broad: a false positive costs a comment, and a false negative is
 * a money decision made from a stale number. `>=` and `<` are here because an
 * affordability check is almost always a comparison, and `Math.min`/`Math.max`
 * because a cap computed from a balance is a decision even when nothing is
 * compared explicitly.
 */
const DECISION_HINT =
  /\b(if|while|return)\b.*[<>]=?|[<>]=?.*\b(balance|Balance)\b|Math\.(min|max)|insufficient|afford|eligib|\$gte|\$lte|>=|<=/;

function walk(dir, acc = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(join(dir, e.name), acc);
    } else if (/\.(js|mjs|cjs)$/.test(e.name)) {
      acc.push(relative(ROOT, join(dir, e.name)).split(sep).join('/'));
    }
  }
  return acc;
}

const findings = [];
for (const rel of walk(join(ROOT, 'backend'))) {
  // The wallet modules ARE the source of truth; reads inside them are the
  // authoritative ones by definition. Tests are excluded because a fixture
  // asserting on a balance is not a production read.
  if (rel.startsWith('database/') || rel.includes('/tests/')) continue;

  const lines = readFileSync(join(ROOT, rel), 'utf8').split('\n');
  lines.forEach((text, i) => {
    if (!READ.test(text)) return;
    if (text.trim().startsWith('*') || text.trim().startsWith('//')) return; // a comment about one

    // Look back a few lines: the sanctioned source is usually the assignment
    // that produced the object being read, not the read itself.
    const context = lines.slice(Math.max(0, i - 6), i + 1).join('\n');
    const safe = SAFE_SOURCE.test(context);
    const decision = DECISION_HINT.test(text);
    findings.push({ file: rel, line: i + 1, text: text.trim(), safe, decision });
  });
}

const argv = process.argv.slice(2);
const list = argv.includes('--list');
const onlyDecisions = argv.includes('--decisions');

const unsafeDecisions = findings.filter((f) => f.decision && !f.safe);
const unsafeDisplay = findings.filter((f) => !f.decision && !f.safe);
const safe = findings.filter((f) => f.safe);

console.log('\nBalance reads outside database/\n');
console.log(`  ${findings.length} total`);
console.log(`  ${safe.length} read from the wallet (sanctioned)`);
console.log(`  ${unsafeDisplay.length} display reads not from the wallet`);
console.log(`  ${unsafeDecisions.length} DECISION reads not from the wallet\n`);

const show = onlyDecisions ? unsafeDecisions : [...unsafeDecisions, ...unsafeDisplay];
if (list || onlyDecisions) {
  for (const f of show) {
    console.log(`${f.decision ? 'DECISION' : 'display '} ${f.file}:${f.line}`);
    console.log(`         ${f.text.slice(0, 120)}`);
  }
} else {
  const byFile = new Map();
  for (const f of show) byFile.set(f.file, (byFile.get(f.file) ?? 0) + 1);
  for (const [file, n] of [...byFile].sort((a, b) => b[1] - a[1])) {
    const d = show.filter((f) => f.file === file && f.decision).length;
    console.log(`  ${String(n).padStart(3)}  ${file}${d ? `   (${d} DECISION)` : ''}`);
  }
}

if (unsafeDecisions.length) {
  console.log(`\n${unsafeDecisions.length} decision read(s) do not come from the wallet.`);
  console.log('A number that gates a transfer must be read from the rows the write will lock.\n');
  process.exit(1);
}
console.log('\nNo decision read bypasses the wallet.\n');
