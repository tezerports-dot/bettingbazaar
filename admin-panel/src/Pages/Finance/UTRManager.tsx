// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * UTR Fraud Monitor — the bank-reference control, from the operator's side.
 *
 * A UTR is the reference a player quotes to prove they paid. One reference
 * belongs to one order, enforced by the registry's primary key, so a reuse is
 * either a mistake or a fraud attempt. The backend has served nine endpoints
 * for this; this screen used to call three of them, and two of those three were
 * calling them wrongly:
 *
 *   RESOLVE SENT THE WRONG BODY. It posted `{ resolution }` while the handler
 *   requires `{ action: 'approve' | 'reject', notes }`, so every review ended
 *   in a 400 and the queue could not be cleared at all. The path was correct,
 *   which is why check:ui-coverage passed it — that gate compares paths, not
 *   contracts.
 *
 *   THE STAT CARDS READ FIELDS THE API DOES NOT SEND. utrStats() returns
 *   total/active/released/fraud/contested/duplicateAttempts; the cards asked
 *   for totalFlagged/duplicateUTR/fraudAlerts/resolvedToday. Four cards, four
 *   `undefined`.
 *
 * Approve and reject are separate buttons because they are separate decisions:
 * reject CANCELS the order through the state machine and releases a
 * withdrawal's escrow. A single "Clear" button that silently did one of them
 * would be an operator moving money without being told they had.
 */
import React, { useEffect, useState } from 'react';
import { Flag, CheckCircle, RefreshCw, AlertTriangle, Search, ShieldOff, ShieldCheck, History, XCircle } from 'lucide-react';
import { Modal } from '../../components/Modal';
import { formatters } from '../../utils/formatters';
import api from '../../services/api';
import toast from 'react-hot-toast';

interface FlaggedOrder {
  _id: string; orderId: string; type: 'DEPOSIT' | 'WITHDRAWAL';
  fiatAmount: number; utrNumber?: string; utrWarning?: string;
  requiresReview?: boolean; status: string; createdAt: string;
  userId?: { username: string; mobile: string; kycStatus: string } | string;
  merchantId?: { username: string; mobile: string } | string;
}

/** The registry row, exactly as database/repositories/utr.js maps it. */
interface RegistryEntry {
  utr: string; orderId: string | null; userId: string | null;
  amount: number | null; status: 'ACTIVE' | 'RELEASED' | 'FRAUD';
  registeredAt: string; releasedAt: string | null;
  flaggedAt: string | null; flaggedBy: string | null; flagReason: string | null;
  duplicateAttempts: number; lastContestedAt: string | null;
  user?: { username: string; mobile: string; kycStatus: string } | null;
  order?: { orderId: string; type: string; status: string; fiatAmount: number } | null;
}

/** utrStats() — the field names the API actually sends. */
interface UTRStats {
  available: boolean; total: number; active: number; released: number;
  fraud: number; contested: number; duplicateAttempts: number;
}

type Tab = 'review' | 'registry' | 'contested';

const STATUS_STYLE: Record<string, string> = {
  ACTIVE:   'bg-blue-500/20 text-blue-300',
  RELEASED: 'bg-green-500/20 text-green-300',
  FRAUD:    'bg-red-500/20 text-red-300',
};

const userLabel = (u: FlaggedOrder['userId']) =>
  (typeof u === 'object' && u ? `${u.username} (${u.mobile}) — KYC: ${u.kycStatus}` : String(u ?? '—'));

