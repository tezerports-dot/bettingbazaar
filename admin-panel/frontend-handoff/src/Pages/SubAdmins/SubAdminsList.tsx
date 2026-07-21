// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
import React, { useEffect, useState } from 'react';
import { ShieldCheck, UserPlus, Edit, Trash2, Key } from 'lucide-react';
import { DataTable } from '../../components/DataTable';
import { Modal } from '../../components/Modal';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { formatters } from '../../utils/formatters';
import api from '../../services/api';
import type { User } from '../../types';
import toast from 'react-hot-toast';
import { PERMISSION_KEYS, DEFAULT_PERMISSIONS, PERMISSION_LABELS, PERMISSION_DESCRIPTIONS } from '../../utils/permissions'; // GOVERNANCE.md M-1


// Derived from shared module — never define permission keys inline here
const PERMISSIONS = PERMISSION_KEYS.map(key => ({
  key,
  label:       PERMISSION_LABELS[key],
  description: PERMISSION_DESCRIPTIONS[key],
}));


export const SubAdminsList: React.FC = () => {
  const [subAdmins, setSubAdmins] = useState<User[]>([]);
  const [isLoading, setIsLoading] = useState(true);

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

  const [phantomAccess, setPhantomAccess] = useState<'NONE' | '30_MIN' | 'FULL_DAY' | 'BOTH'>(
    'NONE'
  );

  useEffect(() => {
    loadSubAdmins();
  }, []);

  const loadSubAdmins = async () => {
    setIsLoading(true);
    try {
      const response = await api.subAdmins.getAll();
      if (response.success && response.data) setSubAdmins(response.data);
    } catch {
      toast.error('Failed to load sub-admins');
    } finally {
      setIsLoading(false);
    }
  };

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
      await api.subAdmins.assignPhantomAccess(selectedUser._id, phantomAccess);
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
      await api.subAdmins.updatePermissions(selectedUser._id, editPermissions);
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

  const permLabel = (key: string) =>
    PERMISSIONS.find((p) => p.key === key)?.label || key.replace('can', '').replace(/([A-Z])/g, ' $1').trim();

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
        const activePerms = PERMISSION_KEYS.filter((k) => perms[k as keyof typeof perms]);
        return (
          <div className="flex flex-wrap gap-1 max-w-xs">
            {activePerms.length === 0 ? (
              <span className="text-xs text-gray-500">None assigned</span>
            ) : (
              activePerms.map((k) => (
                <span key={k} className="px-1.5 py-0.5 rounded text-xs bg-purple-500/20 text-purple-400">
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
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold mb-2">Sub-Admins & Phantom Managers</h1>
          <p className="text-gray-400">Manage roles, permissions, and phantom betting access</p>
        </div>
        <button onClick={() => setShowCreateModal(true)} className="btn-primary flex items-center">
          <UserPlus size={16} className="mr-2" /> Create Sub-Admin
        </button>
      </div>

      {/* Permission Reference */}
      <div className="bg-dark-800 border border-dark-600 rounded-lg p-4">
        <p className="text-sm font-semibold text-gray-300 mb-3">Permission Reference</p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
          {PERMISSIONS.map((p) => (
            <div key={p.key} className="flex items-start gap-2 text-xs">
              <span className="text-purple-400 font-medium whitespace-nowrap">{p.label}:</span>
              <span className="text-gray-500">{p.description}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Phantom Access Reference */}
      <div className="bg-orange-500/10 border border-orange-500/30 rounded-lg p-4 text-sm">
        <p className="font-semibold text-orange-400 mb-1">Phantom Access</p>
        <p className="text-gray-400">
          <strong className="text-gray-300">NONE</strong>: No phantom betting ·{' '}
          <strong className="text-gray-300">30_MIN</strong>: 30-min cycles only ·{' '}
          <strong className="text-gray-300">FULL_DAY</strong>: Full-day cycles only ·{' '}
          <strong className="text-gray-300">BOTH</strong>: All cycle types.
          Phantom bets always lose — they only balance the pool display.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="card">
          <p className="text-sm text-gray-400 mb-1">Total Sub-Admins</p>
          <p className="text-2xl font-bold">{subAdmins.length}</p>
        </div>
        <div className="card">
          <p className="text-sm text-gray-400 mb-1">Phantom Managers</p>
          <p className="text-2xl font-bold text-gold-500">
            {subAdmins.filter((u) => u.phantomAccess && u.phantomAccess !== 'NONE').length}
          </p>
        </div>
        <div className="card">
          <p className="text-sm text-gray-400 mb-1">With Permissions</p>
          <p className="text-2xl font-bold text-purple-500">
            {
              subAdmins.filter(
                (u) => u.subAdminPermissions && Object.values(u.subAdminPermissions).some(Boolean)
              ).length
            }
          </p>
        </div>
      </div>

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
            <label className="label">Username</label>
            <input
              type="text"
              value={formData.username}
              onChange={(e) => setFormData({ ...formData, username: e.target.value })}
              className="input"
              required
            />
          </div>
          <div>
            <label className="label">Mobile</label>
            <input
              type="tel"
              value={formData.mobile}
              onChange={(e) => setFormData({ ...formData, mobile: e.target.value })}
              className="input"
              required
            />
          </div>
          <div>
            <label className="label">Password</label>
            <input
              type="password"
              value={formData.password}
              onChange={(e) => setFormData({ ...formData, password: e.target.value })}
              className="input"
              required
            />
          </div>
          <div>
            <label className="label mb-3">Initial Permissions</label>
            <div className="space-y-3">
              {PERMISSIONS.map((perm) => (
                <label key={perm.key} className="flex items-start space-x-3 cursor-pointer p-2 hover:bg-dark-700 rounded-lg">
                  <input
                    type="checkbox"
                    checked={(formData.permissions as any)[perm.key] || false}
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        permissions: { ...formData.permissions, [perm.key]: e.target.checked },
                      })
                    }
                    className="w-4 h-4 mt-0.5 flex-shrink-0"
                  />
                  <div>
                    <p className="text-sm font-medium">{perm.label}</p>
                    <p className="text-xs text-gray-500">{perm.description}</p>
                  </div>
                </label>
              ))}
            </div>
          </div>
          <button type="submit" className="w-full btn-primary">
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
              Toggle which admin panel features this sub-admin can access. Changes take effect on
              their next login.
            </p>
            <div className="space-y-3">
              {PERMISSIONS.map((perm) => (
                <label
                  key={perm.key}
                  className="flex items-start space-x-3 cursor-pointer p-2 hover:bg-dark-700 rounded-lg"
                >
                  <input
                    type="checkbox"
                    checked={editPermissions[perm.key] || false}
                    onChange={(e) =>
                      setEditPermissions({ ...editPermissions, [perm.key]: e.target.checked })
                    }
                    className="w-4 h-4 mt-0.5 flex-shrink-0 accent-purple-500"
                  />
                  <div>
                    <p className="text-sm font-medium">{perm.label}</p>
                    <p className="text-xs text-gray-500">{perm.description}</p>
                  </div>
                </label>
              ))}
            </div>
            <button
              onClick={handleSavePermissions}
              disabled={isSavingPermissions}
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
              <label className="label">Phantom Access Level</label>
              <select
                value={phantomAccess}
                onChange={(e) => setPhantomAccess(e.target.value as any)}
                className="input"
              >
                <option value="NONE">NONE — No phantom access</option>
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
          onConfirm={() => { handleDelete(confirmDelete._id); setConfirmDelete(null); }}
          title="Remove Sub-Admin"
          message={`Remove sub-admin access for ${confirmDelete.username}? Their user account will remain intact.`}
          type="danger"
          confirmText="Remove"
        />
      )}
    </div>
  );
};
