// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * postgres/kycPg.js — the KYC decision lifecycle, in PostgreSQL.
 *
 * The eleventh and last domain, and the only one whose registry entry still
 * reads `concurrencyTested: false`. It cuts over LAST by design: KYC gates who
 * may move money, so it moves after every path it gates.
 *
 * ── What `user_kyc` already was, and why it is not this ─────────────────────
 * A mirror: the User document's KYC fields projected on every save, overwritten
 * in place, no history and no guard on what may follow what. It answers "is
 * this user approved" and nothing else — not who approved them, not when, not
 * whether they were rejected first and why.
 *
 * ── The state machine ───────────────────────────────────────────────────────
 *
 *   PENDING_SUBMISSION ─▶ PENDING_APPROVAL ─▶ APPROVED
 *                              │    ▲
 *                              ▼    │  (resubmission)
 *                          REJECTED ┘
 *
 * ── Three defects this exists to remove, not port ───────────────────────────
 *
 * 1. NO GUARD. `routes/admin/kyc.admin.routes.js` reads the user, assigns
 *    `user.kycStatus = 'APPROVED'`, and saves — a read-modify-write on a stale
 *    read. Two reviewers acting at once both pass, and the last save wins; an
 *    approve and a reject landing together produce whichever finished second,
 *    with no record that the other happened. Here the expected previous status
 *    is in the UPDATE's WHERE clause, so exactly one reviewer's decision lands.
 *
 * 2. THE REJECTION REASON IS DISCARDED. That route does:
 *
 *        user.kycStatus = 'REJECTED';
 *        if (user.kyc) { …; user.kyc.rejectionReason = reason; }
 *
 *    The User schema has no `kyc` subdocument — only `kycData` — so `user.kyc`
 *    is `undefined` and the guarded block NEVER RUNS. Verified against the
 *    compiled schema: `kyc.rejectionReason` is not a path, `kycData.rejectionReason`
 *    is. The reason the user is shown comes from `kycData.rejectionReason`
 *    (domains/user/kycPublicData.js), which nothing writes. Every rejected user
 *    is told they were rejected and never told why, so they cannot fix the
 *    submission. Here the reason is written in the SAME statement as the
 *    status, so a rejection without one is not representable.
 *
 * 3. NO REVIEWER AND NO HISTORY. `reviewedBy` and `reviewedAt` are lost to the
 *    same dead branch, and the status is a single field, so "was this user ever
 *    rejected, and for what?" — the question every compliance review asks —
 *    cannot be answered once a resubmission overwrites it. `kyc_transitions` is
 *    append-only and records the actor and the reason on every decision.
 *
 * ── Repeat visits need their own key ────────────────────────────────────────
 * A rejected user resubmits, so PENDING_APPROVAL and REJECTED are reachable
 * more than once and the default `kyc_<user>_<status>` key would collide with
 * the previous visit — reported as an idempotent replay rather than applied.
 * Same problem, same resolution and the same derivation as the order lifecycle:
 * docs/ORDERS_REQUEUE_CYCLE.md.
 */
import { getPool, pgQuery, connectGuarded } from '../client.js';
import { setKycStatus } from './users.js';

export const KYC_STATES = Object.freeze({
  PENDING_SUBMISSION: 'PENDING_SUBMISSION',
  PENDING_APPROVAL:   'PENDING_APPROVAL',
  APPROVED:           'APPROVED',
  REJECTED:           'REJECTED',
});

/**
 * Which statuses each target accepts, as DATA. Shared with the Mongo-side seam
 * so the two stores cannot hold two different rules.
 *
 * PENDING_SUBMISSION has no entry: that is where a user starts, not somewhere
 * they move to. Un-approving is deliberately absent — revoking an approval is a
 * compliance action with its own record, not a state change that pretends the
 * approval never happened.
 */
export const KYC_ALLOWED_FROM = Object.freeze({
  // Submission, and resubmission after a rejection.
  [KYC_STATES.PENDING_APPROVAL]: [KYC_STATES.PENDING_SUBMISSION, KYC_STATES.REJECTED],
  [KYC_STATES.APPROVED]:         [KYC_STATES.PENDING_APPROVAL],
  [KYC_STATES.REJECTED]:         [KYC_STATES.PENDING_APPROVAL],
});

/** Statuses reachable more than once — derived, so adding an edge cannot leave it stale. */
export const KYC_REVISITABLE = Object.freeze(
  Object.keys(KYC_STATES).filter((start) => {
    const forward = (from) => Object.keys(KYC_ALLOWED_FROM).filter((to) => KYC_ALLOWED_FROM[to].includes(from));
    const seen = new Set();
    const stack = forward(start);
    while (stack.length) {
      const s = stack.pop();
      if (s === start) return true;
      if (seen.has(s)) continue;
      seen.add(s);
      stack.push(...forward(s));
    }
    return false;
  })
);

