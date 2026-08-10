// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * postgres/kycPgAuthority.js — KYC decisions, behind the resolver.
 *
 * The eleventh and last domain. `isPostgresAuthoritative(MONEY_PATHS.KYC)`
 * decides per call, and only `domains/user/kycDecision.service.js` may call
 * this — the same single-seam rule the order lifecycle follows, for the same
 * reason: a route reaching past the seam would leave some decisions
 * authoritative in Postgres and others in Mongo, which no reconciliation can
 * tell apart from the two stores genuinely disagreeing.
 *
 * ── KYC moves LAST, and the graph enforces it ───────────────────────────────
 * KYC gates who may move money, so it cuts over after every path it gates:
 * PATH_SPEC declares `dependsOn: [WALLET, LEDGER, ORDERS]`. Until all three are
 * authoritative in Postgres this returns `handled: false` on every call and the
 * Mongo seam does the work. That is not a limitation to route around — a user
 * approved in one store while the wallet that checks their approval reads the
 * other is exactly the split the ordering gate exists to prevent.
 *
 * ── What routing buys ───────────────────────────────────────────────────────
 * The Mongo seam already guards the transition and writes the reason to the
 * field the user-facing projection reads, which is the live bug fixed. What it
 * cannot do:
 *
 *   - keep HISTORY. `kyc_transitions` is append-only, so "was this user ever
 *     rejected, and why?" survives a resubmission overwriting the status. On
 *     Mongo the answer is destroyed the moment the user resubmits.
 *   - make an anonymous approval impossible. `findApprovalsMissingReviewer`
 *     is a query here; on Mongo it is unanswerable.
 *   - refuse a repeat decision that carries no key of its own, which is what
 *     stops a resubmission being swallowed as a replay.
 */
import mongoose from 'mongoose';
import { isPostgresAuthoritative, MONEY_PATHS } from './moneyAuthority.js';
import {
  KYC_STATES, KYC_REVISITABLE, transitionKyc, openKyc, getKyc,
} from './kycPg.js';
import { pgQuery } from './pgClient.js';
import { reverseMirrorUserKycStatus } from './reverseMirror.js';

/** Is Postgres the source of truth for KYC decisions? */
export const onPostgres = () => isPostgresAuthoritative(MONEY_PATHS.KYC);

const REASON = Object.freeze({
  APPLIED:            'applied',
  ILLEGAL_TRANSITION: 'illegal_transition',
  ALREADY_THERE:      'already_there',
  NOT_FOUND:          'not_found',
});

/**
 * The key for a decision that may legitimately repeat.
 *
 * A rejected user resubmits, so PENDING_APPROVAL and REJECTED are reachable
 * twice and the default key is taken on the second visit. Where the caller
 * supplies one it is used; otherwise the occurrence is named. That is not
 * idempotency and is not presented as it — see the same note in
 * orderPgAuthority.js.
 */
async function keyForRepeatDecision(userId, to, txId) {
  if (txId) return txId;
  if (!KYC_REVISITABLE.includes(to)) return null;
  const { rows } = await pgQuery(
    `SELECT COUNT(*)::int AS n FROM kyc_transitions WHERE user_id = $1 AND to_status = $2`,
    [String(userId), to],
  );
  return rows[0].n ? `kyc_${userId}_${to}_v${rows[0].n + 1}` : null;
}

/**
 * Make sure Postgres has the KYC row before trying to decide it.
 *
 * `dualWrite.mirrorUserKyc` populates `user_kyc` from the User document's
 * post-save hook, but a user who has not touched their KYC since the mirror was
 * added has no row — and their first decision would come back `not_found` and
 * surface to an admin as a missing user. Opened lazily at the status Mongo
 * currently holds, so the decision that follows is judged from the right place.
 */
async function ensureKycRow(userId) {
  if (await getKyc(userId)) return true;
  const doc = await mongoose.model('User').findById(userId).select('kycStatus').lean();
  if (!doc) return false;
  await openKyc({ userId: String(userId), status: doc.kycStatus || KYC_STATES.PENDING_SUBMISSION });
  return true;
}

/**
 * Decide a user's KYC, with Postgres deciding when it owns the path.
 *
 * `{ handled: false }` tells the seam to run its own guarded Mongo update.
 * Anything else is the final answer — including a refusal, which is SURFACED
 * rather than retried against Mongo. The store that owns the decision saying no
 * must not be overruled by the store that has no opinion.
 */
export async function decideKycOnPostgres(userId, to, { actor = null, reason = null, set = {}, txId = null } = {}) {
  if (!onPostgres()) return { handled: false };

  if (!(await ensureKycRow(userId))) {
    return { handled: true, ok: false, reason: REASON.NOT_FOUND };
  }

  const result = await transitionKyc({
    userId: String(userId), to, actor, reason,
    txId: await keyForRepeatDecision(userId, to, txId),
    set,
  });

  if (!result.ok) {
    return {
      handled: true, ok: false,
      reason: result.reason === 'not_found' ? REASON.NOT_FOUND : REASON.ILLEGAL_TRANSITION,
      status: result.status ?? null,
      attempted: to,
      allowedFrom: result.allowedFrom ?? [],
    };
  }

  // Mongo follows, AWAITED — every KYC gate in the app reads User.kycStatus, and
  // an admin who approves someone then watches them be refused a withdrawal
  // because the mirror was still in flight is not a acceptable outcome.
  await reverseMirrorUserKycStatus({
    user_id:          String(userId),
    kyc_status:       result.kyc?.status ?? to,
    rejection_reason: result.kyc?.rejectionReason ?? null,
    reviewed_by:      result.kyc?.reviewedBy ?? null,
    reviewed_at:      result.kyc?.reviewedAt ?? null,
  });

  return {
    handled: true, ok: true,
    idempotent: Boolean(result.idempotent),
    reason: result.idempotent ? REASON.ALREADY_THERE : REASON.APPLIED,
    status: result.kyc?.status ?? to,
    user: await mongoose.model('User').findById(userId).lean(),
  };
}
