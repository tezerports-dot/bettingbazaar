// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * DepositPolicy.tsx — Business Policy Platform (BBEPS Phase 006).
 *
 * Admin UI for backend/domains/configuration/depositPolicy.{model,service,admin.routes}.js.
 * This is the first page in the Business Policy Platform — deposit/reserve split and reserve usage rules are
 * versioned together as ONE policy per currency because they describe a
 * single coherent business decision, not independent settings. This page
 * governs ONLY the deposit/reserve split and reserve usage rules — merchant
 * incentive pay ("Merchant Performance Bonus") is a separate, cycle-
 * completion-triggered mechanism, not a deposit-time one (2026-07-08
 * correction, see docs/governance/04-GOVERNANCE.md). Future siblings (Withdrawal
 * Policy, Risk Policy, Merchant Policy...) belong in this same
 * Pages/BusinessPolicy/ folder and the same 'policy' nav group, not
 * scattered into Finance/Settings.
 */
import React, { useEffect, useState, useCallback } from 'react';
import {
  Landmark, ShieldCheck, History as HistoryIcon, Info, Save, RefreshCw,
  AlertTriangle, CheckCircle, XCircle, RotateCcw, Undo2,
} from 'lucide-react';
import { LoadingSpinner } from '../../components/LoadingSpinner';
import { Modal } from '../../components/Modal';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { EmptyState } from '../../components/EmptyState';
import { StatusBadge } from '../../components/StatusBadge';
import { DataTable } from '../../components/DataTable';
import api from '../../services/api';
import type { DepositPolicyVersion, DepositPolicyCurrency } from '../../types';
import toast from 'react-hot-toast';

const CURRENCIES: DepositPolicyCurrency[] = ['INR', 'USDT'];

// Defaults offered when no policy has ever been configured for a currency —
// matches the backend's own fallback (paymentOrder.model.js pre-save hook),
// so "Configure Now" starts from the same numbers already silently in effect.
const BOOTSTRAP_DEFAULTS = {
  depositAllocationPercent: 90,
  reserveAllocationPercent: 10,
  reserveUsageRules: { withdrawable: false, settlementBuffer: true, notes: '' },
};

interface FormState {
  depositAllocationPercent: string;
  reserveAllocationPercent: string;
  withdrawable: boolean;
  settlementBuffer: boolean;
  notes: string;
  justification: string;
  effectiveAt: string; // '' = immediate
  requireApproval: boolean;
}

function blankForm(seed?: Partial<FormState>): FormState {
  return {
    depositAllocationPercent: String(BOOTSTRAP_DEFAULTS.depositAllocationPercent),
    reserveAllocationPercent: String(BOOTSTRAP_DEFAULTS.reserveAllocationPercent),
    withdrawable: BOOTSTRAP_DEFAULTS.reserveUsageRules.withdrawable,
    settlementBuffer: BOOTSTRAP_DEFAULTS.reserveUsageRules.settlementBuffer,
    notes: BOOTSTRAP_DEFAULTS.reserveUsageRules.notes,
    justification: '',
    effectiveAt: '',
    requireApproval: false,
    ...seed,
  };
}

const changedByLabel = (v: DepositPolicyVersion) =>
  typeof v.changedBy === 'object' && v.changedBy ? v.changedBy.username : (v.changedByName || '—');

