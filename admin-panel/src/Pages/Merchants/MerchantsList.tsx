// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
//
// Merchants: approval, suspension, the payment details they keep, and the
// orders they have handled. A merchant holds NO tokens of their own and is not
// ranked or capped here — they work in a team, the team's pool holds the
// tokens, and routing hands each order to a member of a working team on the
// order's rail (database/repositories/teamRouting.js). Teams are managed on
// the Supervisors & Teams screen.
import sseService from '../../services/sse';
import React, { useCallback, useEffect, useState } from 'react';
import { Eye, Ban, CheckCircle, Plus, Settings, History, RefreshCw, DollarSign, ExternalLink } from 'lucide-react';
import { DataTable } from '../../components/DataTable';
import { StatusBadge } from '../../components/StatusBadge';
import { DisputeRecordBadge } from '../../components/DisputeRecordBadge';
import { Kpis, Toolbar, AvatarCell } from '../../components/design';
import { Modal } from '../../components/Modal';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { usePagination } from '../../hooks/usePagination';
import { useDebounce } from '../../hooks/useDebounce';
import { formatters } from '../../utils/formatters';
import api from '../../services/api';
import type { Merchant, MerchantProfile } from '../../types';
import toast from 'react-hot-toast';

type DetailTab = 'info' | 'rail' | 'history' | 'earnings';

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

  const [merchantEarnings, setMerchantEarnings] = useState<any>(null);

  const loadEarnings = async (merchantId: string) => {
    try {
      const res = await api.merchants.getEarnings(merchantId);
      setMerchantEarnings(res.earnings || res);
    } catch { setMerchantEarnings(null); }
  };
  // Which payment details a merchant keeps: a bank account (INR) or USDT wallet
  // addresses — never both. Written to merchants.accepted_currencies through
  // the capabilities route; switching clears the other set. Which ORDERS they
  // are offered is decided by their team's rail (supervisor_rail), not by this.
  const [rail, setRail] = useState<'INR' | 'USDT'>('INR');
  const [isSavingRail, setIsSavingRail] = useState(false);

  // Merchant panel URL comes from the admin panel build-time env var
  // VITE_MERCHANT_PANEL_URL (only needed if the merchant panel is on its own host).
  const merchantPanelUrl = (import.meta as any).env?.VITE_MERCHANT_PANEL_URL || '';

  const { page, limit, setPage } = usePagination();
  const debouncedSearch = useDebounce(search);

  // Real-time: update the isOnline dot when a merchant toggles their status.
  useEffect(() => {
    const handleStatusChange = (data: any) => {
      setMerchants(prev => prev.map(m =>
        m._id?.toString() === data.merchantId?.toString()
          ? { ...m, isOnline: data.isOnline }
          : m
      ));
    };
    sseService.on('merchant_status_changed', handleStatusChange);
    return () => {
      sseService.off('merchant_status_changed', handleStatusChange);
    };
  }, []);

  const loadMerchants = useCallback(async () => {
    setIsLoading(true);
    try {
      // The search box narrows on the server (`listMerchants`), on every page.
      const res = await api.merchants.getAll(page, limit, statusFilter === 'ALL' ? undefined : statusFilter, debouncedSearch || undefined);
      if (res.success && res.data) { setMerchants(res.data); setTotal(res.pagination?.total || 0); }
    } catch { toast.error('Failed to load merchants'); }
    finally { setIsLoading(false); }
  }, [page, limit, statusFilter, debouncedSearch]);

  useEffect(() => { loadMerchants(); }, [loadMerchants]);

  const openDetails = async (merchantId: string, tab: DetailTab = 'info') => {
    try {
      const res = await api.merchants.getProfile(merchantId);
      const mData = (res as any).merchant || res.data;
      if ((res.success || (res as any).merchant) && mData) {
        setSelectedMerchant(mData);
        setDetailTab(tab);
        // Settlement rail — Merchant.acceptedCurrencies holds exactly one entry
        // (backend: domains/merchant/merchantCurrency.js). schema default: ['INR'].
        setRail(mData.merchantType ?? mData.acceptedCurrencies?.[0] ?? 'INR');
        if (tab === 'history') loadMerchantOrders(merchantId);
        if (tab === 'earnings') loadEarnings(merchantId);
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

  /**
   * Lift an assignment pause.
   *
   * The reason is shown BEFORE the confirm rather than after, because the whole
   * point of the pause is that somebody reads it and calls the merchant — an
   * admin who clears it without seeing why has skipped the only step that
   * fixes anything. It lives on the profile because the profile is what
   * carries `assignmentPausedAt`; the list rows never did, so a resume button
   * on the list could never appear.
   */
  const handleResumeAssignment = async (merchantId: string, reason?: string | null) => {
    const ok = window.confirm(
      `${reason || 'This merchant is paused from new assignments.'}\n\n`
      + 'Have you checked with them that they can be paid? Resume assignment?',
    );
    if (!ok) return;
    try {
      const res = await api.merchants.resumeAssignment(merchantId);
      toast.success(res?.message || 'Assignment resumed');
      loadMerchants();
      openDetails(merchantId, 'info');
    } catch (e: any) { toast.error(e?.response?.data?.message || 'Failed to resume assignment'); }
  };

  const handleSuspend  = async (merchantId: string) => { try { await api.merchants.suspend(merchantId, 'Suspended by admin'); toast.success('Suspended'); loadMerchants(); } catch { toast.error('Failed'); } };
  // The server's own sentence on a refusal: a member in high-risk review is
  // reinstated by a full admin only, and "Failed" would not say so (§32 S14).
  const handleActivate = async (merchantId: string) => { try { await api.merchants.activate(merchantId); toast.success('Activated'); loadMerchants(); } catch (e: any) { toast.error(e.response?.data?.message || 'Failed to activate'); } };

  const handleApproveMerchant = async (merchantId: string) => {
    try {
      await (api.merchants as any).approve?.(merchantId);
      toast.success('Merchant approved');
      loadMerchants();
      if (selectedMerchant) openDetails(merchantId);
    } catch (e: any) { toast.error(e.response?.data?.message || 'Failed to approve'); }
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

  const handleSaveRail = async (next: 'INR' | 'USDT') => {
    if (!selectedMerchant || next === rail) return;
    setIsSavingRail(true);
    try {
      await api.put(`/api/admin/merchants/${selectedMerchant._id}/capabilities`, { merchantType: next });
      setRail(next);
      toast.success(
        next === 'USDT'
          ? 'Now a USDT merchant. Existing bank details were cleared.'
          : 'Now an INR merchant — bank account. The USDT addresses were cleared.'
      );
      loadMerchants();
    } catch (e: any) {
      toast.error(e.response?.data?.message || 'Failed to change settlement rail');
    } finally { setIsSavingRail(false); }
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
          <AvatarCell name={m.name} sub={formatters.phone(m.mobile)} index={Math.max(0, merchants.indexOf(m))} />
          {m.isOnline && <span className="inline-flex items-center text-xs mt-1" style={{ color: 'var(--success)' }}><span className="w-1.5 h-1.5 rounded-full mr-1" style={{ background: 'var(--success)' }} />Online</span>}
        </div>
      ),
    },
    {
      key: 'status', label: 'Status',
      render: (m: Merchant) => (
        <div className="space-y-1">
          <StatusBadge status={m.status} type="merchant" />
          <StatusBadge status={m.merchantApprovalStatus} type="merchant" />
          <DisputeRecordBadge lostDisputes={m.lostDisputes} highRiskAt={m.highRiskAt} />
        </div>
      ),
    },
    {
      key: 'stats', label: 'Orders',
      render: (m: Merchant) => (
        <div className="text-sm">
          <p className="font-medium">{(m.merchantStats?.totalOrdersProcessed || 0).toLocaleString('en-IN')}</p>
          <p className="text-gray-400 text-xs">Today: {formatters.currency(m.merchantStats?.dailyProcessed || 0)}</p>
        </div>
      ),
    },
    {
      key: 'services', label: 'Services',
      render: (m: Merchant) => (
        <div className="text-xs space-y-1">
          {m.acceptsDeposits    && <div className="text-green-400">Deposits</div>}
          {m.acceptsWithdrawals && <div className="text-blue-400">Withdrawals</div>}
        </div>
      ),
    },
    {
      key: 'actions', label: 'Actions',
      render: (m: Merchant) => (
        <div className="flex items-center space-x-1">
          <button onClick={() => openDetails(m._id, 'info')}    className="p-1.5 hover:bg-dark-700 rounded-sm" title="Details"><Eye size={14}/></button>
          <button onClick={() => openDetails(m._id, 'rail')}    className="p-1.5 hover:bg-blue-600/20 text-blue-400 rounded-sm" title="Payment details"><Settings size={14}/></button>
          <button onClick={() => openDetails(m._id, 'history')} className="p-1.5 hover:bg-purple-600/20 text-purple-400 rounded-sm" title="Orders"><History size={14}/></button>
          {m.merchantApprovalStatus === 'PENDING' && (
            <button onClick={() => handleApproveMerchant(m._id)} className="px-2 py-1 bg-gold-500/20 text-gold-400 hover:bg-gold-500/30 rounded-sm text-xs font-medium">Approve</button>
          )}
          {m.merchantApprovalStatus === 'PENDING' && (
            <button onClick={() => handleRejectMerchant(m._id)} className="px-2 py-1 bg-red-600/20 text-red-400 hover:bg-red-600/30 rounded-sm text-xs font-medium">Reject</button>
          )}
          {m.status !== 'SUSPENDED' ? (
            <button onClick={() => setConfirmAction({ type: 'suspend', merchant: m })} className="p-1.5 hover:bg-red-600/20 text-red-500 rounded-sm" title="Suspend"><Ban size={14}/></button>
          ) : (
            <button onClick={() => setConfirmAction({ type: 'activate', merchant: m })} className="p-1.5 hover:bg-green-600/20 text-green-500 rounded-sm" title="Activate"><CheckCircle size={14}/></button>
          )}
        </div>
      ),
    },
  ];

  return (
    <div className="om-fade">
      <Kpis items={[
        { label: 'Merchants', value: total },
        { label: 'Online', value: merchants.filter((m) => m.isOnline).length, tone: 'var(--success)' },
        { label: 'Approved', value: merchants.filter((m) => m.merchantApprovalStatus === 'APPROVED').length, tone: 'var(--info)' },
        { label: 'Pending', value: merchants.filter((m) => m.merchantApprovalStatus === 'PENDING').length, tone: 'var(--warning)' },
      ]} />

      <Toolbar
        tabs={[
          { label: 'All', active: statusFilter === 'ALL', onClick: () => setStatusFilter('ALL') },
          { label: 'Approved', active: statusFilter === 'APPROVED', onClick: () => setStatusFilter('APPROVED') },
          { label: 'Pending', active: statusFilter === 'PENDING', onClick: () => setStatusFilter('PENDING') },
          { label: 'Suspended', active: statusFilter === 'SUSPENDED', onClick: () => setStatusFilter('SUSPENDED') },
        ]}
        search={{ value: search, onChange: setSearch, placeholder: 'Search merchants…' }}
        actions={[
          { label: 'Refresh', icon: RefreshCw, onClick: loadMerchants },
          { label: 'Create Merchant', icon: Plus, primary: true, onClick: () => setShowCreateModal(true) },
        ]}
      />

      <div className="card">
        <DataTable data={merchants} columns={columns} currentPage={page} totalPages={Math.ceil(total / limit)} onPageChange={setPage} isLoading={isLoading} />
      </div>

      {/* Merchant Detail Modal */}
      {selectedMerchant && (
        <Modal isOpen={!!selectedMerchant} onClose={() => setSelectedMerchant(null)} title="Merchant Profile" size="xl">
          <div className="flex space-x-1 mb-6 bg-dark-800 rounded-lg p-1">
            {(['info', 'rail', 'history', 'earnings'] as DetailTab[]).map((tab) => (
              <button key={tab} onClick={() => { setDetailTab(tab); if (tab === 'history') loadMerchantOrders(selectedMerchant._id); if (tab === 'earnings') loadEarnings(selectedMerchant._id); }}
                className={`flex-1 py-2 px-3 rounded-md text-sm font-medium transition-colors capitalize ${detailTab === tab ? 'bg-dark-600 text-white' : 'text-gray-400 hover:text-white'}`}>
                {tab === 'history' ? 'Order History' : tab === 'rail' ? 'Payment Details' : tab === 'earnings' ? 'Order Volume' : 'Info & Stats'}
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

              {/* Paused, not suspended. Three buy orders in a row expired with
                  nobody paying, which usually means nobody CAN pay this
                  merchant — a wrong or frozen bank account, a bank refusing.
                  They are not accused of anything and keep every order they
                  hold; routing just stops offering them new ones
                  (teamRouting: assignment_paused_at IS NULL) until somebody
                  has asked. There is no timer on purpose: a clock cannot tell
                  whether the QR was fixed. */}
              {selectedMerchant.assignmentPausedAt && (
                <div className="flex items-center gap-3 p-3 bg-amber-500/10 border border-amber-500/30 rounded-lg">
                  <div className="flex-1 text-sm">
                    <p className="font-semibold text-amber-400">Paused from new orders since {formatters.datetime(selectedMerchant.assignmentPausedAt)}</p>
                    <p className="text-xs text-gray-400 mt-0.5">{selectedMerchant.assignmentPauseReason || 'No reason was recorded.'}</p>
                  </div>
                  <button
                    onClick={() => handleResumeAssignment(selectedMerchant._id, selectedMerchant.assignmentPauseReason)}
                    className="px-4 py-1.5 bg-amber-500/20 text-amber-400 hover:bg-amber-500/30 rounded-lg text-sm font-semibold"
                  >
                    Resume assignment
                  </button>
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
                <p className="text-sm font-semibold mb-3 text-gray-300">Performance</p>
                <div className="grid grid-cols-3 gap-3">
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

          {detailTab === 'rail' && (
            <div className="space-y-5">
              {/* The consumer for merchants.accepted_currencies (§3: no
                  admin-editable field without a real consumer): it decides
                  which credential set the merchant keeps, and so what the order
                  snapshot carries (paymentProcessing: merchantType). */}
              <div className="p-4 bg-dark-700 rounded-lg space-y-3">
                <div>
                  <p className="text-sm font-semibold text-gray-300">Settlement Rail</p>
                  <p className="text-xs text-gray-500 mt-1">
                    Which payment details this merchant keeps: a bank account, or USDT wallet addresses — never both.
                    Which orders they are offered is decided by their team&apos;s rail, on the Supervisors &amp; Teams screen.
                  </p>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  {(['INR', 'USDT'] as const).map((option) => (
                    <button
                      key={option}
                      disabled={isSavingRail}
                      onClick={() => handleSaveRail(option)}
                      className={`py-2 rounded-lg text-sm font-medium border transition-colors disabled:opacity-50 ${
                        rail === option
                          ? 'bg-gold-500/15 border-gold-500/60 text-gold-300'
                          : 'bg-dark-800 border-dark-600 text-gray-400 hover:text-gray-200'
                      }`}
                    >
                      {option === 'INR' ? 'INR · bank account' : 'USDT · wallet addresses'}
                    </button>
                  ))}
                </div>
                <p className="text-xs text-amber-400/80">
                  Switching rails clears the payment details for the old rail — the merchant re-enters them from their panel.
                </p>
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

          {/* What GET /merchants/:id/earnings actually sends: four counts
              and the lifetime volume of COMPLETED orders, in tokens (1 token
              = ₹1). It never sent earnings figures — this tab rendered
              totalEarnings / monthlyEarnings / avgPerOrder, read undefined,
              and showed ₹0 for every merchant. Merchant pay is team commission,
              shown per team in Teams; nothing here claims to show it. */}
          {detailTab === 'earnings' && (
            <div className="space-y-4">
              {merchantEarnings ? (
                <div className="grid grid-cols-2 gap-3">
                  <div className="bg-dark-700 rounded-lg p-3"><p className="text-xs text-gray-400">Total Orders</p><p className="text-xl font-bold">{(merchantEarnings.totalOrders || 0).toLocaleString('en-IN')}</p></div>
                  <div className="bg-dark-700 rounded-lg p-3"><p className="text-xs text-gray-400">Completed</p><p className="text-xl font-bold text-green-400">{(merchantEarnings.completedOrders || 0).toLocaleString('en-IN')}</p></div>
                  <div className="bg-dark-700 rounded-lg p-3"><p className="text-xs text-gray-400">In Progress</p><p className="text-xl font-bold text-gold-400">{(merchantEarnings.pendingOrders || 0).toLocaleString('en-IN')}</p></div>
                  <div className="bg-dark-700 rounded-lg p-3"><p className="text-xs text-gray-400">Completed Volume</p><p className="text-xl font-bold">{(merchantEarnings.totalVolume || 0).toLocaleString('en-IN')} <span className="text-xs text-gray-500 font-normal">BB</span></p></div>
                </div>
              ) : (
                <div className="text-center py-8 text-gray-500"><DollarSign size={36} className="mx-auto mb-3 opacity-30"/><p>No order data</p></div>
              )}
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
          onConfirm={() => { if (confirmAction.type === 'suspend') handleSuspend(confirmAction.merchant._id); else handleActivate(confirmAction.merchant._id); }}
          title={confirmAction.type === 'suspend' ? 'Suspend Merchant' : 'Activate Merchant'}
          message={`Are you sure you want to ${confirmAction.type} ${confirmAction.merchant.name}?`}
          type={confirmAction.type === 'suspend' ? 'danger' : 'warning'}
        />
      )}
    </div>
  );
};
