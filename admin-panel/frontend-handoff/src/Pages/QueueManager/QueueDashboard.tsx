import sseService from '../../services/sse';
// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * QueueDashboard.tsx — AUDIT FIX
 * Pending Queue tab: GET /api/admin/queue/pending-orders (live WS, assign orders)
 * All Orders tab:    GET /api/admin/payment-queue (all statuses grouped — was orphaned)
 */
import React, { useEffect, useState, useCallback } from 'react';
import { Layers, Store, Clock, CheckCircle, XCircle, RefreshCw, List, Users } from 'lucide-react';
import { LoadingSpinner } from '../../components/LoadingSpinner';
import { Kpis, Toolbar } from '../../components/design';
import api from '../../services/api';
import type { PaymentOrder, Merchant } from '../../types';
import toast from 'react-hot-toast';

type Tab = 'pending' | 'all' | 'pool';

export const QueueDashboard: React.FC = () => {
  const [tab, setTab]                           = useState<Tab>('pending');
  const [pendingOrders, setPendingOrders]       = useState<PaymentOrder[]>([]);
  const [groupedOrders, setGroupedOrders]       = useState<Record<string, PaymentOrder[]>>({});
  const [groupedStats, setGroupedStats]         = useState<Record<string, number>>({});
  const [merchants, setMerchants]               = useState<Merchant[]>([]);
  const [isLoading, setIsLoading]               = useState(true);
  const [filterType, setFilterType]             = useState<'ALL'|'DEPOSIT'|'WITHDRAWAL'>('ALL');
  const [allStatusFilter, setAllStatusFilter]   = useState('ALL');
  const [assigningId, setAssigningId]           = useState<string|null>(null);
  const [loadError, setLoadError]               = useState(false);

  // ── Merchant Pool state (BBEPS F2 redesign) ──────────────────────────────
  const [poolMerchants, setPoolMerchants]       = useState<any[]>([]);
  const [eligibleMerchants, setEligibleMerchants] = useState<any[]>([]);
  const [selectedPoolIds, setSelectedPoolIds]   = useState<Set<string>>(new Set());
  const [poolLoading, setPoolLoading]           = useState(false);
  const [poolSaving, setPoolSaving]             = useState(false);
  const [poolLoaded, setPoolLoaded]             = useState(false);

  const loadPending = useCallback(async () => {
    const [ordRes, depRes, witRes] = await Promise.all([
      api.queueManager.getPendingOrders(),
      api.queueManager.getAvailableMerchants('DEPOSIT'),
      api.queueManager.getAvailableMerchants('WITHDRAWAL'),
    ]);
    if (ordRes.success && ordRes.data) setPendingOrders(ordRes.data);
    const seen = new Set<string>();
    const all  = [...(depRes.data||[]), ...(witRes.data||[])];
    setMerchants(all.filter(m => { if (seen.has(m._id)) return false; seen.add(m._id); return true; }));
  }, []);

  const loadGrouped = useCallback(async () => {
    const res = await api.queueManager.getGroupedQueue();
    if (res.success && res.grouped) { setGroupedOrders(res.grouped); setGroupedStats(res.stats||{}); }
  }, []);

  const loadData = useCallback(async () => {
    setIsLoading(true); setLoadError(false);
    try   { await Promise.all([loadPending(), loadGrouped()]); }
    catch { toast.error('Failed to load queue data'); setLoadError(true); }
    finally { setIsLoading(false); }
  }, [loadPending, loadGrouped]);

  useEffect(() => {
    loadData();
    const onNew    = (o: PaymentOrder)     => setPendingOrders(p => [o, ...p]);
    const onUpdate = (u: PaymentOrder)     => {
      setPendingOrders(p =>
        ['ASSIGNED','PROCESSING','COMPLETED'].includes(u.status)
          ? p.filter(o => o._id !== u._id)
          : p.map(o => o._id === u._id ? { ...o, ...u } : o)
      );
      loadGrouped();
    };
    sseService.on('new_order',          onNew);
    sseService.on('queue_order_update', onUpdate);
    return () => { sseService.off('new_order', onNew); sseService.off('queue_order_update', onUpdate); };
  }, [loadData, loadGrouped]);

  const loadPool = useCallback(async () => {
    setPoolLoading(true);
    try {
      const [poolRes, eligRes] = await Promise.all([
        api.queueManager.getMerchantPool(),
        api.queueManager.getEligibleMerchants(),
      ]);
      if (poolRes.success) {
        setPoolMerchants(poolRes.pool || []);
        setSelectedPoolIds(new Set((poolRes.pool || []).map((m: any) => m._id)));
      }
      if (eligRes.success) setEligibleMerchants(eligRes.merchants || []);
      setPoolLoaded(true);
    } catch {
      toast.error('Failed to load merchant pool');
    } finally {
      setPoolLoading(false);
    }
  }, []);

  useEffect(() => {
    if (tab === 'pool' && !poolLoaded) loadPool();
  }, [tab, poolLoaded, loadPool]);

  const togglePoolSelection = (merchantId: string) => {
    setSelectedPoolIds(prev => {
      const next = new Set(prev);
      if (next.has(merchantId)) next.delete(merchantId);
      else if (next.size < 5) next.add(merchantId);
      else toast.error('Pool can hold at most 5 merchants — remove one first');
      return next;
    });
  };

  const handleSavePool = async () => {
    if (selectedPoolIds.size < 3 || selectedPoolIds.size > 5) {
      toast.error('Select 3 to 5 merchants for the pool');
      return;
    }
    setPoolSaving(true);
    try {
      const res = await api.queueManager.setMerchantPool(Array.from(selectedPoolIds));
      if (res.success) {
        toast.success(res.message || 'Merchant pool updated');
        setPoolLoaded(false);
        await loadPool();
        await loadPending(); // refresh assign dropdowns with the new pool
      } else {
        toast.error(res.message || 'Failed to update pool');
      }
    } catch (e: any) {
      toast.error(e.response?.data?.message || 'Failed to update pool');
    } finally {
      setPoolSaving(false);
    }
  };

  const handleAssign = async (orderId: string, merchantId: string, fromGrouped = false) => {
    setAssigningId(orderId);
    try {
      const res = fromGrouped
        ? await api.queueManager.reassignOrder(orderId, merchantId)
        : await api.queueManager.assignOrder(orderId, merchantId);
      if (res.success) { toast.success('Order assigned!'); await loadData(); }
      else toast.error(res.message || 'Assignment failed');
    } catch (e: any) { toast.error(e.response?.data?.message || 'Failed to assign'); }
    finally { setAssigningId(null); }
  };

  const handleOrderAction = async (orderId: string, action: 'APPROVE'|'REJECT'|'CANCEL'|'VIDEO_KYC') => {
    const reason = action === 'VIDEO_KYC'
      ? undefined
      : prompt(`Enter reason for ${action}:`);
    if (action !== 'VIDEO_KYC' && !reason) return;
    try {
      let res: any;
      if (action === 'APPROVE') res = await api.orderActions.approve(orderId, reason!);
      else if (action === 'REJECT') res = await api.orderActions.reject(orderId, reason!);
      else if (action === 'CANCEL') res = await api.orderActions.cancel(orderId, reason!);
      else res = await api.orderActions.requireVideoKYC(orderId);
      if (res.success) {
        toast.success(action === 'VIDEO_KYC' ? 'Video KYC requested' : `Order ${action}D`);
        await loadData();
      } else toast.error(res.message || 'Action failed');
    } catch (e: any) { toast.error(e.response?.data?.message || 'Action failed'); }
  };

  const sBadge = (s: string) => {
    const m: Record<string,string> = {
      PENDING_QUEUE: 'bg-yellow-500/20 text-yellow-400', ASSIGNED: 'bg-blue-500/20 text-blue-400',
      PROCESSING:    'bg-purple-500/20 text-purple-400', PAID:     'bg-indigo-500/20 text-indigo-400',
      COMPLETED:     'bg-green-500/20  text-green-400',  DISPUTED: 'bg-red-500/20 text-red-400',
      CANCELLED:     'bg-gray-500/20   text-gray-400',   FAILED:   'bg-red-800/20 text-red-500',
    };
    return <span className={`px-2 py-0.5 rounded text-xs font-medium ${m[s]||m.PENDING_QUEUE}`}>{s.replace(/_/g,' ')}</span>;
  };
  const tBadge = (t: string) => (
    <span className={`px-2 py-0.5 rounded text-xs font-medium ${t==='DEPOSIT'?'bg-green-500/20 text-green-400':'bg-red-500/20 text-red-400'}`}>{t}</span>
  );

  const filteredPending = pendingOrders.filter(o => filterType==='ALL' || o.type===filterType);
  const allFlat: PaymentOrder[] = Object.entries(groupedOrders)
    .filter(([s]) => allStatusFilter==='ALL' || s.toLowerCase()===allStatusFilter.toLowerCase())
    .flatMap(([,os]) => os)
    .sort((a,b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  const OrderCard = ({ order, grouped }: { order: PaymentOrder; grouped?: boolean }) => {
    const id = order._id || order.orderId;
    const canAssign = !grouped || ['PENDING_QUEUE','ASSIGNED'].includes(order.status);
    return (
      <div className="bg-dark-700 rounded-lg p-4 space-y-3">
        <div className="flex flex-wrap items-center gap-2 mb-1">
          {tBadge(order.type)}{sBadge(order.status)}
          <span className="text-xs text-gray-500 font-mono">{order.orderId}</span>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-x-6 gap-y-1 text-sm">
          <div><p className="text-gray-400 text-xs">User</p><p className="font-medium">{(order as any).userName||'—'}</p></div>
          <div><p className="text-gray-400 text-xs">Tokens</p><p className="font-medium text-yellow-400">{(order.tokenAmount||0).toLocaleString()} BB</p></div>
          <div><p className="text-gray-400 text-xs">Fiat</p><p className="font-medium">₹{(order.fiatAmount||0).toLocaleString()}</p></div>
          <div><p className="text-gray-400 text-xs">Profit</p><p className="font-medium text-green-400">₹{(order.merchantProfit||0).toLocaleString()}</p></div>
        </div>
        <div className="flex items-center text-xs text-gray-500 gap-1">
          <Clock size={11}/>{new Date(order.createdAt).toLocaleString()}
        </div>
        {canAssign && (
          <div className="flex items-center gap-2">
            <select className="flex-1 input text-sm" defaultValue=""
              onChange={e => { if (e.target.value) { handleAssign(id, e.target.value, grouped); e.currentTarget.value=''; } }}
              disabled={assigningId===id}>
              <option value="">{grouped ? 'Reassign to merchant…' : 'Assign to merchant…'}</option>
              {merchants.map(m => <option key={m._id} value={m._id}>{m.name} {m.isOnline?'🟢':'🔴'}</option>)}
            </select>
            {assigningId===id && <RefreshCw className="animate-spin text-yellow-400 flex-shrink-0" size={18}/>}
          </div>
        )}
        {/* Admin action buttons — visible on ALL orders regardless of status */}
        <div className="flex flex-wrap gap-1.5 pt-2 border-t border-dark-600 mt-2">
          <button
            onClick={() => handleOrderAction(id, 'APPROVE')}
            className="px-3 py-1.5 bg-green-600 hover:bg-green-500 text-white text-xs font-bold rounded transition-colors"
            title="Force-complete this order and credit the user"
          >✅ Approve</button>
          <button
            onClick={() => handleOrderAction(id, 'REJECT')}
            className="px-3 py-1.5 bg-red-700 hover:bg-red-600 text-white text-xs font-bold rounded transition-colors"
            title="Reject and cancel this order"
          >❌ Reject</button>
          <button
            onClick={() => handleOrderAction(id, 'CANCEL')}
            className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-white text-xs font-bold rounded transition-colors"
            title="Cancel this order"
          >🚫 Cancel</button>
          <button
            onClick={() => handleOrderAction(id, 'VIDEO_KYC')}
            className="px-3 py-1.5 bg-purple-700 hover:bg-purple-600 text-white text-xs font-bold rounded transition-colors"
            title="Require video KYC before releasing funds"
          >📹 Video KYC</button>
        </div>
      </div>
    );
  };

  if (isLoading) return <LoadingSpinner size="lg" />;

  const TAB_CFG = [
    { id: 'pending' as Tab, label: 'Pending Queue', count: pendingOrders.length, color: 'text-yellow-400' },
    { id: 'all'     as Tab, label: 'All Orders',    count: groupedStats.total,   color: 'text-blue-400'   },
    { id: 'pool'    as Tab, label: 'Merchant Pool', count: poolMerchants.length, color: 'text-purple-400' },
  ];

  return (
    <div className="om-fade space-y-6">
      <Toolbar
        tabs={TAB_CFG.map((tc) => ({ label: tc.label, count: tc.count || 0, active: tab === tc.id, onClick: () => setTab(tc.id) }))}
        actions={[{ label: 'Refresh', icon: RefreshCw, onClick: loadData }]}
      />

      {/* ─── PENDING QUEUE TAB ─── */}
      {tab==='pending' && (
        <>
          <Kpis items={[
            { label: 'Pending', value: pendingOrders.length, tone: 'var(--warning)' },
            { label: 'Deposits', value: pendingOrders.filter((o) => o.type === 'DEPOSIT').length, tone: 'var(--success)' },
            { label: 'Withdrawals', value: pendingOrders.filter((o) => o.type === 'WITHDRAWAL').length, tone: 'var(--danger)' },
            { label: 'Online Merchants', value: merchants.filter((m) => m.isOnline).length, tone: 'var(--info)' },
          ]} />

          <div className="flex items-center gap-3 flex-wrap">
            <span className="text-sm text-gray-400">Filter:</span>
            {(['ALL', 'DEPOSIT', 'WITHDRAWAL'] as const).map((f) => (
              <button key={f} onClick={() => setFilterType(f)}
                className="px-3 py-1.5 rounded text-sm font-medium transition-colors"
                style={filterType === f ? { background: 'var(--warning-bg)', color: 'var(--warning)' } : { background: 'var(--surface-2)', color: 'var(--text-2)' }}>{f}</button>
            ))}
          </div>

          <div className="card">
            <h3 className="text-lg font-semibold mb-4">
              Pending Orders
              {loadError && <span className="text-red-400 text-sm ml-2">(load error — check backend)</span>}
            </h3>
            {filteredPending.length===0
              ? <div className="text-center py-10 text-gray-500"><Layers size={40} className="mx-auto mb-3 opacity-40"/><p>No pending orders</p></div>
              : <div className="space-y-3">{filteredPending.map(o => <OrderCard key={o._id} order={o}/>)}</div>}
          </div>

          <div className="card">
            <h3 className="text-lg font-semibold mb-4">Available Merchants ({merchants.length})</h3>
            {merchants.length===0
              ? <div className="text-center py-8 text-gray-500">
                  <Store size={40} className="mx-auto mb-3 opacity-40"/>
                  <p>No merchants available</p>
                  <button onClick={() => setTab('pool')} className="text-purple-400 text-sm underline mt-2">
                    Set up the Merchant Pool →
                  </button>
                </div>
              : <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {merchants.map(m => (
                    <div key={m._id} className="bg-dark-700 rounded-lg p-4 space-y-1.5">
                      <div className="flex items-center justify-between">
                        <h4 className="font-semibold">{m.name}</h4>
                        <span className={`w-2 h-2 rounded-full ${m.isOnline?'bg-green-500':'bg-gray-500'}`}/>
                      </div>
                      <p className="text-sm text-gray-400">{(m as any).mobile||'—'}</p>
                      <div className="text-xs text-gray-400 space-y-0.5">
                        <div className="flex justify-between"><span>Daily vol.</span><span>₹{(m.merchantStats?.dailyProcessed||0).toLocaleString()}</span></div>
                        <div className="flex justify-between"><span>Total orders</span><span>{m.merchantStats?.totalOrdersProcessed||0}</span></div>
                        <div className="flex justify-between"><span>Accepts</span>
                          <span>{[m.acceptsDeposits&&'Dep', m.acceptsWithdrawals&&'With'].filter(Boolean).join(', ')||'None'}</span>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>}
          </div>
        </>
      )}

      {/* ─── ALL ORDERS TAB ─── */}
      {tab==='all' && (
        <>
          <div className="flex items-center gap-2 flex-wrap">
            {[
              { key:'ALL',        label:'All',        count: groupedStats.total,      color:'text-white' },
              { key:'pending',    label:'Pending',    count: groupedStats.pending,    color:'text-yellow-400' },
              { key:'assigned',   label:'Assigned',   count: groupedStats.assigned,   color:'text-blue-400' },
              { key:'processing', label:'Processing', count: groupedStats.processing, color:'text-purple-400' },
              { key:'disputed',   label:'Disputed',   count: groupedStats.disputed,   color:'text-red-400' },
              { key:'completed',  label:'Completed',  count: groupedStats.completed,  color:'text-green-400' },
            ].map(s => (
              <button key={s.key} onClick={() => setAllStatusFilter(s.key)}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors
                  ${allStatusFilter===s.key ? 'bg-dark-700 ring-1 ring-white/20' : 'bg-dark-800 text-gray-400 hover:bg-dark-700'}`}>
                <span className={s.color}>{s.label}</span>
                <span className="bg-dark-600 text-xs px-1.5 py-0.5 rounded">{s.count||0}</span>
              </button>
            ))}
          </div>

          <div className="card">
            <h3 className="text-lg font-semibold mb-4">
              {allStatusFilter==='ALL' ? 'All Orders' : allStatusFilter.charAt(0).toUpperCase()+allStatusFilter.slice(1)+' Orders'}
              <span className="ml-2 text-sm text-gray-400">({allFlat.length})</span>
            </h3>
            {allFlat.length===0
              ? <div className="text-center py-10 text-gray-500"><List size={40} className="mx-auto mb-3 opacity-40"/><p>No orders found</p></div>
              : <div className="space-y-3">{allFlat.map(o => <OrderCard key={o._id||o.orderId} order={o} grouped/>)}</div>}
          </div>
        </>
      )}
      {/* ─── MERCHANT POOL TAB ─── */}
      {tab==='pool' && (
        <>
          <div className="card bg-purple-500/5 border border-purple-500/20">
            <p className="text-sm text-gray-300">
              These 3–5 merchants are the only ones eligible for <strong>manual or forced order assignment</strong>
              {' '}(the "Assign to merchant" dropdown and "Reassign" actions above). This keeps manual assignment
              separate from the automatic assignment algorithm, which scores and picks from the full merchant pool
              on its own. Changing this list does not affect automatic assignment at all.
            </p>
          </div>

          {poolLoading ? <LoadingSpinner size="lg" /> : (
            <>
              <div className="card">
                <h3 className="text-lg font-semibold mb-4">Current Pool ({poolMerchants.length}/5)</h3>
                {poolMerchants.length === 0
                  ? <div className="text-center py-6 text-gray-500">
                      <Users size={36} className="mx-auto mb-3 opacity-40"/>
                      <p>No pool configured yet. Select 3–5 merchants below and save.</p>
                    </div>
                  : <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                      {poolMerchants.map((m: any) => (
                        <div key={m._id} className="bg-dark-700 rounded-lg p-3 flex items-center justify-between">
                          <div>
                            <p className="font-medium">{m.name}</p>
                            <p className="text-xs text-gray-400">{m.mobile || '—'} · {(m.tokenBalance||0).toLocaleString()} BB</p>
                          </div>
                          <span className={`w-2 h-2 rounded-full flex-shrink-0 ${m.isOnline?'bg-green-500':'bg-gray-500'}`}/>
                        </div>
                      ))}
                    </div>}
              </div>

              <div className="card">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-lg font-semibold">
                    Select Pool Merchants
                    <span className="ml-2 text-sm text-gray-400">({selectedPoolIds.size}/5 selected, min 3)</span>
                  </h3>
                  <button
                    onClick={handleSavePool}
                    disabled={poolSaving || selectedPoolIds.size < 3 || selectedPoolIds.size > 5}
                    className="btn-primary flex items-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    {poolSaving ? <RefreshCw size={15} className="animate-spin"/> : <CheckCircle size={15}/>}
                    Save Pool
                  </button>
                </div>
                {eligibleMerchants.length === 0
                  ? <div className="text-center py-8 text-gray-500">
                      <Store size={40} className="mx-auto mb-3 opacity-40"/>
                      <p>No ACTIVE, approved merchants available to pool yet.</p>
                    </div>
                  : <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                      {eligibleMerchants.map((m: any) => {
                        const selected = selectedPoolIds.has(m._id);
                        return (
                          <button
                            key={m._id}
                            onClick={() => togglePoolSelection(m._id)}
                            className={`text-left rounded-lg p-3 border transition-colors ${
                              selected ? 'bg-purple-500/10 border-purple-500' : 'bg-dark-700 border-transparent hover:border-dark-500'
                            }`}
                          >
                            <div className="flex items-center justify-between">
                              <p className="font-medium">{m.name}</p>
                              <span className={`w-2 h-2 rounded-full flex-shrink-0 ${m.isOnline?'bg-green-500':'bg-gray-500'}`}/>
                            </div>
                            <p className="text-xs text-gray-400">{m.mobile || '—'} · {(m.tokenBalance||0).toLocaleString()} BB · {m.totalOrdersProcessed||0} orders</p>
                          </button>
                        );
                      })}
                    </div>}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
};
