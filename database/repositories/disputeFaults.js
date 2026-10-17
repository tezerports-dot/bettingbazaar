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
 * A merchant ACCOUNT (a DIRECT team's owner, owner 2026-10-11) is the one
 * exception: its loss is counted and recorded as a PROBLEM in the same
 * transaction (merchantProblems.js), which may flag it; it is never suspended
 * automatically. An admin may still suspend it by hand.
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
import { withTransaction, pgQuery } from '../client.js';
import { getSystemConfig } from './config.js';
import { recordProblemWithin, flagThresholdOf, PROBLEM_KINDS } from './merchantProblems.js';

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
            RETURNING lost_disputes, high_risk_at, high_risk_at = now() AS newly_high_risk`,
          [String(userId), reason, decidedBy ? String(decidedBy) : null, HIGH_RISK_LOSSES])
        : await client.query(
          // A merchant ACCOUNT (a DIRECT team's owner) is not suspended for a
          // lost dispute: the loss is counted and recorded as a problem below,
          // and problems flag it (owner, 2026-10-11). An agent is suspended.
          `WITH direct AS (SELECT EXISTS (SELECT 1 FROM teams WHERE owner_merchant_id = $1) AS yes)
           UPDATE merchants SET
              lost_disputes = lost_disputes + 1,
              status = CASE WHEN direct.yes THEN status ELSE 'SUSPENDED' END,
              merchant_approval_status = CASE WHEN direct.yes THEN merchant_approval_status ELSE 'SUSPENDED' END,
              suspension_reason = CASE WHEN direct.yes THEN suspension_reason ELSE $2 END,
              cash_ready = FALSE,
              high_risk_at = CASE WHEN lost_disputes + 1 >= $3 THEN COALESCE(high_risk_at, now()) ELSE high_risk_at END,
              updated_at = now()
             FROM direct
            WHERE merchant_id = $1
            RETURNING lost_disputes, high_risk_at, high_risk_at = now() AS newly_high_risk, direct.yes AS direct`,
          [String(merchantId), reason, HIGH_RISK_LOSSES]);
      if (!loser[0]) throw new Refused('party_missing');
      // The merchant account's problem, in this transaction with its fault.
      const problem = loser[0].direct === true
        ? await recordProblemWithin(client, {
          merchantId, kind: PROBLEM_KINDS.DISPUTE_LOST, orderId: oid,
          threshold: flagThresholdOf(await getSystemConfig()),
        })
        : null;

      const lostCount = Number(loser[0].lost_disputes);
      const highRisk = loser[0].high_risk_at !== null;
      await client.query(
        'UPDATE dispute_faults SET lost_count = $2, high_risk = $3 WHERE order_id = $1',
        [oid, lostCount, highRisk]);
      // Newly high-risk when THIS statement set the mark (now() is the
      // transaction's instant; a mark already standing keeps its older time).
      // Not "the count is exactly three": after a full admin lifts a review the
      // count stays, so the next loss re-opens review at four, and the alert
      // must go out again (security review, 2026-10-03).
      return {
        ok: true, party, lostCount, highRisk, newlyHighRisk: loser[0].newly_high_risk === true,
        // Set only for a merchant account: it was flagged, not suspended.
        problem, suspended: party === FAULT_PARTIES.PLAYER || loser[0].direct !== true,
      };
    });
  } catch (e) {
    if (e instanceof Refused) return { ok: false, reason: e.reason };
    throw e;
  }
}

/** How far back the Dispute Manager's offence record counts recent events. */
export const OFFENCE_RECORD_DAYS = 30;

/**
 * The member's (or merchant account owner's) offence record, for the Dispute
 * Manager deciding a dispute against them (owner, 2026-10-17: "the dispute
 * manager can see if the merchant or member is a repeat offender or
 * flagged"). Read only, each figure from its owner: the merchant row's status
 * and counters, lost disputes (`dispute_faults`), refusals (`order_rejections`),
 * low-activity red flags (`team_red_flags`), a merchant account's problems and
 * daily flags (`merchant_problems`, `merchant_flags`) and compensations its
 * team already paid (`dispute_compensations`). Recent = the last
 * `OFFENCE_RECORD_DAYS` days.
 */
export async function merchantOffenceRecord(merchantId) {
  if (!merchantId) return null;
  const { rows } = await pgQuery(
    `SELECT m.merchant_id, m.name, m.status, m.suspension_reason,
            m.lost_disputes, m.high_risk_at, m.consecutive_rejections, m.consecutive_expiries,
            m.assignment_paused_at,
            (SELECT COUNT(*) FROM dispute_faults f WHERE f.merchant_id = m.merchant_id AND f.party = 'MERCHANT')::int AS disputes_lost,
            (SELECT COUNT(*) FROM order_rejections r WHERE r.merchant_id = m.merchant_id
               AND r.rejected_at > now() - make_interval(days => $2))::int AS recent_refusals,
            (SELECT COUNT(*) FROM team_red_flags t WHERE t.merchant_id = m.merchant_id
               AND t.created_at > now() - make_interval(days => $2))::int AS recent_red_flags,
            (SELECT COUNT(*) FROM merchant_problems p WHERE p.merchant_id = m.merchant_id
               AND p.created_at > now() - make_interval(days => $2))::int AS recent_problems,
            (SELECT COUNT(*) FROM merchant_flags g WHERE g.merchant_id = m.merchant_id
               AND g.created_at > now() - make_interval(days => $2))::int AS recent_flags,
            (SELECT COUNT(*) FROM dispute_compensations c WHERE c.merchant_id = m.merchant_id)::int AS compensations_paid,
            (SELECT COALESCE(SUM(amount_paise), 0) FROM dispute_compensations c WHERE c.merchant_id = m.merchant_id) AS compensated_paise
       FROM merchants m WHERE m.merchant_id = $1`,
    [String(merchantId), OFFENCE_RECORD_DAYS], 'dispute_merchant_offence_record');
  const r = rows[0];
  if (!r) return null;
  const disputesLost = Number(r.disputes_lost);
  return {
    merchantId: r.merchant_id,
    name: r.name,
    status: r.status,
    suspensionReason: r.suspension_reason ?? null,
    highRisk: r.high_risk_at != null,
    assignmentPaused: r.assignment_paused_at != null,
    disputesLost,
    refusalStreak: Number(r.consecutive_rejections),
    unpaidBuyStreak: Number(r.consecutive_expiries),
    recentDays: OFFENCE_RECORD_DAYS,
    recentRefusals: Number(r.recent_refusals),
    recentRedFlags: Number(r.recent_red_flags),
    recentProblems: Number(r.recent_problems),
    recentFlags: Number(r.recent_flags),
    compensationsPaid: Number(r.compensations_paid),
    compensatedPaise: Number(r.compensated_paise),
    // One line the screen can lead with: anyone who lost before, is flagged or
    // is on a streak is a repeat offender.
    repeatOffender: disputesLost > 0 || r.high_risk_at != null || Number(r.recent_flags) > 0
      || Number(r.recent_red_flags) > 0 || Number(r.consecutive_rejections) > 1,
  };
}
