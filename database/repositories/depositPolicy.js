// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file.
/**
 * repositories/depositPolicy.js — how a deposit is split between the player's
 * spendable balance and the platform reserve.
 *
 * ── Why this is versioned and never edited ──────────────────────────────────
 * The split is snapshotted onto every DEPOSIT order at creation, so an order in
 * flight keeps the policy it was created under however many times an admin
 * changes the current one. An auditor asking "which policy produced this
 * order's split, and who approved it" needs that version to still exist months
 * later. A trigger refuses to delete a row, to revive a superseded one, or to
 * change the percentages on any of them — supersede instead.
 *
 * ── The rules that moved into the table ─────────────────────────────────────
 * "Exactly one ACTIVE version per currency" was two writes in the service: make
 * the new one active, then mark the old one superseded. Two admins saving at
 * once left two ACTIVE rows and the next deposit read whichever the sort
 * happened to return. It is a partial unique index now.
 *
 * "The percentages sum to 100" was a JavaScript validator, which meant it held
 * for every caller that remembered to call it. A split that does not sum to 100
 * creates or destroys money on every deposit it governs, so it is a CHECK.
 */
import { pgQuery, withTransaction } from '../client.js';

const toPolicy = (r) => (r ? {
  id: Number(r.id),
  _id: `${r.currency}:v${r.version}`,
  currency: r.currency,
  version: Number(r.version),
  status: r.status,
  depositAllocationPercent: Number(r.deposit_allocation_percent),
  reserveAllocationPercent: Number(r.reserve_allocation_percent),
  reserveUsageRules: r.reserve_usage_rules,
  justification: r.justification,
  effectiveAt: r.effective_at,
  changedBy: r.changed_by,
  createdAt: r.created_at,
  supersededAt: r.superseded_at,
} : null);

/** The policy a new order is created under. One row, by construction. */
export async function getActivePolicy(currency) {
  const { rows } = await pgQuery(
    "SELECT * FROM deposit_policies WHERE currency = $1 AND status = 'ACTIVE'",
    [String(currency)], 'deposit_policy_active',
  );
  return toPolicy(rows[0]);
}

/** Every version for a currency, newest first. The audit trail. */
export async function getPolicyHistory(currency, { limit = 100 } = {}) {
  const { rows } = await pgQuery(
    `SELECT * FROM deposit_policies WHERE currency = $1
      ORDER BY version DESC LIMIT ${Math.min(Math.max(Number(limit) || 100, 1), 500)}`,
    [String(currency)], 'deposit_policy_history',
  );
  return rows.map(toPolicy);
}

export async function getPolicyVersion(currency, version) {
  const { rows } = await pgQuery(
    'SELECT * FROM deposit_policies WHERE currency = $1 AND version = $2',
    [String(currency), Number(version)], 'deposit_policy_version',
  );
  return toPolicy(rows[0]);
}

/**
 * Publish a new version.
 *
 * The supersede and the insert are ONE transaction. Making a version active
 * first and superseding the old one afterwards leaves — for however long the
 * second write takes, or forever if it fails — two ACTIVE policies, and the
 * next deposit is split by whichever the query returns.
 *
 * ── What actually stops two writers, measured rather than assumed ───────────
 * NOT the supersede. Under READ COMMITTED the loser's `UPDATE … WHERE status =
 * 'ACTIVE'` re-checks the row it was blocked on, finds it already SUPERSEDED,
 * matches nothing, and holds no lock — while the winner's brand-new ACTIVE row
 * is invisible to that statement. The loser then computes its own version and
 * inserts, and it is `deposit_policies_one_active` (or, for a currency's very
 * first version, `deposit_policies_version_unique`) that refuses it.
 *
 * So the guarantee this function makes is: whatever the interleaving, exactly
 * one ACTIVE row exists per currency, and the losing writer gets a clean
 * CONCURRENT_CHANGE it can retry — never a duplicate version, never two
 * policies governing deposits, and never an unhandled 23505. For an action an
 * operator performs a handful of times a year, "another change landed first,
 * reload and try again" is the right answer; serialising them properly would
 * mean an advisory lock for no gain.
 *
 * A version that is not ACTIVE (PENDING_APPROVAL, SCHEDULED) does not supersede
 * anything — it is a proposal, and the current policy keeps governing deposits
 * until somebody approves it.
 */
