// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)

export const PERMISSION_KEYS = [
  'canViewAnalytics',
  'canManageUsers',
  'canManageMerchants',
  'canVerifyKYC',
  'canViewTransactions',
  'canResolveDisputes',
  'canManageContent',
  'canManageSupport',        // back-compat alias — maps to canManageContent behaviour
  'canModerateChatPublic',   
] as const;

export type PermissionKey = typeof PERMISSION_KEYS[number];

/** All-false default — base for new sub-admin creation forms. */
export const DEFAULT_PERMISSIONS: Record<PermissionKey, boolean> =
  Object.fromEntries(PERMISSION_KEYS.map(k => [k, false])) as Record<PermissionKey, boolean>;

export const PERMISSION_LABELS: Record<PermissionKey, string> = {
  canViewAnalytics:      'View Analytics',
  canManageUsers:        'Manage Users',
  canManageMerchants:    'Manage Merchants',
  canVerifyKYC:          'Verify KYC',
  canViewTransactions:   'View Transactions',
  canResolveDisputes:    'Resolve Disputes',
  canManageContent:      'Manage Content',
  canManageSupport:      'Manage Support',
  canModerateChatPublic: 'Moderate Public Chat',
};

export const PERMISSION_DESCRIPTIONS: Record<PermissionKey, string> = {
  canViewAnalytics:      'Read access: Dashboard, Live Cycles, Cycle History, Profit & Loss',
  canManageUsers:        'View users, block/unblock. Balance adjustments: full admin only.',
  canManageMerchants:    'View merchants, suspend/activate, update transaction limits',
  canVerifyKYC:          'View KYC queue, approve and reject user KYC submissions',
  canViewTransactions:   'Read-only transaction history list',
  canResolveDisputes:    'View and resolve payment order disputes',
  canManageContent:      'FAQ manager, support links, CDN images, branding page',
  canManageSupport:      'Alias for canManageContent (back-compat)',
  canModerateChatPublic: 'Delete messages, ban users, manage chat config',
};
