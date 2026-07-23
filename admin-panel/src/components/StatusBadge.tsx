// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
import React from 'react';

interface StatusBadgeProps {
  status: string;
  type?: 'user' | 'merchant' | 'order' | 'cycle' | 'kyc' | 'policy';
}

export const StatusBadge: React.FC<StatusBadgeProps> = ({ status, type = 'user' }) => {
  const getStyles = () => {
    const upperStatus = status.toUpperCase();

    // User statuses
    if (type === 'user') {
      if (upperStatus === 'ACTIVE') return 'bg-green-500/20 text-green-500';
      if (upperStatus === 'BLOCKED') return 'bg-red-500/20 text-red-500';
      if (upperStatus === 'SUSPENDED') return 'bg-orange-500/20 text-orange-500';
      if (upperStatus === 'PENDING_KYC') return 'bg-yellow-500/20 text-yellow-500';
    }

    // Merchant statuses
    if (type === 'merchant') {
      if (upperStatus === 'ACTIVE')    return 'bg-green-500/20 text-green-500';
      if (upperStatus === 'APPROVED')  return 'bg-green-500/20 text-green-500';
      if (upperStatus === 'PENDING')   return 'bg-yellow-500/20 text-yellow-500';
      if (upperStatus === 'REJECTED')  return 'bg-red-500/20 text-red-500';
      if (upperStatus === 'SUSPENDED') return 'bg-orange-500/20 text-orange-500';
      if (upperStatus === 'INACTIVE')  return 'bg-gray-500/20 text-gray-400';
    }

    // Order statuses
    if (type === 'order') {
      if (upperStatus === 'COMPLETED') return 'bg-green-500/20 text-green-500';
      if (upperStatus === 'PENDING_QUEUE') return 'bg-yellow-500/20 text-yellow-500';
      if (upperStatus === 'ASSIGNED') return 'bg-blue-500/20 text-blue-500';
      if (upperStatus === 'PROCESSING') return 'bg-purple-500/20 text-purple-500';
      if (upperStatus === 'FAILED') return 'bg-red-500/20 text-red-500';
      if (upperStatus === 'CANCELLED') return 'bg-gray-500/20 text-gray-500';
    }

    // Cycle statuses
    if (type === 'cycle') {
      if (upperStatus === 'OPEN') return 'bg-green-500/20 text-green-500';
      if (upperStatus === 'MERGED') return 'bg-blue-500/20 text-blue-500';
      if (upperStatus === 'CLOSED') return 'bg-orange-500/20 text-orange-500';
      if (upperStatus === 'RESULT_DECLARED') return 'bg-gold-500/20 text-gold-500';
      if (upperStatus === 'PAUSED') return 'bg-gray-500/20 text-gray-500';
      if (upperStatus === 'CANCELLED') return 'bg-red-500/20 text-red-500';
    }

    // KYC statuses
    if (type === 'kyc') {
      if (upperStatus === 'APPROVED') return 'bg-green-500/20 text-green-500';
      if (upperStatus === 'PENDING_APPROVAL') return 'bg-yellow-500/20 text-yellow-500';
      if (upperStatus === 'PENDING_SUBMISSION') return 'bg-gray-500/20 text-gray-500';
      if (upperStatus === 'REJECTED') return 'bg-red-500/20 text-red-500';
    }

    // Business Policy Platform statuses (DepositPolicy and future sibling policies)
    if (type === 'policy') {
      if (upperStatus === 'ACTIVE')           return 'bg-green-500/20 text-green-500';
      if (upperStatus === 'SCHEDULED')        return 'bg-blue-500/20 text-blue-500';
      if (upperStatus === 'PENDING_APPROVAL') return 'bg-yellow-500/20 text-yellow-500';
      if (upperStatus === 'SUPERSEDED')       return 'bg-gray-500/20 text-gray-400';
      if (upperStatus === 'ROLLED_BACK')      return 'bg-purple-500/20 text-purple-500';
      if (upperStatus === 'REJECTED')         return 'bg-red-500/20 text-red-500';
    }

    return 'bg-gray-500/20 text-gray-500';
  };

  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold ${getStyles()}`}>
      <span className="w-1.5 h-1.5 rounded-full bg-current flex-none" />
      {status.replace(/_/g, ' ')}
    </span>
  );
};
