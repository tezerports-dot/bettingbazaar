// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
import { useAuthStore } from '../services/auth';
import type { PermissionKey } from '../utils/permissions';

/**
 * What the signed-in staff account may do in the panel.
 *
 * `can(key)` takes a key from `utils/permissions.ts` — the server's list of
 * areas. A full admin holds every key; a sub-admin holds the ones an admin
 * ticked on the Sub-admins screen; a queue manager holds none (their access is
 * the queue, decided separately). This only decides what is OFFERED: the server
 * refuses the same routes by the same keys.
 */
export const usePermissions = () => {
  const { admin } = useAuthStore();

  /** True if the current user has this permission (or is a full admin). */
  const can = (permission: PermissionKey): boolean => {
    if (!admin) return false;
    if (admin.isAdmin) return true;
    if (!admin.isSubAdmin || !admin.permissions) return false;
    return (admin.permissions as any)[permission] === true;
  };

  /** True if the user has ANY of the listed permissions. */
  const canAny = (permissions: PermissionKey[]): boolean => permissions.some(can);

  /** True if the user has ALL of the listed permissions. */
  const canAll = (permissions: PermissionKey[]): boolean => permissions.every(can);

  return {
    can,
    canAny,
    canAll,
    isAdmin: admin?.isAdmin || false,
    isSubAdmin: admin?.isSubAdmin || false,
    isQueueManager: admin?.isQueueManager || false,
  };
};
