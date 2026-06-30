import sseService from '../services/sse';
// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)

import React, { useEffect, useState } from 'react';
import { api } from '../services/api';
import { PaymentOrder } from '../types';
import OrderCard from '../components/OrderCard';
import toast from 'react-hot-toast';
import { RefreshCw, Filter, CheckCircle, Clock, AlertCircle } from 'lucide-react';

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

    
    const handleNewOrderLegacy = (order: PaymentOrder) => {
      setOrders(prev => {
        const exists = prev.find(o => o._id === order._id);
        return exists ? prev : [order, ...prev];
      });
      toast.success(`New ${order.type} order: Rs.${order.fiatAmount}`);
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

      {}
      {showChat && selectedOrder && (
        {}
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
