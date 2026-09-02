// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * startup/cronJobs.js — All scheduled background jobs.
 * Single responsibility: register cron intervals, nothing else.
 * Import and call registerCronJobs(rebuildLeaderboard) from server.js after DB init.
 */
import mongoose from 'mongoose';
import { emitOrderUpdate, emitAdminUpdate } from '../domains/notification/realtimeEmitters.js';
// Items 17+56 (2026-07-13): every job runs through the Background Job Platform
// (services/jobQueue.service.js) — BullMQ repeatables with retry/backoff when
// Redis is configured; the historical setInterval + withLeaderLock (X-4 leader
// election) fallback otherwise, so a Redis-less deploy behaves exactly as
// before. The platform wraps each processor in withLeaderLock either way.
import { registerRecurring } from '../services/jobQueue.service.js';
// Item 38 (2026-07-13): money-critical failures page a human via the
// admin-configured webhook; item 33: reconcile failures are counted for /metrics.
import { sendAlert } from '../services/alerting.service.js';
import { ledgerReconcileErrors } from '../services/metrics.service.js';

export function registerCronJobs(rebuildLeaderboard) {

  // ── Leaderboard rebuild every 10 minutes ────────────────────────────────────
  registerRecurring('leaderboard-rebuild', 10 * 60 * 1000, async () => {
    try { await rebuildLeaderboard(); }
    catch (e) { console.error('Leaderboard rebuild error:', e.message); }
  });

  rebuildLeaderboard().catch(e => console.error('Initial leaderboard:', e.message));

  // ── Order expiry worker — runs every 60 seconds ──────────────────────────────
  // Delegates to paymentProcessing.service.js (domain service owns this logic).
  registerRecurring('order-expiry', 60 * 1000, async () => {
    try {
      const { expireOrders } = await import('../domains/payment/paymentProcessing.service.js');
      const count = await expireOrders();
      if (count > 0) console.log(`[expiry-worker] Expired ${count} order(s)`);
    } catch (e) { console.error('[expiry-worker] cron error:', e.message); }
  });

  // ── Withdrawal settlement worker — runs every 60 seconds ────────────────────
  // Settles confirmed withdrawals whose dispute-hold window has passed: consumes
  // the player's locked stake and credits the merchant. Until this runs, neither
  // side has moved, which is what makes a dispute a reversal rather than a
  // clawback (domains/payment/withdrawalHold.service.js).
  //
  // 60s granularity against a hold measured in minutes: a settlement landing up
  // to a minute late is invisible, and polling faster only adds load for orders
  // that are, by definition, deliberately waiting.
  registerRecurring('withdrawal-hold-settle', 60 * 1000, async () => {
    try {
      const { settleDueHolds } = await import('../domains/payment/withdrawalHold.service.js');
      const settled = await settleDueHolds();
      if (settled > 0) console.log(`[withdrawal-hold] Settled ${settled} withdrawal(s) after hold`);
    } catch (e) {
      console.error('[withdrawal-hold] cron error:', e.message);
      sendAlert('withdrawal-hold-worker-failed',
        'Withdrawal settlement worker failed — held withdrawals are not settling', { error: e.message })
        .catch(() => {});
    }
  });

  // ── Scheduled policy apply worker — runs every 60 seconds ──────────────────
  // Activates deposit-policy versions whose effectiveAt has passed. It processes
  // every due item independently and returns a per-item result; a single item's
  // failure is logged, never thrown, so it cannot block the rest of the batch or
  // crash the interval.
  registerRecurring('scheduled-apply', 60 * 1000, async () => {
    try {
      const { applyScheduledPolicyChanges } = await import('../domains/configuration/depositPolicy.service.js');
      const results = await applyScheduledPolicyChanges();
      for (const r of results) {
        if (!r.applied) console.error(`[scheduled-policy] Failed to apply ${r.currency} version ${r.versionId}:`, r.error);
      }
      const applied = results.filter(r => r.applied).length;
      if (applied > 0) console.log(`[scheduled-policy] Applied ${applied} DepositPolicy version(s)`);
    } catch (e) { console.error('[scheduled-policy] cron error:', e.message); }

    // The scheduled-CONFIG sweep that sat here is gone. It swept for config
    // versions marked SCHEDULED, and nothing could ever create one: the single
    // caller of setConfigField passes no effectiveAt, no route exposed an
    // approval endpoint, and no screen offered a future date. It ran every 60
    // seconds over rows that could not exist. The deposit-policy sweep above
    // is different — that one has a real scheduling surface.
  });

  // ── Settlement-ledger reconciliation — runs every 60 seconds ────────────────
  // Revenue & Settlement Platform (BBEPS Phase 007): derives append-only
  // AccountingEvent entries from COMPLETED PaymentOrders and settled Cycles.
  // Idempotent (unique keys), so re-running is always safe; per-item failures
  // are returned as results and logged, never thrown; historical records
  // backfill automatically across the first passes (200 per source per pass).
  registerRecurring('ledger-reconcile', 60 * 1000, async () => {
    try {
      const { reconcileCompletedOrders, reconcileSettledCycles } =
        await import('../domains/revenue/revenueSettlement.service.js');

      const orderResults = await reconcileCompletedOrders();
      for (const r of orderResults) {
        if (r.error) console.error(`[ledger-reconcile] PaymentOrder ${r.refId} failed:`, r.error);
      }
      const cycleResults = await reconcileSettledCycles();
      for (const r of cycleResults) {
        if (r.error) console.error(`[ledger-reconcile] Cycle ${r.refId} failed:`, r.error);
      }

      const failures = [...orderResults, ...cycleResults].filter(r => r.error);
      if (failures.length > 0) {
        ledgerReconcileErrors.inc(failures.length);
        sendAlert('ledger-reconcile-item', `${failures.length} ledger reconciliation item(s) failed`, {
          sample: failures.slice(0, 5).map(r => ({ refId: r.refId, error: String(r.error).slice(0, 200) })),
        });
      }

      const recorded = [...orderResults, ...cycleResults].filter(r => r.recorded).length;
      if (recorded > 0) console.log(`[ledger-reconcile] Recorded ${recorded} accounting event(s)`);
    } catch (e) {
      console.error('[ledger-reconcile] cron error:', e.message);
      sendAlert('ledger-reconcile-cron', 'Ledger reconciliation cron crashed', { error: e.message });
    }
  });

  // ── Merchant Performance Bonus engine — runs every 10 minutes ───────────────
  // Merchant Platform (BBEPS Phase 008). No-ops unless an admin has enabled
  // an ACTIVE MerchantBonusPolicy with a non-zero percentage (Business Policy
  // Platform). Issuance is idempotent (deterministic keys) and pool-capped —
  // re-running is always safe. Per-merchant failures logged, never thrown.
  registerRecurring('bonus-engine', 10 * 60 * 1000, async () => {
    try {
      const { runBonusEngine } = await import('../domains/merchant/merchantBonus.service.js');
      const outcome = await runBonusEngine();
      if (!outcome.ran) return;
      for (const r of outcome.results) {
        if (r.error) console.error(`[bonus-engine] merchant ${r.merchantId} failed:`, r.error);
        else if (!r.issued && r.reason) console.warn(`[bonus-engine] merchant ${r.merchantId} skipped: ${r.reason}`);
      }
      const issued = outcome.results.filter(r => r.issued);
      if (issued.length > 0) {
        console.log(`[bonus-engine] Issued ${issued.length} Merchant Performance Bonus(es):`,
          issued.map(r => `${r.merchantId}: ₹${r.bonusRupees}`).join(', '));
      }
    } catch (e) { console.error('[bonus-engine] cron error:', e.message); }
  });

  // ── Data retention worker — runs daily (Phase X X-7) ────────────────────────
  // Prunes high-volume OPERATIONAL data (settled bets, completed cycles, error
  // reports) older than SystemConfig.retentionMonths. NEVER touches financial/
  // audit/user data (see retention.service.js + docs/governance/RETENTION_POLICY.md). Leader-
  // locked so only one instance prunes; idempotent (re-running finds nothing
  // new); a 30-day safety floor caps misconfiguration.
  registerRecurring('data-retention', 24 * 60 * 60 * 1000, async () => {
    try {
      const { runRetention } = await import('../domains/operations/retention.service.js');
      await runRetention();
    } catch (e) { console.error('[retention] cron error:', e.message); }
  });


  // ── Payment proof retention — runs hourly ──────────────────────────────────
  // Keeps PaymentOrder transaction records while removing high-volume proof
  // image references after 48 hours. Mongo TTL cannot unset a single field, so
  // this job scrubs proofScreenshot/proofExpiresAt without deleting the order.
  registerRecurring('payment-proof-retention', 60 * 60 * 1000, async () => {
    try {
      const PaymentOrder = mongoose.model('PaymentOrder');
      const result = await PaymentOrder.scrubExpiredProofs();
      const modified = result.modifiedCount || 0;
      if (modified > 0) console.log(`[retention] Scrubbed ${modified} expired payment proof(s)`);
    } catch (e) { console.error('[retention] payment proof scrub error:', e.message); }
  });

  // ── Automated database backup — runs daily (plan item 45) ───────────────────
  // mongodump → gzip archive → S3 (backups/), keep newest BACKUP_KEEP (14).
  // Skips loudly (log + alert) when mongodump or S3 is unavailable; a failed
  // backup pages the alert webhook. Restore steps: docs/governance/DISASTER_RECOVERY.md.
  registerRecurring('db-backup', 24 * 60 * 60 * 1000, async () => {
    try {
      const { runBackup } = await import('../services/backup.service.js');
      const r = await runBackup();
      if (r.ok) console.log(`[backup] OK: ${r.key} (${r.kept} kept)`);
    } catch (e) { console.error('[backup] cron error:', e.message); }
  });


  console.log('✅ Cron jobs registered');
}
