// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * QueueDashboard.tsx — the live payment order queue.
 *
 * Pending Queue tab: GET /api/admin/queue/pending-orders (live over SSE)
 * All Orders tab:    GET /api/admin/payment-queue (every status, grouped)
 *
 * Nobody hand-picks a merchant. Every order is ROUTED to a member of a working
 * team on the order's own rail (database/repositories/teamRouting.js), and the
 * queue manager's two controls ask routing to act now instead of waiting for
 * the sweep:
 *
 *   Offer to teams now — POST /api/admin/queue/assign/:orderId, no body, on a
 *                        PENDING_QUEUE order. 409 NO_MEMBER_FREE carries a
 *                        sentence naming why nobody could take it.
 *   Reassign           — POST /api/admin/payment-orders/:id/reassign, no body,
 *                        on an ASSIGNED order. Takes it off its member and
 *                        offers it to the next; the answer says whether
 *                        anybody took it.
 *
 * The merchant picker, the "available merchants" list and the merchant pool
 * were removed with the routes behind them: none of them decide anything now.
 */
import sseService from '../../services/sse';
import React, { useEffect, useState, useCallback } from 'react';
import { Layers, Clock, RefreshCw, List, Send, Repeat } from 'lucide-react';
import { LoadingSpinner } from '../../components/LoadingSpinner';
import { Kpis, Toolbar } from '../../components/design';
import api from '../../services/api';
import { usePermissions } from '../../hooks/usePermission';
import type { PaymentOrder } from '../../types';
import toast from 'react-hot-toast';

type Tab = 'pending' | 'all';

/**
 * The rail an order runs on, from its own row.
 * §5 MIRROR of `railOf` in database/repositories/orderRails.js — a USDT order
 * is the USDT rail; an INR order stamped CASH_ATM is CASH; every other INR
 * order is UPI_BANK. Display only: the server decides routing from the row.
 */
function orderRail(order: PaymentOrder): 'CASH' | 'UPI_BANK' | 'USDT' {
  if (String(order.currency ?? 'INR').toUpperCase() === 'USDT') return 'USDT';
  return order.paymentMode === 'CASH_ATM' ? 'CASH' : 'UPI_BANK';
}
const RAIL_LABEL: Record<ReturnType<typeof orderRail>, string> = {
  CASH: 'Cash (ATM)', UPI_BANK: 'UPI / bank', USDT: 'USDT',
};

