// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Who is acting on a merchant session, and what they may do (owner,
 * 2026-10-11 — Phase B of the merchants-and-agents plan).
 *
 * A merchant session is the OWNER's (any merchant, agent or merchant account)
 * or a SUB-MEMBER's of a merchant account (merchantStaff.js). `merchantAuth`
 * puts the answer on `req.merchantActor`, read fresh from the rows on every
 * request:
 *
 *   owner        every power.
 *   DEPOSITS     works a BUY only when it is paid into an account assigned to
 *                them for DEPOSIT (`order.payAccountId`).
 *   WITHDRAWALS  works a SELL only with an account assigned to them for
 *                WITHDRAWAL, and marks it paid only from one of those.
 *   AUDIT        reads every order and report; writes nothing.
 *
 * Account-level writes (online switch, directions, profile, payment accounts,
 * sub-members, pool requests) are the owner's alone (`ownerOnly`).
 */
import { STAFF_ROLES } from '#db/repositories/merchantStaff.js';

export const OWNER_ACTOR = Object.freeze({
  isOwner: true, staffId: null, roles: Object.freeze(Object.values(STAFF_ROLES)),
  depositAccountIds: null, withdrawalAccountIds: null,
});

/**
 * The `actor` an order transition records for a merchant's ✓ or ✗ (owner,
 * 2026-10-16: the report shows who acted). A sub-member is named by their
 * staff id, everyone else by the merchant id the session acts for. Read back
 * only by `orderReport` (merchantReports.js).
 */
export function merchantActorTag(req) {
  const a = req.merchantActor;
  return a && a.isOwner === false && a.staffId ? `merchant_staff:${a.staffId}` : `merchant:${req.merchantId}`;
}

/** The actor for a sub-member row (with its assignments). */
export function actorForStaff(staff) {
  const of = (duty) => Object.freeze(staff.assignments.filter((a) => a.duty === duty).map((a) => a.accountId));
  return Object.freeze({
    isOwner: false,
    staffId: staff.staffId,
    userId: staff.userId,
    name: staff.name,
    roles: Object.freeze([...staff.roles]),
    depositAccountIds: of('DEPOSIT'),
    withdrawalAccountIds: of('WITHDRAWAL'),
  });
}

const refusal = (code, message) => ({ status: 403, code, message });

/**
 * Whether this actor may WORK (accept, confirm, decline, reject, flag, scan
 * for) this order: null when they may, or the 403 to answer with.
 */
export function workRefusal(actor, order) {
  if (!actor || actor.isOwner) return null;
  if (order.type === 'DEPOSIT') {
    if (!actor.roles.includes(STAFF_ROLES.DEPOSITS)) {
      return refusal('ROLE_REQUIRED', 'Your role does not include deposits. Ask the merchant account owner.');
    }
    if (!order.payAccountId || !actor.depositAccountIds.includes(String(order.payAccountId))) {
      return refusal('ACCOUNT_NOT_ASSIGNED', 'This deposit is paid into an account not assigned to you.');
    }
    return null;
  }
  if (!actor.roles.includes(STAFF_ROLES.WITHDRAWALS)) {
    return refusal('ROLE_REQUIRED', 'Your role does not include withdrawals. Ask the merchant account owner.');
  }
  if (!actor.withdrawalAccountIds.length) {
    return refusal('ACCOUNT_NOT_ASSIGNED', 'No account is assigned to you for paying withdrawals. Ask the merchant account owner.');
  }
  if (order.paidFromAccountId && !actor.withdrawalAccountIds.includes(String(order.paidFromAccountId))) {
    return refusal('ACCOUNT_NOT_ASSIGNED', 'This withdrawal was paid from an account not assigned to you.');
  }
  return null;
}

/** Answer a refusal from `workRefusal`; true when it answered. */
export function refuseWork(req, res, order) {
  const no = workRefusal(req.merchantActor, order);
  if (!no) return false;
  res.status(no.status).json({ success: false, code: no.code, message: no.message });
  return true;
}

/** Middleware: account-level writes are the owner's. */
export function ownerOnly(req, res, next) {
  if (!req.merchantActor || req.merchantActor.isOwner) return next();
  return res.status(403).json({
    success: false, code: 'OWNER_ONLY',
    message: 'Only the merchant account owner can do this.',
  });
}

/** Middleware: reports are the owner's and AUDIT's. */
export function ownerOrAudit(req, res, next) {
  const a = req.merchantActor;
  if (!a || a.isOwner || a.roles.includes(STAFF_ROLES.AUDIT)) return next();
  return res.status(403).json({ success: false, code: 'ROLE_REQUIRED', message: 'Reports need the AUDIT role.' });
}

/**
 * What a sub-member's order list shows: everything for AUDIT; otherwise the
 * buys paid into their deposit accounts and the sells they may work (unpaid,
 * or paid from one of theirs). Null = no narrowing (owner or AUDIT).
 */
export function listScopeFor(actor) {
  if (!actor || actor.isOwner || actor.roles.includes(STAFF_ROLES.AUDIT)) return null;
  return {
    depositAccountIds: actor.roles.includes(STAFF_ROLES.DEPOSITS) ? [...actor.depositAccountIds] : [],
    withdrawalAccountIds: actor.roles.includes(STAFF_ROLES.WITHDRAWALS) && actor.withdrawalAccountIds.length
      ? [...actor.withdrawalAccountIds] : null,
  };
}
