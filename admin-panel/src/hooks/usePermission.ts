// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
import { useAuthStore } from '../services/auth';

/**
 * Permission hook — use inside any component to check what the current user can do.
 *
 * Permissions (set per sub-admin on the Sub-Admins page):
 *   canVerifyKYC        → /kyc: view queue, approve/reject submissions
 *   canManageUsers      → /users: view, block/unblock users (adjust balance: admin only)
 *   canManageMerchants  → /merchants: view, suspend/activate, update limits
 *   canResolveDisputes  → disputes: view and resolve payment order disputes
 *   canViewTransactions → /transactions: read-only transaction history
 *   canViewAnalytics    → dashboard, profit & loss, cycle history, live cycles
 *   canManageContent    → FAQ, support links, CDN images, branding
 *
 * isAdmin always returns true for all `can()` checks.
 * isQueueManager has no `can()` permissions — they only access /queue-manager.
 */
export const usePermissions = () => {
  const { admin } = useAuthStore();

  /** True if the current user has this permission (or is a full admin). */
  const can = (permission: string): boolean => {
    if (!admin) return false;
    if (admin.isAdmin) return true;
    if (!admin.isSubAdmin || !admin.permissions) return false;
    return (admin.permissions as any)[permission] === true;
  };

  /** True if the user has ANY of the listed permissions. */
  const canAny = (permissions: string[]): boolean => permissions.some(can);

  /** True if the user has ALL of the listed permissions. */
  const canAll = (permissions: string[]): boolean => permissions.every(can);

  /**
   * True if the user can access at least one page in the admin panel.
   * Used to decide where to redirect after login.
   */
  const hasAnyAccess = (): boolean => {
    if (!admin) return false;
    if (admin.isAdmin) return true;
    if (admin.isQueueManager) return true;
    if (!admin.isSubAdmin) return false;
    const perms = admin.permissions || {};
    return Object.values(perms).some(Boolean);
  };

  /**
   * Returns the first route the user is allowed to visit.
   * Used for post-login redirect.
   */
  const defaultRoute = (): string => {
    if (!admin) return '/login';
    if (admin.isAdmin) return '/';
    if (admin.isQueueManager) return '/queue-manager';
    if (can('canViewAnalytics')) return '/';
    if (can('canManageUsers')) return '/users';
    if (can('canManageMerchants')) return '/merchants';
    if (can('canVerifyKYC')) return '/kyc';
    if (can('canViewTransactions')) return '/transactions';
    if (can('canResolveDisputes')) return '/queue-manager'; // closest available
    if (can('canManageContent')) return '/content/faq';
    return '/login'; // no permissions at all
  };

  return {
    can,
    canAny,
    canAll,
    hasAnyAccess,
    defaultRoute,
    isAdmin: admin?.isAdmin || false,
    isSubAdmin: admin?.isSubAdmin || false,
    isQueueManager: admin?.isQueueManager || false,
  };
};
