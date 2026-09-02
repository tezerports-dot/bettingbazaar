#!/usr/bin/env node
/**
 * verify-migration-coherence.mjs — did the migration actually replace anything?
 *
 * Deleting a document store is easy to get half-right in two specific ways, and
 * both produce a codebase that looks migrated and does not work:
 *
 *   SPLIT   an entity is WRITTEN in one store and READ from the other. The
 *           write succeeds, the read finds nothing, and nothing errors. This
 *           happened while moving signup: `createAccountFromOnboarding` wrote
 *           the account to PostgreSQL while `authenticate` still read the
 *           document — so a new player could sign up and then not log in.
 *
 *   GAP     a table exists but is missing a field the code still reads or
 *           writes. The column is absent, the value is silently undefined, and
 *           the feature it belongs to quietly stops working. `backup_codes`
 *           (2FA recovery) and `roles` were both missing this way.
 *
 * Neither is visible to `check:no-mongo`, which counts references rather than
 * asking whether what replaced them is complete. Neither shows up in a passing
 * test suite unless a test happens to exercise that exact field on that exact
 * path.
 *
 *   node scripts/verify-migration-coherence.mjs           summary
 *   node scripts/verify-migration-coherence.mjs --list    every finding
 *
 * A GAP always fails. A SPLIT fails when the count RISES: 185 of them remain
 * while the migration is in flight, so a hard zero would be red for the whole
 * job and would say nothing about the change in front of it. The ratchet below
 * is what makes it useful today — it cannot go up, so a newly-created split
 * fails the build on the commit that creates it, which is when it is cheap.
 * Lower it as sites move. It reaches zero when the migration does.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const SKIP = new Set(['.git', 'node_modules', 'dist', 'build', 'coverage']);

/**
 * Entities that have been migrated, and where each lives now.
 *
 * `model` is the name the document store knew it by; `table` is the PostgreSQL
 * table; `repo` is the module that owns access to it. An entry here is a claim
 * that the migration is DONE for that entity — which is exactly the claim this
 * script tries to falsify.
 */
const MIGRATED = [
  { model: 'User',                table: 'users',                  repo: 'postgres/userPg.js' },
  { model: 'TokenBlacklist',      table: 'token_blacklist',        repo: 'postgres/identityPg.js' },
  { model: 'KycVerification',     table: 'kyc_verifications',      repo: 'postgres/identityPg.js' },
  { model: 'KycBatch',            table: 'kyc_batches',            repo: 'postgres/identityPg.js' },
  { model: 'TelegramConfig',      table: 'telegram_configs',       repo: 'postgres/telegramPg.js' },
  { model: 'TelegramBot',         table: 'telegram_bots',          repo: 'postgres/telegramPg.js' },
  { model: 'TelegramTemplate',    table: 'telegram_templates',     repo: 'postgres/telegramPg.js' },
  { model: 'TelegramIdentity',    table: 'telegram_identities',    repo: 'postgres/telegramPg.js' },
  { model: 'TelegramPendingLink', table: 'telegram_pending_links', repo: 'postgres/telegramPg.js' },
  { model: 'TelegramLoginToken',  table: 'telegram_login_tokens',  repo: 'postgres/telegramPg.js' },
];

/**
 * Fields that deliberately live somewhere OTHER than their entity's own table.
 *
 * Not suppressions — statements of where the value went, so a reader sees the
 * intent and a field that is genuinely missing still fails the check. Each one
 * is a decision worth being able to point at:
 *
 *   the balances  ->  `wallets`, in integer paise behind the row lock the write
 *                     takes. A copy on `users` would be a second writer waiting
 *                     to disagree with the first, which is how an affordability
 *                     check came to be decided from one number and executed
 *                     against another.
 *   kycData       ->  `user_kyc` plus `kyc_transitions`, which owns the decision
 *                     and its audit trail. `users.kyc_status` is the
 *                     denormalised copy authorisation reads, written only in the
 *                     same transaction as the decision itself.
 */
const RELOCATED = {
  User: {
    depositBalance:       'wallets.deposit_paise',
    winningsBalance:      'wallets.winnings_paise',
    lockedBalance:        'wallets.locked_paise',
    reserveBalance:       'wallets.reserve_paise',
    lockedDepositAmount:  'wallets.locked_deposit_paise',
    lockedWinningsAmount: 'wallets.locked_winnings_paise',
    kycData:              'user_kyc (+ kyc_transitions)',
  },
};

function walk(dir, acc = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) { if (!SKIP.has(e.name)) walk(join(dir, e.name), acc); }
    else if (/\.(js|mjs|cjs)$/.test(e.name)) acc.push(relative(ROOT, join(dir, e.name)).split(sep).join('/'));
  }
  return acc;
}

const FILES = walk(join(ROOT, 'backend')).filter((f) => !f.includes('/tests/'));
const SOURCE = new Map(FILES.map((f) => [f, readFileSync(join(ROOT, f), 'utf8')]));
const SCHEMA = readFileSync(join(ROOT, 'backend/postgres/schema.sql'), 'utf8');

/** Every column the schema declares for a table, including later ALTERs. */
function columnsOf(table) {
  const cols = new Set();
  const create = SCHEMA.match(
    new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\s*\\(([\\s\\S]*?)\\n\\);`, 'm'));
  if (create) {
    for (const line of create[1].split('\n')) {
      const m = line.match(/^\s{2}([a-z_]+)\s+[A-Z]/);
      if (m) cols.add(m[1]);
    }
  }
  for (const m of SCHEMA.matchAll(
    new RegExp(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ([a-z_]+)`, 'g'))) {
    cols.add(m[1]);
  }
  return cols;
}