function rowToKyc(row) {
  if (!row) return null;
  return {
    userId:          row.user_id,
    status:          row.kyc_status,
    submittedAt:     row.submitted_at,
    rejectionReason: row.rejection_reason,
    reviewedBy:      row.reviewed_by,
    reviewedAt:      row.reviewed_at,
    updatedAt:       row.updated_at,
  };
}

/** The KYC record for a user, or null. */
export async function getKyc(userId) {
  const { rows } = await pgQuery(`SELECT * FROM user_kyc WHERE user_id = $1`, [String(userId)], 'kyc_get');
  return rowToKyc(rows[0]);
}

/** Every decision ever taken on this user, oldest first. */
export async function getKycHistory(userId) {
  const { rows } = await pgQuery(
    `SELECT tx_id, from_status, to_status, actor, reason, created_at
       FROM kyc_transitions WHERE user_id = $1 ORDER BY id`,
    [String(userId)], 'kyc_history',
  );
  return rows.map((r) => ({
    txId: r.tx_id, from: r.from_status, to: r.to_status,
    actor: r.actor, reason: r.reason, createdAt: r.created_at,
  }));
}

/**
 * Open a KYC record at PENDING_SUBMISSION. Idempotent on the user id, so a
 * retried registration returns the existing record rather than resetting it —
 * which would silently un-approve someone.
 */
export async function openKyc({ userId, status = KYC_STATES.PENDING_SUBMISSION }) {
  if (!userId) throw new Error('openKyc requires a userId');
  const { rows } = await pgQuery(
    `INSERT INTO user_kyc (user_id, kyc_status) VALUES ($1,$2)
     ON CONFLICT (user_id) DO NOTHING RETURNING *`,
    [String(userId), status], 'kyc_open',
  );
  if (!rows.length) return { ok: true, idempotent: true, kyc: await getKyc(userId) };
  return { ok: true, idempotent: false, kyc: rowToKyc(rows[0]) };
}

async function withKycLock(userId, fn) {
  const uid = String(userId);
  const pool = await getPool();
  if (!pool) throw new Error('Postgres not configured (DATABASE_URL unset)');
  const client = await connectGuarded(pool);
  let failure = null;
  try {
    await client.query('BEGIN');
    const locked = await client.query(`SELECT * FROM user_kyc WHERE user_id = $1 FOR UPDATE`, [uid]);
    const { commit, value } = await fn({ client, uid, kyc: rowToKyc(locked.rows[0]) });
    await client.query(commit ? 'COMMIT' : 'ROLLBACK');
    return value;
  } catch (error) {
    failure = error;
    try { await client.query('ROLLBACK'); } catch { /* already unwound */ }
    throw error;
  } finally {
    // Destroy rather than reuse a client whose backend may have gone away
    // mid-transaction — see merchantWalletPg.withMerchantLock.
    client.release(failure ?? undefined);
  }
}

/**
 * Decide a user's KYC, but only from a status the rules allow.
 *
 * The reason and the reviewer are written in the SAME statement as the status,
 * so a decision can never be found without the facts that justify it — which is
 * exactly the gap the Mongo path has, where the reason is assigned to a
 * subdocument that does not exist.
 *
 * Outcomes match orderPg.transition so callers branch the same way:
 *   { ok: true,  idempotent: false }  this call decided it
 *   { ok: true,  idempotent: true  }  someone already did; nothing moved
 *   { ok: false, reason: 'not_found' }
 *   { ok: false, reason: 'invalid_transition', status, allowedFrom }
 */
