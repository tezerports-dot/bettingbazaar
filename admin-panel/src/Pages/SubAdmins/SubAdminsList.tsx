// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
import React, { useCallback, useEffect, useState } from 'react';
import { UserPlus, Edit, Trash2, Key, Layers} from 'lucide-react';
import { DataTable } from '../../components/DataTable';
import { Kpis, Toolbar } from '../../components/design';
import { Modal } from '../../components/Modal';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { formatters } from '../../utils/formatters';
import api from '../../services/api';
import type { User } from '../../types';
import toast from 'react-hot-toast';
import { DEFAULT_PERMISSIONS, type StaffPermissionCatalog } from '../../utils/permissions';
import { PermissionPicker } from './PermissionPicker';


export const SubAdminsList: React.FC = () => {
  const [subAdmins, setSubAdmins] = useState<User[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [queueManagers, setQueueManagers] = useState<any[]>([]);
  const [qmBusy, setQmBusy] = useState<string | null>(null);
  const [grantMobile, setGrantMobile] = useState('');

  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showPhantomModal, setShowPhantomModal] = useState(false);
  const [showPermissionsModal, setShowPermissionsModal] = useState(false);
  const [selectedUser, setSelectedUser] = useState<User | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<User | null>(null);

  const [formData, setFormData] = useState({
    username: '',
    mobile: '',
    password: '',
    permissions: { ...DEFAULT_PERMISSIONS } as Record<string, boolean>,
  });

  const [editPermissions, setEditPermissions] = useState<Record<string, boolean>>({
    ...DEFAULT_PERMISSIONS,
  });
  const [isSavingPermissions, setIsSavingPermissions] = useState(false);

  // 'BOTH' predates the 1-minute block and means EVERY type, not two — the
  // server gate reads it as "skip the per-type check".
  const [phantomAccess, setPhantomAccess] = useState<'NONE' | '1_MIN' | '30_MIN' | 'FULL_DAY' | 'BOTH'>(
    'NONE'
  );

  // The list an admin picks from is the SERVER's (staffPermissions.js): every
  // area, its description, and whether it moves money.
  const [catalog, setCatalog] = useState<StaffPermissionCatalog | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const loadCatalog = useCallback(async () => {
    try {
      setCatalog(await api.subAdmins.permissionCatalog());
      setCatalogError(null);
    } catch (e: any) {
      setCatalogError(e.response?.data?.message || 'The permission list could not be loaded.');
    }
  }, []);

  /**
   * Queue-manager authority — a separate grant from sub-admin permissions.
   *
   * A queue manager assigns payment orders to merchants, so this decides where
   * a player's money is routed. Both endpoints existed with nothing calling
   * them: the only way to grant it was to write the column by hand.
   */
  const loadQueueManagers = useCallback(async () => {
    try {
      const r = await api.subAdmins.listQueueManagers();
      if (r?.success) setQueueManagers(r.managers || []);
    } catch { /* the section simply does not render */ }
  }, []);

  const toggleQueueManager = async (userId: string, enable: boolean) => {
    setQmBusy(userId);
    try {
      await api.subAdmins.setQueueManager(userId, enable);
      toast.success(enable ? 'Queue-manager access granted' : 'Queue-manager access revoked');
      loadQueueManagers();
    } catch (e: any) {
      toast.error(e.response?.data?.message || 'Failed to change queue-manager access');
    } finally { setQmBusy(null); }
  };

  const loadSubAdmins = useCallback(async () => {
    setIsLoading(true);
    try {
      const response = await api.subAdmins.getAll();
      if (response.success && response.data) setSubAdmins(response.data);
    } catch {
      toast.error('Failed to load sub-admins');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => { loadSubAdmins(); loadQueueManagers(); loadCatalog(); }, [loadSubAdmins, loadQueueManagers, loadCatalog]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await api.subAdmins.create(formData);
      toast.success('Sub-admin created successfully');
      setShowCreateModal(false);
      loadSubAdmins();
      resetForm();
    } catch (error: any) {
      toast.error(error.response?.data?.message || 'Failed to create sub-admin');
    }
  };

  const handleDelete = async (subAdminId: string) => {
    try {
      await api.subAdmins.delete(subAdminId);
      toast.success('Sub-admin removed');
      loadSubAdmins();
    } catch (error: any) {
      toast.error(error.response?.data?.message || 'Failed to delete sub-admin');
    }
  };

  const handleAssignPhantomAccess = async () => {
    if (!selectedUser) return;
    try {
      await api.subAdmins.assignPhantomAccess(selectedUser.userId, phantomAccess);
      toast.success('Phantom access updated');
      setShowPhantomModal(false);
      loadSubAdmins();
    } catch (error: any) {
      toast.error(error.response?.data?.message || 'Failed to update phantom access');
    }
  };

  const openPermissionsModal = (user: User) => {
    setSelectedUser(user);
    const perms = { ...DEFAULT_PERMISSIONS, ...(user.subAdminPermissions || {}) };
    setEditPermissions(perms);
    setShowPermissionsModal(true);
  };

  const handleSavePermissions = async () => {
    if (!selectedUser) return;
    setIsSavingPermissions(true);
    try {
      await api.subAdmins.updatePermissions(selectedUser.userId, editPermissions);
      toast.success('Permissions updated');
      setShowPermissionsModal(false);
      loadSubAdmins();
    } catch (error: any) {
      toast.error(error.response?.data?.message || 'Failed to update permissions');
    } finally {
      setIsSavingPermissions(false);
    }
  };

  const resetForm = () => {
    setFormData({ username: '', mobile: '', password: '', permissions: { ...DEFAULT_PERMISSIONS } });
  };

  const permLabel = (key: string) => catalog?.permissions.find((p) => p.key === key)?.label ?? key;

  const columns = [
    {
      key: 'username',
      label: 'Username',
      render: (user: User) => <span className="font-medium">{user.username}</span>,
    },
    {
      key: 'mobile',
      label: 'Mobile',
      render: (user: User) => <span className="text-gray-400">{formatters.phone(user.mobile)}</span>,
    },
    {
      key: 'permissions',
      label: 'Permissions',
      render: (user: User) => {
        const perms = user.subAdminPermissions || {};
        const activePerms = Object.keys(perms).filter((k) => (perms as Record<string, boolean>)[k] === true);
        return (
          <div className="flex flex-wrap gap-1 max-w-xs">
            {activePerms.length === 0 ? (
              <span className="text-xs text-gray-500">None assigned</span>
            ) : (
              activePerms.map((k) => (
                <span key={k} className="px-1.5 py-0.5 rounded-sm text-xs bg-purple-500/20 text-purple-400">
                  {permLabel(k)}
                </span>
              ))
            )}
          </div>
        );
      },
    },
    {
      key: 'phantomAccess',
      label: 'Phantom Access',
      render: (user: User) => {
        const colors: Record<string, string> = {
          NONE: 'bg-gray-500/20 text-gray-500',
          '1_MIN': 'bg-teal-500/20 text-teal-500',
          '30_MIN': 'bg-blue-500/20 text-blue-500',
          FULL_DAY: 'bg-purple-500/20 text-purple-500',
          BOTH: 'bg-gold-500/20 text-gold-500',
        };
        return (
          <span
            className={`px-2 py-1 rounded text-xs font-medium ${
              colors[user.phantomAccess] || colors.NONE
            }`}
          >
            {(user.phantomAccess || 'NONE').replace('_', ' ')}
          </span>
        );
      },
    },
    {
      key: 'actions',
      label: 'Actions',
      render: (user: User) => (
        <div className="flex items-center space-x-2">
          <button
            onClick={() => openPermissionsModal(user)}
            className="p-2 hover:bg-purple-600/20 rounded-lg transition-colors text-purple-400"
            title="Edit Permissions"
          >
            <Key size={16} />
          </button>
          <button
            onClick={() => {
              setSelectedUser(user);
              setPhantomAccess(user.phantomAccess || 'NONE');
              setShowPhantomModal(true);
            }}
            className="p-2 hover:bg-dark-700 rounded-lg transition-colors"
            title="Edit Phantom Access"
          >
            <Edit size={16} />
          </button>
          <button
            onClick={() => setConfirmDelete(user)}
            className="p-2 hover:bg-red-600/20 rounded-lg transition-colors text-red-500"
            title="Remove Sub-Admin"
          >
            <Trash2 size={16} />
          </button>
        </div>
      ),
    },
  ];

  return (
    <div className="om-fade space-y-6">
      <Toolbar actions={[{ label: 'Create Sub-Admin', icon: UserPlus, primary: true, onClick: () => setShowCreateModal(true) }]} />

      {/* ── Queue-manager authority ─────────────────────────────────────────
          Separate from sub-admin permissions: this grant lets an account route
          a player's money to a merchant, so it is listed on its own and the
          revoke is one click. */}
      <div className="bg-dark-800 border border-dark-600 rounded-lg p-4 space-y-3">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div>
            <p className="text-sm font-semibold text-gray-300 flex items-center gap-2">
              <Layers size={14} className="text-blue-400" />
              Queue managers ({queueManagers.length})
            </p>
            <p className="text-xs text-gray-500 mt-0.5">
              These accounts assign payment orders to merchants — they decide where a player's money goes.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <input
              value={grantMobile}
              onChange={(e) => setGrantMobile(e.target.value)}
              className="input text-sm"
              placeholder="User id to grant…"
            />
            <button
              onClick={() => { if (grantMobile.trim()) { toggleQueueManager(grantMobile.trim(), true); setGrantMobile(''); } }}
              disabled={!grantMobile.trim() || qmBusy !== null}
              className="btn-secondary text-sm disabled:opacity-50"
            >Grant</button>
          </div>
        </div>

        {queueManagers.length === 0 ? (
          <p className="text-xs text-gray-500">Nobody holds queue-manager access.</p>
        ) : (
          <div className="space-y-1.5">
            {queueManagers.map((m: any) => (
              <div key={m.userId ?? m._id} className="flex items-center justify-between bg-dark-700 rounded-lg px-4 py-2.5 text-sm">
                <div className="min-w-0">
                  <p className="text-gray-200">{m.username || 'Unnamed'}</p>
                  <p className="text-xs text-gray-500 font-mono truncate">{m.mobile || m.userId || m._id}</p>
                </div>
                <button
                  onClick={() => toggleQueueManager(String(m.userId ?? m._id), false)}
                  disabled={qmBusy !== null}
                  className="px-3 py-1.5 bg-red-500/20 text-red-300 text-xs font-semibold rounded-lg hover:bg-red-500/30 disabled:opacity-50"
                >Revoke</button>
              </div>
            ))}
          </div>
        )}
      </div>

      {catalogError && (
        <div role="alert" className="bg-red-500/10 border border-red-500/30 rounded-lg p-3 text-sm text-red-300 flex items-center justify-between gap-3">
          <span>{catalogError} Sub-admins cannot be created or edited until it loads.</span>
          <button type="button" className="btn-secondary text-xs" onClick={loadCatalog}>Try again</button>
        </div>
      )}

      {/* Phantom Access Reference */}
      <div className="bg-orange-500/10 border border-orange-500/30 rounded-lg p-4 text-sm">
        <p className="font-semibold text-orange-400 mb-1">Phantom Access</p>
        <p className="text-gray-400">
          <strong className="text-gray-300">NONE</strong>: No phantom betting ·{' '}
          <strong className="text-gray-300">1_MIN</strong>: 1-min cycles only ·{' '}
          <strong className="text-gray-300">30_MIN</strong>: 30-min cycles only ·{' '}
          <strong className="text-gray-300">FULL_DAY</strong>: Full-day cycles only ·{' '}
          <strong className="text-gray-300">BOTH</strong>: All cycle types.
          Phantom bets always lose — they only balance the pool display.
        </p>
      </div>

      <Kpis min={200} items={[
        { label: 'Total Sub-Admins', value: subAdmins.length },
        { label: 'Phantom Managers', value: subAdmins.filter((u) => u.phantomAccess && u.phantomAccess !== 'NONE').length, tone: 'var(--gold-ink)' },
        { label: 'With Permissions', value: subAdmins.filter((u) => u.subAdminPermissions && Object.values(u.subAdminPermissions).some(Boolean)).length, tone: 'var(--risk)' },
      ]} />

      <div className="card">
        <DataTable
          data={subAdmins}
          columns={columns}
          currentPage={1}
          totalPages={1}
          onPageChange={() => {}}
          isLoading={isLoading}
        />
      </div>

      {/* ── Create Modal ── */}
      <Modal
        isOpen={showCreateModal}
        onClose={() => { setShowCreateModal(false); resetForm(); }}
        title="Create Sub-Admin"
      >
        <form onSubmit={handleCreate} className="space-y-4">
          <div>
            <label className="label" htmlFor="username">Username</label>
            <input id="username"
              type="text"
              value={formData.username}
              onChange={(e) => setFormData({ ...formData, username: e.target.value })}
              className="input"
              required
            />
          </div>
          <div>
            <label className="label" htmlFor="mobile">Mobile</label>
            <input id="mobile"
              type="tel"
              value={formData.mobile}
              onChange={(e) => setFormData({ ...formData, mobile: e.target.value })}
              className="input"
              required
            />
          </div>
          <div>
            <label className="label" htmlFor="password">Password</label>
            <input id="password"
              type="password"
              value={formData.password}
              onChange={(e) => setFormData({ ...formData, password: e.target.value })}
              className="input"
              required
            />
          </div>
          <div>
            <p className="label mb-3">Permissions — the areas this sub-admin can work in</p>
            <PermissionPicker
              idPrefix="create-perm"
              catalog={catalog}
              value={formData.permissions}
              onChange={(permissions) => setFormData({ ...formData, permissions })}
            />
          </div>
          <button type="submit" className="w-full btn-primary disabled:opacity-50" disabled={!catalog}>
            Create Sub-Admin
          </button>
        </form>
      </Modal>

      {/* ── Edit Permissions Modal ── */}
      {selectedUser && (
        <Modal
          isOpen={showPermissionsModal}
          onClose={() => setShowPermissionsModal(false)}
          title={`Permissions — ${selectedUser.username}`}
        >
          <div className="space-y-4">
            <p className="text-sm text-gray-400">
              Tick the areas this sub-admin can work in. The server applies the change
              immediately and closes their live feeds; their sidebar updates the next
              time they load the panel.
            </p>
            <PermissionPicker
              idPrefix="edit-perm"
              catalog={catalog}
              value={editPermissions}
              onChange={setEditPermissions}
            />
            <button
              onClick={handleSavePermissions}
              disabled={isSavingPermissions || !catalog}
              className="w-full btn-primary disabled:opacity-50"
            >
              {isSavingPermissions ? 'Saving…' : 'Save Permissions'}
            </button>
          </div>
        </Modal>
      )}

      {/* ── Phantom Access Modal ── */}
      {selectedUser && (
        <Modal
          isOpen={showPhantomModal}
          onClose={() => setShowPhantomModal(false)}
          title="Assign Phantom Access"
        >
          <div className="space-y-4">
            <p className="text-gray-400">
              Assign phantom betting access for <strong>{selectedUser.username}</strong>
            </p>
            <div>
              <label className="label" htmlFor="phantom-access-level">Phantom Access Level</label>
              <select id="phantom-access-level"
                value={phantomAccess}
                onChange={(e) => setPhantomAccess(e.target.value as any)}
                className="input"
              >
                <option value="NONE">NONE — No phantom access</option>
                <option value="1_MIN">1_MIN — 1-minute cycles only</option>
                <option value="30_MIN">30_MIN — 30-minute cycles only</option>
                <option value="FULL_DAY">FULL_DAY — Full-day cycles only</option>
                <option value="BOTH">BOTH — All cycle types</option>
              </select>
            </div>
            <div className="bg-orange-500/10 border border-orange-500/30 rounded-lg p-3">
              <p className="text-sm text-orange-400">
                ⚠️ Phantom managers balance the pool display by placing bets. These bets always
                lose — they have zero financial risk but affect what users see.
              </p>
            </div>
            <button onClick={handleAssignPhantomAccess} className="w-full btn-primary">
              Update Phantom Access
            </button>
          </div>
        </Modal>
      )}

      {/* ── Delete Confirmation ── */}
      {confirmDelete && (
        <ConfirmDialog
          isOpen={!!confirmDelete}
          onClose={() => setConfirmDelete(null)}
          onConfirm={() => { handleDelete(confirmDelete.userId); setConfirmDelete(null); }}
          title="Remove Sub-Admin"
          message={`Remove sub-admin access for ${confirmDelete.username}? Their user account will remain intact.`}
          type="danger"
          confirmText="Remove"
        />
      )}
    </div>
  );
};
