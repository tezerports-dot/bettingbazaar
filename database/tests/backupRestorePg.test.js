// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * The backup round trip, against real databases.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * The backup service produced an archive nobody had ever restored. Its own
 * header said "test this on staging before you ever need it" — an instruction
 * addressed to a person, which is another way of saying it had not been done.
 * A backup that has never been restored is not a backup; it is a file.
 *
 * So this dumps a POPULATED database, restores it into an EMPTY one, and asks
 * whether what came back is the same platform.
 *
 * ── What "the same platform" means, and why rows are not enough ─────────────
 * The obvious assertion is that the balances match. That is necessary and it is
 * not sufficient. A restore brings back DATA and SCHEMA separately, and a
 * restore that returns every row without the CHECK constraints and triggers
 * that guard them hands you a database which looks correct and will accept an
 * impossible row on its very next write — a negative balance, a ledger that
 * does not conserve, an append-only table that suddenly permits an UPDATE.
 *
 * That failure is invisible to a row count and catastrophic in production, so
 * the restored database is made to REFUSE things here, not merely to return
 * them.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pgConfigured, pgQuery, applySchema, closePg } from '../client.js';
import { Client } from 'pg';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  dumpToFile, restoreFromFile, pgRestoreAvailable,
} from '../../backend/services/backup.service.js';

// Probed at MODULE SCOPE, not in beforeAll. Vitest registers every test during
// collection, which happens before any hook runs — a flag set in `beforeAll`
// is still false when `it` vs `it.skip` is decided, so the whole suite silently
// skipped while reporting success. Exactly the shape of vacuous pass this
// codebase keeps finding.
const RESTORE_TOOLING = await pgRestoreAvailable();
const describePg = pgConfigured() && RESTORE_TOOLING ? describe : describe.skip;

/** A URL for a sibling database on the same server. */
function siblingUrl(name) {
  const u = new URL(process.env.DATABASE_URL);
  u.pathname = `/${name}`;
  return u.toString();
}

/** Run one statement against `url` on a connection of its own. */
async function onDb(url, sql, params = []) {
  const c = new Client({ connectionString: url });
  await c.connect();
  try { return await c.query(sql, params); } finally { await c.end(); }
}

