// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
//
// KYC Queue — the manual exception path.
//
// There are no documents to review any more. The bot takes the Aadhaar NUMBER
// before an account exists, it is held encrypted, and verification runs in bulk
// against the issuing authority — so what this screen shows is WHY someone is
// still waiting (never exported, out with the verifier, or failed), and the two
// buttons are for settling the cases the batch got wrong or that cannot wait for
// the next run. Both go through the same state machine the batch does.
//
// The Aadhaar itself is deliberately absent: only its last four digits reach
// this panel. The audited bulk export is the one path that releases the numbers.
// No fabricated risk score — the backend does not provide one.
import React, { useEffect, useMemo, useState } from 'react';
import { User as UserIcon, Check, X } from 'lucide-react';
import { Modal } from '../../components/Modal';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { formatters } from '../../utils/formatters';
import api from '../../services/api';
import sseService from '../../services/sse';
import type { User } from '../../types';
import toast from 'react-hot-toast';

const AV = [
  'linear-gradient(140deg,#3d6bd6,#7b4fe0)', 'linear-gradient(140deg,#e08a3d,#d4593a)',
  'linear-gradient(140deg,#34a97f,#2b8f6f)', 'linear-gradient(140deg,#b57cf0,#7b4fe0)',
  'linear-gradient(140deg,#d4913a,#b8941f)',
];
const initials = (name?: string) => (name || '?').trim().split(/\s+/).map((w) => w[0]).join('').toUpperCase().slice(0, 2);

const TILE: React.CSSProperties = {
  height: 158, borderRadius: 12, border: '1px solid var(--border)',
  display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
  gap: 8, color: 'var(--muted)',
  background: 'repeating-linear-gradient(45deg,var(--surface-2),var(--surface-2) 11px,var(--hover) 11px,var(--hover) 22px)',
};

/** The KycVerification row the queue endpoint joins onto each user, if any. */
type Verification = {
  status?: string; aadhaarLast4?: string; exportBatchId?: string | null; failureReason?: string;
};
const v = (u: any): Verification | null => (u?.verification as Verification) || null;

/**
 * Why this person is still in the queue, in a sentence.
 *
 * This is the only thing a reviewer can act on now: there is no document to
 * judge, so the useful question is whether the batch has reached them yet.
 */
function verificationBlurb(u: any): string {
  const rec = v(u);
  if (!rec) return 'No Aadhaar on file for this account — unusual, since the bot asks for one before creating it. Worth checking with the player before deciding.';
  if (rec.status === 'FAILED') return `The verifier returned a failure${rec.failureReason ? `: ${rec.failureReason}` : ''}.`;
  if (rec.exportBatchId) return `Sent to the verifier in batch ${rec.exportBatchId}. A verdict is expected on the next import.`;
  return 'Awaiting the next export to the verifier. Approving here settles it early and is recorded against you.';
}

