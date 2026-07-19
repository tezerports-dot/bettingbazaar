import sseService from '../services/sse';
// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * Dashboard.tsx  v3.0.0
 *
 * FIX M4: Replace hardcoded Mon-Sat: { earnings: 0, orders: 0 } chart data
 * with real 7-day breakdown from GET /api/merchant/earnings/weekly.
 *
 * Before: Mon-Sat always showed Rs.0/0 orders. Only "Today" was real.
 * After:  Each of the last 7 days is populated from the DB aggregation
 *         added in Batch 1 (merchant.routes.js GET /earnings/weekly).
 *
 * wsService events updated to SSE names:
 *   'merchant_stats_update' -> same (kept)
 *   'order_update'          -> same (kept)
 */
import React, { useEffect, useState } from 'react';
import { useAuth } from '../services/AuthContext';
import { api } from '../services/api';
import { DollarSign, TrendingUp, Package, CheckCircle, Users, Activity } from 'lucide-react';
import toast from 'react-hot-toast';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import { Earnings, MerchantProfile, Stats } from '../types';

const Dashboard: React.FC = () => {
  const { merchant, refreshProfile } = useAuth();
  const [earnings, setEarnings]   = useState<Earnings | null>(null);
  const [stats, setStats]         = useState<Stats | null>(null);
  const [loading, setLoading]     = useState(true);
  const [chartData, setChartData] = useState<any[]>([]);
  const [dashboardMerchant, setDashboardMerchant] = useState<MerchantProfile | null>(merchant);
  // Token conversion is fixed 1:1 (Phase 006 flattening, 2026-07-08) — the
  // rates fetch/display was removed; there is no buy/sell spread anymore.

  useEffect(() => {
    setDashboardMerchant(merchant);
  }, [merchant]);

  useEffect(() => {
    loadDashboardData();

    const handleStatsUpdate = (delta: any) => {
      if (delta.pendingOrders !== undefined) {
        setStats(prev => prev ? { ...prev, pending: delta.pendingOrders } : prev);
      }
    };

    const handleOrderComplete = () => {
      api.getEarnings().then(r => { if (r.earnings) setEarnings(r.earnings); });
    };

    sseService.on('merchant_stats', handleStatsUpdate); // §11: backend emits 'merchant_stats' not 'merchant_stats_update'
    sseService.on('order_update', handleOrderComplete);

    return () => {
      sseService.off('merchant_stats', handleStatsUpdate);
      sseService.off('order_update', handleOrderComplete);
    };
  }, []);

  const loadDashboardData = async () => {
    try {
      const [earningsData, statsData, profileData, weeklyData] = await Promise.all([
        api.getEarnings(),
        api.getStats(),
        api.getMerchantProfile(),
        // FIX M4: fetch real 7-day data
        api.getWeeklyEarnings().catch(() => null),
      ]);

      setEarnings(earningsData.earnings);
      setStats(statsData);

      if (profileData) {
        setDashboardMerchant(profileData);
        localStorage.setItem('merchantData', JSON.stringify(profileData));
      }

      // FIX M4: use real weekly data if available; fall back to today-only
      if (weeklyData?.weekly) {
        setChartData(weeklyData.weekly.map((d: any) => ({
          day:      new Date(d.date).toLocaleDateString('en-IN', { weekday: 'short' }),
          earnings: d.earnings,
          orders:   d.orders,
        })));
      } else if (earningsData.earnings && statsData) {
        
        setChartData([
          { day: 'Day -6', earnings: 0, orders: 0 },
          { day: 'Day -5', earnings: 0, orders: 0 },
          { day: 'Day -4', earnings: 0, orders: 0 },
          { day: 'Day -3', earnings: 0, orders: 0 },
          { day: 'Day -2', earnings: 0, orders: 0 },
          { day: 'Yesterday', earnings: 0, orders: 0 },
          {
            day:      'Today',
            earnings: earningsData.earnings.today || 0,
            orders:   statsData.completedToday     || 0,
          },
        ]);
      }
    } catch (error) {
      console.error('Failed to load dashboard data:', error);
      toast.error('Failed to load dashboard data');
    } finally {
      setLoading(false);
    }
  };

  const handleToggleOnline = async () => {
    try {
      await api.toggleOnlineStatus(!merchant?.isOnline);
      await refreshProfile();
      toast.success(merchant?.isOnline ? 'Now offline' : 'Now online');
    } catch (error: any) {
      toast.error(error.message || 'Failed to update status');
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen">
        <div className="text-center">
          <div className="animate-spin rounded-full h-16 w-16 border-b-4 border-blue-600 mx-auto"></div>
          <p className="mt-4 text-gray-600">Loading dashboard...</p>
        </div>
      </div>
    );
  }

  const todayEarnings    = earnings?.today || 0;
  const totalEarnings    = earnings?.total || earnings?.lifetime?.totalEarnings || 0;
  const pendingOrders    = stats?.pending    || 0;
  const processingOrders = stats?.processing || 0;
  const completedToday   = stats?.completedToday || 0;

  const currentMerchant        = dashboardMerchant ?? merchant;
  const totalDepositsVolume    = earnings?.lifetime?.deposits?.totalAmount    ?? currentMerchant?.totalDepositsProcessed    ?? 0;
  const totalWithdrawalsVolume = earnings?.lifetime?.withdrawals?.totalAmount ?? currentMerchant?.totalWithdrawalsProcessed ?? 0;
  const totalVolume            = totalDepositsVolume + totalWithdrawalsVolume;
  const totalOrdersCount       = (earnings?.lifetime?.deposits?.count || 0) + (earnings?.lifetime?.withdrawals?.count || 0);
  const activeOrders           = pendingOrders + processingOrders;
  const successRate            = totalOrdersCount > 0
    ? (completedToday / (completedToday + activeOrders)) * 100
    : 0;
  const tokenBalance           = currentMerchant?.tokenBalance ?? 0;
  const minDepositLimit        = currentMerchant?.limits?.minDeposit ?? 0;
  const maxDepositLimit        = currentMerchant?.limits?.maxDeposit ?? 0;
  const minWithdrawLimit       = currentMerchant?.limits?.minWithdraw ?? 0;
  const maxWithdrawLimit       = currentMerchant?.limits?.maxWithdraw ?? 0;
  const walletCapacityPercent  = maxDepositLimit > 0 ? Math.min(100, Math.round((tokenBalance / maxDepositLimit) * 100)) : 0;
  const avgProfitPerOrder      = completedToday > 0 ? todayEarnings / completedToday : 0;

  return (
    <div className="space-y-6">
      {/* ERP Header */}
      <div className="overflow-hidden rounded-3xl bg-gradient-to-r from-slate-900 via-blue-950 to-indigo-950 p-6 text-white shadow-2xl">
        <div className="flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <p className="mb-3 inline-flex items-center rounded-full bg-white/10 px-3 py-1 text-xs font-bold uppercase tracking-widest text-blue-100">
              Merchant ERP Workspace
            </p>
            <h1 className="text-3xl font-black">Settlement Operations Center</h1>
            <p className="mt-2 max-w-3xl text-sm text-blue-100/80">
              Welcome back, {merchant?.username}. Manage queue capacity, wallet exposure, service readiness and earnings from one command surface.
            </p>
          </div>
          <button
            onClick={handleToggleOnline}
            className={`rounded-2xl px-6 py-4 text-left font-semibold shadow-xl transition-all hover:scale-[1.02] ${
              merchant?.isOnline
                ? 'bg-green-500 text-white hover:bg-green-400'
                : 'bg-slate-700 text-white hover:bg-slate-600'
            }`}
          >
            <span className="block text-xs uppercase tracking-widest opacity-80">Current availability</span>
            <span className="mt-1 block text-lg">{merchant?.isOnline ? 'Online · Accepting Orders' : 'Offline · Not Accepting'}</span>
          </button>
        </div>
      </div>

      <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-lg">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h2 className="text-lg font-bold text-gray-900">Order Limits & Wallet Capacity</h2>
            <p className="text-sm text-gray-500">Uses live merchant limits and wallet balance returned by the profile API.</p>
          </div>
          <span className="rounded-full bg-blue-50 px-3 py-1 text-sm font-bold text-blue-700">{walletCapacityPercent}% wallet cover</span>
        </div>
        <div className="h-3 overflow-hidden rounded-full bg-gray-100">
          <div className="h-full rounded-full bg-gradient-to-r from-blue-500 to-indigo-600" style={{ width: `${walletCapacityPercent}%` }} />
        </div>
        <div className="mt-4 grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
          <div className="rounded-xl bg-gray-50 p-3">
            <p className="text-gray-500">Min Deposit</p>
            <p className="font-bold text-gray-900">Rs.{minDepositLimit.toLocaleString('en-IN')}</p>
          </div>
          <div className="rounded-xl bg-gray-50 p-3">
            <p className="text-gray-500">Max Deposit</p>
            <p className="font-bold text-gray-900">Rs.{maxDepositLimit.toLocaleString('en-IN')}</p>
          </div>
          <div className="rounded-xl bg-gray-50 p-3">
            <p className="text-gray-500">Min Withdraw</p>
            <p className="font-bold text-gray-900">Rs.{minWithdrawLimit.toLocaleString('en-IN')}</p>
          </div>
          <div className="rounded-xl bg-gray-50 p-3">
            <p className="text-gray-500">Max Withdraw</p>
            <p className="font-bold text-gray-900">Rs.{maxWithdrawLimit.toLocaleString('en-IN')}</p>
          </div>
        </div>
      </div>

      {/* Primary Stats */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        <div className="bg-gradient-to-br from-green-50 to-green-100 p-6 rounded-lg shadow-lg hover:shadow-xl transition-shadow border border-green-200">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-green-700 font-medium">Today's Earnings</p>
              <p className="text-3xl font-bold text-green-900 mt-2">
                Rs.{todayEarnings.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
              </p>
              <p className="text-xs text-green-600 mt-1">{completedToday} orders completed</p>
            </div>
            <DollarSign className="h-14 w-14 text-green-500 opacity-80" />
          </div>
        </div>

        <div className="bg-gradient-to-br from-blue-50 to-blue-100 p-6 rounded-lg shadow-lg hover:shadow-xl transition-shadow border border-blue-200">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-blue-700 font-medium">Total Earnings</p>
              <p className="text-3xl font-bold text-blue-900 mt-2">
                Rs.{totalEarnings.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
              </p>
              <p className="text-xs text-blue-600 mt-1">Lifetime profit</p>
            </div>
            <TrendingUp className="h-14 w-14 text-blue-500 opacity-80" />
          </div>
        </div>

        <div className="bg-gradient-to-br from-yellow-50 to-yellow-100 p-6 rounded-lg shadow-lg hover:shadow-xl transition-shadow border border-yellow-200">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-yellow-700 font-medium">Pending Orders</p>
              <p className="text-3xl font-bold text-yellow-900 mt-2">{pendingOrders}</p>
              <p className="text-xs text-yellow-600 mt-1">{processingOrders} in processing</p>
            </div>
            <Package className="h-14 w-14 text-yellow-500 opacity-80" />
          </div>
        </div>

        <div className="bg-gradient-to-br from-purple-50 to-purple-100 p-6 rounded-lg shadow-lg hover:shadow-xl transition-shadow border border-purple-200">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-purple-700 font-medium">Completed Today</p>
              <p className="text-3xl font-bold text-purple-900 mt-2">{completedToday}</p>
              <p className="text-xs text-purple-600 mt-1">Success rate: {successRate.toFixed(1)}%</p>
            </div>
            <CheckCircle className="h-14 w-14 text-purple-500 opacity-80" />
          </div>
        </div>
      </div>

      {/* Token Conversion & Wallet — fixed 1:1, no spread */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="bg-gradient-to-br from-yellow-50 to-yellow-100 p-6 rounded-lg shadow-lg border border-yellow-200">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-yellow-700 font-medium">Token Conversion</p>
              <p className="text-3xl font-bold text-yellow-900 mt-2">1 : 1</p>
              <p className="text-xs text-yellow-600 mt-1">1 BB token = Rs.1 — fixed, no buy/sell spread</p>
            </div>
            <TrendingUp className="h-14 w-14 text-yellow-500 opacity-80" />
          </div>
        </div>

        <div className="bg-gradient-to-br from-emerald-50 to-emerald-100 p-6 rounded-lg shadow-lg border border-emerald-200">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-emerald-700 font-medium">Wallet Balance</p>
              <p className="text-3xl font-bold text-emerald-900 mt-2">
                Rs.{(currentMerchant?.tokenBalance ?? 0).toLocaleString()}
              </p>
              <p className="text-xs text-emerald-600 mt-1">Available token balance</p>
            </div>
            <Users className="h-14 w-14 text-emerald-500 opacity-80" />
          </div>
        </div>
      </div>

      {/* Secondary Stats */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
        <div className="bg-white p-6 rounded-lg shadow border border-gray-200">
          <div className="flex items-center space-x-3 mb-2">
            <Activity className="h-5 w-5 text-indigo-500" />
            <h3 className="text-sm font-semibold text-gray-700">Total Volume</h3>
          </div>
          <p className="text-2xl font-bold text-indigo-600">Rs.{totalVolume.toLocaleString('en-IN')}</p>
          <p className="text-xs text-gray-500 mt-1">All time processed</p>
        </div>

        <div className="bg-white p-6 rounded-lg shadow border border-gray-200">
          <div className="flex items-center space-x-3 mb-2">
            <TrendingUp className="h-5 w-5 text-green-500" />
            <h3 className="text-sm font-semibold text-gray-700">Deposits</h3>
          </div>
          <p className="text-2xl font-bold text-green-600">Rs.{totalDepositsVolume.toLocaleString('en-IN')}</p>
          <p className="text-xs text-gray-500 mt-1">{earnings?.lifetime?.deposits?.count || 0} orders</p>
        </div>

        <div className="bg-white p-6 rounded-lg shadow border border-gray-200">
          <div className="flex items-center space-x-3 mb-2">
            <TrendingUp className="h-5 w-5 text-red-500 transform rotate-180" />
            <h3 className="text-sm font-semibold text-gray-700">Withdrawals</h3>
          </div>
          <p className="text-2xl font-bold text-red-600">Rs.{totalWithdrawalsVolume.toLocaleString('en-IN')}</p>
          <p className="text-xs text-gray-500 mt-1">{earnings?.lifetime?.withdrawals?.count || 0} orders</p>
        </div>

        <div className="bg-white p-6 rounded-lg shadow border border-gray-200">
          <div className="flex items-center space-x-3 mb-2">
            <Users className="h-5 w-5 text-blue-500" />
            <h3 className="text-sm font-semibold text-gray-700">Merchant Rating</h3>
          </div>
          <p className="text-2xl font-bold text-blue-600">{merchant?.rating?.toFixed(1) || '0.0'} [star]</p>
          <p className="text-xs text-gray-500 mt-1">{totalOrdersCount} total orders</p>
        </div>
      </div>

      {/* Weekly Performance Chart -- REAL data (FIX M4) */}
      {chartData.length > 0 && (
        <div className="bg-white p-6 rounded-lg shadow border border-gray-200">
          <h3 className="text-lg font-semibold text-gray-900 mb-4">Weekly Performance</h3>
          <ResponsiveContainer width="100%" height={300}>
            <LineChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="day" />
              <YAxis yAxisId="left" />
              <YAxis yAxisId="right" orientation="right" />
              <Tooltip />
              <Legend />
              <Line yAxisId="left" type="monotone" dataKey="earnings" stroke="#10b981" name="Earnings (Rs.)" strokeWidth={2} />
              <Line yAxisId="right" type="monotone" dataKey="orders" stroke="#3b82f6" name="Orders" strokeWidth={2} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Account Status */}
      <div className="bg-white p-6 rounded-lg shadow border border-gray-200">
        <h2 className="text-xl font-semibold text-gray-900 mb-4">Account Status</h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div>
            <p className="text-sm text-gray-600">Status</p>
            <p className={`text-lg font-semibold ${merchant?.isOnline ? 'text-green-600' : 'text-gray-600'}`}>
              {merchant?.isOnline ? '[green] Online' : '[red] Offline'}
            </p>
          </div>
          <div>
            <p className="text-sm text-gray-600">Account Status</p>
            <p className="text-lg font-semibold text-gray-900">{merchant?.status || 'ACTIVE'}</p>
          </div>
          <div>
            <p className="text-sm text-gray-600">Accepting Deposits</p>
            <p className="text-lg font-semibold text-gray-900">
              {merchant?.acceptsDeposits !== false ? '[OK] Yes' : '[X] No'}
            </p>
          </div>
          <div>
            <p className="text-sm text-gray-600">Accepting Withdrawals</p>
            <p className="text-lg font-semibold text-gray-900">
              {merchant?.acceptsWithdrawals !== false ? '[OK] Yes' : '[X] No'}
            </p>
          </div>
        </div>
      </div>

      {/* Quick Stats */}
      <div className="bg-gradient-to-r from-blue-50 to-indigo-50 p-6 rounded-lg border border-blue-200">
        <h3 className="text-lg font-semibold text-gray-900 mb-3">Quick Stats</h3>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-center">
          <div>
            <p className="text-3xl font-bold text-blue-600">{pendingOrders + processingOrders}</p>
            <p className="text-sm text-gray-600 mt-1">Active Orders</p>
          </div>
          <div>
            <p className="text-3xl font-bold text-green-600">
              Rs.{avgProfitPerOrder.toFixed(0)}
            </p>
            <p className="text-sm text-gray-600 mt-1">Avg Profit/Order</p>
          </div>
          <div>
            <p className="text-3xl font-bold text-purple-600">{totalOrdersCount}</p>
            <p className="text-sm text-gray-600 mt-1">Total Orders</p>
          </div>
          <div>
            <p className="text-3xl font-bold text-orange-600">
              {merchant?.createdAt
                ? Math.floor((Date.now() - new Date(merchant.createdAt).getTime()) / (1000 * 60 * 60 * 24))
                : 0}
            </p>
            <p className="text-sm text-gray-600 mt-1">Days Active</p>
          </div>
        </div>
      </div>

      {/* Scoring Gauges — from merchant scoring algorithm (Section 4C) */}
      {/* Values read from merchant.successRate, avgResponseMinutes, disputeRate, activeOrderCount (GOVERNANCE §1) */}
      <div className="bg-white p-6 rounded-lg shadow border border-gray-200">
        <h3 className="text-lg font-semibold text-gray-900 mb-4">Merchant Performance Score</h3>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-6">
          {/* Success Rate */}
          <div className="text-center">
            <div className="relative w-20 h-20 mx-auto mb-2">
              <svg viewBox="0 0 36 36" className="w-20 h-20 -rotate-90">
                <circle cx="18" cy="18" r="15.9" fill="none" stroke="#e5e7eb" strokeWidth="3" />
                <circle
                  cx="18" cy="18" r="15.9" fill="none"
                  stroke="#16a34a" strokeWidth="3" strokeDasharray="100" strokeDashoffset="0"
                  style={{ strokeDashoffset: `${100 - ((merchant as any)?.successRate ?? 1) * 100}` }}
                  strokeLinecap="round"
                />
              </svg>
              <div className="absolute inset-0 flex items-center justify-center">
                <span className="text-sm font-bold text-gray-900">
                  {Math.round(((merchant as any)?.successRate ?? 1) * 100)}%
                </span>
              </div>
            </div>
            <p className="text-xs font-medium text-gray-700">Success Rate</p>
          </div>
          {/* Avg Response */}
          <div className="text-center">
            <div className="w-20 h-20 mx-auto mb-2 flex items-center justify-center bg-blue-50 rounded-full border-4 border-blue-200">
              <span className="text-lg font-bold text-blue-700">
                {((merchant as any)?.avgResponseMinutes ?? 2).toFixed(1)}m
              </span>
            </div>
            <p className="text-xs font-medium text-gray-700">Avg Response</p>
          </div>
          {/* Dispute Rate */}
          <div className="text-center">
            <div className="w-20 h-20 mx-auto mb-2 flex items-center justify-center bg-orange-50 rounded-full border-4 border-orange-200">
              <span className="text-lg font-bold text-orange-700">
                {Math.round(((merchant as any)?.disputeRate ?? 0) * 100)}%
              </span>
            </div>
            <p className="text-xs font-medium text-gray-700">Dispute Rate</p>
          </div>
          {/* Active Orders */}
          <div className="text-center">
            <div className="w-20 h-20 mx-auto mb-2 flex items-center justify-center bg-purple-50 rounded-full border-4 border-purple-200">
              <span className="text-lg font-bold text-purple-700">
                {(merchant as any)?.activeOrderCount ?? 0}/{(merchant as any)?.maxConcurrentOrders ?? 3}
              </span>
            </div>
            <p className="text-xs font-medium text-gray-700">Active / Max</p>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Dashboard;
