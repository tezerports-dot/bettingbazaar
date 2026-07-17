import sseService from '../../services/sse';
// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
import React, { useEffect, useState } from 'react';
import { UserCheck, CheckCircle, XCircle, Eye } from 'lucide-react';
import { DataTable } from '../../components/DataTable';
import { StatusBadge } from '../../components/StatusBadge';
import { Modal } from '../../components/Modal';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { UserAvatar } from '../../components/UserAvatar';
import { usePagination } from '../../hooks/usePagination';
import { formatters } from '../../utils/formatters';
import api from '../../services/api';
import type { User } from '../../types';
import toast from 'react-hot-toast';

export const KYCQueue: React.FC = () => {
  const [pendingKYC, setPendingKYC] = useState<User[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [selectedUser, setSelectedUser] = useState<User | null>(null);
  const [showDetails, setShowDetails] = useState(false);
  const [confirmAction, setConfirmAction] = useState<{ type: 'approve' | 'reject'; user: User; reason?: string } | null>(null);
  const [rejectReason, setRejectReason] = useState('');

  const { page, limit, setPage } = usePagination({ initialLimit: 20 });

  useEffect(() => {
    loadPendingKYC(); // HTTP seed on mount

    // Backend sends the full user in payload — append directly, no HTTP
    const handleKycSubmission = (data: any) => {
      if (data.user) {
        setPendingKYC(prev => [...prev, data.user]);
      } else {
        loadPendingKYC(); // fallback if payload is thin
      }
    };

    // After approve/reject — remove from pending list
    const handleKycUpdate = (data: any) => {
      setPendingKYC(prev => prev.filter(u => u._id !== data.userId));
    };

    // §11: 'new_kyc_submission' removed — backend emits 'kyc_update' only (kyc.admin.routes.js:47,105)
    sseService.on('kyc_update',         handleKycUpdate);

    return () => {
      // §11: 'new_kyc_submission' removed
      sseService.off('kyc_update',         handleKycUpdate);
    };
    // ✅ No HTTP on every KYC event
  }, [page]);

  const loadPendingKYC = async () => {
    setIsLoading(true);
    try {
      const response = await api.kyc.getQueue();
      if (response.success && response.data) {
        setPendingKYC(response.data);
      }
    } catch (error) {
      toast.error('Failed to load KYC queue');
    } finally {
      setIsLoading(false);
    }
  };

  const handleApprove = async (userId: string) => {
    try {
      await api.kyc.approve(userId);
      toast.success('KYC approved successfully');
      loadPendingKYC();
      setShowDetails(false);
    } catch (error: any) {
      toast.error(error.response?.data?.message || 'Failed to approve KYC');
    }
  };

  const handleReject = async (userId: string, reason: string) => {
    if (!reason.trim()) {
      toast.error('Please provide a rejection reason');
      return;
    }

    try {
      await api.kyc.reject(userId, reason);
      toast.success('KYC rejected');
      loadPendingKYC();
      setShowDetails(false);
      setRejectReason('');
    } catch (error: any) {
      toast.error(error.response?.data?.message || 'Failed to reject KYC');
    }
  };

  const columns = [
    {
      key: 'user',
      label: 'User',
      render: (user: User) => (
        <div className="flex items-center space-x-3">
          <UserAvatar src={user.profilePic} name={user.username} />
          <div>
            <p className="font-medium">{user.username}</p>
            <p className="text-sm text-gray-400">{formatters.phone(user.mobile)}</p>
          </div>
        </div>
      ),
    },
    {
      key: 'kycData',
      label: 'KYC Details',
      render: (user: User) => (
        <div className="text-sm">
          <p>{user.kycData?.nameOnAadhaar}</p>
          <p className="text-gray-400">Aadhaar: {user.kycData?.aadhaarNumber}</p>
          <p className="text-gray-400">Aadhaar: {user.kycData?.aadhaarNumber}</p>
        </div>
      ),
    },
    {
      key: 'status',
      label: 'KYC Status',
      render: (user: User) => (
        <StatusBadge status={user.kycStatus} type="kyc" />
      ),
    },
    {
      key: 'submitted',
      label: 'Submitted',
      render: (user: User) => (
        <span className="text-sm text-gray-400">
          {user.kycData?.submittedAt ? formatters.datetime(user.kycData.submittedAt) : '-'}
        </span>
      ),
    },
    {
      key: 'actions',
      label: 'Actions',
      render: (user: User) => (
        <div className="flex items-center space-x-2">
          <button
            onClick={() => {
              setSelectedUser(user);
              setShowDetails(true);
            }}
            className="p-2 hover:bg-dark-700 rounded-lg transition-colors"
            title="Review KYC"
          >
            <Eye size={16} />
          </button>
          <button
            onClick={() => setConfirmAction({ type: 'approve', user })}
            className="p-2 hover:bg-green-600/20 rounded-lg transition-colors text-green-500"
            title="Approve"
          >
            <CheckCircle size={16} />
          </button>
          <button
            onClick={() => setConfirmAction({ type: 'reject', user })}
            className="p-2 hover:bg-red-600/20 rounded-lg transition-colors text-red-500"
            title="Reject"
          >
            <XCircle size={16} />
          </button>
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold mb-2 flex items-center">
          <UserCheck className="mr-2 text-gold-500" size={28} />
          KYC Verification Queue
        </h1>
        <p className="text-gray-400">Review and approve pending KYC submissions</p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="card">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-400 mb-1">Pending Review</p>
              <p className="text-2xl font-bold text-yellow-500">{pendingKYC.length}</p>
            </div>
            <UserCheck className="text-yellow-500" size={32} />
          </div>
        </div>
      </div>

      {/* Table */}
      <div className="card">
        <DataTable
          data={pendingKYC}
          columns={columns}
          currentPage={page}
          totalPages={Math.ceil(pendingKYC.length / limit)}
          onPageChange={setPage}
          isLoading={isLoading}
        />
      </div>

      {/* KYC Review Modal */}
      {selectedUser && selectedUser.kycData && (
        <Modal
          isOpen={showDetails}
          onClose={() => setShowDetails(false)}
          title="KYC Document Review"
          size="lg"
        >
          <div className="space-y-6">
            {/* User Info */}
            <div className="flex items-center space-x-4">
              <UserAvatar src={selectedUser.profilePic} name={selectedUser.username} size="lg" />
              <div>
                <h3 className="text-xl font-bold">{selectedUser.username}</h3>
                <p className="text-gray-400">{formatters.phone(selectedUser.mobile)}</p>
              </div>
            </div>

            {/* KYC Status */}
            <div>
              <p className="text-sm text-gray-400 mb-2">Current Status</p>
              <StatusBadge status={selectedUser.kycStatus} type="kyc" />
            </div>

            {/* KYC Details */}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <p className="text-sm text-gray-400 mb-1">Name on Aadhaar</p>
                <p className="font-medium">{selectedUser.kycData.nameOnAadhaar}</p>
              </div>
              <div>
                <p className="text-sm text-gray-400 mb-1">Aadhaar Number</p>
                <p className="font-medium">{selectedUser.kycData.aadhaarNumber}</p>
              </div>
              <div>
                <p className="text-sm text-gray-400 mb-1">Aadhaar Number</p>
                <p className="font-medium">{selectedUser.kycData.aadhaarNumber}</p>
              </div>
              <div>
                <p className="text-sm text-gray-400 mb-1">Submitted</p>
                <p className="font-medium">{formatters.datetime(selectedUser.kycData.submittedAt)}</p>
              </div>
            </div>

            {/* Documents */}
            <div>
              <h4 className="font-semibold mb-3">Uploaded Documents</h4>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <p className="text-sm text-gray-400 mb-2">ID Proof</p>
                  <img
                    src={selectedUser.kycData.idProofUrl}
                    alt="ID Proof"
                    className="w-full h-48 object-cover rounded-lg border border-dark-600"
                  />
                </div>
                <div>
                  <p className="text-sm text-gray-400 mb-2">Photo</p>
                  <img
                    src={selectedUser.kycData.photoUrl}
                    alt="User Photo"
                    className="w-full h-48 object-cover rounded-lg border border-dark-600"
                  />
                </div>
              </div>
            </div>

            {/* Actions */}
            <div className="flex space-x-3">
              <button
                onClick={() => handleApprove(selectedUser._id)}
                className="flex-1 bg-green-600 hover:bg-green-700 text-white font-semibold py-3 rounded-lg transition-colors"
              >
                <CheckCircle size={20} className="inline mr-2" />
                Approve KYC
              </button>
              <button
                onClick={() => setConfirmAction({ type: 'reject', user: selectedUser })}
                className="flex-1 bg-red-600 hover:bg-red-700 text-white font-semibold py-3 rounded-lg transition-colors"
              >
                <XCircle size={20} className="inline mr-2" />
                Reject KYC
              </button>
            </div>
          </div>
        </Modal>
      )}

      {/* Approve Confirmation */}
      {confirmAction?.type === 'approve' && (
        <ConfirmDialog
          isOpen={!!confirmAction}
          onClose={() => setConfirmAction(null)}
          onConfirm={() => handleApprove(confirmAction.user._id)}
          title="Approve KYC"
          message={`Approve KYC for ${confirmAction.user.username}?`}
          type="success"
          confirmText="Approve"
        />
      )}

      {/* Reject Dialog with Reason */}
      {confirmAction?.type === 'reject' && (
        <Modal
          isOpen={!!confirmAction}
          onClose={() => {
            setConfirmAction(null);
            setRejectReason('');
          }}
          title="Reject KYC"
        >
          <div className="space-y-4">
            <p className="text-gray-400">
              Rejecting KYC for <strong>{confirmAction.user.username}</strong>
            </p>
            <div>
              <label className="label">Rejection Reason *</label>
              <textarea
                value={rejectReason}
                onChange={(e) => setRejectReason(e.target.value)}
                className="input min-h-[100px]"
                placeholder="Please provide a clear reason for rejection..."
                required
              />
            </div>
            <div className="flex space-x-3">
              <button
                onClick={() => {
                  setConfirmAction(null);
                  setRejectReason('');
                }}
                className="flex-1 btn-secondary"
              >
                Cancel
              </button>
              <button
                onClick={() => handleReject(confirmAction.user._id, rejectReason)}
                className="flex-1 bg-red-600 hover:bg-red-700 text-white font-semibold py-2 rounded-lg transition-colors"
              >
                Reject KYC
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
};
