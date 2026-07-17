// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
import React, { useEffect, useState } from 'react';
import { Users, Eye, Ban, CheckCircle, Plus, Minus, CreditCard, History, Ghost } from 'lucide-react';
import { DataTable } from '../../components/DataTable';
import { StatusBadge } from '../../components/StatusBadge';
import { SearchBar } from '../../components/SearchBar';
import { Modal } from '../../components/Modal';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { UserAvatar } from '../../components/UserAvatar';
import { usePagination } from '../../hooks/usePagination';
import { useDebounce } from '../../hooks/useDebounce';
import { formatters } from '../../utils/formatters';
import api from '../../services/api';
import type { User, Transaction } from '../../types';
import toast from 'react-hot-toast';

type ModalTab = 'profile' | 'bank' | 'history';

export const UsersList: React.FC = () => {
  const [users, setUsers] = useState<User[]>([]);
  const [total, setTotal] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('ALL');
  const [selectedUser, setSelectedUser] = useState<User | null>(null);
  const [activeTab, setActiveTab] = useState<ModalTab>('profile');
  const [confirmAction, setConfirmAction] = useState<{ type: string; user: User } | null>(null);
  const [phantomUser, setPhantomUser]         = useState<User | null>(null);
  const [phantomLevel, setPhantomLevel]       = useState('NONE');
  const [isSavingPhantom, setIsSavingPhantom] = useState(false);

  const handleSetPhantomAccess = async () => {
    if (!phantomUser) return;
    setIsSavingPhantom(true);
    try {
      await api.post(`/api/admin/users/${phantomUser._id}/phantom-access`, { accessLevel: phantomLevel });
      toast.success(`Phantom access set to ${phantomLevel}`);
      setPhantomUser(null);
      loadUsers();
    } catch { toast.error('Failed to set phantom access'); }
    finally { setIsSavingPhantom(false); }
  };

  // Balance adjust
  const [showBalanceModal, setShowBalanceModal] = useState(false);
  const [balanceTarget, setBalanceTarget] = useState<User | null>(null);
  const [balanceType, setBalanceType] = useState<'add' | 'deduct'>('add');
  const [balanceWallet, setBalanceWallet] = useState<'DEPOSIT' | 'WINNINGS'>('DEPOSIT');
  const [balanceAmount, setBalanceAmount] = useState('');
  const [balanceReason, setBalanceReason] = useState('');
  const [isSavingBalance, setIsSavingBalance] = useState(false);

  // Tx history
  const [userTransactions, setUserTransactions] = useState<Transaction[]>([]);
  const [txLoading, setTxLoading] = useState(false);

  const { page, limit, setPage } = usePagination();
  const debouncedSearch = useDebounce(search);

  useEffect(() => { loadUsers(); }, [page, debouncedSearch, statusFilter]);

  const loadUsers = async () => {
    setIsLoading(true);
    try {
      const response = await api.users.getAll(page, limit, debouncedSearch, statusFilter === 'ALL' ? undefined : statusFilter);
      if (response.success && response.data) {
        setUsers(response.data);
        setTotal(response.pagination?.total || 0);
      }
    } catch { toast.error('Failed to load users'); }
    finally { setIsLoading(false); }
  };

  const openUserDetails = async (user: User, tab: ModalTab = 'profile') => {
    setSelectedUser(user);
    setActiveTab(tab);
    if (tab === 'history') loadUserTx(user._id);
  };

  const loadUserTx = async (userId: string) => {
    setTxLoading(true);
    try {
      const res = await (api.users as any).getTransactions?.(userId);
      if (res?.success && res.data) setUserTransactions(res.data);
      else setUserTransactions([]);
    } catch { setUserTransactions([]); }
    finally { setTxLoading(false); }
  };

  const handleBlockUser   = async (id: string) => { try { await api.users.blockUser(id, 'Blocked by admin'); toast.success('Blocked'); loadUsers(); } catch { toast.error('Failed'); } };
  const handleUnblockUser = async (id: string) => { try { await api.users.unblockUser(id); toast.success('Unblocked'); loadUsers(); } catch { toast.error('Failed'); } };

  const openBalanceModal = (user: User, type: 'add' | 'deduct') => {
    setBalanceTarget(user); setBalanceType(type);
    setBalanceAmount(''); setBalanceReason(''); setBalanceWallet('DEPOSIT');
    setShowBalanceModal(true);
  };

  const handleAdjustBalance = async () => {
    if (!balanceTarget || !balanceAmount || !balanceReason) { toast.error('Fill all fields'); return; }
    const amt = parseFloat(balanceAmount);
    if (isNaN(amt) || amt <= 0) { toast.error('Enter valid amount'); return; }
    setIsSavingBalance(true);
    try {
      const finalAmt = balanceType === 'deduct' ? -amt : amt;
      // FIX 10: Map UI values ('DEPOSIT'/'WINNINGS') to backend field names
      const walletType = balanceWallet === 'WINNINGS' ? 'winningsBalance' : 'depositBalance';
      await api.users.adjustBalance(balanceTarget._id, finalAmt, balanceReason, walletType);
      toast.success(`Balance ${balanceType === 'add' ? 'added' : 'deducted'}`);
      setShowBalanceModal(false);
      loadUsers();
    } catch (e: any) { toast.error(e.response?.data?.message || 'Failed'); }
    finally { setIsSavingBalance(false); }
  };

  const columns = [
    {
      key: 'user', label: 'User',
      render: (u: User) => (
        <div className="flex items-center space-x-3">
          <UserAvatar src={u.profilePic} name={u.username} />
          <div><p className="font-medium">{u.username}</p><p className="text-sm text-gray-400">{formatters.phone(u.mobile)}</p></div>
        </div>
      ),
    },
    {
      key: 'balance', label: 'Balance',
      render: (u: User) => (
        <div className="text-sm">
          <p><span className="text-gray-400">Dep:</span> {formatters.currency(u.depositBalance)}</p>
          <p><span className="text-gray-400">Win:</span> {formatters.currency(u.winningsBalance)}</p>
        </div>
      ),
    },
    { key: 'status',    label: 'Status', render: (u: User) => <StatusBadge status={u.status}    type="user" /> },
    { key: 'kycStatus', label: 'KYC',    render: (u: User) => <StatusBadge status={u.kycStatus} type="kyc"  /> },
    { key: 'joined', label: 'Joined', render: (u: User) => <span className="text-sm text-gray-400">{formatters.date(u.joinedAt)}</span> },
    {
      key: 'actions', label: 'Actions',
      render: (u: User) => (
        <div className="flex items-center space-x-1">
          <button onClick={() => openUserDetails(u, 'profile')} className="p-1.5 hover:bg-dark-700 rounded" title="Details"><Eye size={14} /></button>
          <button onClick={() => openBalanceModal(u, 'add')}    className="p-1.5 hover:bg-green-600/20 text-green-500 rounded" title="Add Balance"><Plus size={14} /></button>
          <button onClick={() => openBalanceModal(u, 'deduct')} className="p-1.5 hover:bg-red-600/20   text-red-400   rounded" title="Deduct"><Minus size={14} /></button>
          <button onClick={() => openUserDetails(u, 'history')} className="p-1.5 hover:bg-blue-600/20  text-blue-400  rounded" title="Tx History"><History size={14} /></button>
          <button onClick={() => openUserDetails(u, 'bank')}    className="p-1.5 hover:bg-purple-600/20 text-purple-400 rounded" title="Bank"><CreditCard size={14} /></button>
          <button onClick={() => { setPhantomUser(u); setPhantomLevel((u as any).phantomAccess || 'NONE'); }} className="p-1.5 hover:bg-yellow-600/20 text-yellow-400 rounded" title="Phantom Access"><Ghost size={14} /></button>
          {u.status === 'BLOCKED' ? (
            <button onClick={() => setConfirmAction({ type: 'unblock', user: u })} className="p-1.5 hover:bg-green-600/20 text-green-500 rounded" title="Unblock"><CheckCircle size={14} /></button>
          ) : (
            <button onClick={() => setConfirmAction({ type: 'block', user: u })}   className="p-1.5 hover:bg-red-600/20   text-red-500   rounded" title="Block"><Ban size={14} /></button>
          )}
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold mb-2">User Management</h1>
        <p className="text-gray-400">Manage users, balances, bank details and transaction history</p>
      </div>

      <div className="card">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="md:col-span-2">
            <SearchBar value={search} onChange={setSearch} placeholder="Search by name, mobile or email..." />
          </div>
          <select id="user-status-filter" name="statusFilter" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="input">
            <option value="ALL">All Status</option>
            <option value="ACTIVE">Active</option>
            <option value="BLOCKED">Blocked</option>
            <option value="SUSPENDED">Suspended</option>
            <option value="PENDING_KYC">Pending KYC</option>
          </select>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="card"><p className="text-sm text-gray-400 mb-1">Total</p><p className="text-2xl font-bold">{total.toLocaleString()}</p></div>
        <div className="card"><p className="text-sm text-gray-400 mb-1">Active</p><p className="text-2xl font-bold text-green-500">{users.filter(u => u.status === 'ACTIVE').length}</p></div>
        <div className="card"><p className="text-sm text-gray-400 mb-1">Blocked</p><p className="text-2xl font-bold text-red-500">{users.filter(u => u.status === 'BLOCKED').length}</p></div>
        <div className="card"><p className="text-sm text-gray-400 mb-1">KYC Pending</p><p className="text-2xl font-bold text-yellow-500">{users.filter(u => u.kycStatus !== 'APPROVED').length}</p></div>
      </div>

      <div className="card">
        <DataTable data={users} columns={columns} currentPage={page} totalPages={Math.ceil(total / limit)} onPageChange={setPage} isLoading={isLoading} />
      </div>

      {/* User Detail Modal */}
      {selectedUser && (
        <Modal isOpen={!!selectedUser} onClose={() => setSelectedUser(null)} title="User Details" size="lg">
          <div className="flex space-x-1 mb-6 bg-dark-800 rounded-lg p-1">
            {(['profile', 'bank', 'history'] as ModalTab[]).map((tab) => (
              <button key={tab} onClick={() => { setActiveTab(tab); if (tab === 'history') loadUserTx(selectedUser._id); }}
                className={`flex-1 py-2 px-3 rounded-md text-sm font-medium transition-colors ${activeTab === tab ? 'bg-dark-600 text-white' : 'text-gray-400 hover:text-white'}`}>
                {tab === 'bank' ? 'Bank Details' : tab === 'history' ? 'Tx History' : 'Profile'}
              </button>
            ))}
          </div>

          {activeTab === 'profile' && (
            <div className="space-y-4">
              <div className="flex items-center space-x-4">
                <UserAvatar src={selectedUser.profilePic} name={selectedUser.username} size="lg" />
                <div>
                  <h3 className="text-xl font-bold">{selectedUser.username}</h3>
                  <p className="text-gray-400">{formatters.phone(selectedUser.mobile)}</p>
                  {selectedUser.email && <p className="text-sm text-gray-400">{selectedUser.email}</p>}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="p-3 bg-dark-700 rounded-lg"><p className="text-xs text-gray-400 mb-1">Deposit Balance</p><p className="text-xl font-bold text-green-500">{formatters.currency(selectedUser.depositBalance)}</p><p className="text-xs text-gray-500">Non-withdrawable</p></div>
                <div className="p-3 bg-dark-700 rounded-lg"><p className="text-xs text-gray-400 mb-1">Winnings Balance</p><p className="text-xl font-bold text-gold-500">{formatters.currency(selectedUser.winningsBalance)}</p><p className="text-xs text-gray-500">Withdrawable</p></div>
                <div className="p-3 bg-dark-700 rounded-lg"><p className="text-xs text-gray-400 mb-1">Locked</p><p className="text-xl font-bold text-yellow-500">{formatters.currency(selectedUser.lockedBalance)}</p></div>
                <div className="p-3 bg-dark-700 rounded-lg"><p className="text-xs text-gray-400 mb-1">Total</p><p className="text-xl font-bold">{formatters.currency((selectedUser.depositBalance||0)+(selectedUser.winningsBalance||0))}</p></div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div><p className="text-xs text-gray-400 mb-1">Status</p><StatusBadge status={selectedUser.status} type="user" /></div>
                <div><p className="text-xs text-gray-400 mb-1">KYC</p><StatusBadge status={selectedUser.kycStatus} type="kyc" /></div>
              </div>

              {selectedUser.kycData && (
                <div className="bg-dark-700 rounded-lg p-4 text-sm">
                  <p className="font-semibold mb-3 text-gray-300">KYC Data</p>
                  <div className="grid grid-cols-2 gap-2">
                    <div><p className="text-gray-400">Name</p><p>{selectedUser.kycData.nameOnAadhaar}</p></div>
                    <div><p className="text-gray-400">Aadhaar</p><p className="font-mono">XXXX-{selectedUser.kycData.aadhaarNumber?.slice(-4)}</p></div>
                    <div><p className="text-gray-400">Submitted</p><p>{formatters.date(selectedUser.kycData.submittedAt)}</p></div>
                  </div>
                </div>
              )}

              <p className="text-sm text-gray-400">Joined: {formatters.datetime(selectedUser.joinedAt)}</p>

              <div className="flex gap-3 pt-2 border-t border-dark-700">
                <button onClick={() => openBalanceModal(selectedUser, 'add')} className="flex-1 flex items-center justify-center bg-green-600 hover:bg-green-700 py-2 rounded-lg text-sm font-medium"><Plus size={14} className="mr-1" />Add Balance</button>
                <button onClick={() => openBalanceModal(selectedUser, 'deduct')} className="flex-1 flex items-center justify-center bg-red-600 hover:bg-red-700 py-2 rounded-lg text-sm font-medium"><Minus size={14} className="mr-1" />Deduct</button>
              </div>
            </div>
          )}

          {activeTab === 'bank' && (
            <div>
              {selectedUser.bankDetails ? (
                <div className="bg-dark-700 rounded-lg p-5 space-y-3 text-sm">
                  <div className="flex justify-between"><span className="text-gray-400">Account Holder</span><span className="font-semibold">{selectedUser.bankDetails.accountHolderName}</span></div>
                  <div className="flex justify-between"><span className="text-gray-400">Account Number</span><span className="font-mono font-semibold">{selectedUser.bankDetails.accountNumber}</span></div>
                  <div className="flex justify-between"><span className="text-gray-400">IFSC Code</span><span className="font-mono font-semibold">{selectedUser.bankDetails.ifscCode}</span></div>
                  <div className="flex justify-between"><span className="text-gray-400">Bank Name</span><span className="font-semibold">{selectedUser.bankDetails.bankName}</span></div>
                </div>
              ) : (
                <div className="text-center py-12 text-gray-500">
                  <CreditCard size={40} className="mx-auto mb-3 opacity-30" />
                  <p>No bank details added</p>
                </div>
              )}
            </div>
          )}

          {activeTab === 'history' && (
            <div>
              {txLoading ? (
                <div className="text-center py-8 text-gray-400">Loading transactions...</div>
              ) : userTransactions.length === 0 ? (
                <div className="text-center py-8 text-gray-500"><History size={36} className="mx-auto mb-3 opacity-30"/><p>No transactions found</p></div>
              ) : (
                <div className="space-y-2 max-h-96 overflow-y-auto pr-1">
                  {userTransactions.map((tx: any) => (
                    <div key={tx._id} className="flex items-center justify-between bg-dark-700 rounded-lg px-4 py-3 text-sm">
                      <div>
                        <p className="font-medium">{tx.type.replace(/_/g, ' ')}</p>
                        <p className="text-xs text-gray-400">{formatters.datetime(tx.date || tx.timestamp)}</p>
                        {tx.referenceId   && <p className="text-xs text-gray-500 font-mono">Ref: {tx.referenceId}</p>}
                        {tx.orderId       && <p className="text-xs text-gray-500 font-mono">Order: {tx.orderId}</p>}
                        {tx.cycleId       && <p className="text-xs text-gray-500">Cycle: {tx.cycleType} {tx.cycleWinner ? `→ ${tx.cycleWinner} won` : ''}</p>}
                        {tx.merchantName  && <p className="text-xs text-gray-500">Merchant: {tx.merchantName}</p>}
                        {tx.side          && <p className="text-xs text-blue-400">Side: {tx.side}</p>}
                        {tx.source === 'bet' && tx.payout > 0 && <p className="text-xs text-green-400">Payout: {formatters.currency(tx.payout)}</p>}
                      </div>
                      <div className="text-right">
                        <span className={`font-semibold ${tx.status === 'WON' ? 'text-green-400' : tx.status === 'LOST' ? 'text-red-400' : tx.type === 'DEPOSIT' ? 'text-green-400' : tx.type?.startsWith('BET_') ? 'text-yellow-400' : 'text-red-400'}`}>
                          {tx.amount ? formatters.currency(tx.amount) : '-'}
                        </span>
                        <p className="text-xs text-gray-500 capitalize">{(tx.status || '').toLowerCase()}</p>
                        {tx.source && tx.source !== 'transaction' && <p className="text-xs text-gray-600 capitalize">{tx.source.replace('_', ' ')}</p>}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </Modal>
      )}

      {/* Balance Modal */}
      {showBalanceModal && balanceTarget && (
        <Modal isOpen={showBalanceModal} onClose={() => setShowBalanceModal(false)} title={balanceType === 'add' ? 'Add Balance' : 'Deduct Balance'}>
          <div className="space-y-4">
            <div className="bg-dark-700 rounded-lg p-4 text-sm">
              <p className="text-gray-400">User</p>
              <p className="font-semibold">{balanceTarget.username} — {formatters.phone(balanceTarget.mobile)}</p>
              <div className="grid grid-cols-2 gap-2 mt-2">
                <div><span className="text-gray-400">Deposit: </span><span className="text-green-400">{formatters.currency(balanceTarget.depositBalance)}</span></div>
                <div><span className="text-gray-400">Winnings: </span><span className="text-gold-400">{formatters.currency(balanceTarget.winningsBalance)}</span></div>
              </div>
            </div>

            <div>
              <label htmlFor="balance-wallet" className="label">Target Wallet</label>
              <select id="balance-wallet" name="balanceWallet" value={balanceWallet} onChange={(e) => setBalanceWallet(e.target.value as any)} className="input">
                <option value="DEPOSIT">Deposit Balance (betting only, non-withdrawable)</option>
                <option value="WINNINGS">Winnings Balance (withdrawable)</option>
              </select>
            </div>

            <div>
              <label htmlFor="balance-amount" className="label">Amount (₹)</label>
              <input id="balance-amount" name="balanceAmount" type="number" min="1" value={balanceAmount} onChange={(e) => setBalanceAmount(e.target.value)} className="input" placeholder="0" />
            </div>

            <div>
              <label htmlFor="balance-reason" className="label">Reason</label>
              <input id="balance-reason" name="balanceReason" type="text" value={balanceReason} onChange={(e) => setBalanceReason(e.target.value)} className="input" placeholder="e.g. Bonus, Correction, Refund" />
            </div>

            <div className="flex gap-3">
              <button onClick={() => setShowBalanceModal(false)} className="flex-1 btn-secondary">Cancel</button>
              <button onClick={handleAdjustBalance} disabled={isSavingBalance}
                className={`flex-1 py-2 px-4 rounded-lg font-semibold text-white transition-colors disabled:opacity-50 ${balanceType === 'add' ? 'bg-green-600 hover:bg-green-700' : 'bg-red-600 hover:bg-red-700'}`}>
                {isSavingBalance ? 'Saving...' : balanceType === 'add' ? 'Add Balance' : 'Deduct Balance'}
              </button>
            </div>
          </div>
        </Modal>
      )}

      {confirmAction && (
        <ConfirmDialog isOpen={!!confirmAction} onClose={() => setConfirmAction(null)}
          onConfirm={() => { confirmAction.type === 'block' ? handleBlockUser(confirmAction.user._id) : handleUnblockUser(confirmAction.user._id); }}
          title={confirmAction.type === 'block' ? 'Block User' : 'Unblock User'}
          message={`Are you sure you want to ${confirmAction.type} ${confirmAction.user.username}?`}
          type={confirmAction.type === 'block' ? 'danger' : 'warning'}
          confirmText={confirmAction.type === 'block' ? 'Block' : 'Unblock'}
        />
      )}

      {phantomUser && (
        <Modal isOpen onClose={() => setPhantomUser(null)} title="Set Phantom Access">
          <div className="space-y-4">
            <div className="bg-dark-700 rounded-lg p-4 text-sm">
              <p className="text-gray-400">User</p>
              <p className="font-semibold">{phantomUser.username} — {formatters.phone(phantomUser.mobile)}</p>
              <p className="text-xs text-gray-500 mt-1">Current: {(phantomUser as any).phantomAccess || 'NONE'}</p>
            </div>
            <div>
              <label className="label">Phantom Access Level</label>
              <select value={phantomLevel} onChange={e => setPhantomLevel(e.target.value)} className="input">
                <option value="NONE">NONE — No phantom betting</option>
                <option value="30_MIN">30_MIN — 30-minute cycles only</option>
                <option value="FULL_DAY">FULL_DAY — Full-day cycles only</option>
                <option value="BOTH">BOTH — All cycles</option>
              </select>
            </div>
            <p className="text-xs text-yellow-400">⚠️ Phantom bets are cosmetic — they never win and don't affect real pools. Use to balance pool display only.</p>
            <div className="flex gap-3">
              <button onClick={() => setPhantomUser(null)} className="flex-1 btn-secondary">Cancel</button>
              <button onClick={handleSetPhantomAccess} disabled={isSavingPhantom} className="flex-1 btn-primary disabled:opacity-50">
                {isSavingPhantom ? 'Saving...' : 'Save Access'}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
};

