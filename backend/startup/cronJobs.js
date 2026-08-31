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
import { ledgerReconcileErrors, stalledSettlements, stalledSettlementBets } from '../services/metrics.service.js';
import { findIncompleteSettlements } from '../postgres/settlementPg.js';
import { anyPathOnPostgres } from '../postgres/moneyAuthority.js';

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

  // ── Scheduled policy/config apply worker — runs every 60 seconds ────────────
  // Activates DepositPolicy versions and ConfigVersion field changes whose
  // effectiveAt has passed. Both functions process every due item independently
  // and return a per-item result; a single item's failure is logged, never
  // thrown, so it can't block the rest of the batch or crash the interval.
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

    try {
      const { applyScheduledConfigChanges } = await import('../domains/configuration/configVersioning.service.js');
      const results = await applyScheduledConfigChanges();
      for (const r of results) {
        if (!r.applied) console.error(`[scheduled-config] Failed to apply version ${r.versionId}:`, r.error);
      }
      const applied = results.filter(r => r.applied).length;
      if (applied > 0) console.log(`[scheduled-config] Applied ${applied} config version(s)`);
    } catch (e) { console.error('[scheduled-config] cron error:', e.message); }
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

      // ── Stalled settlements ─────────────────────────────────────────────
      // A run marked COMPLETED while bets on its cycle are still PENDING is a
      // player's stake locked with nothing coming to release it — never paid,
      // never lost, never refunded.
      //
      // `findIncompleteSettlements()` was written for exactly this, described
      // in its own module as "the strongest check", cited in four other
      // modules' comments — and had NO production call site. It was a query
      // nobody ran. This is that call site.
      //
      // Postgres-only by nature (it reads `cycle_settlements`), so it no-ops
      // while every path is still on Mongo rather than throwing on a missing
      // table. It does not REPAIR anything: the repair for a stalled run is a
      // settlement pass, and quietly re-running one from a metrics cron would
      // hide the condition instead of surfacing it.
      if (anyPathOnPostgres()) {
        const stalled = await findIncompleteSettlements();
        const betsStuck = stalled.reduce((n, s) => n + s.stillPending, 0);
        stalledSettlements.set(stalled.length);
        stalledSettlementBets.set(betsStuck);
        if (stalled.length > 0) {
          console.error(`[ledger-reconcile] ${stalled.length} stalled settlement(s), ${betsStuck} bet(s) stuck PENDING`);
          sendAlert('settlement-stalled',
            `${stalled.length} settlement run(s) COMPLETED with ${betsStuck} bet(s) still PENDING — stakes are locked`, {
              sample: stalled.slice(0, 5).map(s => ({
                cycleId: s.cycleId, betsSettled: s.betsSettled, stillPending: s.stillPending,
              })),
            });
        }
      }
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

  // ── Hybrid money-DB continuous reconciliation (AQ-9) — every 5 minutes ──────
  // No-ops unless DATABASE_URL is set (Postgres provisioned + dual-write live).
  // While dual-write runs toward cutover, this proves Mongo and Postgres agree
  // on every money table and that the PG ledger conserves to zero — surfacing
  // drift as a metric + alert instead of waiting for a manual `reconcile:pg`.
  // Detection ONLY: it never auto-backfills — a human decides how to resolve
  // drift. Leader-locked (via the platform) so one instance reconciles.
  registerRecurring('pg-reconcile', 5 * 60 * 1000, async () => {
    try {
      const { pgConfigured } = await import('../postgres/pgClient.js');
      if (!pgConfigured()) return; // dormant until Postgres is wired
      const { runReconcile } = await import('../postgres/reconcile.js');
      const { ALL_PATHS, isPostgresAuthoritative, anyPathOnPostgres } =
        await import('../postgres/moneyAuthority.js');
      const {
        pgDriftRows, pgTrialBalanceOk, pgReconcileConsecutiveClean,
        mongoDriftRows, ledgersAgree, moneyAuthorityPostgres,
        balanceDriftPaise, balanceDriftAccounts,
      } = await import('../services/metrics.service.js');

      // Publish the current source-of-truth matrix so the dashboard shows which
      // paths have moved, and an alert can fire if one moves unexpectedly.
      for (const path of ALL_PATHS) {
        moneyAuthorityPostgres.set({ path }, isPostgresAuthoritative(path) ? 1 : 0);
      }

      // runReconcile turns the reverse pass on by itself once any path is
      // PG-authoritative; asking for it explicitly keeps this job's behaviour
      // readable at the call site rather than implicit.
      const cutoverActive = anyPathOnPostgres();
      const report = await runReconcile({ hours: 24, reverse: cutoverActive });

      const missing = report.results.reduce((s, r) => s + r.missingInPg, 0);
      pgDriftRows.set(missing);
      pgTrialBalanceOk.set(report.trialBalance.conservesToZero ? 1 : 0);

      // Reverse direction: only meaningful after a cutover, but the gauges are
      // always published so a Grafana panel never shows "no data" — before the
      // cutover the honest reading is "zero drift, ledgers agree".
      const missingInMongo = (report.reverse || []).reduce((s, r) => s + r.missingInMongo, 0);
      mongoDriftRows.set(missingInMongo);
      ledgersAgree.set(report.ledgersAgree ? (report.ledgersAgree.agree ? 1 : 0) : 1);

      // Balance disagreement, which the row counts above cannot see. An orphan
      // wallet row counts as a drifted account: it is money in Postgres that no
      // Mongo merchant owns, and it must not read as clean.
      const mb = report.merchantBalances;
      balanceDriftPaise.set({ path: 'merchant_wallet' }, mb.totalDriftPaise);
      balanceDriftAccounts.set(
        { path: 'merchant_wallet' },
        mb.driftedBeforeRepair + mb.orphansInPg + report.merchantLedgers.unexplained,
      );

      if (report.drift) {
        pgReconcileConsecutiveClean.set(0); // any drift breaks the cutover-readiness streak
        console.error(
          `[pg-reconcile] DRIFT: ${missing} row(s) missing in PG, ${missingInMongo} missing in Mongo, ` +
          `pgTrialBalanceOk=${report.trialBalance.conservesToZero}, ` +
          `merchantBalanceDrift=${mb.driftedBeforeRepair} account(s)/${mb.totalDriftPaise}p, ` +
          `merchantOrphanWallets=${mb.orphansInPg}, unexplainedMerchantBalances=${report.merchantLedgers.unexplained}` +
          (report.ledgersAgree ? `, ledgersAgree=${report.ledgersAgree.agree}` : '')
        );
        sendAlert('pg-drift', 'Hybrid money-DB drift detected (Mongo vs Postgres)', {
          missingInPg: missing,
          missingInMongo,
          trialBalanceOk: report.trialBalance.conservesToZero,
          merchantBalanceDrift: {
            accounts: mb.driftedBeforeRepair,
            totalPaise: mb.totalDriftPaise,
            orphanWalletsInPg: mb.orphansInPg,
            sample: mb.sampleDrift,
          },
          unexplainedMerchantBalances: report.merchantLedgers.sample,
          // After a cutover, a Mongo shortfall is the more urgent of the two: it
          // is the store the rollback plan falls back to, so every missing row
          // is a write that a fallback would lose.
          cutoverActive,
          ledgerDifferences: report.ledgersAgree?.differences?.slice(0, 10) ?? [],
          perTable: report.results.filter(r => r.missingInPg > 0)
            .map(r => ({ table: r.table, missing: r.missingInPg, sample: r.sampleMissing })),
          perTableReverse: (report.reverse || []).filter(r => r.missingInMongo > 0)
            .map(r => ({ table: r.table, missing: r.missingInMongo, sample: r.sampleMissing })),
        });
      } else {
        // Clean pass — advance the cutover gate. This is the signal to watch
        // before a cutover: it must stay high over a sustained window
        // (DATA_ROLLBACK_PLAN.md). Any drift or crash resets it to 0.
        pgReconcileConsecutiveClean.inc();
      }
    } catch (e) {
      console.error('[pg-reconcile] cron error:', e.message);
      try {
        const { pgReconcileErrors, pgReconcileConsecutiveClean } = await import('../services/metrics.service.js');
        pgReconcileErrors.inc();
        pgReconcileConsecutiveClean.set(0); // a failed run is not a clean run
      } catch { /* metrics optional */ }
      sendAlert('pg-reconcile-cron', 'Postgres reconciliation cron crashed', { error: e.message });
    }
  });

  console.log('✅ Cron jobs registered');
}