const camelToSnake = (s) => s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();

const splits = [];
const gaps = [];
const relocated = [];

for (const entry of MIGRATED) {
  // ── SPLIT: is this entity still reached through the document store? ───────
  const pattern = new RegExp(
    `mongoose\\.model\\(['"]${entry.model}['"]\\)|\\b${entry.model}\\.(find|create|updateOne|updateMany|deleteOne|deleteMany|findById|findOne|aggregate|countDocuments)`);
  for (const [file, src] of SOURCE) {
    if (file === entry.repo || file.startsWith('backend/postgres/')) continue;
    src.split('\n').forEach((line, i) => {
      if (line.trim().startsWith('*') || line.trim().startsWith('//')) return;
      if (pattern.test(line)) {
        splits.push({ model: entry.model, table: entry.table, file, line: i + 1, text: line.trim() });
      }
    });
  }
}

// ── GAP: a field the code uses with no column behind it ────────────────────
//
// Read from the model file when one still exists, because that is the complete
// list of what the code may touch. Once the model files are gone this check
// narrows to what the repository maps, which is the right thing to compare at
// that point.
for (const entry of MIGRATED) {
  const modelFile = FILES.find((f) => SOURCE.get(f)?.includes(`mongoose.model('${entry.model}'`)
    && f.endsWith('.model.js'));
  if (!modelFile) continue;

  const src = SOURCE.get(modelFile);
  const schemaBlock = src.match(
    new RegExp(`const \\w*[Ss]chema = new mongoose\\.Schema\\(\\{([\\s\\S]*?)\\n\\}`, 'm'));
  if (!schemaBlock) continue;

  const columns = columnsOf(entry.table);
  if (!columns.size) continue;

  for (const m of schemaBlock[1].matchAll(/^\s{2}([a-zA-Z][a-zA-Z0-9]*)\s*:/gm)) {
    const field = m[1];
    const snake = camelToSnake(field);
    // A field may legitimately live in a RELATED table (kycData -> user_kyc,
    // the balances -> wallets) rather than this one. Only report a field with
    // no home anywhere in the schema.
    if (columns.has(snake)) continue;
    const moved = RELOCATED[entry.model]?.[field];
    if (moved) { relocated.push({ model: entry.model, field, moved }); continue; }
    if (new RegExp(`\\b${snake}\\b`).test(SCHEMA)) continue;
    gaps.push({ model: entry.model, table: entry.table, field, expected: snake, modelFile });
  }
}

/**
 * The most splits allowed. Only ever LOWERED.
 *
 * Raising this to make a build pass is the one thing that turns this check into
 * decoration: the number is the whole mechanism.
 */
const SPLIT_BUDGET = 185;

const list = process.argv.includes('--list');
console.log('\nMigration coherence — is what replaced the document store complete?\n');
console.log(`  ${MIGRATED.length} entities claimed migrated`);
console.log(`  ${splits.length} SPLIT  (written in one store, read from the other)`);
console.log(`  ${gaps.length} GAP    (a field the code uses with no column behind it)`);
console.log(`  ${relocated.length} field(s) deliberately relocated to another table\n`);
if (list && relocated.length) {
  console.log('RELOCATED — declared, not missing:');
  for (const r of relocated) console.log(`  ${r.model}.${r.field}  ->  ${r.moved}`);
  console.log('');
}

if (splits.length) {
  console.log('SPLIT — these still reach the document store for a migrated entity:');
  const byModel = new Map();
  for (const s of splits) byModel.set(s.model, [...(byModel.get(s.model) ?? []), s]);
  for (const [model, rows] of byModel) {
    console.log(`\n  ${model} -> ${rows[0].table}`);
    for (const r of (list ? rows : rows.slice(0, 6))) {
      console.log(`    ${r.file}:${r.line}`);
      console.log(`      ${r.text.slice(0, 110)}`);
    }
    if (!list && rows.length > 6) console.log(`    … and ${rows.length - 6} more (--list)`);
  }
  console.log('');
}

if (gaps.length) {
  console.log('GAP — the code has a field with nowhere to put it:');
  for (const g of gaps) {
    console.log(`  ${g.model}.${g.field}  ->  ${g.table}.${g.expected} does not exist`);
    console.log(`      declared in ${g.modelFile}`);
  }
  console.log('');
}

if (gaps.length) {
  console.log('A gap silently drops a value: the column is absent, the read is undefined,');
  console.log('and the feature it belongs to stops working without erroring.\n');
  process.exit(1);
}

if (splits.length > SPLIT_BUDGET) {
  console.log(`SPLIT COUNT WENT UP: ${splits.length} > ${SPLIT_BUDGET}.`);
  console.log('A split writes to one store and reads from the other — the write succeeds,');
  console.log('the read finds nothing, and nothing errors anywhere. Move the read to match');
  console.log('the write, or move the write back, but do not leave them disagreeing.\n');
  process.exit(1);
}

if (splits.length) {
  console.log(`${splits.length} split(s) remain, within the budget of ${SPLIT_BUDGET}.`);
  console.log('Lower SPLIT_BUDGET as sites move; it reaches zero when the migration does.\n');
  process.exit(0);
}
console.log('No entity is split across stores, and no field is missing a column.\n');
