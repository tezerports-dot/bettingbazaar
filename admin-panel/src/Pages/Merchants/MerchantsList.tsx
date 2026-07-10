import sseService from '../../services/sse';
// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
import React, { useEffect, useState } from 'react';
import { Store, Eye, Ban, CheckCircle, Plus, Settings, History, RefreshCw, DollarSign, ExternalLink } from 'lucide-react';
import { DataTable } from '../../components/DataTable';
import { StatusBadge } from '../../components/StatusBadge';
import { SearchBar } from '../../components/SearchBar';
import { Modal } from '../../components/Modal';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { usePagination } from '../../hooks/usePagination';
import { useDebounce } from '../../hooks/useDebounce';
import { formatters } from '../../utils/formatters';
import api from '../../services/api';
import type { Merchant, MerchantProfile } from '../../types';
import toast from 'react-hot-toast';

type DetailTab = 'info' | 'limits' | 'history' | 'earnings' | 'profit';

export const MerchantsList: React.FC = () => {
  const [merchants, setMerchants] = useState<Merchant[]>([]);
  const [total, setTotal] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('ALL');
  const [selectedMerchant, setSelectedMerchant] = useState<MerchantProfile | null>(null);
  const [detailTab, setDetailTab] = useState<DetailTab>('info');
  const [merchantOrders, setMerchantOrders] = useState<any[]>([]);
  const [ordersLoading, setOrdersLoading] = useState(false);
  const [confirmAction, setConfirmAction] = useState<{ type: string; merchant: Merchant } | null>(null);

  // Create merchant
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [createForm, setCreateForm] = useState({ username: '', mobile: '', password: '', email: '' });
  const [isCreating, setIsCreating] = useState(false);

  // Limits edit
  // M-01 fix: initial values are 0; openDetails() populates from merchant.limits schema.
  // GOVERNANCE §5: UI fallbacks must equal Merchant schema defaults (minOrder:500, maxOrder:50000).
  // Merchant.limits.minDeposit default=500, maxDeposit default=50000 per merchant.model.js.
  const [limitsForm, setLimitsForm]   = useState({ minOrder: 500, maxOrder: 50000, dailyCap: 0, maxConcurrentOrders: 3 });
  const [panelUrl, setPanelUrl]       = useState('');
  const [merchantEarnings, setMerchantEarnings] = useState<any>(null);

  // FIX-2: commission handler removed — commission model dropped; merchants earn via spread

  const handleSavePanelUrl = async () => {
    if (!selectedMerchant) return;
    try {
      await api.merchants.setPanelUrl(selectedMerchant._id, panelUrl.trim());
      toast.success('Panel URL saved');
    } catch { toast.error('Failed to save panel URL'); }
  };

  const loadEarnings = async (merchantId: string) => {
    try {
      const res = await api.merchants.getEarnings(merchantId);
      setMerchantEarnings(res.earnings || res);
    } catch { setMerchantEarnings(null); }
  };
    const [merchantProfit, setMerchantProfit] = useState<any>(null);

  const loadProfitEngine = async (merchantId: string) => {
    try {
      const res = await api.get(`/api/admin/merchants/${merchantId}/profit-engine`);
      setMerchantProfit((res as any)?.data?.data || (res as any)?.data || null);
    } catch { setMerchantProfit(null); }
  };
  const [isSavingLimits, setIsSavingLimits] = useState(false);

  // Merchant panel URL comes from admin panel env var VITE_MERCHANT_PANEL_URL
  // Set this in Railway → admin-panel service → Variables
  const merchantPanelUrl = (import.meta as any).env?.VITE_MERCHANT_PANEL_URL || '';

  const { page, limit, setPage } = usePagination();
  const debouncedSearch = useDebounce(search);

  useEffect(() => { loadMerchants(); }, [page, debouncedSearch, statusFilter]);

  // Real-time: update isOnline dot when merchant toggles status, update limits when admin saves them
  useEffect(() => {
    const handleStatusChange = (data: any) => {
      setMerchants(prev => prev.map(m =>
        m._id?.toString() === data.merchantId?.toString()
          ? { ...m, isOnline: data.isOnline }
          : m
      ));
    };
    const handleLimitsUpdate = (data: any) => {
      // Reload the list so the detail modal also refreshes if open
      loadMerchants();
    };
    sseService.on('merchant_status_changed', handleStatusChange);
    sseService.on('merchant_limits_updated',  handleLimitsUpdate);
    return () => {
      sseService.off('merchant_status_changed', handleStatusChange);
      sseService.off('merchant_limits_updated',  handleLimitsUpdate);
    };
  }, []);

  const loadMerchants = async () => {
    setIsLoading(true);
    try {
      const res = await api.merchants.getAll(page, limit, statusFilter === 'ALL' ? undefined : statusFilter);
      if (res.success && res.data) { setMerchants(res.data); setTotal(res.pagination?.total || 0); }
    } catch { toast.error('Failed to load merchants'); }
    finally { setIsLoading(false); }
  };

  const openDetails = async (merchantId: string, tab: DetailTab = 'info') => {
    try {
      const res = await api.merchants.getProfile(merchantId);
      const mData = (res as any).merchant || res.data;
      if ((res.success || (res as any).merchant) && mData) {
        setSelectedMerchant(mData);
        setPanelUrl(mData.panelUrl || '');
        setDetailTab(tab);
        setLimitsForm({
          // M-01 fix: use Merchant.limits from schema defaults (500 / 50000) — GOVERNANCE §5
          minOrder: mData.minOrder ?? mData.merchantLimits?.minOrder ?? 500,
          maxOrder: mData.maxOrder ?? mData.merchantLimits?.maxOrder ?? 50000,
          maxConcurrentOrders: mData.maxConcurrentOrders ?? 3, // schema default: 3
          dailyCap: 0,  // this field is the wallet top-up amount — always start at 0 for safety
        });
        if (tab === 'history') loadMerchantOrders(merchantId);
      }
    } catch { toast.error('Failed to load merchant profile'); }
  };

  const loadMerchantOrders = async (merchantId: string) => {
    setOrdersLoading(true);
    try {
      const res = await (api.merchants as any).getOrders?.(merchantId) as any;
      if (res?.success && res.data) setMerchantOrders(res.data);
      else setMerchantOrders([]);
    } catch { setMerchantOrders([]); }
    finally { setOrdersLoading(false); }
  };

  const handleSuspend  = async (merchantId: string) => { try { await api.merchants.suspend(merchantId, 'Suspended by admin'); toast.success('Suspended'); loadMerchants(); } catch { toast.error('Failed'); } };
  const handleActivate = async (merchantId: string) => { try { await api.merchants.activate(merchantId); toast.success('Activated'); loadMerchants(); } catch { toast.error('Failed'); } };

  const handleApproveMerchant = async (merchantId: string) => {
    try {
      await (api.merchants as any).approve?.(merchantId);
      toast.success('Merchant approved');
      loadMerchants();
      if (selectedMerchant) openDetails(merchantId);
    } catch { toast.error('Failed to approve'); }
  };

  // FIX A3: Reject merchant -- backend PUT /merchants/:id/reject added in Batch 1
  const handleRejectMerchant = async (merchantId: string) => {
    const reason = prompt('Rejection reason (required):');
    if (!reason?.trim()) return;
    try {
      await (api.merchants as any).reject?.(merchantId, reason.trim());
      toast.success('Merchant rejected');
      loadMerchants();
      if (selectedMerchant?._id === merchantId) {
        setSelectedMerchant(null);
      }
    } catch { toast.error('Failed to reject merchant'); }
  };

  const handleSaveLimits = async () => {
    if (!selectedMerchant) return;
    setIsSavingLimits(true);
    try {
      // Save order amount limits
      await api.merchants.updateLimits(selectedMerchant._id, limitsForm);
      // Save maxConcurrentOrders via scoring endpoint (Section 8 / admin route)
      await api.put(`/api/admin/queue/merchants/${selectedMerchant._id}/scoring`, {
        maxConcurrentOrders: limitsForm.maxConcurrentOrders,
      });
      toast.success('Limits updated');
    } catch { toast.error('Failed to save limits'); }
    finally { setIsSavingLimits(false); }
  };

  const handleCreateMerchant = async () => {
    if (!createForm.username || !createForm.mobile || !createForm.password) { toast.error('Fill required fields'); return; }
    setIsCreating(true);
    try {
      await (api.merchants as any).create?.(createForm);
      toast.success('Merchant account created');
      setShowCreateModal(false);
      setCreateForm({ username: '', mobile: '', password: '', email: '' });
      loadMerchants();
    } catch (e: any) { toast.error(e.response?.data?.message || 'Failed to create merchant'); }
    finally { setIsCreating(false); }
  };

  const columns = [
    {
      key: 'merchant', label: 'Merchant',
      render: (m: Merchant) => (
        <div>
          <p className="font-medium">{m.name}</p>
          <p className="text-sm text-gray-400">{formatters.phone(m.mobile)}</p>
          {m.isOnline && <span className="inline-flex items-center text-xs text-green-500 mt-0.5"><span className="w-1.5 h-1.5 bg-green-500 rounded-full mr-1"/>Online</span>}
        </div>
      ),
    },
    {
      key: 'status', label: 'Status',
      render: (m: Merchant) => (
        <div className="space-y-1">
          <StatusBadge status={m.status} type="merchant" />
          <StatusBadge status={m.merchantApprovalStatus} type="merchant" />
        </div>
      ),
    },
    {
      key: 'stats', label: 'Wallet / Stats',
      render: (m: Merchant) => (
        <div className="text-sm">
          {/* FIX 8: Show tokenBalance (actual capacity) instead of daily processed volume */}
          <p className="font-medium text-gold-400">Rs.{((m as any).tokenBalance ?? 0).toLocaleString()} <span className="text-xs text-gray-500 font-normal">tokens</span></p>
          <p className="text-gray-400 text-xs">Orders: {m.merchantStats?.totalOrdersProcessed || (m as any).totalOrdersAll || 0}</p>
        </div>
      ),
    },
    {
      key: 'scoring', label: 'Scoring',
      render: (m: Merchant) => {
        const successRate  = (m as any).successRate  ?? 1;
        const avgResp      = (m as any).avgResponseMinutes ?? 2;
        const disputeRate  = (m as any).disputeRate  ?? 0;
        const activeOrders = (m as any).activeOrderCount ?? 0;
        const maxOrders    = (m as any).maxConcurrentOrders ?? 3;
        return (
          <div className="text-xs space-y-0.5 min-w-[120px]">
            <div className="flex justify-between">
              <span className="text-gray-400">Success</span>
              <span className={successRate >= 0.9 ? 'text-green-400 font-medium' : successRate >= 0.7 ? 'text-yellow-400' : 'text-red-400'}>
                {Math.round(successRate * 100)}%
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-400">Avg resp.</span>
              <span className="text-gray-300">{avgResp.toFixed(1)}m</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-400">Disputes</span>
              <span className={disputeRate > 0.1 ? 'text-red-400' : 'text-gray-300'}>
                {Math.round(disputeRate * 100)}%
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-400">Active</span>
              <span className="text-gray-300">{activeOrders}/{maxOrders}</span>
            </div>
          </div>
        );
      },
    },
    {
      key: 'services', label: 'Services',
      render: (m: Merchant) => (
        <div className="text-xs space-y-1">
          {m.acceptsDeposits    && <div className="text-green-400">? Deposits</div>}
          {m.acceptsWithdrawals && <div className="text-blue-400">? Withdrawals</div>}
        </div>
      ),
    },
    {
      key: 'actions', label: 'Actions',
      render: (m: Merchant) => (
        <div className="flex items-center space-x-1">
          <button onClick={() => openDetails(m._id, 'info')}    className="p-1.5 hover:bg-dark-700 rounded" title="Details"><Eye size={14}/></button>
          <button onClick={() => openDetails(m._id, 'limits')}  className="p-1.5 hover:bg-blue-600/20 text-blue-400 rounded" title="Limits"><Settings size={14}/></button>
          <button onClick={() => openDetails(m._id, 'history')} className="p-1.5 hover:bg-purple-600/20 text-purple-400 rounded" title="Orders"><History size={14}/></button>
          {m.merchantApprovalStatus === 'PENDING' && (
            <button onClick={() => handleApproveMerchant(m._id)} className="px-2 py-1 bg-gold-500/20 text-gold-400 hover:bg-gold-500/30 rounded text-xs font-medium">Approve</button>
          )}
          {m.merchantApprovalStatus === 'PENDING' && (
            <button onClick={() => handleRejectMerchant(m._id)} className="px-2 py-1 bg-red-600/20 text-red-400 hover:bg-red-600/30 rounded text-xs font-medium">Reject</button>
          )}
          {m.status !== 'SUSPENDED' ? (
            <button onClick={() => setConfirmAction({ type: 'suspend', merchant: m })} className="p-1.5 hover:bg-red-600/20 text-red-500 rounded" title="Suspend"><Ban size={14}/></button>
          ) : (
            <button onClick={() => setConfirmAction({ type: 'activate', merchant: m })} className="p-1.5 hover:bg-green-600/20 text-green-500 rounded" title="Activate"><CheckCircle size={14}/></button>
          )}
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold mb-2">Merchant Management</h1>
          <p className="text-gray-400">Manage merchants, approvals, limits and transaction history</p>
        </div>
        <div className="flex gap-2">
          <button onClick={loadMerchants} className="btn-secondary flex items-center"><RefreshCw size={15} className="mr-1"/>Refresh</button>
          <button onClick={() => setShowCreateModal(true)} className="btn-primary flex items-center"><Plus size={15} className="mr-1"/>Create Merchant</button>
        </div>
      </div>

      <div className="card">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="md:col-span-2"><SearchBar value={search} onChange={setSearch} placeholder="Search merchants..." /></div>
          <select id="merchant-status-filter" name="statusFilter" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="input">
            <option value="ALL">All Status</option>
            <option value="APPROVED">Approved</option>
            <option value="PENDING">Pending Approval</option>
            <option value="SUSPENDED">Suspended</option>
          </select>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="card"><p className="text-sm text-gray-400 mb-1">Total</p><p className="text-2xl font-bold">{total}</p></div>
        <div className="card"><p className="text-sm text-gray-400 mb-1">Online</p><p className="text-2xl font-bold text-green-500">{merchants.filter(m => m.isOnline).length}</p></div>
        <div className="card"><p className="text-sm text-gray-400 mb-1">Approved</p><p className="text-2xl font-bold text-blue-500">{merchants.filter(m => m.merchantApprovalStatus === 'APPROVED').length}</p></div>
        <div className="card"><p className="text-sm text-gray-400 mb-1">Pending</p><p className="text-2xl font-bold text-yellow-500">{merchants.filter(m => m.merchantApprovalStatus === 'PENDING').length}</p></div>
      </div>

      <div className="card">
        <DataTable data={merchants} columns={columns} currentPage={page} totalPages={Math.ceil(total / limit)} onPageChange={setPage} isLoading={isLoading} />
      </div>

      {/* Merchant Detail Modal */}
      {selectedMerchant && (
        <Modal isOpen={!!selectedMerchant} onClose={() => setSelectedMerchant(null)} title="Merchant Profile" size="xl">
          <div className="flex space-x-1 mb-6 bg-dark-800 rounded-lg p-1">
            {(['info', 'limits', 'history', 'earnings', 'profit'] as DetailTab[]).map((tab) => (
              <button key={tab} onClick={() => { setDetailTab(tab); if (tab === 'history') loadMerchantOrders(selectedMerchant._id); if (tab === 'earnings') loadEarnings(selectedMerchant._id); if (tab === 'profit') loadProfitEngine(selectedMerchant._id); }}
                className={`flex-1 py-2 px-3 rounded-md text-sm font-medium transition-colors capitalize ${detailTab === tab ? 'bg-dark-600 text-white' : 'text-gray-400 hover:text-white'}`}>
                {tab === 'history' ? 'Order History' : tab === 'limits' ? 'Edit Limits' : tab === 'profit' ? '📊 Profit Engine' : tab === 'earnings' ? 'Earnings' : 'Info & Stats'}
              </button>
            ))}
          </div>

          {detailTab === 'info' && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div><p className="text-gray-400">Name</p><p className="font-medium">{selectedMerchant.name}</p></div>
                <div><p className="text-gray-400">Mobile</p><p className="font-medium">{formatters.phone(selectedMerchant.mobile)}</p></div>
                <div><p className="text-gray-400">Account Status</p><StatusBadge status={selectedMerchant.status} type="merchant" /></div>
                <div><p className="text-gray-400">Approval</p><StatusBadge status={selectedMerchant.merchantApprovalStatus} type="merchant" /></div>
              </div>

              {selectedMerchant.merchantApprovalStatus === 'PENDING' && (
                <div className="flex gap-3 p-3 bg-yellow-500/10 border border-yellow-500/30 rounded-lg">
                  <p className="flex-1 text-sm text-yellow-400">[!] This merchant is pending approval</p>
                  <button onClick={() => handleRejectMerchant(selectedMerchant._id)} className="px-4 py-1.5 bg-red-600 text-white rounded-lg text-sm font-semibold hover:bg-red-500">Reject</button>
                  <button onClick={() => handleApproveMerchant(selectedMerchant._id)} className="px-4 py-1.5 bg-gold-500 text-dark-900 rounded-lg text-sm font-semibold hover:bg-gold-400">Approve Now</button>
                </div>
              )}

              {/* FIX 3: Token rates — backend returns prices.buyPrice/sellPrice/profit */}
              {(selectedMerchant as any).prices && (
                <div className="grid grid-cols-3 gap-3 p-3 bg-dark-700 rounded-lg border border-gold-500/20">
                  <div>
                    <p className="text-xs text-gray-400">Buy Rate (user pays)</p>
                    <p className="text-lg font-bold text-green-400">₹{(selectedMerchant as any).prices.buyPrice ?? '—'}</p>
                  </div>
                  <div>
                    <p className="text-xs text-gray-400">Sell Rate (user gets)</p>
                    <p className="text-lg font-bold text-red-400">₹{(selectedMerchant as any).prices.sellPrice ?? '—'}</p>
                  </div>
                  <div>
                    <p className="text-xs text-gray-400">Merchant Spread</p>
                    <p className="text-lg font-bold text-gold-400">₹{(selectedMerchant as any).prices.profit ?? '—'}</p>
                  </div>
                </div>
              )}

              <div>
                <p className="text-sm font-semibold mb-3 text-gray-300">Wallet & Performance</p>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  {/* FIX 8: Show tokenBalance prominently -- this is the merchant's actual capacity */}
                  <div className="p-3 bg-dark-700 rounded-lg border border-gold-500/30">
                    <p className="text-xs text-gray-400">Token Wallet</p>
                    <p className="text-xl font-bold text-gold-400">Rs.{((selectedMerchant as any).tokenBalance ?? 0).toLocaleString()}</p>
                    <p className="text-xs text-gray-500">Available balance</p>
                  </div>
                  <div className="p-3 bg-dark-700 rounded-lg"><p className="text-xs text-gray-400">Total Orders</p><p className="text-xl font-bold">{selectedMerchant.statistics?.totalOrders || 0}</p></div>
                  <div className="p-3 bg-dark-700 rounded-lg"><p className="text-xs text-gray-400">Completed</p><p className="text-xl font-bold text-green-500">{selectedMerchant.statistics?.completedOrders || 0}</p></div>
                  <div className="p-3 bg-dark-700 rounded-lg"><p className="text-xs text-gray-400">Success Rate</p><p className="text-xl font-bold text-gold-500">{selectedMerchant.statistics?.successRate || 0}%</p></div>
                </div>
              </div>

              <div className="grid grid-cols-3 gap-3">
                <div className="p-3 bg-dark-700 rounded-lg"><p className="text-xs text-gray-400">Today Vol.</p><p className="text-lg font-bold">{formatters.currency(selectedMerchant.merchantStats?.dailyProcessed || 0)}</p></div>
                <div className="p-3 bg-dark-700 rounded-lg"><p className="text-xs text-gray-400">Monthly Vol.</p><p className="text-lg font-bold">{formatters.currency(selectedMerchant.merchantStats?.monthlyProcessed || 0)}</p></div>
                <div className="p-3 bg-dark-700 rounded-lg"><p className="text-xs text-gray-400">Total Orders</p><p className="text-lg font-bold">{selectedMerchant.merchantStats?.totalOrdersProcessed || 0}</p></div>
              </div>

              {/* Open Merchant Panel — URL from VITE_MERCHANT_PANEL_URL env var */}
              {merchantPanelUrl && (
                <div className="pt-3 border-t border-dark-700">
                  <a
                    href={merchantPanelUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center justify-center gap-2 w-full py-2 bg-blue-600 hover:bg-blue-700 rounded-lg text-sm font-medium transition-colors"
                  >
                    <ExternalLink size={14} /> Open Merchant Panel
                  </a>
                </div>
              )}

              <div className="flex gap-3 pt-2 border-t border-dark-700">
                {selectedMerchant.status !== 'SUSPENDED' ? (
                  <button onClick={() => handleSuspend(selectedMerchant._id)} className="flex-1 py-2 bg-red-600 hover:bg-red-700 rounded-lg text-sm font-medium">Suspend Merchant</button>
                ) : (
                  <button onClick={() => handleActivate(selectedMerchant._id)} className="flex-1 py-2 bg-green-600 hover:bg-green-700 rounded-lg text-sm font-medium">Activate Merchant</button>
                )}
              </div>
            </div>
          )}

          {detailTab === 'limits' && (
            <div className="space-y-5">
              {/* FIX 8: tokenBalance is the capacity -- show it prominently and allow top-up */}
              <div className="p-4 bg-dark-700 rounded-lg border border-gold-500/30">
                <p className="text-xs text-gray-400 mb-1">Current Token Wallet Balance</p>
                <p className="text-3xl font-bold text-gold-400">Rs.{((selectedMerchant as any).tokenBalance ?? 0).toLocaleString()}</p>
                <p className="text-xs text-gray-500 mt-1">Merchant can only process orders up to this amount</p>
              </div>

              <div className="space-y-3">
                <p className="text-sm font-semibold text-gray-300">Top-Up Wallet</p>
                <div>
                  <label className="label">Amount to Add (Rs. tokens)</label>
                  <input
                    type="number" min="1"
                    value={limitsForm.dailyCap || ''}
                    onChange={(e) => setLimitsForm(f => ({ ...f, dailyCap: Number(e.target.value) || 0 }))}
                    placeholder="e.g. 10000"
                    className="input"
                  />
                </div>
                <button
                  disabled={isSavingLimits || !limitsForm.dailyCap}
                  onClick={async () => {
                    setIsSavingLimits(true);
                    try {
                      await (api.merchants as any).fundWallet(selectedMerchant._id, limitsForm.dailyCap);
                      toast.success(`Wallet topped up by Rs.${limitsForm.dailyCap}`);
                      setLimitsForm(f => ({ ...f, dailyCap: 0 }));
                      loadMerchants();
                    } catch { toast.error('Failed to top up wallet'); }
                    finally { setIsSavingLimits(false); }
                  }}
                  className="btn-primary w-full disabled:opacity-50"
                >
                  {isSavingLimits ? 'Processing...' : 'Top Up Wallet'}
                </button>
              </div>

              <div className="border-t border-dark-600 pt-4 space-y-4">
                <p className="text-sm font-semibold text-gray-300">Order Limits</p>
                {/* M-01: per GOVERNANCE §1 — per-merchant caps live on Merchant.limits */}
                <p className="text-xs text-gray-400">
                  Min/max order amounts used when assigning payment orders.
                  Buy-token capacity = merchant&apos;s current token wallet balance.
                  Sell-token capacity = merchant&apos;s lifetime initial token top-up.
                  Both are enforced by the queue assignment logic — edit min/max here.
                </p>
                <div>
                  <label htmlFor="min-order" className="label">Min Order Amount (Rs.)</label>
                  <input id="min-order" name="minOrder" type="number" min="0" value={limitsForm.minOrder} onChange={(e) => setLimitsForm(f => ({ ...f, minOrder: Number(e.target.value) || 0 }))} className="input" />
                </div>
                <div>
                  <label htmlFor="max-order" className="label">Max Order Amount (Rs.)</label>
                  <input id="max-order" name="maxOrder" type="number" min="0" value={limitsForm.maxOrder} onChange={(e) => setLimitsForm(f => ({ ...f, maxOrder: Number(e.target.value) || 0 }))} className="input" />
                </div>
                <div>
                  <label htmlFor="max-concurrent" className="label">Max Concurrent Orders (1–10)</label>
                  <input
                    id="max-concurrent" name="maxConcurrentOrders" type="number" min="1" max="10"
                    value={limitsForm.maxConcurrentOrders}
                    onChange={(e) => setLimitsForm(f => ({ ...f, maxConcurrentOrders: Math.min(10, Math.max(1, Number(e.target.value) || 1)) }))}
                    className="input"
                  />
                  <p className="text-xs text-gray-500 mt-1">Controls how many orders this merchant handles simultaneously (scoring algorithm: load score)</p>
                </div>
                <button onClick={handleSaveLimits} disabled={isSavingLimits} className="btn-primary w-full disabled:opacity-50">
                  {isSavingLimits ? 'Saving...' : 'Save Order Limits'}
                </button>
              </div>
            </div>
          )}

          {detailTab === 'history' && (
            <div>
              {ordersLoading ? (
                <div className="text-center py-8 text-gray-400">Loading orders...</div>
              ) : merchantOrders.length === 0 ? (
                <div className="text-center py-8 text-gray-500"><DollarSign size={36} className="mx-auto mb-3 opacity-30"/><p>No orders found</p></div>
              ) : (
                <div className="space-y-2 max-h-96 overflow-y-auto pr-1">
                  {merchantOrders.map((order: any) => (
                    <div key={order._id} className="flex justify-between bg-dark-700 rounded-lg px-4 py-3 text-sm">
                      <div>
                        <p className="font-mono text-xs text-gray-400">{order.orderId}</p>
                        <p className="font-medium">{order.type} -- {order.userName || 'User'}</p>
                        <p className="text-xs text-gray-400">{formatters.datetime(order.createdAt)}</p>
                      </div>
                      <div className="text-right">
                        <p className="font-semibold">{formatters.currency(order.fiatAmount)}</p>
                        <p className="text-xs text-gold-400">{order.tokenAmount} tokens</p>
                        <p className="text-xs text-gray-500">{order.status}</p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {detailTab === 'earnings' && (
            <div className="space-y-4">
              {merchantEarnings ? (
                <div className="space-y-3">
                  <div className="grid grid-cols-2 gap-3">
                    <div className="bg-dark-700 rounded-lg p-3"><p className="text-xs text-gray-400">Total Earnings</p><p className="text-xl font-bold text-green-400">{formatters.currency(merchantEarnings.totalEarnings || 0)}</p></div>
                    <div className="bg-dark-700 rounded-lg p-3"><p className="text-xs text-gray-400">This Month</p><p className="text-xl font-bold text-gold-400">{formatters.currency(merchantEarnings.monthlyEarnings || 0)}</p></div>
                    <div className="bg-dark-700 rounded-lg p-3"><p className="text-xs text-gray-400">Orders Processed</p><p className="text-xl font-bold">{merchantEarnings.totalOrders || 0}</p></div>
                    <div className="bg-dark-700 rounded-lg p-3"><p className="text-xs text-gray-400">Avg per Order</p><p className="text-xl font-bold">{formatters.currency(merchantEarnings.avgPerOrder || 0)}</p></div>
                  </div>
                </div>
              ) : (
                <div className="text-center py-8 text-gray-500"><DollarSign size={36} className="mx-auto mb-3 opacity-30"/><p>No earnings data</p></div>
              )}
              <div className="pt-4 border-t border-dark-700">
                <p className="text-xs text-gray-500">Merchants earn via the buy/sell price spread — no commission applies.</p>
              </div>
            </div>
          )}

          {/* PROFIT ENGINE TAB */}
          {detailTab === 'profit' && (
            <div className="space-y-4">
              <h4 className="font-semibold text-sm text-gray-400 uppercase tracking-wider">f4ca Profit Engine — from Ledger</h4>
              {!merchantProfit ? (
                <div className="text-center py-8 text-gray-500"><p>Loading profit data…</p></div>
              ) : (
                <div className="grid grid-cols-2 gap-3">
                  {([
                    ['Current Token Holdings',(merchantProfit.currentTokenHoldings||0).toLocaleString('en-IN')+' T',''],
                    ['Tokens Allocated',(merchantProfit.tokensAllocated||0).toLocaleString('en-IN')+' T',''],
                    ['Tokens Returned',(merchantProfit.tokensReturned||0).toLocaleString('en-IN')+' T',''],
                    ['Deposits Processed',(merchantProfit.depositsProcessed||0).toLocaleString('en-IN'),''],
                    ['Withdrawals Processed',(merchantProfit.withdrawalsProcessed||0).toLocaleString('en-IN'),''],
                    ['Net User Volume','₹'+(merchantProfit.netUserVolume||0).toLocaleString('en-IN'),''],
                    ['Revenue Generated','₹'+(merchantProfit.revenue||0).toLocaleString('en-IN'),'green'],
                    ['Funding Cost','₹'+(merchantProfit.fundingCost||0).toLocaleString('en-IN'),'red'],
                    ['Withdrawal Exposure','₹'+(merchantProfit.withdrawalExposure||0).toLocaleString('en-IN'),'red'],
                    ['Profit Generated','₹'+(merchantProfit.profit||0).toLocaleString('en-IN'),(merchantProfit.profit||0)>=0?'green':'red'],
                    ['ROI',(merchantProfit.roi||0)+'%',(merchantProfit.roi||0)>=0?'green':'red'],
                    ['Spread','₹'+(merchantProfit.spread||0).toFixed(4)+'/token',''],
                  ] as [string,string,string][]).map(([lbl,val,hl]) => (
                    <div key={lbl} className="bg-dark-700 rounded-lg p-3">
                      <p className="text-xs text-gray-400">{lbl}</p>
                      <p className={`font-bold text-sm ${hl==='green'?'text-green-400':hl==='red'?'text-red-400':'text-white'}`}>{val}</p>
                    </div>
                  ))}
                </div>
              )}
              <p className="text-xs text-gray-600 pt-2 border-t border-dark-700">Formula: Revenue − Funding Cost − Withdrawal Exposure = Profit</p>
            </div>
          )}
        </Modal>
      )}

      {/* Create Merchant Modal */}
      {showCreateModal && (
        <Modal isOpen={showCreateModal} onClose={() => setShowCreateModal(false)} title="Create Merchant Account">
          <div className="space-y-4">
            <p className="text-sm text-gray-400">Create a new merchant account. The merchant will receive login credentials and must be approved before they can process orders.</p>
            <div>
              <label htmlFor="create-username" className="label">Username *</label>
              <input id="create-username" name="username" type="text" value={createForm.username} onChange={(e) => setCreateForm(f => ({ ...f, username: e.target.value }))} className="input" placeholder="Merchant display name" />
            </div>
            <div>
              <label htmlFor="create-mobile" className="label">Mobile Number *</label>
              <input id="create-mobile" name="mobile" type="tel" value={createForm.mobile} onChange={(e) => setCreateForm(f => ({ ...f, mobile: e.target.value }))} className="input" placeholder="10-digit mobile" />
            </div>
            <div>
              <label htmlFor="create-email" className="label">Email</label>
              <input id="create-email" name="email" type="email" value={createForm.email} onChange={(e) => setCreateForm(f => ({ ...f, email: e.target.value }))} className="input" placeholder="Optional" />
            </div>
            <div>
              <label htmlFor="create-password" className="label">Temporary Password *</label>
              <input id="create-password" name="password" type="text" value={createForm.password} onChange={(e) => setCreateForm(f => ({ ...f, password: e.target.value }))} className="input" placeholder="Set initial password" />
            </div>
            <div className="flex gap-3">
              <button onClick={() => setShowCreateModal(false)} className="flex-1 btn-secondary">Cancel</button>
              <button onClick={handleCreateMerchant} disabled={isCreating} className="flex-1 btn-primary disabled:opacity-50">{isCreating ? 'Creating...' : 'Create Merchant'}</button>
            </div>
          </div>
        </Modal>
      )}

      {confirmAction && (
        <ConfirmDialog isOpen={!!confirmAction} onClose={() => setConfirmAction(null)}
          onConfirm={() => { confirmAction.type === 'suspend' ? handleSuspend(confirmAction.merchant._id) : handleActivate(confirmAction.merchant._id); }}
          title={confirmAction.type === 'suspend' ? 'Suspend Merchant' : 'Activate Merchant'}
          message={`Are you sure you want to ${confirmAction.type} ${confirmAction.merchant.name}?`}
          type={confirmAction.type === 'suspend' ? 'danger' : 'warning'}
        />
      )}
    </div>
  );
};
