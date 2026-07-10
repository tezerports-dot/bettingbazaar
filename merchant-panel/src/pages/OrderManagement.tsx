import sseService from '../services/sse';
// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)

import React, { useEffect, useState } from 'react';
import { api } from '../services/api';
import { PaymentOrder } from '../types';
import OrderCard from '../components/OrderCard';
import CountdownTimer from '../components/CountdownTimer';
import toast from 'react-hot-toast';
import { RefreshCw, Filter, X, Copy, Clock, CheckCircle, AlertCircle } from 'lucide-react';

// ── OrderDetailPanel — NO chat, just the info merchant needs to act ────────────
interface OrderDetailPanelProps {
  order: PaymentOrder;
  onClose:          () => void;
  onConfirm:        (id: string) => void;
  onReject:         (id: string) => void;
  onRaiseDispute:   (id: string) => void;
  onMarkPayoutSent: (id: string) => void;
}

const copy = (text: string, label: string) => {
  navigator.clipboard.writeText(text).catch(() => {});
  toast.success(`${label} copied`);
};

const Row: React.FC<{ label: string; value: string; mono?: boolean; copyable?: boolean }> = ({ label, value, mono, copyable }) => (
  <div className="flex justify-between items-center py-2 border-b border-gray-100 last:border-0">
    <span className="text-xs text-gray-500 w-36 shrink-0">{label}</span>
    <div className="flex items-center gap-1.5">
      <span className={`text-sm font-medium text-gray-900 text-right ${mono ? 'font-mono' : ''}`}>{value || '—'}</span>
      {copyable && value && value !== '—' && (
        <button onClick={() => copy(value, label)} className="text-gray-300 hover:text-blue-500 ml-1">
          <Copy size={11} />
        </button>
      )}
    </div>
  </div>
);

