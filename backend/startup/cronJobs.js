// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * startup/cronJobs.js — All scheduled background jobs.
 * Single responsibility: register cron intervals, nothing else.
 * Import and call registerCronJobs(rebuildLeaderboard) from server.js after DB init.
 */
import { db } from '#db';
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

  // ── The merchant's own clock, on a PAID buy — every 2 minutes ───────────────
  // The expiry worker cancels orders nobody paid for. This one handles the
  // opposite case: the player DID pay and the merchant has said nothing. It
  // cannot cancel — the money is already gone — so it sends the order to the
  // admin queue and counts the silence against the merchant.
  //
  // Two minutes rather than sixty seconds: the window it enforces is measured
  // in tens of minutes, so a sweep landing a minute late is invisible, and this
  // one writes to three places per order it finds.
  registerRecurring('paid-order-timeout', 2 * 60 * 1000, async () => {
    try {
      const { sweepUnansweredPaidDeposits } = await import('../domains/payment/paymentProcessing.service.js');
      const n = await sweepUnansweredPaidDeposits();
      if (n > 0) console.warn(`[paid-timeout] ${n} paid order(s) went to the admin queue unanswered`);
    } catch (e) { console.error('[paid-timeout] cron error:', e.message); }
  });

  // ── The player's half of the same clock — every 2 minutes ──────────────────
  // A cash buy reaches PAID on the player's tap, so the merchant can carry on
  // at a machine that is timing out, and the reference follows. This catches
  // the ones where it never does.
  //
  // Separate from `paid-order-timeout` above on purpose: that one is the
  // merchant's silence and records a REFUSAL against them, and these orders are
  // ones the merchant CANNOT act on — their Confirm refuses without a
  // reference. One sweep for both would suspend a merchant for a player's
  // delay (§2: whose fault an expiry is depends on the DIRECTION).
  registerRecurring('utr-after-paid-timeout', 2 * 60 * 1000, async () => {
    try {
      const { sweepUtrAfterPaid } = await import('../domains/payment/paymentProcessing.service.js');
      const n = await sweepUtrAfterPaid();
      if (n > 0) console.warn(`[utr-timeout] ${n} cash order(s) went to the admin queue with no reference`);
    } catch (e) { console.error('[utr-timeout] cron error:', e.message); }
  });

  // ── Team pool hold sweep — runs every 5 minutes ─────────────────────────────
  // The net under every path that ends a buy. A hold whose order ended without
  // spending it is RELEASED back to the team's pool (a path forgot); a
  // COMPLETED buy still holding is REPORTED, never fixed, because its player
  // was credited and the tokens are owed to them, not to the team.
  registerRecurring('team-pool-hold-sweep', 5 * 60 * 1000, async () => {
    try {
      const stranded = await db.teamPools.findStrandedBuyHolds();
      let released = 0;
      for (const h of stranded) {
        try {
          await db.teamPools.releaseBuyHold(h.orderId, { actor: 'system:hold-sweep', reason: `Order ended ${h.state} still holding` });
          released += 1;
        } catch (e) { console.error(`[team-pool] release of ${h.orderId} failed:`, e.message); }
      }
      const unspent = await db.teamPools.findCompletedUnspentBuys();
      if (released || unspent.length) {
        console.warn('[team-pool] hold sweep:', JSON.stringify({ released, unspent: unspent.map((u) => u.orderId) }));
      }
      if (unspent.length) {
        sendAlert('team-pool-unspent-completed',
          'Completed buy orders still hold team pool tokens — the player was credited but the pool was never charged',
          { orders: unspent.map((u) => u.orderId) }).catch(() => {});
      }
    } catch (e) { console.error('[team-pool] cron error:', e.message); }
  });

  // ── Team commission sweep — runs every 5 minutes ───────────────────────────
  // Commission is paid the moment an order completes (Step 2e); this pays what
  // that missed: a payment that failed after the completion committed, or one
  // the commission pool could not cover until an admin topped it up.
  registerRecurring('team-commission-sweep', 5 * 60 * 1000, async () => {
    try {
      const { payOwedCommissions } = await import('../domains/team/teamCommission.service.js');
      const results = await payOwedCommissions();
      const paid = results.filter((r) => r.paid).length;
      if (paid > 0) console.log(`[team-commission] Paid ${paid} team commission(s) in the sweep`);
    } catch (e) { console.error('[team-commission] cron error:', e.message); }
  });

  // ── Red flags — hourly, each IST day evaluated once ────────────────────────
  // Step 2f: low activity per member and commission farming per team, for the
  // days that have ended. The day's row is the once-only guard, so the hourly
  // run is a catch-up after downtime rather than a repeat.
  registerRecurring('team-red-flags', 60 * 60 * 1000, async () => {
    try {
      const { runDailyRedFlags } = await import('../domains/team/teamOversight.service.js');
      for (const r of await runDailyRedFlags()) {
        if (r.evaluated) console.log(`[red-flags] ${r.day}: ${r.lowActivity} low-activity, ${r.commissionFarming} commission-farming`);
      }
    } catch (e) { console.error('[red-flags] cron error:', e.message); }
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
  // The BUY escrow window (2c+): a buy the member rejected as unpaid keeps
  // its team pool hold while the player may dispute; when the window closes
  // with no dispute, the buy is cancelled and the hold goes back to the pool.
  registerRecurring('rejected-buy-window', 60 * 1000, async () => {
    try {
      const { closeRejectedBuyWindows } = await import('../domains/payment/rejectedBuyWindow.service.js');
      const n = await closeRejectedBuyWindows();
      if (n > 0) console.log(`[reject-window] Closed ${n} rejected buy window(s); holds returned to their pools`);
    } catch (e) {
      console.error('[reject-window] cron error:', e.message);
      sendAlert('rejected-buy-window-failed',
        'Rejected-buy window sweep failed — team tokens stay in escrow after their window closed', { error: e.message })
        .catch(() => {});
    }
  });

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

  // ── Queued orders, offered to the teams again — runs every 30 seconds ──────
  // An order created while every member on its rail was busy, not Ready, or
  // short of pool tokens waits PENDING_QUEUE. Nothing else looks at it again
  // when a member frees up, so this sweep does, until the order is taken or
  // its assignment wait runs out and the expiry sweep ends it.
  registerRecurring('order-assignment', 30 * 1000, async () => {
    try {
      const { assignQueuedOrders } = await import('../domains/payment/paymentProcessing.service.js');
      const { assigned } = await assignQueuedOrders();
      if (assigned > 0) console.log(`[order-assignment] Assigned ${assigned} queued order(s) to team members`);
    } catch (e) {
      console.error('[order-assignment] cron error:', e.message);
      sendAlert('order-assignment-failed',
        'Queued order assignment failed — orders may sit waiting while members are free', { error: e.message })
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
    // versions marked SCHEDULED, and nothing could ever create one: no config
    // write ever passed an effectiveAt, no route exposed an
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
  // Keeps the ORDER — it is the financial record — while dropping the
  // high-volume proof screenshot once its retention window has passed. One
  // statement clears both the image and its expiry, so an order cannot end up
  // with a cleared expiry and a proof still attached.
  registerRecurring('payment-proof-retention', 60 * 60 * 1000, async () => {
    try {
      const scrubbed = await db.orders.scrubExpiredProofs();
      if (scrubbed > 0) console.log(`[retention] Scrubbed ${scrubbed} expired payment proof(s)`);
    } catch (e) { console.error('[retention] payment proof scrub error:', e.message); }
  });

  // ── Automated database backup — runs daily ─────────────────────────────────
  // pg_dump (custom format) → S3 (backups/), keeping the newest BACKUP_KEEP
  // (14). Skips loudly (log + alert) when pg_dump or S3 is unavailable; a
  // failed backup pages the alert webhook. Restore steps:
  // docs/governance/DISASTER_RECOVERY.md.
  registerRecurring('db-backup', 24 * 60 * 60 * 1000, async () => {
    try {
      const { runBackup } = await import('../services/backup.service.js');
      const r = await runBackup();
      if (r.ok) console.log(`[backup] OK: ${r.key} (${r.kept} kept)`);
    } catch (e) { console.error('[backup] cron error:', e.message); }
  });


  console.log('✅ Cron jobs registered');
}