export async function createPolicyVersion({
  currency, depositAllocationPercent, reserveAllocationPercent,
  reserveUsageRules = {}, justification = '', effectiveAt = null,
  changedBy = null, status = 'ACTIVE',
}) {
  if (!currency) throw new Error('createPolicyVersion requires a currency');

  try {
    return await withTransaction(async (client) => {
      if (status === 'ACTIVE') {
        await client.query(
          `UPDATE deposit_policies SET status = 'SUPERSEDED', superseded_at = now()
            WHERE currency = $1 AND status = 'ACTIVE'`,
          [String(currency)],
        );
      }
      const { rows } = await client.query(
        `INSERT INTO deposit_policies
           (currency, version, status, deposit_allocation_percent,
            reserve_allocation_percent, reserve_usage_rules, justification,
            effective_at, changed_by)
         VALUES ($1,
                 (SELECT COALESCE(MAX(version), 0) + 1 FROM deposit_policies WHERE currency = $1),
                 $2, $3, $4, $5, $6, $7, $8)
         RETURNING *`,
        [String(currency), status, depositAllocationPercent, reserveAllocationPercent,
          JSON.stringify(reserveUsageRules ?? {}), String(justification),
          effectiveAt, changedBy],
      );
      return { ok: true, policy: toPolicy(rows[0]) };
    });
  } catch (err) {
    // The table refused it. Each of these is an operator error with a specific
    // answer, not a 500: say which rule stopped the save.
    if (err.constraint === 'deposit_policies_sums_to_100') {
      return {
        ok: false,
        reason: 'PERCENTAGES_MUST_SUM_TO_100',
        message: `depositAllocationPercent + reserveAllocationPercent must equal 100 (got ${
          Number(depositAllocationPercent) + Number(reserveAllocationPercent)})`,
      };
    }
    if (err.constraint === 'deposit_policies_percent_range') {
      return { ok: false, reason: 'PERCENTAGES_NEGATIVE', message: 'Allocation percentages cannot be negative.' };
    }
    if (err.code === '23505') {
      return { ok: false, reason: 'CONCURRENT_CHANGE', message: 'Another change to this policy landed first. Reload and try again.' };
    }
    throw err;
  }
}

/**
 * Approve a proposal, making it the policy deposits are split by.
 *
 * The supersede and the promotion are one transaction, for the same reason as
 * above. Returns null when the version does not exist or is not promotable.
 */
export async function activatePolicyVersion(currency, version, { changedBy = null } = {}) {
  return withTransaction(async (client) => {
    const { rows: candidate } = await client.query(
      `SELECT * FROM deposit_policies
        WHERE currency = $1 AND version = $2 AND status IN ('PENDING_APPROVAL', 'SCHEDULED')
        FOR UPDATE`,
      [String(currency), Number(version)],
    );
    if (!candidate.length) return null;

    await client.query(
      `UPDATE deposit_policies SET status = 'SUPERSEDED', superseded_at = now()
        WHERE currency = $1 AND status = 'ACTIVE'`,
      [String(currency)],
    );
    const { rows } = await client.query(
      `UPDATE deposit_policies SET status = 'ACTIVE', changed_by = COALESCE($3, changed_by)
        WHERE currency = $1 AND version = $2 RETURNING *`,
      [String(currency), Number(version), changedBy],
    );
    return toPolicy(rows[0]);
  });
}

/**
 * Reject a proposal. It stays in the history as a rejected version, because
 * "who proposed changing the split to 50/50 and who refused it" is a question
 * a review asks.
 */
export async function rejectPolicyVersion(currency, version, { changedBy = null } = {}) {
  const { rows } = await pgQuery(
    `UPDATE deposit_policies SET status = 'REJECTED', changed_by = COALESCE($3, changed_by)
      WHERE currency = $1 AND version = $2 AND status = 'PENDING_APPROVAL'
      RETURNING *`,
    [String(currency), Number(version), changedBy], 'deposit_policy_reject',
  );
  return toPolicy(rows[0]);
}

/**
 * Activate the scheduled versions whose time has come.
 *
 * ── One transaction per currency, not one for the batch ─────────────────────
 * `FOR UPDATE SKIP LOCKED` is what lets two instances run this at the same
 * time: the second skips the rows the first has taken rather than blocking on
 * them or activating them twice. A batch that failed halfway used to leave some
 * currencies switched and others not, with no record of which.
 *
 * Only ONE version per currency is taken per pass — the newest due one. Two
 * scheduled versions for the same currency coming due together would otherwise
 * both try to be ACTIVE, and the partial unique index would refuse the second
 * with an error rather than the correct answer, which is that the later one
 * wins.
 */