const OrderDetailPanel: React.FC<OrderDetailPanelProps> = ({
  order, onClose, onConfirm, onReject, onRaiseDispute, onMarkPayoutSent,
}) => {
  const orderId   = order._id || order.id;
  const isDeposit = order.type === 'DEPOSIT';
  const snap      = (order as any).merchantSnapshot;
  const bank      = (order as any).userBankDetails;
  const kyc       = (order as any).userKycSnapshot;
  const profit    = (order as any).merchantProfit || 0;
  const userName  = typeof order.userId === 'object'
    ? (order.userId as any).username
    : (order as any).user?.username || '—';
  const userPhone = (order as any).userPhone
    || (typeof order.userId === 'object' ? (order.userId as any).mobile : null) || '—';

  const statusBg: Record<string, string> = {
    ASSIGNED:   'bg-blue-100 text-blue-700',
    PROCESSING: 'bg-yellow-100 text-yellow-700',
    PAID:       'bg-green-100 text-green-700',
    COMPLETED:  'bg-green-200 text-green-800',
    DISPUTED:   'bg-orange-100 text-orange-700',
    CANCELLED:  'bg-gray-100 text-gray-500',
  };

  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md max-h-[92vh] overflow-y-auto"
        onClick={e => e.stopPropagation()}>

        {/* ── Header ── */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100 sticky top-0 bg-white rounded-t-2xl z-10">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-bold text-gray-900">
              {isDeposit ? '⬇️ Deposit' : '⬆️ Withdrawal'}
            </span>
            <span className="text-xs text-gray-400 font-mono">
              #{order.shortId || (order.orderId || '').slice(-8)}
            </span>
            <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${statusBg[order.status] || 'bg-gray-100 text-gray-500'}`}>
              {order.status}
            </span>
          </div>
          <button onClick={onClose} className="p-1.5 hover:bg-gray-100 rounded-full shrink-0">
            <X size={16} className="text-gray-500" />
          </button>
        </div>

        <div className="px-5 py-4 space-y-5">

          {/* ── Timer ── */}
          {(order as any).expiresAt && ['ASSIGNED','PROCESSING','PAID'].includes(order.status) && (
            <div className="flex items-center justify-between bg-amber-50 border border-amber-200 rounded-xl px-4 py-2.5">
              <span className="text-xs text-amber-700 font-medium">⏱ Time remaining</span>
              <CountdownTimer expiresAt={(order as any).expiresAt} />
            </div>
          )}

          {/* ── Amounts ── */}
          <div className="grid grid-cols-2 gap-3">
            <div className="bg-gray-50 rounded-xl p-3 text-center">
              <p className="text-xs text-gray-400 mb-0.5">{isDeposit ? 'User pays you' : 'You send to user'}</p>
              <p className="text-2xl font-bold text-gray-900">
                ₹{(order.fiatAmount || (order as any).amount || 0).toLocaleString('en-IN')}
              </p>
            </div>
            <div className="bg-gray-50 rounded-xl p-3 text-center">
              <p className="text-xs text-gray-400 mb-0.5">Tokens</p>
              <p className="text-2xl font-bold text-gray-900">{(order.tokenAmount || 0).toLocaleString()}</p>
              {isDeposit && profit > 0 && (
                <p className="text-xs text-green-600 mt-0.5 font-medium">+₹{profit.toFixed(2)} profit</p>
              )}
            </div>
          </div>

          {/* ── User info ── */}
          <div>
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">User</p>
            <div className="bg-gray-50 rounded-xl px-4 py-1">
              <Row label="Name"   value={kyc?.name || userName} />
              <Row label="Mobile" value={userPhone} mono copyable />
              {kyc?.pan && <Row label="PAN" value={kyc.pan} mono />}
            </div>
          </div>

          {/* ── Payment details ── */}
          {isDeposit ? (
            snap?.upiId ? (
              <div>
                <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">Your UPI — user pays here</p>
                <div className="bg-blue-50 rounded-xl px-4 py-1 border border-blue-100">
                  <Row label="UPI ID"      value={snap.upiId}             mono copyable />
                  <Row label="Merchant"    value={snap.merchantName || '—'} />
                </div>
              </div>
            ) : null
          ) : (
            <div>
              <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">Send money to user</p>
              <div className="bg-green-50 rounded-xl px-4 py-1 border border-green-100">
                <Row label="Account holder" value={bank?.accountHolderName || kyc?.name || '—'} />
                <Row label="Account no."    value={bank?.accountNumber || '—'}  mono copyable />
                <Row label="IFSC"           value={bank?.ifscCode || '—'}        mono copyable />
                <Row label="Bank"           value={bank?.bankName || '—'} />
                {(order as any).upiId && (
                  <Row label="UPI ID" value={(order as any).upiId} mono copyable />
                )}
              </div>
            </div>
          )}

          {/* ── UTR + proof ── */}
          {order.utrNumber && (
            <div>
              <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">Payment proof</p>
              <div className="bg-gray-50 rounded-xl px-4 py-1 mb-2">
                <Row label="UTR / Ref no." value={order.utrNumber} mono copyable />
              </div>
              {order.proofScreenshot && (
                <>
                  <a href={order.proofScreenshot} target="_blank" rel="noreferrer">
                    <img src={order.proofScreenshot} alt="Payment proof"
                      className="w-full max-h-52 object-contain rounded-xl border border-gray-200 hover:opacity-90 cursor-zoom-in" />
                  </a>
                  <p className="text-xs text-gray-400 text-center mt-1">Click to open full size</p>
                </>
              )}
            </div>
          )}

          {/* ── Dispute info ── */}
          {order.status === 'DISPUTED' && (order as any).disputeReason && (
            <div className="bg-orange-50 border border-orange-200 rounded-xl px-4 py-3">
              <p className="text-xs font-semibold text-orange-600 mb-1">Under Admin Review</p>
              <p className="text-sm text-orange-800">"{(order as any).disputeReason}"</p>
            </div>
          )}

          {/* ── Actions ── */}
          {order.status === 'PAID' && isDeposit && (
            <div className="flex gap-2">
              <button onClick={() => { onConfirm(orderId); onClose(); }}
                className="flex-1 bg-green-600 hover:bg-green-700 text-white font-bold py-3 rounded-xl text-sm">
                ✅ Confirm — Release Tokens
              </button>
              <button onClick={() => { onRaiseDispute(orderId); onClose(); }}
                className="bg-orange-100 hover:bg-orange-200 text-orange-700 font-bold py-3 px-4 rounded-xl text-sm border border-orange-200"
                title="Raise dispute">⚠️</button>
            </div>
          )}
          {order.status === 'PROCESSING' && !isDeposit && (
            <button onClick={() => { onMarkPayoutSent(orderId); onClose(); }}
              className="w-full bg-green-600 hover:bg-green-700 text-white font-bold py-3 rounded-xl text-sm">
              💸 I've Sent the Money — Confirm Payout
            </button>
          )}
          {order.status === 'ASSIGNED' && (
            <div className="flex gap-2">
              <button onClick={() => { onConfirm(orderId); onClose(); }}
                className="flex-1 bg-blue-600 hover:bg-blue-700 text-white font-bold py-3 rounded-xl text-sm">
                ✅ Accept
              </button>
              <button onClick={() => { onReject(orderId); onClose(); }}
                className="flex-1 bg-red-50 hover:bg-red-100 text-red-600 font-bold py-3 rounded-xl text-sm border border-red-200">
                ✕ Reject
              </button>
            </div>
          )}

        </div>
      </div>
    </div>
  );
};

const OrderManagement: React.FC = () => {
  const [orders, setOrders] = useState<PaymentOrder[]>([]);
  const [filteredOrders, setFilteredOrders] = useState<PaymentOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedOrder, setSelectedOrder] = useState<PaymentOrder | null>(null);
  const [showChat, setShowChat] = useState(false);
  const [filterStatus, setFilterStatus] = useState<string>('ALL');
  const [filterType, setFilterType] = useState<string>('ALL');

  useEffect(() => {
    loadOrders(); // HTTP seed -- SSE snapshot will also arrive on connect

    // SSE snapshot replaces the full order list on connect
    const handleSnapshot = (data: { orders: PaymentOrder[] }) => {
      if (Array.isArray(data?.orders)) {
        setOrders(data.orders);
        setLoading(false);
      }
    };

    // Incremental order update (status change)
    const handleOrderUpdate = (updatedOrder: PaymentOrder) => {
      setOrders(prev => {
        const exists = prev.find(o => o._id === updatedOrder._id || o.id === updatedOrder._id);
        if (exists) {
          return prev.map(o =>
            (o._id === updatedOrder._id || o.id === updatedOrder._id)
              ? { ...o, ...updatedOrder }
              : o
          );
        }
        return [updatedOrder, ...prev];
      });
    };

    // New order assigned to this merchant (SSE snake_case event)
    const handleNewOrderSSE = (payload: any) => {
      // Backend sends partial payload on SSE -- trigger a targeted reload
      loadOrders();
      toast.success(`[NEW] New ${payload.type || ''} order: Rs.${payload.fiatAmount || ''}`);
    };

    
    sseService.on('merchant_orders_snapshot', handleSnapshot);
    sseService.on('order_update',             handleOrderUpdate);
    sseService.on('new_order',                handleNewOrderSSE);
    // §11: 'newOrder' removed — backend emits 'new_order' only (H-02 fix applied)

    return () => {
      sseService.off('merchant_orders_snapshot', handleSnapshot);
      sseService.off('order_update',             handleOrderUpdate);
      sseService.off('new_order',                handleNewOrderSSE);
      // §11: 'newOrder' removed
    };
  }, []);

  useEffect(() => {
    applyFilters();
  }, [orders, filterStatus, filterType]);

  const loadOrders = async () => {
    try {
      const data = await api.getOrders({ limit: 100 });
      setOrders(data.orders);
    } catch (error) {
      console.error('Failed to load orders:', error);
      toast.error('Failed to load orders');
    } finally {
      setLoading(false);
    }
  };

  const applyFilters = () => {
    let filtered = [...orders];
    if (filterStatus !== 'ALL') {
      filtered = filtered.filter(order => order.status === filterStatus);
    }
    if (filterType !== 'ALL') {
      filtered = filtered.filter(order => order.type === filterType);
    }
    filtered.sort((a, b) =>
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
    setFilteredOrders(filtered);
  };

  const handleAcceptOrder = async (orderId: string) => {
    try {
      await api.acceptOrder(orderId);
      toast.success('Order accepted successfully');
      await loadOrders();
    } catch (error: any) {
      toast.error(error.message || 'Failed to accept order');
    }
  };

  const handleRejectOrder = async (orderId: string) => {
    const reason = prompt('Please enter rejection reason:');
    if (!reason) return;
    try {
      await api.rejectOrder(orderId, reason);
      toast.success('Order rejected');
      await loadOrders();
    } catch (error: any) {
      toast.error(error.message || 'Failed to reject order');
    }
  };

  const handleViewDetails = (order: PaymentOrder) => {
    setSelectedOrder(order);
    setShowChat(true);
  };

  const handleConfirmPayment = async (orderId: string) => {
    // GOVERNANCE §10: toast used instead of window.confirm — per spec Section 8
    try {
      await api.confirmPayment(orderId);
      toast.success('✅ Payment confirmed — tokens released to user Deposit Balance');
      await loadOrders();
      setShowChat(false);
    } catch (error: any) {
      toast.error(error.message || 'Failed to confirm payment');
    }
  };

  // Called from OrderCard "Payment NOT Received" button — merchant raises dispute
  const handleRejectPayment = async (orderId: string) => {
    // Per spec: merchant raises dispute via POST /merchant/order/:id/dispute
    const reason = 'Payment not received in my UPI/bank account';
    try {
      await api.raiseDispute(orderId, reason);
      toast.success('Dispute raised — admin will review');
      await loadOrders();
    } catch (error: any) {
      toast.error(error.message || 'Failed to raise dispute');
    }
  };

  // Called from OrderCard "I've Sent the Money" on WITHDRAWAL PROCESSING orders
  // Per spec Section 2C: merchant confirm = auto-complete, no user confirmation step.
  const handleMarkPayoutSent = async (orderId: string) => {
    try {
      await api.confirmPayment(orderId);
      toast.success('✅ Payout confirmed — order completed. Tokens debited from user automatically.');
      await loadOrders();
    } catch (error: any) {
      toast.error(error.message || 'Failed to confirm payout');
    }
  };

  const handleRaiseDispute = async (orderId: string) => {
    const reason = 'Cannot process this order — raising dispute for admin review';
    try {
      await api.raiseDispute(orderId, reason);
      toast.success('Dispute raised — admin will review');
      await loadOrders();
    } catch (error: any) {
      toast.error(error.message || 'Failed to raise dispute');
    }
  };

  const stats = {
    assigned:   orders.filter(o => o.status === 'ASSIGNED').length,
    processing: orders.filter(o => o.status === 'PROCESSING').length,
    paid:       orders.filter(o => o.status === 'PAID').length,
    disputed:   orders.filter(o => o.status === 'DISPUTED').length,
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen">
        <div className="text-center">
          <div className="animate-spin rounded-full h-16 w-16 border-b-4 border-blue-600 mx-auto"></div>
          <p className="mt-4 text-gray-600">Loading orders from database...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Order Management</h1>
          <p className="text-gray-600 mt-1">Live updates via SSE . {orders.length} total orders</p>
        </div>
        <button
          onClick={loadOrders}
          className="flex items-center space-x-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
        >
          <RefreshCw className="h-4 w-4" />
          <span>Refresh</span>
        </button>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="bg-blue-50 p-4 rounded-lg border border-blue-200">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-blue-700 font-medium">Assigned</p>
              <p className="text-3xl font-bold text-blue-900">{stats.assigned}</p>
            </div>
            <Clock className="h-10 w-10 text-blue-500 opacity-70" />
          </div>
          <p className="text-xs text-blue-600 mt-2">Waiting for action</p>
        </div>

        <div className="bg-yellow-50 p-4 rounded-lg border border-yellow-200">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-yellow-700 font-medium">Processing</p>
              <p className="text-3xl font-bold text-yellow-900">{stats.processing}</p>
            </div>
            <RefreshCw className="h-10 w-10 text-yellow-500 opacity-70" />
          </div>
          <p className="text-xs text-yellow-600 mt-2">In progress</p>
        </div>

        <div className="bg-green-50 p-4 rounded-lg border border-green-200">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-green-700 font-medium">Paid</p>
              <p className="text-3xl font-bold text-green-900">{stats.paid}</p>
            </div>
            <CheckCircle className="h-10 w-10 text-green-500 opacity-70" />
          </div>
          <p className="text-xs text-green-600 mt-2">Awaiting completion</p>
        </div>

        <div className="bg-orange-50 p-4 rounded-lg border border-orange-200">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-orange-700 font-medium">Disputed</p>
              <p className="text-3xl font-bold text-orange-900">{stats.disputed}</p>
            </div>
            <AlertCircle className="h-10 w-10 text-orange-500 opacity-70" />
          </div>
          <p className="text-xs text-orange-600 mt-2">Under mediation</p>
        </div>
      </div>

      {/* Filters */}
      <div className="bg-white p-4 rounded-lg shadow border border-gray-200">
        <div className="flex items-center space-x-4 flex-wrap gap-y-2">
          <Filter className="h-5 w-5 text-gray-600" />
          <span className="text-sm font-medium text-gray-700">Filters:</span>
          <select
            value={filterStatus}
            onChange={(e) => setFilterStatus(e.target.value)}
            className="px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
          >
            <option value="ALL">All Status</option>
            <option value="ASSIGNED">Assigned</option>
            <option value="PROCESSING">Processing</option>
            <option value="PAID">Paid</option>
            <option value="COMPLETED">Completed</option>
            <option value="DISPUTED">Disputed</option>
          </select>
          <select
            value={filterType}
            onChange={(e) => setFilterType(e.target.value)}
            className="px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
          >
            <option value="ALL">All Types</option>
            <option value="DEPOSIT">Deposits</option>
            <option value="WITHDRAWAL">Withdrawals</option>
          </select>
          <span className="text-sm text-gray-600">
            Showing {filteredOrders.length} of {orders.length} orders
          </span>
        </div>
      </div>

      {/* Orders Grid */}
      {filteredOrders.length === 0 ? (
        <div className="bg-white rounded-lg shadow p-12 text-center border border-gray-200">
          <p className="text-gray-500 text-lg">No orders found</p>
          <p className="text-gray-400 text-sm mt-2">Orders will appear here when assigned to you</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {filteredOrders.map((order) => (
            <OrderCard
              key={order.id || order._id}
              order={order}
              onAccept={handleAcceptOrder}
              onReject={handleRejectOrder}
              onViewDetails={handleViewDetails}
              onConfirm={handleConfirmPayment}
              onRejectPayment={handleRejectPayment}
              onMarkPayoutSent={handleMarkPayoutSent}
              onRaiseDispute={handleRaiseDispute}
            />
          ))}
        </div>
      )}

      {/* Order Detail + Chat Modal */}
      {showChat && selectedOrder && (
        <OrderDetailPanel
          order={selectedOrder}
          onClose={() => { setShowChat(false); setSelectedOrder(null); }}
          onConfirm={handleConfirmPayment}
          onReject={handleRejectOrder}
          onRaiseDispute={handleRaiseDispute}
          onMarkPayoutSent={handleMarkPayoutSent}
        />
      )}

      {/* FIX3-PAID-CONFIRM: floating confirm button for any PAID order — always visible */}
      {orders.filter(o => o.status === 'PAID').map(o => (
        <div key={o.id || o._id} className="fixed bottom-4 right-4 bg-white rounded-lg shadow-xl p-4 border-2 border-green-500 z-50" style={{pointerEvents:"auto"}}>
          <p className="text-sm font-medium text-gray-900 mb-1">💰 Payment received!</p>
          <p className="text-xs text-gray-500 mb-2">{o.shortId || o.orderId}</p>
          <div className="flex gap-2">
            <button
              onClick={() => handleViewDetails(o)}
              className="flex-1 px-3 py-2 bg-blue-100 text-blue-700 rounded-lg text-sm font-medium hover:bg-blue-200"
            >
              View Chat
            </button>
            <button
              onClick={() => handleConfirmPayment(o.id || o._id || '')}
              className="flex-1 px-3 py-2 bg-green-600 text-white rounded-lg text-sm font-bold hover:bg-green-700"
            >
              ✓ Complete
            </button>
          </div>
        </div>
      ))[0] /* show topmost PAID order */}
    </div>
  );
};

export default OrderManagement;
