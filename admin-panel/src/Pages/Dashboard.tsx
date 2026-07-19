// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
import React, { useEffect, useState } from 'react';
import { Users, Store, DollarSign, Activity, TrendingUp, Layers } from 'lucide-react';
import { StatCard } from '../components/StatCard';
import { LoadingSpinner } from '../components/LoadingSpinner';
import api from '../services/api';
import type { DashboardStats } from '../types';
import toast from 'react-hot-toast';

export const Dashboard: React.FC = () => {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    loadDashboardStats();
  }, []);

  const loadDashboardStats = async () => {
    try {
      const response = await api.analytics.getDashboard();
      if (response.success && response.data) {
        setStats(response.data);
      }
    } catch (error) {
      toast.error('Failed to load dashboard stats');
      console.error('Dashboard error:', error);
    } finally {
      setIsLoading(false);
    }
  };

  if (isLoading) {
    return <LoadingSpinner size="lg" />;
  }

  if (!stats) {
    return (
      <div className="text-center py-12">
        <p className="text-gray-400">Failed to load dashboard data</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div>
        <h1 className="text-2xl font-bold mb-2">Dashboard Overview</h1>
        <p className="text-gray-400">Platform statistics and real-time metrics</p>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        <StatCard
          title="Total Users"
          value={stats.users.total.toLocaleString()}
          icon={Users}
          iconColor="text-blue-500"
          trend={{ value: 12, isPositive: true }}
        />
        <StatCard
          title="Active Merchants"
          value={stats.merchants.active}
          icon={Store}
          iconColor="text-green-500"
        />
        <StatCard
          title="Pending Orders"
          value={stats.queue.pendingOrders}
          icon={Layers}
          iconColor="text-yellow-500"
        />
        <StatCard
          title="Total Bets Today"
          value={stats.cycles.totalBets.toLocaleString()}
          icon={Activity}
          iconColor="text-purple-500"
        />
        <StatCard
          title="Net Profit"
          value={`₹${stats.finance.netProfit.toLocaleString()}`}
          icon={TrendingUp}
          iconColor="text-gold-500"
          trend={{ value: 8, isPositive: true }}
        />
        <StatCard
          title="Total Payouts"
          value={`₹${stats.finance.totalPayouts.toLocaleString()}`}
          icon={DollarSign}
          iconColor="text-red-500"
        />
      </div>

      {/* Quick Stats */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* User Stats */}
        <div className="card">
          <h3 className="text-lg font-semibold mb-4">User Statistics</h3>
          <div className="space-y-3">
            <div className="flex justify-between items-center">
              <span className="text-gray-400">Active Users</span>
              <span className="font-semibold">{stats.users.active.toLocaleString()}</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-gray-400">Blocked Users</span>
              <span className="font-semibold text-red-500">{stats.users.blocked}</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-gray-400">Pending KYC</span>
              <span className="font-semibold text-yellow-500">{stats.users.kycPending}</span>
            </div>
          </div>
        </div>

        {/* Merchant Stats */}
        <div className="card">
          <h3 className="text-lg font-semibold mb-4">Merchant Statistics</h3>
          <div className="space-y-3">
            <div className="flex justify-between items-center">
              <span className="text-gray-400">Total Merchants</span>
              <span className="font-semibold">{stats.merchants.total}</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-gray-400">Online Now</span>
              <span className="font-semibold text-green-500">{stats.merchants.online}</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-gray-400">Pending Approval</span>
              <span className="font-semibold text-yellow-500">{stats.merchants.pending}</span>
            </div>
          </div>
        </div>
      </div>

      {/* Financial Overview — FIX-9: shows Token Buy/Sell, Bets, Payouts, Net Revenue */}
      <div className="card">
        <h3 className="text-lg font-semibold mb-1">Financial Overview</h3>
        <p className="text-xs text-gray-500 mb-4">
          Net Revenue = Total Bets − Total Payouts − Commission Paid
          &nbsp;·&nbsp; Merchant deposits are shown in Merchant Dashboard only.
        </p>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div>
            <p className="text-sm text-gray-400 mb-1">Token Buy (Deposits)</p>
            <p className="text-xl font-bold text-green-500">
              ₹{(stats.finance.tokenBuy ?? stats.finance.totalDeposits ?? 0).toLocaleString()}
            </p>
          </div>
          <div>
            <p className="text-sm text-gray-400 mb-1">Token Sell (Withdrawals)</p>
            <p className="text-xl font-bold text-red-500">
              ₹{(stats.finance.tokenSell ?? stats.finance.totalWithdrawals ?? 0).toLocaleString()}
            </p>
          </div>
          <div>
            <p className="text-sm text-gray-400 mb-1">Total Bets</p>
            <p className="text-xl font-bold text-blue-500">
              ₹{stats.finance.totalBets.toLocaleString()}
            </p>
          </div>
          <div>
            <p className="text-sm text-gray-400 mb-1">Total Payouts</p>
            <p className="text-xl font-bold text-orange-400">
              ₹{(stats.finance.totalPayouts ?? 0).toLocaleString()}
            </p>
          </div>
        </div>
        <div className="mt-4 p-3 rounded-xl" style={{ background:'rgba(212,175,55,0.07)', border:'1px solid rgba(212,175,55,0.2)' }}>
          <p className="text-sm text-gray-400 mb-0.5">Net Revenue</p>
          <p className="text-2xl font-black" style={{ color:'#D4AF37' }}>
            ₹{stats.finance.netProfit.toLocaleString()}
          </p>
          <p className="text-xs text-gray-600 mt-0.5">Bets − Payouts − Affiliate commissions</p>
        </div>
      </div>

      {/* Active Cycles */}
      <div className="card">
        <h3 className="text-lg font-semibold mb-4">Active Cycles</h3>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div>
            <p className="text-sm text-gray-400 mb-1">Running Now</p>
            <p className="text-2xl font-bold">{stats.cycles.activeCount}</p>
          </div>
          <div>
            <p className="text-sm text-gray-400 mb-1">Completed Today</p>
            <p className="text-2xl font-bold">{stats.cycles.todayCount}</p>
          </div>
          <div>
            <p className="text-sm text-gray-400 mb-1">Total Bets Placed</p>
            <p className="text-2xl font-bold">{stats.cycles.totalBets.toLocaleString()}</p>
          </div>
        </div>
      </div>
    </div>
  );
};