export const DepositPolicy: React.FC = () => {
  const [currency, setCurrency] = useState<DepositPolicyCurrency>('INR');
  const [activePolicy, setActivePolicy] = useState<DepositPolicyVersion | null>(null);
  const [history, setHistory] = useState<DepositPolicyVersion[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);

  const [showEditModal, setShowEditModal] = useState(false);
  const [form, setForm] = useState<FormState>(blankForm());

  const [confirmAction, setConfirmAction] = useState<
    | { kind: 'rollback'; versionId: string; version: number }
    | { kind: 'approve' | 'reject'; versionId: string; version: number }
    | null
  >(null);

  const [exampleAmount, setExampleAmount] = useState('1000');

  const load = useCallback(async (curr: DepositPolicyCurrency) => {
    setIsLoading(true);
    try {
      const [curRes, histRes] = await Promise.all([
        api.depositPolicy.getCurrent(curr),
        api.depositPolicy.getHistory(curr),
      ]);
      setActivePolicy(curRes.success ? curRes.policy : null);
      setHistory(histRes.success ? histRes.history : []);
    } catch (error) {
      toast.error('Failed to load deposit policy');
      console.error('Deposit policy load error:', error);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    load(currency);
  }, [currency, load]);

  const openConfigureNow = () => {
    setForm(blankForm({ justification: '' }));
    setShowEditModal(true);
  };

  const openEditExisting = () => {
    if (!activePolicy) return openConfigureNow();
    setForm(
      blankForm({
        depositAllocationPercent: String(activePolicy.depositAllocationPercent),
        reserveAllocationPercent: String(activePolicy.reserveAllocationPercent),
        withdrawable: activePolicy.reserveUsageRules?.withdrawable ?? false,
        settlementBuffer: activePolicy.reserveUsageRules?.settlementBuffer ?? true,
        notes: activePolicy.reserveUsageRules?.notes ?? '',
        justification: '',
      })
    );
    setShowEditModal(true);
  };

  // Keep deposit%/reserve% linked so they always sum to 100 — the backend
  // rejects anything else anyway; doing it live in the form avoids a round
  // trip just to find that out.
  const onDepositPercentChange = (value: string) => {
    setForm((f) => ({
      ...f,
      depositAllocationPercent: value,
      reserveAllocationPercent: value === '' ? f.reserveAllocationPercent : String(Math.max(0, 100 - parseFloat(value || '0'))),
    }));
  };
  const onReservePercentChange = (value: string) => {
    setForm((f) => ({
      ...f,
      reserveAllocationPercent: value,
      depositAllocationPercent: value === '' ? f.depositAllocationPercent : String(Math.max(0, 100 - parseFloat(value || '0'))),
    }));
  };

  const handleSubmit = async () => {
    const depositPct = parseFloat(form.depositAllocationPercent);
    const reservePct = parseFloat(form.reserveAllocationPercent);

    if (isNaN(depositPct) || isNaN(reservePct)) {
      toast.error('Please enter valid numbers');
      return;
    }
    if (Math.abs(depositPct + reservePct - 100) > 0.01) {
      toast.error('Deposit % + Reserve % must equal 100');
      return;
    }
    if (!form.justification.trim()) {
      toast.error('Business justification is required');
      return;
    }

    setIsSaving(true);
    try {
      const res = await api.depositPolicy.update(currency, {
        depositAllocationPercent: depositPct,
        reserveAllocationPercent: reservePct,
        reserveUsageRules: {
          withdrawable: form.withdrawable,
          settlementBuffer: form.settlementBuffer,
          notes: form.notes,
        },
        justification: form.justification.trim(),
        effectiveAt: form.effectiveAt || undefined,
        requireApproval: form.requireApproval,
      });
      if (res.success) {
        toast.success(res.message || 'Deposit policy updated');
        setShowEditModal(false);
        await load(currency);
      } else {
        toast.error(res.message || 'Failed to update deposit policy');
      }
    } catch (error: any) {
      toast.error(error.response?.data?.message || 'Failed to update deposit policy');
    } finally {
      setIsSaving(false);
    }
  };

  const runConfirmedAction = async () => {
    if (!confirmAction) return;
    try {
      let res;
      if (confirmAction.kind === 'rollback') {
        res = await api.depositPolicy.rollback(confirmAction.versionId);
      } else {
        res = await api.depositPolicy.approve(confirmAction.versionId, confirmAction.kind === 'approve');
      }
      if (res.success) {
        toast.success(res.message);
        await load(currency);
      } else {
        toast.error(res.message || 'Action failed');
      }
    } catch (error: any) {
      toast.error(error.response?.data?.message || 'Action failed');
    }
  };

  // Example calculator — uses the active policy if one exists, otherwise the
  // same 90/10 fallback the backend itself falls back to.
  const previewReservePct = activePolicy?.reserveAllocationPercent ?? BOOTSTRAP_DEFAULTS.reserveAllocationPercent;
  const amountNum = parseFloat(exampleAmount || '0');
  const previewReserve = Math.floor(amountNum * (previewReservePct / 100));
  const previewDeposit = amountNum - previewReserve;

  const historyColumns = [
    { key: 'version', label: 'V', render: (v: DepositPolicyVersion) => (
      <span className="font-mono">{v.version}{v.isRollback ? ' ↺' : ''}</span>
    )},
    { key: 'status', label: 'Status', render: (v: DepositPolicyVersion) => (
      <StatusBadge status={v.status} type="policy" />
    )},
    { key: 'split', label: 'Deposit / Reserve', render: (v: DepositPolicyVersion) => (
      <span>{v.depositAllocationPercent}% / {v.reserveAllocationPercent}%</span>
    )},
    { key: 'effectiveAt', label: 'Effective', render: (v: DepositPolicyVersion) => (
      <span className="text-sm text-gray-400">{new Date(v.effectiveAt).toLocaleString()}</span>
    )},
    { key: 'justification', label: 'Justification', render: (v: DepositPolicyVersion) => (
      <span className="text-sm text-gray-400 max-w-xs block truncate" title={v.businessJustification}>
        {v.businessJustification}
      </span>
    )},
    { key: 'changedBy', label: 'Changed By', render: (v: DepositPolicyVersion) => (
      <span className="text-sm">{changedByLabel(v)}</span>
    )},
    { key: 'actions', label: 'Actions', render: (v: DepositPolicyVersion) => (
      <div className="flex gap-2">
        {v.status === 'PENDING_APPROVAL' && (
          <>
            <button
              onClick={() => setConfirmAction({ kind: 'approve', versionId: v._id, version: v.version })}
              className="p-1.5 rounded-lg bg-green-500/10 hover:bg-green-500/20 text-green-500"
              title="Approve"
            >
              <CheckCircle size={16} />
            </button>
            <button
              onClick={() => setConfirmAction({ kind: 'reject', versionId: v._id, version: v.version })}
              className="p-1.5 rounded-lg bg-red-500/10 hover:bg-red-500/20 text-red-500"
              title="Reject"
            >
              <XCircle size={16} />
            </button>
          </>
        )}
        {v.status !== 'ACTIVE' && v.status !== 'PENDING_APPROVAL' && (
          <button
            onClick={() => setConfirmAction({ kind: 'rollback', versionId: v._id, version: v.version })}
            className="p-1.5 rounded-lg bg-blue-500/10 hover:bg-blue-500/20 text-blue-500"
            title="Restore these values as a new version"
          >
            <Undo2 size={16} />
          </button>
        )}
      </div>
    )},
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold mb-2">Deposit Policy</h1>
          <p className="text-gray-400">Business Policy Platform — deposit/reserve split &amp; reserve usage rules</p>
        </div>
        <div className="flex bg-dark-700 rounded-lg p-1">
          {CURRENCIES.map((c) => (
            <button
              key={c}
              onClick={() => setCurrency(c)}
              className={`px-4 py-1.5 rounded-md text-sm font-medium transition-colors ${
                currency === c ? 'bg-gold-500 text-dark-900' : 'text-gray-400 hover:text-white'
              }`}
            >
              {c}
            </button>
          ))}
        </div>
      </div>

      <div className="bg-blue-500/10 border border-blue-500/30 rounded-lg p-4">
        <div className="flex items-start space-x-3">
          <Info className="text-blue-500 mt-0.5 flex-shrink-0" size={20} />
          <div className="text-sm">
            <p className="font-semibold text-blue-400 mb-1">What This Policy Governs</p>
            <ul className="space-y-1 text-gray-300">
              <li>• <strong>Deposit / Reserve split:</strong> how each deposit's tokens divide between the user's deposit balance and the platform reserve</li>
              <li>• <strong>Reserve usage rules:</strong> whether reserve funds are user-withdrawable and whether they act as a settlement buffer</li>
            </ul>
            <p className="mt-2 text-gray-400">
              Every change is versioned with a required business justification, full audit history, and optional scheduling or approval-gating.
            </p>
          </div>
        </div>
      </div>

      {isLoading ? (
        <LoadingSpinner size="lg" />
      ) : !activePolicy ? (
        <EmptyState
          icon={Landmark}
          title={`No Deposit Policy configured for ${currency}`}
          description={`Orders currently fall back to a hardcoded ${BOOTSTRAP_DEFAULTS.depositAllocationPercent}/${BOOTSTRAP_DEFAULTS.reserveAllocationPercent} split — configure a real policy to make this admin-editable and audited.`}
          action={{ label: 'Configure Now', onClick: openConfigureNow }}
        />
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="card">
            <h3 className="text-lg font-semibold mb-4 flex items-center">
              <Landmark className="mr-2 text-gold-500" size={20} />
              Active Policy — v{activePolicy.version}
              <span className="ml-3"><StatusBadge status={activePolicy.status} type="policy" /></span>
            </h3>
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div className="p-4 bg-dark-700 rounded-lg">
                  <p className="text-sm text-gray-400 mb-1">Deposit Wallet</p>
                  <p className="text-2xl font-bold text-green-500">{activePolicy.depositAllocationPercent}%</p>
                </div>
                <div className="p-4 bg-dark-700 rounded-lg">
                  <p className="text-sm text-gray-400 mb-1">Reserve Wallet</p>
                  <p className="text-2xl font-bold text-blue-500">{activePolicy.reserveAllocationPercent}%</p>
                </div>
              </div>
              <div className="p-3 bg-dark-700 rounded-lg text-sm">
                <p className="text-gray-400">Reserve usage: {activePolicy.reserveUsageRules.withdrawable ? 'user-withdrawable' : 'not user-withdrawable'}, {activePolicy.reserveUsageRules.settlementBuffer ? 'settlement buffer' : 'not a settlement buffer'}</p>
                {activePolicy.reserveUsageRules.notes && (
                  <p className="text-gray-500 mt-1 italic">"{activePolicy.reserveUsageRules.notes}"</p>
                )}
              </div>
              <div className="text-sm text-gray-500">
                Effective {new Date(activePolicy.effectiveAt).toLocaleString()} · changed by {changedByLabel(activePolicy)}
              </div>
              <div className="text-sm text-gray-500 italic">"{activePolicy.businessJustification}"</div>
              <button onClick={openEditExisting} className="w-full btn-primary flex items-center justify-center">
                <Save className="mr-2" size={16} />
                Create New Version
              </button>
            </div>
          </div>

          <div className="card">
            <h3 className="text-lg font-semibold mb-4 flex items-center">
              <ShieldCheck className="mr-2 text-gold-500" size={20} />
              Example Calculator
            </h3>
            <div className="space-y-4">
              <div>
                <label className="label">Deposit Amount ({currency})</label>
                <input
                  type="number"
                  value={exampleAmount}
                  onChange={(e) => setExampleAmount(e.target.value)}
                  className="input"
                />
              </div>
              <div className="grid grid-cols-1 gap-3">
                <div className="p-4 bg-dark-700 rounded-lg flex justify-between items-center">
                  <span className="text-sm text-gray-400">→ Deposit Wallet</span>
                  <span className="text-xl font-bold text-green-500">{previewDeposit.toLocaleString()}</span>
                </div>
                <div className="p-4 bg-dark-700 rounded-lg flex justify-between items-center">
                  <span className="text-sm text-gray-400">→ Reserve Wallet</span>
                  <span className="text-xl font-bold text-blue-500">{previewReserve.toLocaleString()}</span>
                </div>
              </div>
              <p className="text-xs text-gray-500">
                Deposit + Reserve always equal the full deposit amount — the user never loses value.
              </p>
            </div>
          </div>
        </div>
      )}

      <div className="card">
        <h3 className="text-lg font-semibold mb-4 flex items-center">
          <HistoryIcon className="mr-2 text-gold-500" size={20} />
          Version History — {currency}
        </h3>
        <DataTable
          data={history}
          columns={historyColumns}
          currentPage={1}
          totalPages={1}
          onPageChange={() => {}}
          isLoading={isLoading}
        />
      </div>

      <Modal
        isOpen={showEditModal}
        onClose={() => setShowEditModal(false)}
        title={`New Deposit Policy Version — ${currency}`}
        size="lg"
      >
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="label">Deposit Wallet %</label>
              <input
                type="number" step="0.01" min="0" max="100"
                value={form.depositAllocationPercent}
                onChange={(e) => onDepositPercentChange(e.target.value)}
                className="input"
              />
            </div>
            <div>
              <label className="label">Reserve Wallet %</label>
              <input
                type="number" step="0.01" min="0" max="100"
                value={form.reserveAllocationPercent}
                onChange={(e) => onReservePercentChange(e.target.value)}
                className="input"
              />
            </div>
          </div>
          {Math.abs(parseFloat(form.depositAllocationPercent || '0') + parseFloat(form.reserveAllocationPercent || '0') - 100) > 0.01 && (
            <div className="flex items-center space-x-2 p-3 bg-red-500/10 border border-red-500/30 rounded-lg">
              <AlertTriangle className="text-red-500 flex-shrink-0" size={16} />
              <p className="text-sm text-red-400">Deposit % + Reserve % must equal 100</p>
            </div>
          )}

          <div className="p-4 bg-dark-700 rounded-lg space-y-3">
            <p className="text-sm font-semibold text-gray-300">Reserve Usage Rules</p>
            <div className="flex items-center justify-between">
              <p className="text-sm text-gray-400">User-withdrawable</p>
              <label className="relative inline-flex items-center cursor-pointer">
                <input
                  type="checkbox"
                  checked={form.withdrawable}
                  onChange={(e) => setForm((f) => ({ ...f, withdrawable: e.target.checked }))}
                  className="sr-only peer"
                />
                <div className="w-11 h-6 bg-gray-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-gold-500"></div>
              </label>
            </div>
            <div className="flex items-center justify-between">
              <p className="text-sm text-gray-400">Settlement buffer</p>
              <label className="relative inline-flex items-center cursor-pointer">
                <input
                  type="checkbox"
                  checked={form.settlementBuffer}
                  onChange={(e) => setForm((f) => ({ ...f, settlementBuffer: e.target.checked }))}
                  className="sr-only peer"
                />
                <div className="w-11 h-6 bg-gray-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-gold-500"></div>
              </label>
            </div>
            <div>
              <label className="label">Notes</label>
              <textarea
                value={form.notes}
                onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
                className="input w-full h-16 resize-none"
                placeholder="Optional free-text notes on how the reserve is used..."
              />
            </div>
          </div>

          <div>
            <label className="label">Business Justification (required)</label>
            <textarea
              value={form.justification}
              onChange={(e) => setForm((f) => ({ ...f, justification: e.target.value }))}
              className="input w-full h-20 resize-none"
              placeholder="Why is this change being made?"
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="label">Effective At (optional — blank = immediate)</label>
              <input
                type="datetime-local"
                value={form.effectiveAt}
                onChange={(e) => setForm((f) => ({ ...f, effectiveAt: e.target.value }))}
                className="input"
              />
            </div>
            <div className="flex items-end pb-2">
              <label className="flex items-center space-x-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={form.requireApproval}
                  onChange={(e) => setForm((f) => ({ ...f, requireApproval: e.target.checked }))}
                  className="w-4 h-4"
                />
                <span className="text-sm text-gray-400">Require separate approval before this goes active</span>
              </label>
            </div>
          </div>

          <button
            onClick={handleSubmit}
            disabled={isSaving}
            className="w-full btn-primary disabled:opacity-50 flex items-center justify-center"
          >
            {isSaving ? (
              <>
                <RefreshCw className="mr-2 animate-spin" size={16} />
                Saving...
              </>
            ) : (
              <>
                <Save className="mr-2" size={16} />
                Save New Version
              </>
            )}
          </button>
        </div>
      </Modal>

      <ConfirmDialog
        isOpen={!!confirmAction}
        onClose={() => setConfirmAction(null)}
        onConfirm={runConfirmedAction}
        title={
          confirmAction?.kind === 'rollback'
            ? `Restore v${confirmAction.version}'s values?`
            : confirmAction?.kind === 'approve'
            ? `Approve v${confirmAction?.version}?`
            : `Reject v${confirmAction?.version}?`
        }
        message={
          confirmAction?.kind === 'rollback'
            ? 'This creates a NEW version copying these values forward — it does not delete or alter any history.'
            : confirmAction?.kind === 'approve'
            ? 'This version will become ACTIVE immediately (or SCHEDULED if it has a future effective date), superseding the current active version.'
            : 'This version will be marked REJECTED and will never take effect.'
        }
        type={confirmAction?.kind === 'reject' ? 'danger' : confirmAction?.kind === 'rollback' ? 'info' : 'success'}
        confirmText={confirmAction?.kind === 'rollback' ? 'Restore' : confirmAction?.kind === 'approve' ? 'Approve' : 'Reject'}
      />
    </div>
  );
};
