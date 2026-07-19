// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * domains/operations/retention.service.js — data retention (Phase X X-7).
 *
 * Prunes HIGH-VOLUME OPERATIONAL data that dominates DB growth once it is old
 * and no longer needed for live features — settled bets, completed cycles,
 * frontend error reports. It NEVER touches financial, audit, or user data:
 * the money history and the append-only ledgers are kept forever.
 *
 * WHY THIS IS SAFE FOR FINANCIAL INTEGRITY (see docs/governance/RETENTION_POLICY.md):
 *   - The double-entry ledger (AccountingEvent) is DERIVED and stored
 *     independently; a settled cycle's net result is already recorded as a
 *     BET_CYCLE_SETTLED event long before the retention window (months) — so
 *     deleting the source Cycle/Bet docs changes no balance.
 *   - Per-user money history lives in Transaction + WalletLedger (preserved).
 *   - The reconciler only scans NOT-yet-recorded sources; pruned (already
 *     recorded) cycles are simply never re-scanned.
 *
 * HARD RULES:
 *   - Only the models in PRUNABLE below can ever be pruned. Financial/audit/
 *     user models are not reachable from here.
 *   - A safety floor (MIN_FLOOR_DAYS) means nothing younger than ~1 month is
 *     ever deleted, even if the admin misconfigures the window to 0.
 *   - Only SETTLED/COMPLETED records are eligible — never pending/in-flight.
 */
import mongoose from 'mongoose';
import { logger } from '../../services/logger.js';

const MIN_FLOOR_DAYS = 30; // never delete anything younger than this, ever
const DELETE_BATCH = 5000;

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

// The ONLY collections retention may prune. Each entry: model name + the
// filter selecting eligible-and-old records. No financial/audit/user model
// appears here — that is the structural guarantee.
function prunablePlan(cutoff) {
  return [
    {
      model: 'Bet',
      // settled bets only (never PENDING); old by settlement or placement time
      filter: {
        status: { $in: ['WON', 'LOST', 'REFUNDED'] },
        $or: [{ settledAt: { $lt: cutoff } }, { settledAt: { $exists: false }, timestamp: { $lt: cutoff } }],
      },
    },
    {
      model: 'Cycle',
      filter: { isSettled: 'COMPLETED', settledAt: { $lt: cutoff } },
    },
    {
      model: 'FrontendErrorReport',
      filter: { ts: { $lt: cutoff } },
    },
  ];
}

async function pruneOne(modelName, filter, dryRun) {
  let Model;
  try { Model = mongoose.model(modelName); }
  catch { return { model: modelName, skipped: 'model not registered', deleted: 0 }; }

  const eligible = await Model.countDocuments(filter);
  if (dryRun || eligible === 0) {
    return { model: modelName, eligible, deleted: 0, dryRun: !!dryRun };
  }

  // Batch the delete so a huge backlog doesn't lock the collection in one shot.
  let deleted = 0;
  // deleteMany is already server-side; batching via a capped id set keeps each
  // op bounded and cancellable between batches.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const ids = await Model.find(filter).select('_id').limit(DELETE_BATCH).lean();
    if (ids.length === 0) break;
    const res = await Model.deleteMany({ _id: { $in: ids.map(d => d._id) } });
    deleted += res.deletedCount || 0;
    if (ids.length < DELETE_BATCH) break;
  }
  return { model: modelName, eligible, deleted };
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
      const SystemConfig = mongoose.model('SystemConfig');
      const cfg = await SystemConfig.findOne({ key: 'main' }).select('retentionMonths').lean();
      m = cfg?.retentionMonths;
    } catch { /* fall back to default below */ }
  }
  const cutoff = retentionCutoff(m);
  const plan = prunablePlan(cutoff);

  const results = [];
  for (const { model, filter } of plan) {
    try {
      results.push(await pruneOne(model, filter, dryRun));
    } catch (e) {
      results.push({ model, error: e.message, deleted: 0 });
      logger.error(`[retention] prune ${model} failed`, { error: e.message });
    }
  }

  const totalDeleted = results.reduce((s, r) => s + (r.deleted || 0), 0);
  if (totalDeleted > 0 || dryRun) {
    logger.info(`[retention] cutoff ${cutoff.toISOString()} — ${dryRun ? 'dry-run' : 'pruned'}`, { results });
  }
  return { cutoff, dryRun, results, totalDeleted };
}
