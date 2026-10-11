// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The merchant account's screens, one tab each, and who sees which (owner,
 * 2026-10-11 — Phase B of the merchants-and-agents plan).
 *
 *   Payment accounts  everyone in the account (a sub-member names the account
 *                     they paid a withdrawal from); edits are the owner's.
 *   Sub-members       the owner (the server sends the list to the owner only).
 *   Pool              everyone; a pool request is the owner's.
 *   Reports           the owner and AUDIT (`ownerOrAudit`).
 *   Flags             everyone.
 *
 * What a screen OFFERS, never the rule: the server answers OWNER_ONLY or
 * ROLE_REQUIRED whatever is shown (merchantActor.js).
 */
import { ROUTES } from '../../constants';
import type { MerchantProfile } from '../../types';
import { isOwner, mayReadReports } from '../../utils/actor';

type Who = Pick<MerchantProfile, 'actor' | 'isMerchantAccount'> | null | undefined;

export interface AccountTab { path: string; label: string; visible: (m: Who) => boolean }

export const ACCOUNT_TABS: AccountTab[] = [
  { path: ROUTES.ACCOUNT_PAYMENT_ACCOUNTS, label: 'Payment accounts', visible: () => true },
  { path: ROUTES.ACCOUNT_SUB_MEMBERS,      label: 'Sub-members',      visible: isOwner },
  { path: ROUTES.ACCOUNT_POOL,             label: 'Pool',             visible: () => true },
  { path: ROUTES.ACCOUNT_REPORTS,          label: 'Reports',          visible: mayReadReports },
  { path: ROUTES.ACCOUNT_FLAGS,            label: 'Flags',            visible: () => true },
];

export const accountTabsFor = (merchant: Who): AccountTab[] => ACCOUNT_TABS.filter((t) => t.visible(merchant));

/** Where the Account nav entry goes: the first tab this person may see. */
export const firstAccountTab = (merchant: Who): string => accountTabsFor(merchant)[0]?.path ?? ROUTES.DASHBOARD;