export const QueueDashboard: React.FC = () => {
  // Approve / Reject / Cancel decide an order's money, which is the disputes
  // area (canResolveDisputes) — a queue manager ROUTES. They were offered to
  // every viewer and refused on press for the queue manager this screen is for
  // (measured: the cross-area sweep of every admin screen).
  const { can } = usePermissions();
  const canDecide = can('canResolveDisputes');
  const [tab, setTab]                           = useState<Tab>('pending');
  const [pendingOrders, setPendingOrders]       = useState<PaymentOrder[]>([]);
  const [groupedOrders, setGroupedOrders]       = useState<Record<string, PaymentOrder[]>>({});
  const [groupedStats, setGroupedStats]         = useState<Record<string, number>>({});
  const [isLoading, setIsLoading]               = useState(true);
  const [filterType, setFilterType]             = useState<'ALL'|'DEPOSIT'|'WITHDRAWAL'>('ALL');
  const [allStatusFilter, setAllStatusFilter]   = useState('ALL');
  const [routingId, setRoutingId]               = useState<string|null>(null);
  const [loadError, setLoadError]               = useState(false);

  const loadPending = useCallback(async () => {
    const res = await api.queueManager.getPendingOrders();
    if (res.success && res.data) setPendingOrders(res.data);
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
    const onNew    = (o: PaymentOrder) => setPendingOrders(p => [o, ...p]);
    // `queue_order_update` carries `{ orderId, status }` — no `_id` — so the
    // match is on the order id. Matching on `_id` compared undefined with
    // undefined and the pending list never moved on an update.
    const onUpdate = (u: PaymentOrder) => {
      const key = u.orderId ?? u._id;
      const same = (o: PaymentOrder) => (o.orderId ?? o._id) === key;
      setPendingOrders(p =>
        u.status && u.status !== 'PENDING_QUEUE'
          ? p.filter(o => !same(o))
          : p.map(o => same(o) ? { ...o, ...u } : o)
      );
      loadGrouped();
    };
    sseService.on('new_order',          onNew);
    sseService.on('queue_order_update', onUpdate);
    return () => { sseService.off('new_order', onNew); sseService.off('queue_order_update', onUpdate); };
  }, [loadData, loadGrouped]);

  /**
   * Ask routing to act on this order now. A PENDING_QUEUE order is offered to
   * the teams; an ASSIGNED one is taken off its member and offered to the next.
   * The server's own sentence is shown either way, because it is the only thing
   * that says WHY nobody took it — a cap, a team not ready, a pool short of
   * tokens — and so whether to wait or to call a supervisor.
   */
  const handleRoute = async (order: PaymentOrder) => {
    const id = order._id || order.orderId;
    setRoutingId(id);
    try {
      const res = order.status === 'ASSIGNED'
        ? await api.queueManager.reassignOrder(id)
        : await api.queueManager.assignOrder(id);
      if (res.success) { toast.success(res.message || 'Order assigned'); await loadData(); }
      else toast.error(res.message || 'Assignment failed');
    } catch (e: any) {
      const data = e?.response?.data;
      toast.error(data?.message || 'Failed to assign');
      // NO_MEMBER_FREE leaves the order queued, which is a state worth
      // re-reading: the sweep may have moved it in the meantime.
      if (data?.code === 'NO_MEMBER_FREE') await loadData();
    }
    finally { setRoutingId(null); }
  };

  const handleOrderAction = async (orderId: string, action: 'APPROVE'|'REJECT'|'CANCEL') => {
    const reason = prompt(`Enter reason for ${action}:`);
    if (!reason) return;
    try {
      let res: any;
      if (action === 'APPROVE') res = await api.orderActions.approve(orderId, reason!);
      else if (action === 'REJECT') res = await api.orderActions.reject(orderId, reason!);
      else res = await api.orderActions.cancel(orderId, reason!);
      if (res.success) {
        toast.success(`Order ${action}D`);
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
    return <span className={`px-2 py-0.5 rounded-sm text-xs font-medium ${m[s]||m.PENDING_QUEUE}`}>{s.replace(/_/g,' ')}</span>;
  };
  const tBadge = (t: string) => (
    <span className={`px-2 py-0.5 rounded-sm text-xs font-medium ${t==='DEPOSIT'?'bg-green-500/20 text-green-400':'bg-red-500/20 text-red-400'}`}>{t}</span>
  );

  const filteredPending = pendingOrders.filter(o => filterType==='ALL' || o.type===filterType);
  const allFlat: PaymentOrder[] = Object.entries(groupedOrders)
    .filter(([s]) => allStatusFilter==='ALL' || s.toLowerCase()===allStatusFilter.toLowerCase())
    .flatMap(([,os]) => os)
    .sort((a,b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  // A render FUNCTION, not a component declared in this one: a nested
  // component is a new type on every render and React remounts it (§32 S23).
  const renderOrderCard = (order: PaymentOrder) => {
    const id = order._id || order.orderId;
    const rail = orderRail(order);
    // On a USDT order the fiat column is in USDT (trap 15) — never "₹".
    const fiat = rail === 'USDT'
      ? `${(order.fiatAmount||0).toLocaleString()} USDT`
      : `₹${(order.fiatAmount||0).toLocaleString()}`;
    const canOffer    = order.status === 'PENDING_QUEUE';
    const canReassign = order.status === 'ASSIGNED';
    const busy = routingId === id;
    return (
      <div key={id} className="bg-dark-700 rounded-lg p-4 space-y-3">
        <div className="flex flex-wrap items-center gap-2 mb-1">
          {tBadge(order.type)}{sBadge(order.status)}
          <span className="text-xs text-gray-500 font-mono">{order.orderId}</span>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-x-6 gap-y-1 text-sm">
          <div><p className="text-gray-400 text-xs">User</p><p className="font-medium">{(order as any).userName||'—'}</p></div>
          <div><p className="text-gray-400 text-xs">Tokens</p><p className="font-medium text-yellow-400">{(order.tokenAmount||0).toLocaleString()} BB</p></div>
          <div><p className="text-gray-400 text-xs">Fiat</p><p className="font-medium">{fiat}</p></div>
          <div><p className="text-gray-400 text-xs">Rail</p><p className="font-medium">{RAIL_LABEL[rail]}</p></div>
        </div>
        <div className="flex items-center text-xs text-gray-500 gap-1">
          <Clock size={11}/>{new Date(order.createdAt).toLocaleString()}
        </div>
        {(canOffer || canReassign) && (
          <div className="flex items-center gap-2">
            <button
              onClick={() => handleRoute(order)}
              disabled={busy}
              className="btn-secondary flex items-center gap-1.5 text-sm disabled:opacity-50"
              title={canOffer
                ? 'Offer this order to a member of a working team on its rail now'
                : 'Take this order off its member and offer it to the next one'}
            >
              {canOffer ? <Send size={14}/> : <Repeat size={14}/>}
              {canOffer ? 'Offer to teams now' : 'Reassign'}
            </button>
            {busy && <RefreshCw className="animate-spin text-yellow-400 shrink-0" size={18}/>}
          </div>
        )}
        {/* Decisions on the order's money — the disputes area only */}
        {canDecide && <div className="flex flex-wrap gap-1.5 pt-2 border-t border-dark-600 mt-2">
          <button
            onClick={() => handleOrderAction(id, 'APPROVE')}
            className="px-3 py-1.5 bg-green-600 hover:bg-green-500 text-white text-xs font-bold rounded-sm transition-colors"
            title="Force-complete this order and credit the user"
          >✅ Approve</button>
          <button
            onClick={() => handleOrderAction(id, 'REJECT')}
            className="px-3 py-1.5 bg-red-700 hover:bg-red-600 text-white text-xs font-bold rounded-sm transition-colors"
            title="Reject and cancel this order"
          >❌ Reject</button>
          <button
            onClick={() => handleOrderAction(id, 'CANCEL')}
            className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-white text-xs font-bold rounded-sm transition-colors"
            title="Cancel this order"
          >🚫 Cancel</button>
        </div>}
      </div>
    );
  };

  if (isLoading) return <LoadingSpinner size="lg" />;

  const TAB_CFG = [
    { id: 'pending' as Tab, label: 'Pending Queue', count: pendingOrders.length },
    { id: 'all'     as Tab, label: 'All Orders',    count: groupedStats.total   },
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
          ]} />

          <div className="flex items-center gap-3 flex-wrap">
            <span className="text-sm text-gray-400">Filter:</span>
            {(['ALL', 'DEPOSIT', 'WITHDRAWAL'] as const).map((f) => (
              <button key={f} onClick={() => setFilterType(f)} aria-pressed={filterType === f}
                className="px-3 py-1.5 rounded-sm text-sm font-medium transition-colors"
                style={filterType === f ? { background: 'var(--warning-bg)', color: 'var(--warning)' } : { background: 'var(--surface-2)', color: 'var(--text-2)' }}>{f}</button>
            ))}
          </div>

          <div className="card">
            <h3 className="text-lg font-semibold mb-1">
              Pending Orders
              {loadError && <span className="text-red-400 text-sm ml-2">(load error — check backend)</span>}
            </h3>
            <p className="text-xs text-gray-500 mb-4">
              Each order is offered automatically to a member of a working team on its rail. An order
              still here means nobody could take it yet — a team at its cap, not ready, or a pool short
              of tokens. Teams and pools are on the Supervisors &amp; Teams screen.
            </p>
            {filteredPending.length===0
              ? <div className="text-center py-10 text-gray-500"><Layers size={40} className="mx-auto mb-3 opacity-40"/><p>No pending orders</p></div>
              : <div className="space-y-3">{filteredPending.map(o => renderOrderCard(o))}</div>}
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
                <span className="bg-dark-600 text-xs px-1.5 py-0.5 rounded-sm">{s.count||0}</span>
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
              : <div className="space-y-3">{allFlat.map(o => renderOrderCard(o))}</div>}
          </div>
        </>
      )}
    </div>
  );
};
