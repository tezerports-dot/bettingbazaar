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
 * (`payOwedCommissions`, every few minutes) pays whatever is still owed.
 * Commission comes straight out of platform revenue, so nothing waits on a
 * pool being funded (owner, 2026-10-24).
 */
import { db } from '#db';
import { sendAlert } from '../../services/alerting.service.js';

/** Pay this completed order's commission. Never throws; returns the outcome, or null when it could not ask. */
export async function payCommissionFor(order, { actor = 'system' } = {}) {
  const orderId = order?.orderId;
  if (!orderId || !order?.teamId) return null;
  try {
    const out = await db.teamCommission.payOrderCommission(orderId, { actor });
    if (!out.ok) {
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

/** Every order owed its commission, paid now: the sweep. */
export async function payOwedCommissions({ actor = 'system:commission-sweep' } = {}) {
  const results = await db.teamCommission.payOwedCommissions({ actor });
  const refused = results.filter((r) => !r.ok);
  if (refused.length) {
    sendAlert('team-commission-refused', 'Some order commission could not be paid; the sweep will retry', {
      teams: [...new Set(refused.map((r) => r.teamId))],
      reasons: [...new Set(refused.map((r) => r.reason))],
    }).catch(() => {});
  }
  return results;
}
