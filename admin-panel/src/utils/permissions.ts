// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The permission KEYS the panel's route guards and sidebar name — a §5 mirror of
 * `backend/domains/identity/staffPermissions.js` (`PERMISSION_KEYS`).
 *
 * Keys only. What each one is CALLED and what it opens is not kept here: the
 * Sub-admins screen renders its picker from `GET /api/admin/staff-permissions`,
 * so the words an admin reads are the server's. The previous nine-key list here
 * had labels of its own and had drifted from the routes in both directions — the
 * chat screen asked for `canModerateChatPublic` while every chat route asked for
 * `canManageSupport`.
 *
 * `npm run check:staff-permissions` fails the build when this list differs from
 * the server's, or when a guard below names a key the server does not declare.
 */
export const PERMISSION_KEYS = [
  'canViewAnalytics',
  'canExportLedger',
  'canViewAuditLogs',
  'canManageUsers',
  'canAdjustBalances',
  'canViewTransactions',
  'canManagePhantomAgents',
  'canManageReferrals',
  'canManageMerchants',
  'canManageTeams',
  'canFundMerchants',
  'canManageCommission',
  'canResolveDisputes',
  'canManageUtr',
  'canManagePaymentSystem',
  'canManageBusinessPolicy',
  'canManageGames',
  'canManageCycles',
  'canManageContent',
  'canModerateChat',
  'canManageSupportTickets',
  'canManageSupportAssistant',
  'canManageTelegram',
  'canManageSystemSettings',
  'canManageAndroidApp',
  'canManageIpBlocks',
  'canRunMaintenance',
] as const;

export type PermissionKey = typeof PERMISSION_KEYS[number];

/** All-false — the starting point of a new sub-admin's grant. */
export const DEFAULT_PERMISSIONS: Record<PermissionKey, boolean> =
  Object.fromEntries(PERMISSION_KEYS.map((k) => [k, false])) as Record<PermissionKey, boolean>;

/** One grantable permission, as `GET /api/admin/staff-permissions` describes it. */
export interface StaffPermission {
  key: PermissionKey;
  group: string;
  label: string;
  description: string;
  money?: boolean;
}

export interface StaffPermissionCatalog {
  groups: { key: string; label: string }[];
  permissions: StaffPermission[];
  adminOnly: { area: string; why: string }[];
}
