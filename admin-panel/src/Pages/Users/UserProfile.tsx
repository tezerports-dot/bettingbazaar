// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
//
// One player's page (owner, 2026-10-14): what they hold, what they have put in
// and taken out, how they are doing, and every control an operator uses on
// them, on the page itself. No pop-ups: a control that needs a reason asks for
// it beside the button, and the one that cannot be undone (closing the
// account) asks a second time in place.
//
// Each control is offered only to an account whose AREA admits it (block and
// close: canManageUsers, this screen's area; balance: canAdjustBalances;
// phantom-bettor access: canManagePhantomAgents), and only on a PLAYER, since
// the routes refuse anything else.
import React, { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import { ArrowLeft, CreditCard } from 'lucide-react';
import { StatusBadge } from '../../components/StatusBadge';
import { DisputeRecordBadge } from '../../components/DisputeRecordBadge';
import { UserAvatar } from '../../components/UserAvatar';
import { Kpis } from '../../components/design';
import { formatters, CONTACT_HIDDEN } from '../../utils/formatters';
import { usePermissions } from '../../hooks/usePermission';
import { useBoards } from '../../hooks/useBoards';
import api from '../../services/api';
import type { PlayerRow } from '../../types';
import toast from 'react-hot-toast';

interface ProfileUser {
  userId: string; username: string; mobile?: string; status: PlayerRow['status'];
  accountType?: string; profilePic?: string; phantomAccess?: string;
  blockReason?: string | null; joinedAt: string; lastLogin?: string | null;
  // Account number, IFSC and UPI ID reach full admins only (staffContactShield.js).
  bankDetails?: { accountHolderName: string; accountNumber?: string; ifscCode?: string; bankName: string; upiId?: string } | null;
}
interface Profile {
  user: ProfileUser;
  summary: PlayerRow | null;
  escrow: { inSellOrders: number; inDispute: number } | null;
  recentBets: any;
  recentTransactions: any[];
}

const errorOf = (e: any, fallback: string) => e?.response?.data?.message || fallback;

const Section: React.FC<{ title: string; children: React.ReactNode; sub?: string }> = ({ title, sub, children }) => (
  <section className="card p-4 space-y-3">
    <div>
      <h2 className="text-sm font-semibold text-gray-200">{title}</h2>
      {sub && <p className="text-xs text-gray-500 mt-0.5">{sub}</p>}
    </div>
    {children}
  </section>
);

export const UserProfile: React.FC = () => {
  const { userId = '' } = useParams();
  const { can } = usePermissions();
  const { boards } = useBoards();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [problem, setProblem] = useState('');
  const [busy, setBusy] = useState('');

  const [blockReason, setBlockReason] = useState('');
  const [wallet, setWallet] = useState<'depositBalance' | 'winningsBalance'>('depositBalance');
  const [amount, setAmount] = useState('');
  const [adjustReason, setAdjustReason] = useState('');
  const [phantom, setPhantom] = useState('NONE');
  const [confirmClose, setConfirmClose] = useState(false);
  const [history, setHistory] = useState<any[] | null>(null);

  const load = useCallback(async () => {
    setProblem('');
    try {
      const res = await api.users.getProfile(userId);
      if (!res?.success) { setProblem(res?.message || 'Could not load this player.'); return; }
      setProfile(res as Profile);
      setPhantom(res.user?.phantomAccess || 'NONE');
    } catch (e: any) { setProblem(errorOf(e, 'Could not load this player.')); }
  }, [userId]);

  useEffect(() => { void load(); }, [load]);

  if (problem) {
    return (
      <div className="om-fade space-y-3">
        <Link to="/users" className="inline-flex items-center gap-1 text-sm text-gray-400 hover:text-white"><ArrowLeft size={14} /> Players</Link>
        <p role="alert" className="text-red-400">{problem}</p>
      </div>
    );
  }
  if (!profile) return <div className="py-12 text-center text-gray-400" role="status">Loading player…</div>;

  const { user, summary, escrow } = profile;
  const isPlayer = user.accountType === 'PLAYER' && user.status !== 'DELETED';
  const canUsers = can('canManageUsers');
  const canAdjust = can('canAdjustBalances') && isPlayer;
  const canPhantom = can('canManagePhantomAgents') && isPlayer;
  const bets: any[] = Array.isArray(profile.recentBets) ? profile.recentBets : (profile.recentBets?.bets ?? []);

  const run = async (key: string, fn: () => Promise<unknown>, ok: string, fail: string) => {
    setBusy(key);
    try { await fn(); toast.success(ok); await load(); return true; }
    catch (e: any) { toast.error(errorOf(e, fail)); return false; }
    finally { setBusy(''); }
  };

  const block = async () => {
    if (!blockReason.trim()) { toast.error('Write why you are blocking this player.'); return; }
    if (await run('block', () => api.users.blockUser(user.userId, blockReason.trim()), 'Player blocked', 'Failed to block')) setBlockReason('');
  };
  const unblock = () => run('unblock', () => api.users.unblockUser(user.userId), 'Player unblocked', 'Failed to unblock');

  const adjust = async (direction: 'add' | 'deduct') => {
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0) { toast.error('Enter an amount above zero.'); return; }
    if (!adjustReason.trim()) { toast.error('Write the reason for the audit trail.'); return; }
    const done = await run(direction,
      () => api.users.adjustBalance(user.userId, direction === 'deduct' ? -amt : amt, adjustReason.trim(), wallet),
      direction === 'add' ? 'Balance added' : 'Balance deducted', 'Failed to adjust the balance');
    if (done) { setAmount(''); setAdjustReason(''); }
  };

  const savePhantom = () => run('phantom',
    () => api.post(`/api/admin/users/${user.userId}/phantom-access`, { accessLevel: phantom }),
    `Phantom-bettor access set to ${phantom}`, 'Failed to set phantom-bettor access');

  const closeAccount = async () => {
    if (await run('close', () => api.users.deleteUser(user.userId), 'Account closed', 'Failed to delete the account')) setConfirmClose(false);
  };

  const loadHistory = async () => {
    setBusy('history');
    try {
      const res = await api.users.getTransactions(user.userId);
      setHistory(res?.success && Array.isArray(res.data) ? res.data : []);
    } catch { setHistory([]); }
    finally { setBusy(''); }
  };

  return (
    <div className="om-fade space-y-4">
      <Link to="/users" className="inline-flex items-center gap-1 text-sm text-gray-400 hover:text-white"><ArrowLeft size={14} /> Players</Link>

      <header className="flex flex-wrap items-center gap-4">
        <UserAvatar src={user.profilePic} name={user.username} size="lg" />
        <div className="flex-1 min-w-0">
          <h1 className="text-xl font-bold truncate">{user.username}</h1>
          <p className="text-gray-400 text-sm">{formatters.phone(user.mobile)} · joined {formatters.date(user.joinedAt)}
            {user.lastLogin ? ` · last seen ${formatters.datetime(user.lastLogin)}` : ''}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge status={user.status} type="user" />
          {summary && <span className="text-xs px-2 py-0.5 rounded-sm bg-dark-700 text-gray-300">Plays {summary.playProfile}</span>}
          {summary && <DisputeRecordBadge lostDisputes={summary.lostDisputes} highRiskAt={summary.highRiskAt} />}
        </div>
      </header>

      {summary && (
        <Kpis min={160} items={[
          { label: 'VIP wallet', value: formatters.paise(summary.wallet.vipPaise) },
          { label: 'General wallet', value: formatters.paise(summary.wallet.generalPaise) },
          { label: 'Locked in bets', value: formatters.paise(summary.wallet.lockedPaise), tone: summary.wallet.lockedPaise > 0 ? 'var(--warning)' : undefined },
          { label: 'In sell orders', value: formatters.currency(escrow?.inSellOrders ?? 0) },
          { label: 'In dispute', value: formatters.currency(escrow?.inDispute ?? 0), tone: (escrow?.inDispute ?? 0) > 0 ? 'var(--danger)' : undefined },
          { label: `Total deposits (${summary.totals.depositCount})`, value: formatters.paise(summary.totals.depositsPaise) },
          { label: 'Total sold', value: formatters.paise(summary.totals.withdrawalsPaise) },
          {
            label: 'Net win / loss', value: formatters.signedPaise(summary.totals.netPaise),
            tone: summary.totals.netPaise > 0 ? 'var(--success)' : summary.totals.netPaise < 0 ? 'var(--danger)' : undefined,
          },
        ]} />
      )}
      {summary && (
        <p className="text-xs text-gray-500">
          VIP wallet = deposit {formatters.paise(summary.wallet.depositPaise)} + winnings {formatters.paise(summary.wallet.winningsPaise)}.
          Net win / loss counts settled board bets and casino rounds; phantom bets are not counted.
        </p>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        {canUsers && (
          <Section title="Account" sub={user.status === 'BLOCKED' ? `Blocked: ${user.blockReason || 'no reason recorded'}` : 'A blocked player cannot sign in or place orders.'}>
            {user.status === 'BLOCKED' ? (
              <button type="button" className="btn-primary" disabled={busy === 'unblock'} onClick={() => void unblock()}>
                {busy === 'unblock' ? 'Unblocking…' : 'Unblock player'}
              </button>
            ) : (
              <div className="flex flex-wrap gap-2">
                <label htmlFor="block-reason" className="sr-only">Reason for blocking</label>
                <input id="block-reason" className="input flex-1 min-w-[12rem]" placeholder="Reason for blocking (required)"
                  value={blockReason} onChange={(e) => setBlockReason(e.target.value)} />
                <button type="button" className="px-4 py-2 rounded-lg text-sm font-semibold bg-red-600 hover:bg-red-700 text-white disabled:opacity-50"
                  disabled={busy === 'block' || !isPlayer} onClick={() => void block()}>
                  {busy === 'block' ? 'Blocking…' : 'Block player'}
                </button>
              </div>
            )}
            {isPlayer && (
              <div className="pt-3 border-t border-dark-700">
                {!confirmClose ? (
                  <button type="button" className="text-sm text-red-400 hover:text-red-300" onClick={() => setConfirmClose(true)}>Close this account…</button>
                ) : (
                  <div role="group" aria-label="Close account" className="space-y-2">
                    <p className="text-sm text-red-300">
                      Close {user.username}&apos;s account? They will be signed out everywhere and cannot sign in again. Their bets,
                      orders and ledger are kept. This cannot be undone from the panel.
                    </p>
                    <div className="flex gap-2">
                      <button type="button" className="px-4 py-2 rounded-lg text-sm font-semibold bg-red-600 hover:bg-red-700 text-white disabled:opacity-50"
                        disabled={busy === 'close'} onClick={() => void closeAccount()}>
                        {busy === 'close' ? 'Closing…' : 'Yes, close the account'}
                      </button>
                      <button type="button" className="btn-secondary" onClick={() => setConfirmClose(false)}>Keep it</button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </Section>
        )}

        {canAdjust && (
          <Section title="Adjust balance" sub="A manual credit or debit, recorded with your reason in the audit trail.">
            <div className="grid gap-2 sm:grid-cols-2">
              <div>
                <label htmlFor="adjust-wallet" className="label">Wallet</label>
                <select id="adjust-wallet" className="input" value={wallet} onChange={(e) => setWallet(e.target.value as typeof wallet)}>
                  <option value="depositBalance">Deposit (betting only, not withdrawable)</option>
                  <option value="winningsBalance">Winnings (withdrawable)</option>
                </select>
              </div>
              <div>
                <label htmlFor="adjust-amount" className="label">Amount (₹)</label>
                <input id="adjust-amount" className="input" type="number" min="1" value={amount} onChange={(e) => setAmount(e.target.value)} />
              </div>
            </div>
            <div>
              <label htmlFor="adjust-reason" className="label">Reason</label>
              <input id="adjust-reason" className="input" placeholder="e.g. Bonus, correction, refund" value={adjustReason} onChange={(e) => setAdjustReason(e.target.value)} />
            </div>
            <div className="flex gap-2">
              <button type="button" className="flex-1 py-2 rounded-lg text-sm font-semibold bg-green-600 hover:bg-green-700 text-white disabled:opacity-50"
                disabled={!!busy} onClick={() => void adjust('add')}>{busy === 'add' ? 'Adding…' : 'Add'}</button>
              <button type="button" className="flex-1 py-2 rounded-lg text-sm font-semibold bg-red-600 hover:bg-red-700 text-white disabled:opacity-50"
                disabled={!!busy} onClick={() => void adjust('deduct')}>{busy === 'deduct' ? 'Deducting…' : 'Deduct'}</button>
            </div>
          </Section>
        )}

        {canPhantom && (
          <Section title="Phantom-bettor access" sub="Phantom bets are cosmetic: they never win and never touch real pools.">
            <div className="flex flex-wrap gap-2">
              <label htmlFor="phantom-access-level" className="sr-only">Phantom-bettor access level</label>
              <select id="phantom-access-level" className="input flex-1 min-w-[12rem]" value={phantom} onChange={(e) => setPhantom(e.target.value)}>
                <option value="NONE">None</option>
                {boards.map((b) => <option key={b.key} value={b.key}>{b.name} only</option>)}
                <option value="BOTH">Every board</option>
              </select>
              <button type="button" className="btn-primary disabled:opacity-50" disabled={busy === 'phantom' || phantom === (user.phantomAccess || 'NONE')}
                onClick={() => void savePhantom()}>{busy === 'phantom' ? 'Saving…' : 'Save'}</button>
            </div>
          </Section>
        )}

        <Section title="Bank account" sub="Where this player's sells are paid.">
          {user.bankDetails ? (
            <dl className="grid grid-cols-2 gap-y-2 text-sm">
              <dt className="text-gray-400">Account holder</dt><dd className="font-semibold">{user.bankDetails.accountHolderName}</dd>
              <dt className="text-gray-400">Account number</dt><dd className="font-mono">{user.bankDetails.accountNumber ?? CONTACT_HIDDEN}</dd>
              <dt className="text-gray-400">IFSC</dt><dd className="font-mono">{user.bankDetails.ifscCode ?? CONTACT_HIDDEN}</dd>
              <dt className="text-gray-400">Bank</dt><dd>{user.bankDetails.bankName}</dd>
              <dt className="text-gray-400">UPI ID</dt><dd className="font-mono">{user.bankDetails.upiId ?? CONTACT_HIDDEN}</dd>
            </dl>
          ) : (
            <p className="text-sm text-gray-500 flex items-center gap-2"><CreditCard size={16} className="opacity-40" /> No bank account added.</p>
          )}
        </Section>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Section title="Recent bets">
          {bets.length === 0 ? <p className="text-sm text-gray-500">No bets yet.</p> : (
            <ul className="divide-y divide-dark-700 text-sm">
              {bets.map((b) => (
                <li key={b.betId || b.id} className="flex justify-between py-2">
                  <span>{b.cycleType || 'Board'} · {b.side} <span className="text-xs text-gray-500">{formatters.datetime(b.placedAt || b.timestamp)}</span></span>
                  <span className={b.status === 'WON' ? 'text-green-400' : b.status === 'LOST' ? 'text-red-400' : 'text-gray-400'}>
                    {formatters.currency(b.amount)} · {String(b.status).toLowerCase()}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section title="Wallet movements">
          {(history ?? profile.recentTransactions ?? []).length === 0 ? <p className="text-sm text-gray-500">No movements yet.</p> : (
            <ul className="divide-y divide-dark-700 text-sm max-h-96 overflow-y-auto pr-1">
              {(history ?? profile.recentTransactions).map((tx: any, i: number) => (
                <li key={tx.txId || tx._id || i} className="flex justify-between gap-3 py-2">
                  <span className="min-w-0">
                    <span className="block truncate">{String(tx.reason || tx.type || '').replace(/_/g, ' ')}</span>
                    <span className="text-xs text-gray-500">{formatters.datetime(tx.createdAt || tx.date || tx.timestamp)}</span>
                  </span>
                  <span className={`shrink-0 ${tx.type === 'DEBIT' ? 'text-red-400' : 'text-green-400'}`}>{formatters.currency(tx.amount)}</span>
                </li>
              ))}
            </ul>
          )}
          {history === null && (
            <button type="button" className="btn-secondary text-sm" disabled={busy === 'history'} onClick={() => void loadHistory()}>
              {busy === 'history' ? 'Loading…' : 'Show full history'}
            </button>
          )}
        </Section>
      </div>
    </div>
  );
};