export const KYCQueue: React.FC = () => {
  const [pendingKYC, setPendingKYC] = useState<User[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [confirmApprove, setConfirmApprove] = useState<User | null>(null);
  const [rejectUser, setRejectUser] = useState<User | null>(null);
  const [rejectReason, setRejectReason] = useState('');

  useEffect(() => {
    loadPendingKYC();
    const handleKycUpdate = (data: any) => setPendingKYC((prev) => prev.filter((u) => u._id !== data.userId));
    sseService.on('kyc_update', handleKycUpdate);
    return () => sseService.off('kyc_update', handleKycUpdate);
  }, []);

  const loadPendingKYC = async () => {
    setIsLoading(true);
    try {
      const response = await api.kyc.getQueue();
      if (response.success && response.data) setPendingKYC(response.data);
    } catch {
      toast.error('Failed to load KYC queue');
    } finally {
      setIsLoading(false);
    }
  };

  const handleApprove = async (userId: string) => {
    try {
      await api.kyc.approve(userId);
      toast.success('KYC approved successfully');
      setPendingKYC((prev) => prev.filter((u) => u._id !== userId));
    } catch (e: any) {
      toast.error(e.response?.data?.message || 'Failed to approve KYC');
    }
  };

  const handleReject = async (userId: string, reason: string) => {
    if (!reason.trim()) { toast.error('Please provide a rejection reason'); return; }
    try {
      await api.kyc.reject(userId, reason);
      toast.success('KYC rejected');
      setPendingKYC((prev) => prev.filter((u) => u._id !== userId));
      setRejectUser(null);
      setRejectReason('');
    } catch (e: any) {
      toast.error(e.response?.data?.message || 'Failed to reject KYC');
    }
  };

  const selected = useMemo(
    () => pendingKYC.find((u) => u._id === selectedId) || pendingKYC[0] || null,
    [pendingKYC, selectedId]
  );

  const oldest = pendingKYC
    .map((u: any) => (u.createdAt ? new Date(u.createdAt).getTime() : Infinity))
    .reduce((a, b) => Math.min(a, b), Infinity);
  const relTime = (ms: number): string => {
    const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
  };
  const oldestWait = Number.isFinite(oldest) ? relTime(oldest) : '—';

  if (isLoading) {
    return <div className="flex items-center justify-center py-12"><div className="w-8 h-8 border-4 border-dark-600 border-t-gold-500 rounded-full animate-spin" /></div>;
  }

  return (
    <div className="om-fade" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* KPI row — real figures only */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(200px,1fr))', gap: 14 }}>
        <div className="card" style={{ padding: '15px 16px' }}>
          <div style={{ fontSize: 11.5, color: 'var(--text-2)', fontWeight: 600 }}>Pending Review</div>
          <div className="font-mono" style={{ fontSize: 22, fontWeight: 800, marginTop: 7, color: 'var(--warning)' }}>{pendingKYC.length}</div>
        </div>
        <div className="card" style={{ padding: '15px 16px' }}>
          <div style={{ fontSize: 11.5, color: 'var(--text-2)', fontWeight: 600 }}>Oldest In Queue</div>
          <div className="font-mono" style={{ fontSize: 22, fontWeight: 800, marginTop: 7, color: 'var(--text)' }}>{oldestWait}</div>
        </div>
      </div>

      {pendingKYC.length === 0 ? (
        <div className="card" style={{ padding: '64px 24px', display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center' }}>
          <Check size={40} style={{ color: 'var(--success)', marginBottom: 14 }} />
          <div style={{ fontSize: 16, fontWeight: 700 }}>Queue is clear</div>
          <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 6 }}>No KYC submissions are awaiting review.</div>
        </div>
      ) : (
        <div className="bb-grid" style={{ display: 'grid', gridTemplateColumns: '340px 1fr', gap: 16, alignItems: 'start' }}>
          {/* Queue list */}
          <div className="card" style={{ padding: 10 }}>
            <div style={{ fontSize: 10.5, fontWeight: 800, color: 'var(--muted)', letterSpacing: '.08em', textTransform: 'uppercase', padding: '9px 9px 7px' }}>Verification Queue · {pendingKYC.length}</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
              {pendingKYC.map((u, i) => {
                const active = selected?._id === u._id;
                return (
                  <div key={u._id} onClick={() => setSelectedId(u._id)} style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '11px 12px', borderRadius: 11, cursor: 'pointer', border: `1px solid ${active ? 'var(--gold)' : 'transparent'}`, background: active ? 'var(--active)' : 'transparent' }}>
                    <div style={{ width: 34, height: 34, borderRadius: 9, flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, fontSize: 12, color: '#fff', background: AV[i % 5] }}>{initials(u.username)}</div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{u.username}</div>
                      <div className="font-mono" style={{ fontSize: 10.5, color: 'var(--muted)' }}>{formatters.phone(u.mobile)}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Detail panel */}
          {selected && (
            <div className="card" style={{ padding: 22 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 20 }}>
                <div style={{ width: 52, height: 52, borderRadius: 13, flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, fontSize: 17, color: '#fff', background: AV[pendingKYC.indexOf(selected) % 5] }}>{initials(selected.username)}</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 18, fontWeight: 800 }}>{selected.username}</div>
                  <div className="font-mono" style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>{formatters.phone(selected.mobile)}</div>
                </div>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, fontWeight: 700, padding: '5px 11px', borderRadius: 20, color: 'var(--warning)', background: 'var(--warning-bg)' }}>
                  {(selected.kycStatus || '').replace(/_/g, ' ')}
                </span>
              </div>

              <div style={{ ...TILE, marginBottom: 14, padding: '0 18px' }}>
                <UserIcon size={24} />
                <span style={{ fontSize: 11.5, fontWeight: 700, textAlign: 'center', maxWidth: 420, lineHeight: 1.5 }}>
                  {verificationBlurb(selected)}
                </span>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 24px', paddingTop: 8 }}>
                {[
                  { label: 'Aadhaar (last 4)', value: v(selected)?.aadhaarLast4 ? `•••• •••• ${v(selected)!.aadhaarLast4}` : '—', mono: true },
                  { label: 'Verification', value: v(selected)?.status || 'Not started', mono: true },
                  { label: 'Mobile', value: formatters.phone(selected.mobile), mono: true },
                  { label: 'Export batch', value: v(selected)?.exportBatchId || 'Not exported yet', mono: true },
                ].map((f) => (
                  <div key={f.label} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '11px 0', borderBottom: '1px solid var(--border)' }}>
                    <span style={{ fontSize: 12, color: 'var(--muted)', fontWeight: 600 }}>{f.label}</span>
                    <span className={f.mono ? 'font-mono' : ''} style={{ fontSize: 12.5, fontWeight: 700, textAlign: 'right' }}>{f.value}</span>
                  </div>
                ))}
              </div>

              <div style={{ display: 'flex', gap: 11, marginTop: 22 }}>
                <button onClick={() => { setRejectUser(selected); setRejectReason(''); }} style={{ flex: 1, height: 44, borderRadius: 10, background: 'var(--danger-bg)', border: '1px solid var(--danger)', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, fontSize: 13.5, fontWeight: 700, cursor: 'pointer', color: 'var(--danger)' }}>
                  <X size={16} /> Reject
                </button>
                <button onClick={() => setConfirmApprove(selected)} style={{ flex: 2, height: 44, borderRadius: 10, background: 'var(--success)', border: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, fontSize: 13.5, fontWeight: 800, cursor: 'pointer', color: '#04140b' }}>
                  <Check size={16} /> Approve KYC
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {confirmApprove && (
        <ConfirmDialog
          isOpen={!!confirmApprove}
          onClose={() => setConfirmApprove(null)}
          onConfirm={() => handleApprove(confirmApprove._id)}
          title="Approve KYC?"
          message={`Approve ${confirmApprove.username}'s identity verification. The player gains full withdrawal access. Recorded in Audit Logs.`}
          type="success"
          confirmText="Approve KYC"
        />
      )}

      {rejectUser && (
        <Modal isOpen={!!rejectUser} onClose={() => { setRejectUser(null); setRejectReason(''); }} title="Reject KYC">
          <div className="space-y-4">
            <p className="text-gray-400">Rejecting KYC for <strong>{rejectUser.username}</strong>. They will be told the reason and asked to contact support.</p>
            <div>
              <label className="label">Rejection Reason *</label>
              <textarea value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} className="input min-h-[100px]" placeholder="Please provide a clear reason for rejection…" required />
            </div>
            <div className="flex space-x-3">
              <button onClick={() => { setRejectUser(null); setRejectReason(''); }} className="flex-1 btn-secondary">Cancel</button>
              <button onClick={() => handleReject(rejectUser._id, rejectReason)} className="flex-1 btn-danger">Reject KYC</button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
};
