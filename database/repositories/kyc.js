// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * postgres/kycPgAuthority.js — KYC decisions, behind the resolver.
 *
 * The eleventh and last domain. `true`
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
import { MONEY_PATHS } from '../moneyPaths.js';
import {
  KYC_STATES, KYC_REVISITABLE, transitionKyc, openKyc, getKyc,
} from './kyc.core.js';
import { pgQuery } from '../client.js';
import { getUser } from './users.js';

/** Is Postgres the source of truth for KYC decisions? */

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
 * Decide a user's KYC.
 *
 * ── What used to be in front of this ────────────────────────────────────────
 * A lazy `ensureKycRow` that read the user's status out of the document store
 * and opened a `user_kyc` row at whatever it found, so a cutover would not make
 * every un-mirrored user's first decision look like a missing account. There is
 * no cutover: a user with no KYC row is one who has never started KYC, and
 * `openKyc` at signup is where that row comes from.
 */
export async function decideKyc(userId, to, { actor = null, reason = null, set = {}, txId = null } = {}) {
  const result = await transitionKyc({
    userId: String(userId), to, actor, reason,
    txId: await keyForRepeatDecision(userId, to, txId),
    set,
  });

  if (!result.ok) {
    return {
      ok: false,
      reason: result.reason === 'not_found' ? REASON.NOT_FOUND : REASON.ILLEGAL_TRANSITION,
      status: result.status ?? null,
      attempted: to,
      allowedFrom: result.allowedFrom ?? [],
    };
  }

  // `users.kyc_status` — the column every gate in the app reads — was written
  // inside the decision's own transaction by `transitionKyc`. Nothing was
  // writing it before, so an approved player was still refused a withdrawal.
  const user = await getUser(userId);

  return {
    ok: true,
    idempotent: Boolean(result.idempotent),
    reason: result.idempotent ? REASON.ALREADY_THERE : REASON.APPLIED,
    status: result.kyc?.status ?? to,
    user,
  };
}
