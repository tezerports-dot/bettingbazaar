// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
import React, { useEffect, useState } from 'react';
import { Flag, CheckCircle, RefreshCw, AlertTriangle } from 'lucide-react';
import { Modal } from '../../components/Modal';
import { formatters } from '../../utils/formatters';
import api from '../../services/api';
import toast from 'react-hot-toast';

interface FlaggedOrder {
  _id: string;
  orderId: string;
  type: 'DEPOSIT' | 'WITHDRAWAL';
  fiatAmount: number;
  utrNumber?: string;
  utrWarning?: string;
  requiresReview?: boolean;
  status: string;
  createdAt: string;
  userId?: { username: string; mobile: string; kycStatus: string };
  merchantId?: { username: string; mobile: string };
}

interface UTRStats {
  totalFlagged: number;
  duplicateUTR: number;
  fraudAlerts: number;
  resolvedToday: number;
}

export const UTRManager: React.FC = () => {
  const [orders, setOrders]       = useState<FlaggedOrder[]>([]);
  const [stats, setStats]         = useState<UTRStats | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [selected, setSelected]   = useState<FlaggedOrder | null>(null);
  const [resolveNote, setResolveNote] = useState('');
  const [isSaving, setIsSaving]   = useState(false);
  const [filterType, setFilterType] = useState('');

  const loadStats = async () => {
    try {
      const res = await api.get<any>('/api/admin/utr/stats');
      setStats(res.data?.stats || null);
    } catch {}
  };

  const load = async () => {
    setIsLoading(true);
    try {
      const res = await api.get<any>('/api/admin/utr/flagged', { params: { type: filterType || undefined } });
      setOrders(res.data?.flaggedOrders || []);
    } catch { toast.error('Failed to load flagged orders'); }
    finally { setIsLoading(false); }
  };

  useEffect(() => { load(); loadStats(); }, [filterType]);

  const handleResolve = async () => {
    if (!selected) return;
    setIsSaving(true);
    try {
      await api.post(`/api/admin/utr/resolve/${selected._id}`, { resolution: resolveNote.trim() || 'Reviewed by admin' });
      toast.success('Order cleared');
      setSelected(null); setResolveNote('');
      load(); loadStats();
    } catch (e: any) { toast.error(e.response?.data?.message || 'Failed to resolve'); }
    finally { setIsSaving(false); }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">UTR Fraud Monitor</h1>
          <p className="text-gray-400 text-sm mt-1">Review flagged UTR numbers — duplicate submissions and fraud alerts</p>
        </div>
        <div className="flex items-center gap-3">
          <select value={filterType} onChange={e => setFilterType(e.target.value)} className="input text-sm">
            <option value="">All Flags</option>
            <option value="DUPLICATE_UTR">Duplicate UTR</option>
            <option value="FRAUD_ALERT">Fraud Alert</option>
          </select>
          <button onClick={() => { load(); loadStats(); }} className="p-2 hover:bg-dark-700 rounded-lg"><RefreshCw size={16} /></button>
        </div>
      </div>

      {stats && (
        <div className="grid grid-cols-4 gap-4">
          {[
            { label: 'Total Flagged', value: stats.totalFlagged, color: 'text-yellow-400' },
            { label: 'Duplicate UTR', value: stats.duplicateUTR, color: 'text-orange-400' },
            { label: 'Fraud Alerts', value: stats.fraudAlerts, color: 'text-red-400' },
            { label: 'Resolved Today', value: stats.resolvedToday, color: 'text-green-400' },
          ].map(s => (
            <div key={s.label} className="bg-dark-800 rounded-xl p-4 border border-dark-700">
              <p className="text-xs text-gray-400">{s.label}</p>
              <p className={`text-3xl font-bold mt-1 ${s.color}`}>{s.value}</p>
            </div>
          ))}
        </div>
      )}

      {isLoading ? (
        <div className="text-center py-16 text-gray-400">Loading flagged orders...</div>
      ) : orders.length === 0 ? (
        <div className="text-center py-16 text-gray-500">
          <CheckCircle size={48} className="mx-auto mb-4 text-green-500 opacity-50" />
          <p className="text-lg">No flagged orders</p>
          <p className="text-sm text-gray-600 mt-1">All clear — no suspicious UTR activity detected</p>
        </div>
      ) : (
        <div className="space-y-3">
          {orders.map(o => (
            <div key={o._id} className="bg-dark-800 rounded-xl p-4 border border-red-500/20">
              <div className="flex items-start justify-between">
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <Flag size={14} className="text-red-400" />
                    <span className="font-mono text-sm">{o.orderId}</span>
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${o.utrWarning === 'FRAUD_ALERT' ? 'bg-red-500/20 text-red-400' : 'bg-orange-500/20 text-orange-400'}`}>
                      {o.utrWarning?.replace(/_/g, ' ')}
                    </span>
                  </div>
                  <p className="text-sm"><span className="text-gray-400">User: </span>{o.userId?.username} ({o.userId?.mobile}) — KYC: {o.userId?.kycStatus}</p>
                  <p className="text-sm"><span className="text-gray-400">Merchant: </span>{o.merchantId?.username}</p>
                  {o.utrNumber && <p className="text-sm font-mono text-yellow-400">UTR: {o.utrNumber}</p>}
                  <p className="text-xs text-gray-500">{formatters.datetime(o.createdAt)}</p>
                </div>
                <div className="text-right space-y-2">
                  <p className="text-xl font-bold">{formatters.currency(o.fiatAmount)}</p>
                  <p className="text-sm text-gray-400">{o.type}</p>
                  <button onClick={() => { setSelected(o); setResolveNote(''); }} className="px-3 py-1.5 bg-gold-500 text-black text-xs font-semibold rounded-lg hover:bg-gold-400">
                    Review & Clear
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {selected && (
        <Modal isOpen onClose={() => setSelected(null)} title={`Review Order — ${selected.orderId}`}>
          <div className="space-y-4">
            <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-4 text-sm space-y-2">
              <div className="flex items-center gap-2 text-red-400 font-semibold"><AlertTriangle size={16} />{selected.utrWarning?.replace(/_/g,' ')}</div>
              <div className="flex justify-between text-gray-300"><span>Amount</span><span className="font-bold">{formatters.currency(selected.fiatAmount)}</span></div>
              <div className="flex justify-between text-gray-300"><span>User</span><span>{selected.userId?.username} — KYC: {selected.userId?.kycStatus}</span></div>
              {selected.utrNumber && <div className="flex justify-between text-gray-300"><span>UTR Number</span><span className="font-mono text-yellow-400">{selected.utrNumber}</span></div>}
            </div>

            <div>
              <label className="label">Resolution Note (optional)</label>
              <textarea value={resolveNote} onChange={e => setResolveNote(e.target.value)} className="input resize-none" rows={3} placeholder="Add notes about your review decision..." />
            </div>

            <div className="flex gap-3">
              <button onClick={() => setSelected(null)} className="flex-1 btn-secondary">Cancel</button>
              <button onClick={handleResolve} disabled={isSaving} className="flex-1 btn-primary disabled:opacity-50">
                {isSaving ? 'Clearing...' : 'Clear Flag & Approve'}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
};