export async function transitionKyc({ userId, to, actor = null, reason = null, txId = null, set = {} }) {
  if (!KYC_STATES[to]) {
    throw new Error(`Unknown KYC status '${to}'. Known: ${Object.keys(KYC_STATES).join(', ')}`);
  }
  const allowedFrom = KYC_ALLOWED_FROM[to];
  if (!allowedFrom) {
    throw new Error(`Nothing may transition INTO '${to}' — a user starts there, they do not move there.`);
  }
  // A rejection with no reason is the defect this module exists to fix. It is
  // refused rather than defaulted: inventing "Rejected by admin" would satisfy
  // the constraint and tell the user nothing, which is where it started.
  if (to === KYC_STATES.REJECTED && !String(reason ?? '').trim()) {
    throw new Error('transitionKyc: a REJECTED decision requires a reason — it is what the user is shown.');
  }
  const mayRepeat = KYC_REVISITABLE.includes(to);

  return withKycLock(userId, async ({ client, uid, kyc }) => {
    if (!kyc) return { commit: false, value: { ok: false, reason: 'not_found' } };
    if (kyc.status === to) return { commit: false, value: { ok: true, idempotent: true, kyc } };
    if (!allowedFrom.includes(kyc.status)) {
      return {
        commit: false,
        value: { ok: false, reason: 'invalid_transition', status: kyc.status, allowedFrom },
      };
    }

    // The default key is only safe on a FIRST visit — a resubmitted user
    // reaches PENDING_APPROVAL twice and would collide with their own earlier
    // submission, which reads as "already done". Checked under the row lock, so
    // nothing can insert between this read and the write below.
    if (!txId && mayRepeat) {
      const prior = await client.query(
        `SELECT 1 FROM kyc_transitions WHERE user_id = $1 AND to_status = $2 LIMIT 1`, [uid, to]);
      if (prior.rowCount) {
        throw new Error(
          `transitionKyc to '${to}' for ${uid} requires an explicit txId: this user has been in '${to}' ` +
          `before, so the default key kyc_${uid}_${to} is taken and the decision would be reported as an ` +
          `idempotent replay rather than applied (statuses that repeat: ${KYC_REVISITABLE.join(', ')}).`,
        );
      }
    }

    // The guard is in the WHERE clause. The read above gives a good error
    // message; this is what settles the race between two reviewers.
    const moved = await client.query(
      `UPDATE user_kyc
          SET kyc_status = $2, updated_at = now(),
              reviewed_by = COALESCE($3, reviewed_by),
              reviewed_at = CASE WHEN $3 IS NULL THEN reviewed_at ELSE now() END,
              rejection_reason = $4,
              submitted_at = COALESCE($5, submitted_at)
        WHERE user_id = $1 AND kyc_status = ANY($6)
        RETURNING *`,
      // name_on_pan, pan_number and the four document columns are no longer
      // written: nothing collects a name, a PAN or a document since the
      // Telegram/bulk cutover (2026-08-25). The COLUMNS stay — a mirror keeps
      // its history, and dropping them is a migration with no benefit — but
      // passing dead parameters through here made this statement read as though
      // fields still existed that do not.
      [uid, to, actor ? String(actor) : null,
       to === KYC_STATES.REJECTED ? reason : null,
       set.submittedAt ?? null,
       allowedFrom],
    );
    if (!moved.rowCount) {
      return { commit: false, value: { ok: false, reason: 'invalid_transition', status: kyc.status, allowedFrom } };
    }

    // ── The column authorisation actually reads ─────────────────────────────
    // `user_kyc` OWNS the decision and `kyc_transitions` is its audit trail,
    // but every gate in the app — deposit, withdrawal, bet placement — checks
    // `users.kyc_status`. That copy was written by nothing at all: an admin
    // could approve somebody in `user_kyc` and the player would still be
    // refused a withdrawal, with the two tables disagreeing and neither
    // obviously wrong.
    //
    // Written HERE, inside the transaction that records the decision, which is
    // the only thing that makes a denormalised copy safe. `setKycStatus`
    // demands a client for exactly this reason and had no caller passing one.
    await setKycStatus(client, uid, to);

    // One decision per user per target status unless a key says otherwise. A
    // double-clicked approve collides here, INSIDE the transaction, so the
    // status change unwinds with it.
    try {
      await client.query(
        `INSERT INTO kyc_transitions (tx_id, user_id, from_status, to_status, actor, reason)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [txId || `kyc_${uid}_${to}`, uid, kyc.status, to, actor ? String(actor) : null, reason],
      );
    } catch (error) {
      if (error.code === '23505') return { commit: false, value: { ok: true, idempotent: true, kyc } };
      throw error;
    }

    return { commit: true, value: { ok: true, idempotent: false, kyc: rowToKyc(moved.rows[0]) } };
  });
}

// ── Named decisions, so a call site reads as the thing it means ─────────────
export const submitKyc  = (a) => transitionKyc({ ...a, to: KYC_STATES.PENDING_APPROVAL });
export const approveKyc = (a) => transitionKyc({ ...a, to: KYC_STATES.APPROVED });
export const rejectKyc  = (a) => transitionKyc({ ...a, to: KYC_STATES.REJECTED });

/**
 * Approvals with no reviewer recorded.
 *
 * The gap check for this domain, and it is not hypothetical: the Mongo route
 * intends to record one and cannot, so on the Mongo path EVERY approval is
 * anonymous. A non-empty result once Postgres owns the path means something
 * approved a user without going through this module.
 */
export async function findApprovalsMissingReviewer() {
  const { rows } = await pgQuery(
    `SELECT k.user_id, k.reviewed_at
       FROM user_kyc k
      WHERE k.kyc_status = 'APPROVED' AND k.reviewed_by IS NULL`,
    [], 'kyc_missing_reviewer',
  );
  return rows.map((r) => ({ userId: r.user_id, reviewedAt: r.reviewed_at }));
}

/**
 * Rejections with no reason recorded — the defect this domain was built around,
 * as a query. Every one of these is a user who was told no and not told why.
 */
export async function findRejectionsMissingReason() {
  const { rows } = await pgQuery(
    `SELECT user_id FROM user_kyc
      WHERE kyc_status = 'REJECTED' AND COALESCE(TRIM(rejection_reason), '') = ''`,
    [], 'kyc_missing_reason',
  );
  return rows.map((r) => r.user_id);
}