export async function applyScheduledPolicyChanges() {
  const { rows: due } = await pgQuery(
    `SELECT DISTINCT ON (currency) currency, version
       FROM deposit_policies
      WHERE status = 'SCHEDULED' AND effective_at <= now()
      ORDER BY currency, effective_at DESC, version DESC`,
    [], 'deposit_policy_due',
  );

  const results = [];
  for (const row of due) {
    try {
      const activated = await withTransaction(async (client) => {
        // SKIP LOCKED: another instance running the same sweep takes this row
        // instead, and this one moves on rather than waiting or double-applying.
        const { rows: claimed } = await client.query(
          `SELECT currency, version FROM deposit_policies
            WHERE currency = $1 AND version = $2 AND status = 'SCHEDULED'
            FOR UPDATE SKIP LOCKED`,
          [row.currency, row.version],
        );
        if (!claimed.length) return null;

        await client.query(
          `UPDATE deposit_policies SET status = 'SUPERSEDED', superseded_at = now()
            WHERE currency = $1 AND status = 'ACTIVE'`,
          [row.currency],
        );
        const { rows } = await client.query(
          `UPDATE deposit_policies SET status = 'ACTIVE'
            WHERE currency = $1 AND version = $2 RETURNING *`,
          [row.currency, row.version],
        );
        return toPolicy(rows[0]);
      });
      if (activated) {
        results.push({ currency: row.currency, version: Number(row.version), applied: true });
      }
    } catch (e) {
      results.push({
        currency: row.currency, version: Number(row.version), applied: false, error: e.message,
      });
    }
  }
  return results;
}

/**
 * Reinstate an old version's numbers as a NEW active version.
 *
 * History is never edited: the version being restored FROM is untouched, and
 * the one being replaced is superseded through the ordinary path. "Rollback"
 * here means "make these numbers current again", not "undo".
 */
export async function rollbackToPolicyVersion(currency, version, { changedBy = null } = {}) {
  const target = await getPolicyVersion(currency, version);
  if (!target) return { ok: false, reason: 'NOT_FOUND' };
  return createPolicyVersion({
    currency: target.currency,
    depositAllocationPercent: target.depositAllocationPercent,
    reserveAllocationPercent: target.reserveAllocationPercent,
    reserveUsageRules: target.reserveUsageRules,
    justification: `Rollback to v${target.version}`,
    effectiveAt: new Date(),
    changedBy,
    status: 'ACTIVE',
  });
}

/**
 * The split for one deposit, and the snapshot recording which policy produced it.
 *
 * ── Spec 4.4 rounding, and why it is here ───────────────────────────────────
 * The reserve share is FLOORED and the remainder goes to the player, so the two
 * always add back to the full amount. Rounding both independently loses or
 * invents a paisa on most amounts — over a day of deposits that is a reserve
 * that does not reconcile against the ledger.
 *
 * The fallback exists for a fresh install before any policy is configured. It
 * is logged loudly because a platform splitting real deposits by a hardcoded
 * default is a bootstrap state somebody forgot to leave.
 */
export async function splitForDeposit(tokenAmountRupees, currency = 'INR') {
  const policy = await getActivePolicy(currency);
  let depositPercent; let reservePercent; let version = null;

  if (policy) {
    depositPercent = policy.depositAllocationPercent;
    reservePercent = policy.reserveAllocationPercent;
    version = policy.version;
  } else {
    console.warn(`⚠️  No active DepositPolicy for ${currency} — falling back to 90/10. Configure one via PUT /api/admin/deposit-policy/${currency}.`);
    depositPercent = 90; reservePercent = 10;
  }

  const amount = Number(tokenAmountRupees) || 0;
  const reserveAllocation = Math.floor((amount * reservePercent) / 100);
  const depositAllocation = amount - reserveAllocation;

  return {
    depositAllocation,
    reserveAllocation,
    snapshot: {
      policyVersionId: version === null ? null : `${currency}:v${version}`,
      currency,
      depositAllocationPercent: depositPercent,
      reserveAllocationPercent: reservePercent,
    },
  };
}
