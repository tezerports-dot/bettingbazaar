// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file.
/**
 * postgres/migratePartitions.js — opt-in partitioning runner (capability #16,
 * Bucket A "framework now, activate later").
 *
 * Applies migrations/001_partition_ledger.sql (idempotent) and ensures a landing
 * partition exists for the current and next month. Deliberately NOT wired into
 * boot — run explicitly with `npm run pg:migrate:partition` once ledger volume
 * justifies partitioning. No-ops loudly if DATABASE_URL is unset.
 *
 * Cutover from the flat tables to the *_p tables (copy → verify → rename) is a
 * separate operator step (deploy/README.md) so it happens in a maintenance
 * window, never implicitly.
 */
import fs from 'fs';
import path from 'path';
import { pgConfigured, pgQuery, closePg } from './pgClient.js';

export async function applyPartitionFramework() {
  if (!pgConfigured()) {
    console.error('DATABASE_URL not set — nothing to partition.');
    return false;
  }
  const sql = fs.readFileSync(
    path.join(path.dirname(new URL(import.meta.url).pathname), 'migrations', '001_partition_ledger.sql'), 'utf8');
  await pgQuery(sql);

  // Ensure current + next month partitions exist for both parents.
  const first = new Date(); first.setUTCDate(1); first.setUTCHours(0, 0, 0, 0);
  const next = new Date(first); next.setUTCMonth(next.getUTCMonth() + 1);
  const asDate = (d) => d.toISOString().slice(0, 10);
  for (const parent of ['wallet_ledger_p', 'accounting_events_p']) {
    for (const d of [first, next]) {
      await pgQuery('SELECT bb_ensure_month_partition($1, $2)', [parent, asDate(d)]);
    }
  }
  console.log('✅ Partition framework applied; current+next month partitions ensured.');
  return true;
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (isMain) {
  applyPartitionFramework()
    .then(() => closePg())
    .then(() => process.exit(0))
    .catch((e) => { console.error('[pg:migrate:partition] failed:', e.message); process.exit(1); });
}
