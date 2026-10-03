// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * database/repositories/disputeFaults.js — who LOST a dispute, and what it
 * costs them (2c+, owner 2026-10-02 21:13).
 *
 * ── The rule ───────────────────────────────────────────────────────────────
 * When the dispute manager decides a dispute, whoever was wrong — the player
 * or the team member — is SUSPENDED completely, and only staff lift it. Every
 * lost dispute counts; the THIRD sends the account to HIGH-RISK review, where
 * only a full admin may lift the suspension.
 *
 * ── One writer, one transaction, once per dispute ──────────────────────────
 * The `dispute_faults` row is keyed by the ORDER, so a decision replayed (two
 * admins, a retried request, a route's idempotent branch) records nothing the
 * second time. The count, the suspension and the high-risk mark are written
 * in the SAME transaction as that row: an account is never suspended for a
 * dispute the record does not show, nor recorded as having lost one it was
 * never suspended for. If the party at fault has no row (trap 19: an order's
 * merchant id has no foreign key), the whole thing rolls back and says so —
 * a record naming nobody is worse than none.
 */
import { withTransaction } from '../client.js';

export const FAULT_PARTIES = Object.freeze({ PLAYER: 'PLAYER', MERCHANT: 'MERCHANT' });

/** The lost dispute that opens high-risk review. Owner: "no more than three". */
export const HIGH_RISK_LOSSES = 3;

class Refused extends Error {
  constructor(reason) { super(reason); this.reason = reason; }
}

/**
 * Record one decided dispute against the party that lost it, suspend them,
 * and open high-risk review on the third loss.
 *
 * @param {object} a
 * @param {string} a.orderId
 * @param {'PLAYER'|'MERCHANT'} a.party
 * @param {string|null} a.userId      the player on the order
 * @param {string|null} a.merchantId  the member on the order
 * @param {string} a.decision         the resolution, as the route recorded it
 * @param {string|null} a.decidedBy   the staff account that decided it
 * @returns {Promise<{ok: true, already?: boolean, party, lostCount, highRisk, newlyHighRisk?}
 *   | {ok: false, reason: string}>}
 */
export async function recordDisputeFault({ orderId, party, userId = null, merchantId = null, decision, decidedBy = null }) {
  if (!Object.values(FAULT_PARTIES).includes(party)) throw new Error(`recordDisputeFault: unknown party '${party}'`);
  const oid = String(orderId);
  const reason = `Lost a payment dispute (order ${oid}). A staff member must review and lift this suspension.`;
  try {
    return await withTransaction(async (client) => {
      const { rows: fresh } = await client.query(
        `INSERT INTO dispute_faults (order_id, party, user_id, merchant_id, decision, decided_by, lost_count)
         VALUES ($1, $2, $3, $4, $5, $6, 1)
         ON CONFLICT (order_id) DO NOTHING
         RETURNING order_id`,
        [oid, party, userId ? String(userId) : null, merchantId ? String(merchantId) : null,
          String(decision), decidedBy ? String(decidedBy) : null]);
      if (!fresh[0]) {
        const { rows } = await client.query(
          'SELECT party, lost_count, high_risk FROM dispute_faults WHERE order_id = $1', [oid]);
        return { ok: true, already: true, party: rows[0].party, lostCount: rows[0].lost_count, highRisk: rows[0].high_risk };
      }

      // The loser's count, suspension and high-risk mark, in one statement.
      // `high_risk_at` is kept once set (COALESCE): a fourth loss does not
      // restart a review that is already open.
      const { rows: loser } = party === FAULT_PARTIES.PLAYER
        ? await client.query(
          `UPDATE users SET
              lost_disputes = lost_disputes + 1,
              is_blocked    = TRUE,
              block_reason  = $2,
              blocked_at    = now(),
              blocked_by    = $3,
              -- Only ACTIVE becomes BLOCKED: a DELETED account stays deleted.
              status        = CASE WHEN status = 'ACTIVE' THEN 'BLOCKED' ELSE status END,
              high_risk_at  = CASE WHEN lost_disputes + 1 >= $4 THEN COALESCE(high_risk_at, now()) ELSE high_risk_at END,
              updated_at    = now()
            WHERE user_id = $1
            RETURNING lost_disputes, high_risk_at`,
          [String(userId), reason, decidedBy ? String(decidedBy) : null, HIGH_RISK_LOSSES])
        : await client.query(
          `UPDATE merchants SET
              lost_disputes = lost_disputes + 1,
              status = 'SUSPENDED',
              merchant_approval_status = 'SUSPENDED',
              suspension_reason = $2,
              cash_ready = FALSE,
              high_risk_at = CASE WHEN lost_disputes + 1 >= $3 THEN COALESCE(high_risk_at, now()) ELSE high_risk_at END,
              updated_at = now()
            WHERE merchant_id = $1
            RETURNING lost_disputes, high_risk_at`,
          [String(merchantId), reason, HIGH_RISK_LOSSES]);
      if (!loser[0]) throw new Refused('party_missing');

      const lostCount = Number(loser[0].lost_disputes);
      const highRisk = loser[0].high_risk_at !== null;
      await client.query(
        'UPDATE dispute_faults SET lost_count = $2, high_risk = $3 WHERE order_id = $1',
        [oid, lostCount, highRisk]);
      return { ok: true, party, lostCount, highRisk, newlyHighRisk: highRisk && lostCount === HIGH_RISK_LOSSES };
    });
  } catch (e) {
    if (e instanceof Refused) return { ok: false, reason: e.reason };
    throw e;
  }
}
