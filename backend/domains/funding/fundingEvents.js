// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
// Domain: Funding Platform (BBEPS Phase 009).
//
// FUNDING EVENTS — first real wiring of eventBus.service.js (Phase 010 of
// the original roadmap said "wire, don't rewrite" — this is that wiring).
//
// Publishers:
//   - fundingAuthority.service.js → PAYMENT_ORDER_CREATED on every new
//     deposit/withdrawal intent.
//   - merchant.routes.js (confirm + approve) → PAYMENT_ORDER_COMPLETED when
//     an order completes on the live paths.
//
// Subscribers (registered once at startup from server.js):
//   - PAYMENT_ORDER_COMPLETED → nudge the Revenue & Settlement reconciler
//     immediately, so ledger entries appear within seconds of completion
//     instead of waiting for the 60s cron. The cron remains the safety net
//     (idempotent either way); a subscriber failure can never affect the
//     money flow.

import { subscribe, EVENTS } from '../../services/eventBus.service.js';

let registered = false;
let reconcilePending = false;

export function registerFundingEventSubscribers() {
  if (registered) return; // idempotent — safe against double startup calls
  registered = true;

  subscribe(EVENTS.PAYMENT_ORDER_COMPLETED, async () => {
    // Debounce: one reconciliation at a time; the cron catches stragglers.
    if (reconcilePending) return;
    reconcilePending = true;
    try {
      const { reconcileCompletedOrders } = await import('../revenue/revenueSettlement.service.js');
      const results = await reconcileCompletedOrders(20);
      const recorded = results.filter(r => r.recorded).length;
      if (recorded > 0) console.log(`[funding-events] Ledger recorded ${recorded} completion(s) event-driven`);
    } catch (e) {
      console.warn('[funding-events] event-driven reconcile failed (cron will catch up):', e.message);
    } finally {
      reconcilePending = false;
    }
  });

  console.log('✅ Funding event subscribers registered');
}
