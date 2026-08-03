#!/usr/bin/env node
// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * scripts/certification-report.mjs — regenerates the per-domain table inside
 * docs/PRODUCTION_CERTIFICATION_CHECKLIST.md from the registry.
 *
 * The table exists so anyone can see what is actually production ready versus
 * what is still under development. A hand-maintained one answers that question
 * with somebody's memory of last week, which is the failure this whole registry
 * was built to remove — so the table is GENERATED, and the prose around it is
 * the only part a human writes.
 *
 *   npm run certify:report          print the table
 *   npm run certify:report -- --write   rewrite the block inside the doc
 *
 * Exit code is 1 when the platform is not certified, so CI can gate on it once
 * every domain has landed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const {
  certificationMatrix, productionCertificationStatus,
} = await import('../backend/postgres/moneyAuthority.js');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOC = path.join(ROOT, 'docs/PRODUCTION_CERTIFICATION_CHECKLIST.md');
const BEGIN = '<!-- BEGIN GENERATED: certification-matrix -->';
const END = '<!-- END GENERATED: certification-matrix -->';

/** Human-facing domain names, in the user-visible language of the platform. */
const DOMAIN_LABEL = {
  wallet: 'User Wallet',
  merchant_wallet: 'Merchant Wallet',
  ledger: 'Accounting Ledger',
  orders: 'Orders',
  kyc: 'KYC',
  merchant_settlement: 'Merchant ↔ User Settlement',
  admin_issuance: 'Admin Treasury / Token Issuance',
  bets: 'Betting',
  settlements: 'Sports Settlement',
  casino_settlement: 'Casino Settlement',
  bonuses_and_commissions: 'Bonuses & Commissions',
};

// ✅ proven. ⏳ not started or not proven. There is deliberately no symbol for
// "partially done": a half-built money path is not a state anyone should be
// able to read as progress on a go-live checklist.
const mark = (v) => (v ? '✅' : '⏳');

function table() {
  const header = [
    '| Domain | PG Authority | Mirroring | Reconciliation | Concurrency Tested | Infrastructure Tested | Certified |',
    '|---|:--:|:--:|:--:|:--:|:--:|:--:|',
  ];
  const rows = certificationMatrix().map((r) => [
    '', DOMAIN_LABEL[r.path] ?? r.path,
    mark(r.implemented), mark(r.dualWrite), mark(r.reconciled),
    mark(r.concurrencyTested), mark(r.infrastructureTested), mark(r.certified), '',
  ].join(' | ').trim());
  return [...header, ...rows].join('\n');
}

function blockers() {
  const rows = certificationMatrix().filter((r) => !r.certified);
  if (!rows.length) return '_Every money path is certified._';
  return [
    '| Domain | Blocked by |',
    '|---|---|',
    ...rows.map((r) => `| ${DOMAIN_LABEL[r.path] ?? r.path} | ${r.blockedBy.join(', ')} |`),
  ].join('\n');
}

const status = productionCertificationStatus();
const generated = [
  BEGIN,
  '',
  `**\`${status.status}\`** — ${status.certified.length} of ${status.totalPaths} money paths certified.`,
  `Generated from \`backend/postgres/moneyAuthority.js\` by \`npm run certify:report\`. Do not edit by hand.`,
  '',
  table(),
  '',
  '### What is blocking each domain',
  '',
  blockers(),
  '',
  END,
].join('\n');

if (process.argv.includes('--write')) {
  const doc = fs.readFileSync(DOC, 'utf8');
  const start = doc.indexOf(BEGIN);
  const end = doc.indexOf(END);
  if (start < 0 || end < 0) {
    console.error(`${DOC} is missing the ${BEGIN} / ${END} markers.`);
    process.exit(2);
  }
  fs.writeFileSync(DOC, doc.slice(0, start) + generated + doc.slice(end + END.length));
  console.log(`Updated ${path.relative(ROOT, DOC)}`);
} else {
  console.log(generated);
}

process.exit(status.ready ? 0 : 1);