export const UTRManager: React.FC = () => {
  const [tab, setTab] = useState<Tab>('review');
  const [stats, setStats] = useState<UTRStats | null>(null);

  // Review queue (orders held for review)
  const [orders, setOrders] = useState<FlaggedOrder[]>([]);
  const [ordersLoading, setOrdersLoading] = useState(true);
  const [selected, setSelected] = useState<FlaggedOrder | null>(null);
  const [resolveNote, setResolveNote] = useState('');
  const [saving, setSaving] = useState<'approve' | 'reject' | null>(null);

  // Registry
  const [registry, setRegistry] = useState<RegistryEntry[]>([]);
  const [registryLoading, setRegistryLoading] = useState(false);
  const [registryStatus, setRegistryStatus] = useState('');
  const [lookup, setLookup] = useState('');
  const [lookedUp, setLookedUp] = useState<RegistryEntry | null>(null);

  // Contested (references somebody tried to reuse)
  const [contested, setContested] = useState<RegistryEntry[]>([]);
  const [contestedLoading, setContestedLoading] = useState(false);

  // Flag / clear
  const [flagTarget, setFlagTarget] = useState<RegistryEntry | null>(null);
  const [flagReason, setFlagReason] = useState('');
  const [flagBusy, setFlagBusy] = useState(false);

  // Per-player history
  const [historyFor, setHistoryFor] = useState<string | null>(null);
  const [history, setHistory] = useState<RegistryEntry[]>([]);

  const loadStats = async () => {
    try {
      const res = await api.get<any>('/api/admin/utr/stats');
      setStats(res.data?.stats ?? null);
    } catch { /* the cards simply do not render */ }
  };

  const loadOrders = async () => {
    setOrdersLoading(true);
    try {
      const res = await api.get<any>('/api/admin/utr/flagged');
      setOrders(res.data?.flaggedOrders || []);
    } catch { toast.error('Failed to load flagged orders'); }
    finally { setOrdersLoading(false); }
  };

  const loadRegistry = async () => {
    setRegistryLoading(true);
    try {
      const res = await api.get<any>('/api/admin/utr-registry', {
        params: { status: registryStatus || undefined, limit: 100 },
      });
      setRegistry(res.data?.entries || []);
    } catch { toast.error('Failed to load the registry'); }
    finally { setRegistryLoading(false); }
  };

  const loadContested = async () => {
    setContestedLoading(true);
    try {
      const res = await api.get<any>('/api/admin/utr/contested', { params: { limit: 100 } });
      setContested(res.data?.contested || []);
    } catch { toast.error('Failed to load contested references'); }
    finally { setContestedLoading(false); }
  };

  useEffect(() => { loadStats(); }, []);
  useEffect(() => {
    if (tab === 'review') loadOrders();
    if (tab === 'registry') loadRegistry();
    if (tab === 'contested') loadContested();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, registryStatus]);

  /**
   * Clear an order held for review.
   *
   * `action` is what the handler requires and what this screen never sent.
   * Reject cancels the order, so it is asked for explicitly rather than
   * inferred from an empty note.
   */
  const resolve = async (action: 'approve' | 'reject') => {
    if (!selected) return;
    if (action === 'reject' && !resolveNote.trim()) {
      toast.error('Rejecting cancels the order — say why.');
      return;
    }
    setSaving(action);
    try {
      await api.post(`/api/admin/utr/resolve/${selected._id}`, { action, notes: resolveNote.trim() });
      toast.success(action === 'approve' ? 'Order approved and released' : 'Order rejected and cancelled');
      setSelected(null); setResolveNote('');
      loadOrders(); loadStats();
    } catch (e: any) {
      toast.error(e.response?.data?.message || `Failed to ${action}`);
    } finally { setSaving(null); }
  };

  const doLookup = async () => {
    const utr = lookup.trim();
    if (!utr) return;
    try {
      const res = await api.get<any>(`/api/admin/utr-registry/${encodeURIComponent(utr)}`);
      setLookedUp(res.data?.entry ?? null);
    } catch (e: any) {
      setLookedUp(null);
      toast.error(e.response?.status === 404 ? 'That reference is not in the registry' : 'Lookup failed');
    }
  };

  const flagFraud = async () => {
    if (!flagTarget || !flagReason.trim()) return;
    setFlagBusy(true);
    try {
      await api.put(`/api/admin/utr-registry/${encodeURIComponent(flagTarget.utr)}/flag`, { reason: flagReason.trim() });
      toast.success('Reference flagged as FRAUD');
      setFlagTarget(null); setFlagReason('');
      loadRegistry(); loadContested(); loadStats();
    } catch (e: any) { toast.error(e.response?.data?.message || 'Failed to flag'); }
    finally { setFlagBusy(false); }
  };

  const clearFlag = async (entry: RegistryEntry) => {
    try {
      await api.put(`/api/admin/utr-registry/${encodeURIComponent(entry.utr)}/clear`, {});
      toast.success('Flag cleared');
      loadRegistry(); loadContested(); loadStats();
    } catch (e: any) { toast.error(e.response?.data?.message || 'Failed to clear the flag'); }
  };

  const openHistory = async (userId: string) => {
    setHistoryFor(userId); setHistory([]);
    try {
      const res = await api.get<any>(`/api/admin/utr/user-history/${encodeURIComponent(userId)}`);
      setHistory(res.data?.history || []);
    } catch { toast.error('Failed to load that player’s history'); }
  };

  const refreshCurrent = () => {
    loadStats();
    if (tab === 'review') loadOrders();
    if (tab === 'registry') loadRegistry();
    if (tab === 'contested') loadContested();
  };

  const EntryRow: React.FC<{ e: RegistryEntry }> = ({ e }) => (
    <div className="bg-dark-800 rounded-xl p-4 border border-dark-700">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-mono text-sm text-yellow-400">{e.utr}</span>
            <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${STATUS_STYLE[e.status] ?? 'bg-dark-700 text-gray-300'}`}>{e.status}</span>
            {e.duplicateAttempts > 0 && (
              <span className="text-xs px-2 py-0.5 rounded-full bg-orange-500/20 text-orange-300 font-medium">
                {e.duplicateAttempts} reuse {e.duplicateAttempts === 1 ? 'attempt' : 'attempts'}
              </span>
            )}
          </div>
          {e.order && <p className="text-sm text-gray-300 font-mono">{e.order.orderId} · {e.order.type} · {e.order.status}</p>}
          {e.user && <p className="text-sm text-gray-300">{e.user.username} ({e.user.mobile}) — KYC: {e.user.kycStatus}</p>}
          {e.flagReason && <p className="text-xs text-red-300 italic">Flagged: {e.flagReason}</p>}
          <p className="text-xs text-gray-500">
            Registered {formatters.datetime(e.registeredAt)}
            {e.lastContestedAt && <> · last contested {formatters.datetime(e.lastContestedAt)}</>}
          </p>
        </div>
        <div className="text-right space-y-2 shrink-0">
          {e.amount !== null && <p className="text-lg font-bold">{formatters.currency(e.amount)}</p>}
          <div className="flex flex-col gap-1.5">
            {e.status === 'FRAUD' ? (
              <button onClick={() => clearFlag(e)} className="px-3 py-1.5 bg-dark-700 text-xs font-semibold rounded-lg hover:bg-dark-600 flex items-center gap-1.5">
                <ShieldCheck size={12} />Clear flag
              </button>
            ) : (
              <button onClick={() => { setFlagTarget(e); setFlagReason(''); }} className="px-3 py-1.5 bg-red-500/20 text-red-300 text-xs font-semibold rounded-lg hover:bg-red-500/30 flex items-center gap-1.5">
                <ShieldOff size={12} />Flag fraud
              </button>
            )}
            {e.userId && (
              <button onClick={() => openHistory(e.userId!)} className="px-3 py-1.5 bg-dark-700 text-xs rounded-lg hover:bg-dark-600 flex items-center gap-1.5">
                <History size={12} />History
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );

  const Empty: React.FC<{ text: string; sub?: string }> = ({ text, sub }) => (
    <div className="text-center py-16 text-gray-500">
      <CheckCircle size={48} className="mx-auto mb-4 text-green-500 opacity-50" />
      <p className="text-lg">{text}</p>
      {sub && <p className="text-sm text-gray-600 mt-1">{sub}</p>}
    </div>
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">UTR Fraud Monitor</h1>
          <p className="text-gray-400 text-sm mt-1">Bank references: the review queue, the registry, and every reference somebody tried to reuse</p>
        </div>
        <button onClick={refreshCurrent} className="p-2 hover:bg-dark-700 rounded-lg"><RefreshCw size={16} /></button>
      </div>

      {/* Stats — the field names utrStats() actually sends. */}
      {stats?.available && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
          {[
            { label: 'References', value: stats.total, color: 'text-gray-200' },
            { label: 'Active', value: stats.active, color: 'text-blue-400' },
            { label: 'Released', value: stats.released, color: 'text-green-400' },
            { label: 'Flagged Fraud', value: stats.fraud, color: 'text-red-400' },
            { label: 'Reuse Attempts', value: stats.duplicateAttempts, color: 'text-orange-400' },
          ].map(s => (
            <div key={s.label} className="bg-dark-800 rounded-xl p-4 border border-dark-700">
              <p className="text-xs text-gray-400">{s.label}</p>
              <p className={`text-3xl font-bold mt-1 ${s.color}`}>{s.value ?? 0}</p>
            </div>
          ))}
        </div>
      )}

      <div className="flex gap-2 border-b border-dark-700">
        {([
          ['review', `Review queue${orders.length ? ` (${orders.length})` : ''}`],
          ['registry', 'Registry'],
          ['contested', `Contested${stats?.contested ? ` (${stats.contested})` : ''}`],
        ] as [Tab, string][]).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px ${tab === key ? 'border-gold-500 text-gold-400' : 'border-transparent text-gray-400 hover:text-gray-200'}`}
          >{label}</button>
        ))}
      </div>

      {tab === 'review' && (
        ordersLoading ? <div className="text-center py-16 text-gray-400">Loading flagged orders…</div>
        : orders.length === 0 ? <Empty text="No flagged orders" sub="All clear — no suspicious UTR activity detected" />
        : (
          <div className="space-y-3">
            {orders.map(o => (
              <div key={o._id} className="bg-dark-800 rounded-xl p-4 border border-red-500/20">
                <div className="flex items-start justify-between gap-4">
                  <div className="space-y-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <Flag size={14} className="text-red-400" />
                      <span className="font-mono text-sm">{o.orderId}</span>
                      {o.utrWarning && (
                        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${o.utrWarning === 'FRAUD_ALERT' ? 'bg-red-500/20 text-red-400' : 'bg-orange-500/20 text-orange-400'}`}>
                          {o.utrWarning.replace(/_/g, ' ')}
                        </span>
                      )}
                    </div>
                    <p className="text-sm"><span className="text-gray-400">User: </span>{userLabel(o.userId)}</p>
                    {o.utrNumber && <p className="text-sm font-mono text-yellow-400">UTR: {o.utrNumber}</p>}
                    <p className="text-xs text-gray-500">{formatters.datetime(o.createdAt)}</p>
                  </div>
                  <div className="text-right space-y-2 shrink-0">
                    <p className="text-xl font-bold">{formatters.currency(o.fiatAmount)}</p>
                    <p className="text-sm text-gray-400">{o.type}</p>
                    <button onClick={() => { setSelected(o); setResolveNote(''); }} className="px-3 py-1.5 bg-gold-500 text-black text-xs font-semibold rounded-lg hover:bg-gold-400">
                      Review
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )
      )}

      {tab === 'registry' && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <select value={registryStatus} onChange={e => setRegistryStatus(e.target.value)} className="input text-sm">
              <option value="">All statuses</option>
              <option value="ACTIVE">Active</option>
              <option value="RELEASED">Released</option>
              <option value="FRAUD">Fraud</option>
            </select>
            <div className="flex items-center gap-2 flex-1 min-w-[240px]">
              <input
                value={lookup}
                onChange={e => setLookup(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') doLookup(); }}
                className="input text-sm flex-1"
                placeholder="Look up an exact reference…"
              />
              <button onClick={doLookup} className="btn-secondary text-sm flex items-center gap-1.5"><Search size={14} />Look up</button>
            </div>
          </div>

          {lookedUp && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <p className="text-xs uppercase tracking-wide text-gray-500">Lookup result</p>
                <button onClick={() => { setLookedUp(null); setLookup(''); }} className="text-xs text-gray-400 hover:text-gray-200 flex items-center gap-1"><XCircle size={12} />Clear</button>
              </div>
              <EntryRow e={lookedUp} />
            </div>
          )}

          {registryLoading ? <div className="text-center py-16 text-gray-400">Loading the registry…</div>
            : registry.length === 0 ? <Empty text="No references" sub="Nothing has been registered under this filter yet" />
            : <div className="space-y-3">{registry.map(e => <EntryRow key={e.utr} e={e} />)}</div>}
        </div>
      )}

      {tab === 'contested' && (
        <div className="space-y-3">
          <p className="text-sm text-gray-400">
            References somebody tried to claim twice. A refused duplicate is the signal this control exists to catch — newest contest first.
          </p>
          {contestedLoading ? <div className="text-center py-16 text-gray-400">Loading…</div>
            : contested.length === 0 ? <Empty text="Nothing contested" sub="No reference has been submitted twice" />
            : contested.map(e => <EntryRow key={e.utr} e={e} />)}
        </div>
      )}

      {selected && (
        <Modal isOpen onClose={() => setSelected(null)} title={`Review Order — ${selected.orderId}`}>
          <div className="space-y-4">
            <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-4 text-sm space-y-2">
              {selected.utrWarning && (
                <div className="flex items-center gap-2 text-red-400 font-semibold"><AlertTriangle size={16} />{selected.utrWarning.replace(/_/g, ' ')}</div>
              )}
              <div className="flex justify-between text-gray-300"><span>Amount</span><span className="font-bold">{formatters.currency(selected.fiatAmount)}</span></div>
              <div className="flex justify-between text-gray-300"><span>User</span><span>{userLabel(selected.userId)}</span></div>
              {selected.utrNumber && <div className="flex justify-between text-gray-300"><span>UTR Number</span><span className="font-mono text-yellow-400">{selected.utrNumber}</span></div>}
            </div>

            <div>
              <label className="label">Review notes</label>
              <textarea value={resolveNote} onChange={e => setResolveNote(e.target.value)} className="input resize-none" rows={3}
                placeholder="Why are you approving or rejecting this?" />
              <p className="text-xs text-gray-500 mt-1">Required to reject — rejecting cancels the order.</p>
            </div>

            <div className="flex gap-3">
              <button onClick={() => setSelected(null)} className="flex-1 btn-secondary">Cancel</button>
              <button onClick={() => resolve('reject')} disabled={saving !== null}
                className="flex-1 px-3 py-2 bg-red-500/20 text-red-300 font-semibold rounded-lg hover:bg-red-500/30 disabled:opacity-50">
                {saving === 'reject' ? 'Rejecting…' : 'Reject & cancel'}
              </button>
              <button onClick={() => resolve('approve')} disabled={saving !== null} className="flex-1 btn-primary disabled:opacity-50">
                {saving === 'approve' ? 'Approving…' : 'Approve & release'}
              </button>
            </div>
          </div>
        </Modal>
      )}

      {flagTarget && (
        <Modal isOpen onClose={() => setFlagTarget(null)} title={`Flag ${flagTarget.utr} as fraud`}>
          <div className="space-y-4">
            <p className="text-sm text-gray-300">
              This marks the reference, and does <strong>not</strong> reverse the order it belongs to — those are separate decisions.
            </p>
            <div>
              <label className="label">Reason</label>
              <textarea value={flagReason} onChange={e => setFlagReason(e.target.value)} className="input resize-none" rows={3}
                placeholder="What makes this reference fraudulent?" />
              <p className="text-xs text-gray-500 mt-1">Required — this is what the player is shown if they appeal.</p>
            </div>
            <div className="flex gap-3">
              <button onClick={() => setFlagTarget(null)} className="flex-1 btn-secondary">Cancel</button>
              <button onClick={flagFraud} disabled={flagBusy || !flagReason.trim()}
                className="flex-1 px-3 py-2 bg-red-500 text-white font-semibold rounded-lg hover:bg-red-400 disabled:opacity-50">
                {flagBusy ? 'Flagging…' : 'Flag as fraud'}
              </button>
            </div>
          </div>
        </Modal>
      )}

      {historyFor && (
        <Modal isOpen onClose={() => setHistoryFor(null)} title="Reference history for this player" size="lg">
          {history.length === 0 ? (
            <p className="text-sm text-gray-400 py-6 text-center">No references on file.</p>
          ) : (
            <div className="space-y-2 max-h-[60vh] overflow-y-auto pr-1">
              {history.map(h => (
                <div key={h.utr} className="flex items-center justify-between bg-dark-700 rounded-lg px-4 py-3 text-sm">
                  <div>
                    <p className="font-mono text-yellow-400">{h.utr}</p>
                    <p className="text-xs text-gray-400">{formatters.datetime(h.registeredAt)}</p>
                  </div>
                  <div className="text-right">
                    {h.amount !== null && <p className="font-semibold">{formatters.currency(h.amount)}</p>}
                    <span className={`text-xs px-2 py-0.5 rounded-full ${STATUS_STYLE[h.status] ?? ''}`}>{h.status}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Modal>
      )}
    </div>
  );
};
