// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * What "Save Permissions" actually puts on the wire (§32 S26).
 *
 * `updatePermissions` sent the grant AS the request body. The route reads
 * `req.body.permissions`, found nothing, and stored an empty grant — so every
 * save on the Sub-admins screen revoked everything the sub-admin had. A screen
 * test that mocks this client cannot see that; only the request can.
 */
import { describe, it, expect, vi } from 'vitest';

const { put, get } = vi.hoisted(() => ({ put: vi.fn(), get: vi.fn() }));
vi.mock('axios', () => {
  const instance = {
    get, put, post: vi.fn(), patch: vi.fn(), delete: vi.fn(),
    interceptors: { request: { use: vi.fn() }, response: { use: vi.fn() } },
    defaults: { headers: { common: {} } },
  };
  return { default: { create: () => instance, isAxiosError: () => false }, isAxiosError: () => false };
});

import api from './api';

describe('the sub-admin permission requests', () => {
  it('sends the grant under `permissions`, the key the route reads', async () => {
    put.mockResolvedValue({ data: { success: true } });
    await api.subAdmins.updatePermissions('u-1', { canManageUsers: true, canViewAnalytics: false });
    expect(put).toHaveBeenCalledWith('/api/admin/sub-admins/u-1/permissions', {
      permissions: { canManageUsers: true, canViewAnalytics: false },
    });
  });

  it('reads the list an admin picks from from the server', async () => {
    get.mockResolvedValue({ data: { success: true, groups: [], permissions: [], adminOnly: [] } });
    await api.subAdmins.permissionCatalog();
    expect(get).toHaveBeenCalledWith('/api/admin/staff-permissions');
  });
});
