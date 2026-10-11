// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Who is signed in, and what the screens offer them (owner, 2026-10-11 —
 * Phase B of the merchants-and-agents plan).
 *
 * A merchant session is the OWNER's (any merchant: an agent, a supervisor, or a
 * merchant account) or a SUB-MEMBER's of a merchant account, with the roles
 * DEPOSITS, WITHDRAWALS and AUDIT and the payment accounts assigned to them.
 *
 * ── A mirror for what is OFFERED, never the rule ──────────────────────────────
 * The server decides every one of these on every request
 * (backend/domains/merchant/merchantActor.js: `workRefusal`, `ownerOnly`,
 * `ownerOrAudit`) and answers 403 ROLE_REQUIRED / ACCOUNT_NOT_ASSIGNED /
 * OWNER_ONLY with a sentence. This only keeps a control off the screen of a
 * person who cannot use it (§11: UI-only, never used for validation). Change
 * it in the same commit as merchantActor.js (§5).
 */
import type { MerchantActor, MerchantProfile, PaymentOrder, StaffRole } from '../types';

type Who = Pick<MerchantProfile, 'actor' | 'isMerchantAccount'> | null | undefined;

/** The owner unless the server said otherwise (the login answer and GET /profile carry `actor`). */
export function actorOf(merchant: Who): MerchantActor {
  return merchant?.actor ?? { isOwner: true };
}

/** A merchant account's sub-member (never the owner). */
export function isSubMember(merchant: Who): boolean {
  return actorOf(merchant).isOwner === false;
}

/** Whether this session belongs to a merchant account: its owner, or one of its sub-members. */
export function isMerchantAccountSession(merchant: Who): boolean {
  return merchant?.isMerchantAccount === true || isSubMember(merchant);
}

export function hasRole(merchant: Who, role: StaffRole): boolean {
  const actor = actorOf(merchant);
  return actor.isOwner || actor.roles.includes(role);
}

/** Account-level writes: online switch, directions, profile, accounts, sub-members, pool requests. */
export function isOwner(merchant: Who): boolean {
  return actorOf(merchant).isOwner;
}

/** Reports: the owner's and AUDIT's (`ownerOrAudit`). */
export function mayReadReports(merchant: Who): boolean {
  return hasRole(merchant, 'AUDIT');
}

/**
 * Whether this person may WORK this order — accept, confirm, decline, reject,
 * flag, scan — the same questions `workRefusal` asks. AUDIT alone works
 * nothing; a deposit needs DEPOSITS and the account it is paid into assigned
 * to them; a withdrawal needs WITHDRAWALS and an account to pay it from.
 */
export function mayWorkOrder(merchant: Who, order: Pick<PaymentOrder, 'type' | 'payAccountId' | 'paidFromAccountId'>): boolean {
  const actor = actorOf(merchant);
  if (actor.isOwner) return true;
  if (order.type === 'DEPOSIT') {
    if (!actor.roles.includes('DEPOSITS')) return false;
    return Boolean(order.payAccountId) && (actor.depositAccountIds ?? []).includes(String(order.payAccountId));
  }
  if (!actor.roles.includes('WITHDRAWALS')) return false;
  const mine = actor.withdrawalAccountIds ?? [];
  if (!mine.length) return false;
  return !order.paidFromAccountId || mine.includes(String(order.paidFromAccountId));
}

/** The accounts a sell may be marked paid from: active, paying withdrawals, and (sub-member) assigned to them. */
export function payFromChoices<A extends { accountId: string; status: string; paysWithdrawals: boolean }>(
  merchant: Who, accounts: A[],
): A[] {
  const actor = actorOf(merchant);
  const allowed = actor.isOwner ? null : (actor.withdrawalAccountIds ?? []);
  return accounts.filter((a) => a.status === 'ACTIVE' && a.paysWithdrawals
    && (allowed === null || allowed.includes(a.accountId)));
}

/** What each role is called on screen. */
export const ROLE_LABEL: Record<StaffRole, string> = {
  DEPOSITS: 'Deposit verifier',
  WITHDRAWALS: 'Withdrawal processor',
  AUDIT: 'Auditor',
};

/** STAFF_ROLES (database/repositories/merchantStaff.js), in its order. */
export const STAFF_ROLE_LIST: StaffRole[] = ['DEPOSITS', 'WITHDRAWALS', 'AUDIT'];
