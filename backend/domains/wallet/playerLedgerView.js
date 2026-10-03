// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * What a PLAYER is told about their own wallet history — the ledger and the
 * bonus records — as allowlists, the way `playerOrderView.js` does it for
 * orders (CLAUDE.md §24: an allowlist fails closed).
 *
 * ── What was wrong (2026-10-01) ─────────────────────────────────────────────
 * The ledger row of an admin adjustment carries the admin's note as its
 * description, prefixed with the staff account's id:
 * `[Admin:<staff user id>] Compensation for issue #123`. The admin screen
 * tells the admin that note "is written to the audit log". The player's
 * `GET /api/v1/wallet/ledger` returned the row's description as `reason`, and
 * the wallet's History tab renders `reason` as each entry's title — so every
 * adjustment showed the player which staff account acted and what they
 * privately wrote. The bonus record of a credit holds the same note.
 *
 * The admin's own user-detail screen reads the same ledger and keeps the full
 * text; this is the PLAYER's view of it, applied on the player's routes only.
 */
import { ADJUSTMENT_TX_PREFIX } from '#db/repositories/balanceAdjustments.js';

/** What a player reads for a balance an admin changed by hand. */
export const SUPPORT_CREDIT = 'Credited by support';
export const SUPPORT_DEBIT = 'Debited by support';

const isAdjustment = (entry) => String(entry?.txId ?? '').startsWith(ADJUSTMENT_TX_PREFIX);

/** One ledger entry, as its owner may see it. */
export function toPlayerLedgerEntry(entry) {
  return {
    txId: entry.txId,
    type: entry.type,
    field: entry.field,
    amount: entry.amount,
    balanceBefore: entry.balanceBefore,
    balanceAfter: entry.balanceAfter,
    reason: isAdjustment(entry)
      ? (entry.type === 'DEBIT' ? SUPPORT_DEBIT : SUPPORT_CREDIT)
      : entry.reason,
    createdAt: entry.createdAt,
  };
}

/**
 * The words for each kind of bonus record. A type with no entry here is shown
 * by its name, never hidden — a kind somebody adds later still reaches the
 * player, just less politely.
 */
const BONUS_LABEL = Object.freeze({
  ADMIN_CREDIT: SUPPORT_CREDIT,
});

/** One bonus record, as its owner may see it. Never the admin's note. */
export function toPlayerBonus(record) {
  return {
    bonusId: record.bonusId,
    type: record.type,
    label: BONUS_LABEL[record.type] ?? record.type,
    amount: record.amount,
    createdAt: record.createdAt,
  };
}
