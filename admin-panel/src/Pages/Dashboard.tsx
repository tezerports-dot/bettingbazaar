// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
import React, { useEffect, useState } from 'react';
import { Users, Store, DollarSign, Activity, TrendingUp, Layers, ShieldCheck, Gauge, ClipboardList, Landmark } from 'lucide-react';
import { StatCard } from '../components/StatCard';
import { LoadingSpinner } from '../components/LoadingSpinner';
import api from '../services/api';
import type { DashboardStats } from '../types';
import toast from 'react-hot-toast';

export const Dashboard: React.FC = () => {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const formatMoney = (value: number | undefined | null) =>
    `₹${(value ?? 0).toLocaleString('en-IN')}`;

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

  const pendingKyc = stats.users.kycPending ?? 0;
  const blockedUsers = stats.users.blocked ?? 0;
  const pendingMerchantApprovals = stats.merchants.pending ?? 0;
  const pendingOrders = stats.queue.pendingOrders ?? 0;
  const completedCycles = stats.cycles.todayCount ?? 0;
  const activeCycles = stats.cycles.activeCount ?? 0;
  const grossInflow = stats.finance.tokenBuy ?? stats.finance.totalDeposits ?? 0;
  const grossOutflow = stats.finance.tokenSell ?? stats.finance.totalWithdrawals ?? 0;
  const liquidityCoverage = grossOutflow > 0 ? Math.round((grossInflow / grossOutflow) * 100) : 100;
  const operationalLoad = pendingOrders + pendingKyc + pendingMerchantApprovals;
  const riskFlags = blockedUsers + pendingKyc + Math.max(0, pendingOrders - stats.merchants.online);

  const erpLanes = [
    {
      title: 'Cashflow Control',
      subtitle: 'Token buy/sell settlement health',
      icon: Landmark,
      tone: 'text-green-400 bg-green-500/10',
      metrics: [
        { label: 'Inflow', value: formatMoney(grossInflow) },
        { label: 'Outflow', value: formatMoney(grossOutflow) },
        { label: 'Coverage', value: `${liquidityCoverage}%` },
      ],
    },
    {
      title: 'Operations Queue',
      subtitle: 'Actionable work across KYC, merchants and orders',
      icon: ClipboardList,
      tone: 'text-blue-400 bg-blue-500/10',
      metrics: [
        { label: 'Pending Orders', value: pendingOrders.toLocaleString('en-IN') },
        { label: 'KYC Review', value: pendingKyc.toLocaleString('en-IN') },
        { label: 'Merchant Review', value: pendingMerchantApprovals.toLocaleString('en-IN') },
      ],
    },
    {
      title: 'Risk & Controls',
      subtitle: 'Exceptions that need admin intervention',
      icon: ShieldCheck,
      tone: 'text-orange-400 bg-orange-500/10',
      metrics: [
        { label: 'Risk Flags', value: riskFlags.toLocaleString('en-IN') },
        { label: 'Blocked Users', value: blockedUsers.toLocaleString('en-IN') },
        { label: 'Online Merchants', value: stats.merchants.online.toLocaleString('en-IN') },
      ],
    },
  ];

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div className="overflow-hidden rounded-2xl border border-dark-700 bg-gradient-to-br from-dark-800 to-dark-900 p-6 shadow-2xl">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <p className="mb-2 inline-flex items-center gap-2 rounded-full border border-gold-500/20 bg-gold-500/10 px-3 py-1 text-xs font-semibold uppercase tracking-widest text-gold-400">
              <Gauge size={14} /> ERP Command Center
            </p>
            <h1 className="text-3xl font-black text-gray-100">Enterprise Operations Dashboard</h1>
            <p className="mt-2 max-w-3xl text-sm text-gray-400">
              One-screen command view for finance, order queues, risk controls, merchants and live market operations.
            </p>
          </div>
          <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
            <div className="rounded-xl border border-dark-700 bg-dark-900/70 p-3">
              <p className="text-gray-500">Workload</p>
              <p className="text-xl font-bold text-gray-100">{operationalLoad}</p>
            </div>
            <div className="rounded-xl border border-dark-700 bg-dark-900/70 p-3">
              <p className="text-gray-500">Cycles</p>
              <p className="text-xl font-bold text-gray-100">{activeCycles}/{completedCycles}</p>
            </div>
            <div className="rounded-xl border border-dark-700 bg-dark-900/70 p-3">
              <p className="text-gray-500">Coverage</p>
              <p className="text-xl font-bold text-green-400">{liquidityCoverage}%</p>
            </div>
            <div className="rounded-xl border border-dark-700 bg-dark-900/70 p-3">
              <p className="text-gray-500">Risk Flags</p>
              <p className="text-xl font-bold text-orange-400">{riskFlags}</p>
            </div>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        {erpLanes.map((lane) => {
          const Icon = lane.icon;
          return (
            <div key={lane.title} className="rounded-2xl border border-dark-700 bg-dark-800 p-5 shadow-xl">
              <div className="mb-4 flex items-start gap-3">
                <div className={`rounded-xl p-3 ${lane.tone}`}>
                  <Icon size={22} />
                </div>
                <div>
                  <h2 className="font-bold text-gray-100">{lane.title}</h2>
                  <p className="text-xs text-gray-500">{lane.subtitle}</p>
                </div>
              </div>
              <div className="grid grid-cols-3 gap-2">
                {lane.metrics.map((metric) => (
                  <div key={metric.label} className="rounded-xl bg-dark-900/70 p-3">
                    <p className="text-[11px] text-gray-500">{metric.label}</p>
                    <p className="mt-1 text-sm font-bold text-gray-100">{metric.value}</p>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
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
              {formatMoney(grossInflow)}
            </p>
          </div>
          <div>
            <p className="text-sm text-gray-400 mb-1">Token Sell (Withdrawals)</p>
            <p className="text-xl font-bold text-red-500">
              {formatMoney(grossOutflow)}
            </p>
          </div>
          <div>
            <p className="text-sm text-gray-400 mb-1">Total Bets</p>
            <p className="text-xl font-bold text-blue-500">
              {formatMoney(stats.finance.totalBets)}
            </p>
          </div>
          <div>
            <p className="text-sm text-gray-400 mb-1">Total Payouts</p>
            <p className="text-xl font-bold text-orange-400">
              {formatMoney(stats.finance.totalPayouts)}
            </p>
          </div>
        </div>
        <div className="mt-4 p-3 rounded-xl" style={{ background:'rgba(212,175,55,0.07)', border:'1px solid rgba(212,175,55,0.2)' }}>
          <p className="text-sm text-gray-400 mb-0.5">Net Revenue</p>
          <p className="text-2xl font-black" style={{ color:'#D4AF37' }}>
            {formatMoney(stats.finance.netProfit)}
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
