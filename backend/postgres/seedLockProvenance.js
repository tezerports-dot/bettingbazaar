// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * postgres/seedLockProvenance.js — the one piece of wallet state the forward
 * mirror cannot carry, seeded before a wallet cutover.
 *
 *     npm run pg:seed-locks            # copy the split for every locked user
 *     npm run pg:seed-locks -- --check # report drift, write nothing
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * dualWrite.js populates `wallets` from WalletLedger rows: each row carries the
 * post-movement balance for ONE field, and the mirror writes it to the matching
 * column. That covers every balance a ledger row names.
 *
 * `lockedDepositAmount` / `lockedWinningsAmount` are never a ledger row's
 * field. They are provenance counters — how much of `lockedBalance` came from
 * each pocket — that the Mongo path `$inc`s alongside the movement without
 * recording separately. So `locked_deposit_paise` and `locked_winnings_paise`
 * would still be 0 at the moment a flip happened, and the first settlement to
 * release a stake would unwind a split that Postgres never learned.
 *
 * Running this immediately before setting MONEY_AUTHORITY_WALLET=postgres
 * closes that gap. It is idempotent and safe to re-run: it copies the current
 * Mongo values, it does not accumulate.
 *
 * ── Ordering requirement ────────────────────────────────────────────────────
 * Run it while MongoDB is STILL authoritative and after a clean reconcile pass.
 * Running it afterwards would copy stale Mongo values over the live Postgres
 * ones — see LAUNCH_READINESS.md §E.
 */
import mongoose from 'mongoose';
import { getPool, pgConfigured } from './pgClient.js';
import { rupeesToPaise } from '../shared/money.js';

/**
 * @param {object} [options]
 * @param {boolean} [options.check=false] report only; make no writes.
 * @returns {Promise<{scanned, seeded, drifted, wouldChange}>}
 */
export async function seedLockProvenance({ check = false } = {}) {
  if (!pgConfigured()) throw new Error('DATABASE_URL is unset — nothing to seed');

  const User = mongoose.model('User');
  const pool = await getPool();
  const client = await pool.connect();

  const result = { scanned: 0, seeded: 0, drifted: 0, wouldChange: [] };

  try {
    // Only users who actually have something locked. A user with no lock has
    // nothing to seed, and zero is already the column default.
    const cursor = User.find(
      { $or: [{ lockedDepositAmount: { $gt: 0 } }, { lockedWinningsAmount: { $gt: 0 } }] },
      { lockedDepositAmount: 1, lockedWinningsAmount: 1 },
    ).lean().cursor();

    for await (const user of cursor) {
      result.scanned++;
      const uid = String(user._id);
      const depositPaise  = rupeesToPaise(user.lockedDepositAmount  || 0);
      const winningsPaise = rupeesToPaise(user.lockedWinningsAmount || 0);

      const { rows } = await client.query(
        `SELECT locked_deposit_paise, locked_winnings_paise FROM wallets WHERE user_id = $1`,
        [uid],
      );
      const current = rows[0];
      const same = current
        && Number(current.locked_deposit_paise)  === depositPaise
        && Number(current.locked_winnings_paise) === winningsPaise;
      if (same) continue;

      result.drifted++;
      if (check) {
        result.wouldChange.push({ userId: uid, depositPaise, winningsPaise });
        continue;
      }

      await client.query(
        `INSERT INTO wallets (user_id, locked_deposit_paise, locked_winnings_paise, updated_at)
         VALUES ($1,$2,$3,now())
         ON CONFLICT (user_id) DO UPDATE
            SET locked_deposit_paise = $2, locked_winnings_paise = $3, updated_at = now()`,
        [uid, depositPaise, winningsPaise],
      );
      result.seeded++;
    }
  } finally {
    client.release();
  }

  return result;
}

// ── CLI ─────────────────────────────────────────────────────────────────────
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  const check = process.argv.includes('--check');
  if (!pgConfigured()) { console.error('DATABASE_URL not set — nothing to seed.'); process.exit(1); }
  if (!process.env.MONGODB_URI) { console.error('MONGODB_URI not set.'); process.exit(1); }

  await mongoose.connect(process.env.MONGODB_URI);
  await import('../models/index.js');
  try {
    const r = await seedLockProvenance({ check });
    console.log(
      check
        ? `🔍 ${r.scanned} locked users scanned, ${r.drifted} would change.`
        : `✅ ${r.scanned} locked users scanned, ${r.seeded} seeded into Postgres.`,
    );
    if (check && r.wouldChange.length) console.log(JSON.stringify(r.wouldChange.slice(0, 20), null, 2));
  } finally {
    await mongoose.disconnect();
    const { closePg } = await import('./pgClient.js');
    await closePg();
  }
}
