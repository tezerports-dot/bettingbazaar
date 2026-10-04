// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * When the team commission is paid (Step 2e). The money is in
 * `database/repositories/teamCommission.js`; this decides WHEN to ask it.
 *
 * Instant: every path that completes an order asks right after its own commit
 * — the lifecycle's transition (buys, and every admin or dispute decision) and
 * the withdrawal settlement (sells). Asking can never fail the completion that
 * asked: the order has already completed, and a payment that did not run is
 * not lost, because the mark only moves when a payment lands. The sweep
 * (`payOwedCommissions`, every few minutes) and an admin's top-up of the
 * commission pool pay whatever is still owed.
 */
import { db } from '#db';
import { sendAlert } from '../../services/alerting.service.js';

/** Pay this team what it has earned. Never throws; returns the outcome, or null when it could not ask. */
export async function payCommissionFor(teamId, { actor = 'system' } = {}) {
  if (!teamId) return null;
  try {
    const out = await db.teamCommission.payTeamCommission(teamId, { actor });
    // A short pool is the platform's state, not the team's: an admin tops it
    // up and the sweep pays. Said once per ask, never per team per minute.
    if (!out.ok && out.reason !== 'pool_short') {
      console.error(`[team-commission] ${teamId} not paid:`, out.reason);
    }
    return out;
  } catch (err) {
    console.error(`[team-commission] ${teamId} failed:`, err.message);
    sendAlert('team-commission-failed', 'A team commission could not be paid; the sweep will retry', {
      teamId: String(teamId), error: err.message,
    }).catch(() => {});
    return null;
  }
}

/** Every team owed something, paid now: the sweep, and right after an admin funds the pool. */
export async function payOwedCommissions({ actor = 'system:commission-sweep' } = {}) {
  const results = await db.teamCommission.payOwedCommissions({ actor });
  const short = results.filter((r) => r.reason === 'pool_short');
  if (short.length) {
    sendAlert('team-commission-pool-short', 'Team commission is waiting: the commission pool cannot cover it', {
      teams: short.map((r) => r.teamId),
      owedPaise: short.reduce((sum, r) => sum + (r.owedPaise ?? 0), 0),
    }).catch(() => {});
  }
  return results;
}
