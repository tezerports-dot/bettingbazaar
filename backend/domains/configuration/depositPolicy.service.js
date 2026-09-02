// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * domains/configuration/depositPolicy.service.js — the deposit/reserve split.
 *
 * A thin adapter over `db.depositPolicy`. The rules live in the table and the
 * repository; this file exists because the admin routes and the cron already
 * import these names.
 *
 * ── What moved into the row ─────────────────────────────────────────────────
 *
 * 1. "EXACTLY ONE ACTIVE VERSION PER CURRENCY" was two writes: create the new
 *    version, then `updateMany` the old ones to SUPERSEDED. Two admins saving
 *    together left two ACTIVE documents and the next deposit was split by
 *    whichever `.sort({version:-1})` returned. It is a partial unique index
 *    now, and the supersede commits with the insert.
 *
 * 2. "THE PERCENTAGES SUM TO 100" was `validatePolicyFields`, called by the
 *    callers that remembered to call it — the rollback path did not. A split
 *    that does not sum to 100 creates or destroys money on every deposit it
 *    governs, so it is a CHECK constraint.
 *
 * 3. `nextVersionNumber()` was `MAX(version) + 1` read outside any transaction.
 *    Two versions saved together got the same number and one died on the
 *    index — after the other had already been made ACTIVE.
 *
 * SCOPE: this policy governs ONLY the deposit/reserve wallet split and reserve
 * usage rules. Merchant incentive pay is a separate mechanism (the Merchant
 * Performance Bonus) triggered by completed buy+sell cycles.
 */
import { db } from '#db';

export const SUPPORTED_CURRENCIES = Object.freeze(['INR', 'USDT']);

/**
 * Cross-field validation, kept as an exported name because the admin routes
 * call it to produce a friendly message BEFORE attempting the write.
 *
 * It is no longer the guard. The table refuses a bad split whether or not
 * anybody calls this, which is the point — this only decides how the refusal
 * is worded.
 */
export function validatePolicyFields(fields) {
  const { currency, depositAllocationPercent, reserveAllocationPercent } = fields;

  if (!SUPPORTED_CURRENCIES.includes(currency)) {
    throw new Error(`Unsupported currency '${currency}'. Add it to SUPPORTED_CURRENCIES in depositPolicy.service.js first.`);
  }
  if (typeof depositAllocationPercent !== 'number' || typeof reserveAllocationPercent !== 'number') {
    throw new Error('depositAllocationPercent and reserveAllocationPercent are required numbers.');
  }
  if (depositAllocationPercent < 0 || reserveAllocationPercent < 0) {
    throw new Error('Allocation percentages cannot be negative.');
  }
  const sum = depositAllocationPercent + reserveAllocationPercent;
  if (Math.abs(sum - 100) > 0.01) {
    throw new Error(`depositAllocationPercent + reserveAllocationPercent must equal 100 (got ${sum}).`);
  }
  return true;
}

/** The runtime read path — what a new DEPOSIT order is split by. */
export const getActivePolicy = (currency) => db.depositPolicy.getActivePolicy(currency);

/** Every version for a currency, newest first. */
export const getPolicyHistory = (currency) => db.depositPolicy.getPolicyHistory(currency);

/**
 * Publish a new version.
 *
 * `requireApproval` holds it at PENDING_APPROVAL; a future `effectiveAt`
 * schedules it. Neither supersedes the current policy — a proposal does not
 * govern deposits, and the version that does keeps doing so until somebody
 * approves this one or its time arrives.
 */
export async function createPolicyVersion(currency, fields, actor, opts = {}) {
  const { justification, effectiveAt = new Date(), requireApproval = false } = opts;
  if (!justification || !justification.trim()) {
    throw new Error('businessJustification is required for every DepositPolicy change.');
  }
  validatePolicyFields({
    currency,
    depositAllocationPercent: fields.depositAllocationPercent,
    reserveAllocationPercent: fields.reserveAllocationPercent,
  });

  const isFuture = effectiveAt > new Date();
  const status = requireApproval ? 'PENDING_APPROVAL' : (isFuture ? 'SCHEDULED' : 'ACTIVE');

  const result = await db.depositPolicy.createPolicyVersion({
    currency,
    depositAllocationPercent: fields.depositAllocationPercent,
    reserveAllocationPercent: fields.reserveAllocationPercent,
    reserveUsageRules: fields.reserveUsageRules ?? {},
    justification, effectiveAt, status,
    changedBy: actor?.userId ?? null,
  });

  if (!result.ok) throw Object.assign(new Error(result.message), { status: 400, code: result.reason });
  return result.policy;
}

/**
 * Move a PENDING_APPROVAL version forward. Rejecting is the same call with
 * `approve=false`.
 *
 * Takes a currency and a version rather than a document id: the version is what
 * the history, the snapshot on every order, and the operator all refer to.
 */
export async function approvePolicyVersion({ currency, version }, actor, approve = true) {
  if (!approve) {
    const rejected = await db.depositPolicy.rejectPolicyVersion(currency, version, { changedBy: actor?.userId });
    if (!rejected) throw Object.assign(new Error('Version is not awaiting approval'), { status: 409 });
    return rejected;
  }
  const activated = await db.depositPolicy.activatePolicyVersion(currency, version, { changedBy: actor?.userId });
  if (!activated) throw Object.assign(new Error('Version is not awaiting approval'), { status: 409 });
  return activated;
}

/** Reinstate an old version's numbers as a NEW active version. History is never edited. */
export async function rollbackToPolicyVersion({ currency, version }, actor) {
  const result = await db.depositPolicy.rollbackToPolicyVersion(currency, version, { changedBy: actor?.userId });
  if (!result.ok) {
    throw Object.assign(
      new Error(result.reason === 'NOT_FOUND' ? 'Policy version not found' : result.message),
      { status: result.reason === 'NOT_FOUND' ? 404 : 400, code: result.reason },
    );
  }
  return result.policy;
}

/** Activate SCHEDULED versions whose effectiveAt has passed. Runs on the cron. */
export const applyScheduledPolicyChanges = () => db.depositPolicy.applyScheduledPolicyChanges();

/** The split for one deposit, plus the snapshot recording which policy produced it. */
export const splitForDeposit = (tokenAmount, currency) => db.depositPolicy.splitForDeposit(tokenAmount, currency);
