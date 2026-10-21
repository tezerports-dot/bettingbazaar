// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * When the order commission is paid (owner, 2026-10-21). The money is in
 * `database/repositories/teamCommission.js`; this decides WHEN to ask it.
 *
 * Instant: every path that completes an order asks right after its own commit
 * — the lifecycle's transition (buys, and every admin or dispute decision) and
 * the withdrawal settlement (sells). Asking can never fail the completion that
 * asked: the order has already completed, and a payment that did not run is
 * not lost, because an order stays owed until its row exists. The sweep
 * (`payOwedCommissions`, every few minutes) and an admin's top-up of the
 * commission pool pay whatever is still owed.
 */
import { db } from '#db';
import { sendAlert } from '../../services/alerting.service.js';

/** Pay this completed order's commission. Never throws; returns the outcome, or null when it could not ask. */
export async function payCommissionFor(order, { actor = 'system' } = {}) {
  const orderId = order?.orderId;
  if (!orderId || !order?.teamId) return null;
  try {
    const out = await db.teamCommission.payOrderCommission(orderId, { actor });
    // A short pool is the platform's state, not the team's: an admin tops it
    // up and the sweep pays. Said once per ask, never per order per minute.
    if (!out.ok && out.reason !== 'pool_short') {
      console.error(`[team-commission] ${orderId} not paid:`, out.reason);
    }
    return out;
  } catch (err) {
    console.error(`[team-commission] ${orderId} failed:`, err.message);
    sendAlert('team-commission-failed', 'An order commission could not be paid; the sweep will retry', {
      orderId: String(orderId), teamId: String(order.teamId), error: err.message,
    }).catch(() => {});
    return null;
  }
}

/** Every order owed its commission, paid now: the sweep, and right after an admin funds the pool. */
export async function payOwedCommissions({ actor = 'system:commission-sweep' } = {}) {
  const results = await db.teamCommission.payOwedCommissions({ actor });
  const short = results.filter((r) => r.reason === 'pool_short');
  if (short.length) {
    sendAlert('team-commission-pool-short', 'Team commission is waiting: the commission pool cannot cover it', {
      teams: [...new Set(short.map((r) => r.teamId))],
      owedPaise: short.reduce((sum, r) => sum + (r.owedPaise ?? 0), 0),
    }).catch(() => {});
  }
  return results;
}
