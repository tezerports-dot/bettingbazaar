// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * domains/operations/retention.service.js — data retention.
 *
 * Prunes HIGH-VOLUME OPERATIONAL data that dominates database growth once it is
 * old and no longer needed: crash reports, expired referral clicks, expired
 * notifications. It NEVER touches financial, audit or user data — the money
 * history and the append-only ledgers are kept forever.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHAT THIS NO LONGER PRUNES, AND WHY THAT IS THE FIX
 * ══════════════════════════════════════════════════════════════════════════
 * The plan used to include settled BETS and completed CYCLES, on the reasoning
 * that a cycle's net result is already recorded as a BET_CYCLE_SETTLED ledger
 * event, so deleting the source rows "changes no balance".
 *
 * The balance, no. Everything else, yes. The bets ARE the source of:
 *
 *   • the real cycle pools, which are DERIVED and not stored (trap 4) — a
 *     pruned cycle's pools become zero, so its history entry claims nobody
 *     ever bet on it;
 *   • `cyclePayoutTotals`, which reconstructs what a cycle paid from its rows,
 *     precisely so a resumed settlement pass cannot undercount;
 *   • every analytics figure over betting volume, profit and player activity;
 *   • the funding split a refund needs, reconstructed from the placement
 *     ledger rows keyed to the bet.
 *
 * Deleting them does not corrupt the money. It deletes the evidence for it,
 * which in a real-money product is the thing an auditor asks for. If bet
 * volume genuinely becomes a storage problem, the answer is a rollup table
 * written BEFORE the source rows go — not a delete that silently rewrites
 * history to say the platform had no players.
 *
 * ── The safety floor is in the statement ───────────────────────────────────
 * Nothing younger than 30 days is ever deleted, whatever the admin sets. The
 * floor can only make the window LONGER, so a misconfigured zero cannot reach
 * fresh data.
 */
import { db } from '#db';
import { logger } from '../../services/logger.js';
import { getSystemConfig } from '#db/repositories/config.js';

const MIN_FLOOR_DAYS = 30; // never delete anything younger than this, ever

/** Compute the cutoff date `months` before now, clamped by the safety floor. */
export function retentionCutoff(months, now = new Date()) {
  const m = Number.isFinite(months) && months >= 1 ? Math.floor(months) : 6;
  const byMonths = new Date(now);
  byMonths.setMonth(byMonths.getMonth() - m);
  const floor = new Date(now.getTime() - MIN_FLOOR_DAYS * 24 * 60 * 60 * 1000);
  // Whichever is EARLIER (further in the past) — the floor can only make the
  // window LONGER, never shorter, so a tiny/zero config can't nuke fresh data.
  return byMonths < floor ? byMonths : floor;
}

/**
 * runRetention — prune operational data older than `months` (default read
 * from SystemConfig.retentionMonths). Pass { dryRun: true } to only count.
 * Returns per-collection results; never throws into the caller (cron-safe).
 */
export async function runRetention({ months, dryRun = false } = {}) {
  let m = months;
  if (m === undefined) {
    try {
      const cfg = await getSystemConfig();
      m = cfg?.retentionMonths;
    } catch { /* fall back to the default below */ }
  }
  const cutoff = retentionCutoff(m);
  // Months, derived back from the clamped cutoff rather than from the raw
  // input, so the safety floor reaches the statement that does the deleting.
  const effectiveMonths = Math.max(
    1, Math.round((Date.now() - cutoff.getTime()) / (30 * 24 * 60 * 60 * 1000)),
  );

  let results = {};
  let totalDeleted = 0;
  try {
    results = dryRun
      ? await db.operations.countPrunableData({ months: effectiveMonths })
      : await db.operations.pruneOperationalData({ months: effectiveMonths });
    totalDeleted = Object.values(results).reduce((sum, n) => sum + (Number(n) || 0), 0);
  } catch (e) {
    // Never throws into the caller: this runs from cron, and a retention
    // failure must not take a scheduled run down with it.
    logger.error('[retention] prune failed', { error: e.message });
    return { cutoff, dryRun, results: { error: e.message }, totalDeleted: 0 };
  }

  if (totalDeleted > 0 || dryRun) {
    logger.info(
      `[retention] cutoff ${cutoff.toISOString()} — ${dryRun ? 'would prune' : 'pruned'}`,
      { results },
    );
  }
  return { cutoff, dryRun, results, totalDeleted };
}