describePg('the backup round trip', () => {
  const RESTORE_DB = 'bb_restore_drill';
  const archive = path.join(os.tmpdir(), `bb-drill-${Date.now()}.dump`);
  const restoreUrl = siblingUrl(RESTORE_DB);

  // The figures seeded into the source database and looked for afterwards.
  // A fresh id per run, because `wallet_ledger` is append-only: the seed cannot
  // be deleted between runs, so it must not collide with an earlier one. (The
  // first draft of this file tried to DELETE it and the trigger refused —
  // which is the trigger doing its job.)
  const RUN = Math.random().toString(36).slice(2, 8);
  const USER = `u-drill-${RUN}`;
  const DEPOSIT_PAISE = 123_456n;
  const TX = `drill_seed_${Math.random().toString(36).slice(2, 10)}`;

  beforeAll(async () => {
    await applySchema();

    // A user with a real balance and the ledger row that explains it. Seeded
    // through SQL rather than the repositories so the drill tests the ARCHIVE,
    // not the writers — those have their own suites.
    await pgQuery(
      `INSERT INTO users (user_id, username, mobile) VALUES ($1, 'drill', $2)`,
      [USER, `9997${RUN.replace(/\D/g, '0').padEnd(6, '0').slice(0, 6)}`],
    );
    await pgQuery(
      `INSERT INTO wallets (user_id, deposit_paise) VALUES ($1, $2)`,
      [USER, DEPOSIT_PAISE.toString()],
    );
    await pgQuery(
      `INSERT INTO wallet_ledger (tx_id, user_id, field, amount_paise, balance_after_paise, tx_type, description)
       VALUES ($1, $2, 'depositBalance', $3, $3, 'CREDIT', 'drill seed')`,
      [TX, USER, DEPOSIT_PAISE.toString()],
    );

    // A DIFFERENT database, empty, to restore into. Dropped and recreated so a
    // previous run cannot contribute a row and make a failed restore look fine.
    const admin = siblingUrl('postgres');
    await onDb(admin, `DROP DATABASE IF EXISTS ${RESTORE_DB}`);
    await onDb(admin, `CREATE DATABASE ${RESTORE_DB}`);

    await dumpToFile(archive, process.env.DATABASE_URL);
    await restoreFromFile(archive, restoreUrl);
  }, 180_000);

  afterAll(async () => {
    try { fs.unlinkSync(archive); } catch { /* already gone */ }
    try { await onDb(siblingUrl('postgres'), `DROP DATABASE IF EXISTS ${RESTORE_DB}`); }
    catch { /* leave it; the next run drops it */ }
    await closePg();
  }, 60_000);

  it('produces an archive with something in it', () => {
    // A zero-byte archive is the failure mode that looks most like success: the
    // job runs, the upload succeeds, retention prunes, and the file restores to
    // nothing.
    expect(fs.existsSync(archive)).toBe(true);
    expect(fs.statSync(archive).size).toBeGreaterThan(10_000);
  });

  it('restores every table, not just the ones with rows', async () => {
    const src = await pgQuery(
      `SELECT count(*)::int AS n FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`);
    const dst = await onDb(restoreUrl,
      `SELECT count(*)::int AS n FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`);
    expect(dst.rows[0].n).toBe(src.rows[0].n);
    expect(dst.rows[0].n).toBeGreaterThan(50);
  });

  it('brings the money back to the paise', async () => {
    const { rows } = await onDb(restoreUrl,
      'SELECT deposit_paise FROM wallets WHERE user_id = $1', [USER]);
    expect(rows).toHaveLength(1);
    // Compared as a STRING. BIGINT arrives from node-postgres as one, and a
    // Number() round trip is exactly the cast this codebase gets wrong when it
    // is done anywhere but the read boundary.
    expect(rows[0].deposit_paise).toBe(DEPOSIT_PAISE.toString());
  });

  it('brings back the ledger row that explains the balance', async () => {
    const { rows } = await onDb(restoreUrl,
      'SELECT tx_id, amount_paise, tx_type FROM wallet_ledger WHERE user_id = $1', [USER]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tx_id: TX, tx_type: 'CREDIT' });
    expect(rows[0].amount_paise).toBe(DEPOSIT_PAISE.toString());
  });

  // ── The half a row count cannot see ───────────────────────────────────────

  it('does NOT constrain balances to be non-negative, and that is deliberate', async () => {
    // Worth writing down, because the obvious assertion here is the opposite.
    //
    // A first draft of this drill asserted a CHECK forbidding a negative
    // pocket, and adding one broke two tests that turned out to be documenting
    // real behaviour: a bonus clawback may drive a balance negative because the
    // money can already be spent, and refusing to record a reversal that has
    // already happened is worse than recording an uncomfortable number; and the
    // corrective admin path may do the same under authorisation.
    //
    // So the overdraft guard is `AND column + $delta >= 0` in the movement's
    // own UPDATE, inside the transaction that holds the row lock — and that is
    // the RIGHT mechanism precisely because an authorised caller can bypass it
    // by passing `allowNegative`. A CHECK cannot be bypassed, which would make
    // a legitimate correction unrepresentable.
    //
    // The restore therefore carries no such constraint, and this pins that the
    // absence is a decision rather than an omission somebody should 'fix'.
    const r = await onDb(restoreUrl,
      'UPDATE wallets SET deposit_paise = -1 WHERE user_id = $1 RETURNING deposit_paise', [USER]);
    expect(r.rows[0].deposit_paise).toBe('-1');
    await onDb(restoreUrl,
      'UPDATE wallets SET deposit_paise = $2 WHERE user_id = $1',
      [USER, DEPOSIT_PAISE.toString()]);
  });

  it('restores the append-only trigger on the audit trail', async () => {
    // The ledger is append-only because a money platform's audit trail must not
    // be editable. A restore that dropped the trigger leaves a table that still
    // LOOKS append-only — same columns, same rows — and silently is not.
    await expect(onDb(restoreUrl,
      `UPDATE wallet_ledger SET amount_paise = 1 WHERE user_id = $1`, [USER]),
    ).rejects.toThrow();
  });

  it('restores the UNIQUE that makes tx_id an idempotency gate', async () => {
    // Without it a replayed movement inserts a second row and the money moves
    // twice — the single most expensive thing a restore can quietly lose.
    await expect(onDb(restoreUrl,
      `INSERT INTO wallet_ledger (tx_id, user_id, field, amount_paise, balance_after_paise, tx_type)
       VALUES ($1, $2, 'depositBalance', 1, 1, 'CREDIT')`, [TX, USER]),
    ).rejects.toThrow(/duplicate key|unique/i);
  });

  it('restores the double-entry conservation trigger', async () => {
    // Postings that do not sum to zero are money created from nothing. The
    // trigger is what makes that unrepresentable; a restore that lost it turns
    // the ledger back into a suggestion.
    await expect(onDb(restoreUrl,
      `INSERT INTO accounting_events (idempotency_key, event_type, amount_paise, postings)
       VALUES ('drill-unbalanced', 'DEPOSIT', 100,
               '[{"account":"USER_WALLET","amountPaise":100}]'::jsonb)`),
    ).rejects.toThrow();
  });
});
