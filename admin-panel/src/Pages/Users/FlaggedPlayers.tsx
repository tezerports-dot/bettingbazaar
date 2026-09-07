// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * Flagged Players — where a merchant's payment complaint gets decided.
 *
 * ── Why this screen exists ──────────────────────────────────────────────────
 * A merchant rejecting a paid order used to BLOCK the player outright once
 * three rejections had accumulated, with no admin in the loop. Three merchants
 * — or one merchant three times, or two honest mistakes and one bad actor —
 * and a player was locked out of their own balance: `is_blocked` refuses them
 * at `authenticate`, so they could not see their wallet, their orders, or any
 * notice explaining why.
 *
 * The rejection now warns and flags. Nothing blocks. This screen is the other
 * half of that decision, and without it the change would have moved the block
 * from an automatic rule to nobody at all: `payment_flagged` was written on
 * every rejection, an index was created for it, and no query ever came back
 * for it.
 *
 * ── The proof is the point ──────────────────────────────────────────────────
 * A rejection is one merchant's unreviewed word about someone else's money.
 * The merchant's stated reason and the screenshot they uploaded are shown
 * here BEFORE either action, because the alternative is an admin blocking a
 * player on a row count. A rejection with no proof image is itself a signal —
 * it is rendered as a gap, not hidden.
 */
import React, { useEffect, useState } from 'react';
import { Flag, ShieldAlert, Ban, CheckCircle2, RefreshCw, ExternalLink, AlertTriangle } from 'lucide-react';
import { Modal } from '../../components/Modal';
import { UserAvatar } from '../../components/UserAvatar';
import { formatters } from '../../utils/formatters';
import api from '../../services/api';
import toast from 'react-hot-toast';

interface Rejection {
  orderId: string;
  reason: string | null;
  proofUrl: string | null;
  rejectedAt: string | null;
  merchantId: string | null;
  amountPaise: number | null;
}

interface FlaggedPlayer {
  userId: string;
  username: string;
  mobile: string;
  warningCount: number;
  paymentFlagCount: number;
  paymentFlagReason: string | null;
  paymentFlaggedAt: string | null;
  isBlocked: boolean;
  overWarningThreshold: boolean;
  lastRejection: Rejection | null;
}

export const FlaggedPlayers: React.FC = () => {
  const [players, setPlayers] = useState<FlaggedPlayer[]>([]);
  const [threshold, setThreshold] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [blockTarget, setBlockTarget] = useState<FlaggedPlayer | null>(null);
  const [blockReason, setBlockReason] = useState('');
  const [clearTarget, setClearTarget] = useState<FlaggedPlayer | null>(null);
  const [resetWarnings, setResetWarnings] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const res = await api.users.getFlagged();
      if (res?.success) {
        setPlayers(res.players || []);
        setThreshold(Number(res.warningThreshold) || 0);
      } else {
        toast.error(res?.message || 'Failed to load flagged players');
      }
    } catch { toast.error('Failed to load flagged players'); }
    finally { setLoading(false); }
  };

  useEffect(() => { load(); }, []);

  const doBlock = async () => {
    if (!blockTarget) return;
    // A block needs a reason — `users_blocked_has_reason` refuses a blocked row
    // without one, so submitting an empty box would be a 400 the admin cannot
    // act on. It is required here, where the admin can still type it.
    if (blockReason.trim().length < 10) {
      toast.error('A block needs a reason of at least 10 characters — the player is shown it.');
      return;
    }
    setBusy(blockTarget.userId);
    try {
      await api.users.blockUser(blockTarget.userId, blockReason.trim());
      toast.success(`${blockTarget.username} blocked`);
      setBlockTarget(null); setBlockReason('');
      load();
    } catch (e: any) { toast.error(e.response?.data?.message || 'Block failed'); }
    finally { setBusy(null); }
  };

  const doClear = async () => {
    if (!clearTarget) return;
    setBusy(clearTarget.userId);
    try {
      await api.users.clearFlag(clearTarget.userId, resetWarnings);
      toast.success(resetWarnings ? 'Flag cleared and warnings reset' : 'Flag cleared');
      setClearTarget(null); setResetWarnings(false);
      load();
    } catch (e: any) { toast.error(e.response?.data?.message || 'Clear failed'); }
    finally { setBusy(null); }
  };

  const overCount = players.filter(p => p.overWarningThreshold).length;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Flag size={22} className="text-orange-400" /> Flagged Players
          </h1>
          <p className="text-gray-400 text-sm mt-1 max-w-3xl">
            A merchant rejected a payment these players said they made. A rejection warns and
            flags — it does not block. The block is yours to make, from the merchant's reason
            and proof below.
          </p>
        </div>
        <button onClick={load} disabled={loading}
          className="p-2 hover:bg-dark-700 rounded-lg disabled:opacity-50" title="Refresh">
          <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      <div className="grid sm:grid-cols-3 gap-4">
        <div className="card">
          <p className="text-xs uppercase tracking-wider text-gray-500">Flagged</p>
          <p className="text-2xl font-bold mt-1">{players.length}</p>
        </div>
        <div className="card">
          <p className="text-xs uppercase tracking-wider text-gray-500">At or over threshold</p>
          <p className={`text-2xl font-bold mt-1 ${overCount ? 'text-orange-400' : ''}`}>{overCount}</p>
        </div>
        <div className="card">
          <p className="text-xs uppercase tracking-wider text-gray-500">Review threshold</p>
          <p className="text-2xl font-bold mt-1">{threshold > 0 ? threshold : 'Off'}</p>
          <p className="text-[11px] text-gray-500 mt-1">System Settings → risk rules</p>
        </div>
      </div>

      {loading ? (
        <div className="card text-center py-16 text-gray-400">Loading…</div>
      ) : players.length === 0 ? (
        <div className="card text-center py-16">
          <CheckCircle2 size={32} className="text-green-400 mx-auto mb-3" />
          <p className="text-gray-300">No flagged players.</p>
          <p className="text-sm text-gray-500 mt-1">No merchant has disputed a player's payment.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {players.map(p => (
            <div key={p.userId}
              className={`card space-y-4 ${p.overWarningThreshold ? 'border-l-2 border-orange-500' : ''}`}>
              <div className="flex items-start justify-between gap-4 flex-wrap">
                <div className="flex items-center gap-3 min-w-0">
                  <UserAvatar name={p.username} />
                  <div className="min-w-0">
                    <p className="font-semibold text-gray-100 truncate">
                      {p.username}
                      {p.isBlocked && (
                        <span className="ml-2 text-[10px] uppercase tracking-wider bg-red-500/15 text-red-400 px-1.5 py-0.5 rounded">
                          Blocked
                        </span>
                      )}
                    </p>
                    <p className="text-xs text-gray-500 font-mono">{formatters.phone(p.mobile)}</p>
                  </div>
                </div>
                <div className="flex items-center gap-5 text-sm">
                  <div className="text-right">
                    <p className="text-[11px] uppercase tracking-wider text-gray-500">Warnings</p>
                    <p className={`font-semibold ${p.overWarningThreshold ? 'text-orange-400' : 'text-gray-200'}`}>
                      {p.warningCount}{threshold > 0 ? ` / ${threshold}` : ''}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-[11px] uppercase tracking-wider text-gray-500">Complaints</p>
                    <p className="font-semibold text-gray-200">{p.paymentFlagCount}</p>
                  </div>
                  <div className="text-right">
                    <p className="text-[11px] uppercase tracking-wider text-gray-500">Flagged</p>
                    <p className="text-gray-300">
                      {p.paymentFlaggedAt ? formatters.datetime(p.paymentFlaggedAt) : '—'}
                    </p>
                  </div>
                </div>
              </div>

              {p.overWarningThreshold && (
                <p className="flex items-center gap-2 text-xs text-orange-400">
                  <AlertTriangle size={13} className="shrink-0" />
                  At or past the review threshold. This is a prompt to look, not a verdict —
                  nothing has been done to this account.
                </p>
              )}

              <div className="bg-dark-800 rounded-lg p-4 space-y-3">
                <p className="text-[11px] uppercase tracking-wider text-gray-500">
                  The merchant's complaint
                </p>
                <p className="text-sm text-gray-200 whitespace-pre-wrap break-words">
                  {p.lastRejection?.reason || p.paymentFlagReason || 'No reason recorded.'}
                </p>
                {p.lastRejection && (
                  <p className="text-xs text-gray-500 font-mono">
                    Order {p.lastRejection.orderId}
                    {p.lastRejection.amountPaise != null && ` · ₹${(p.lastRejection.amountPaise / 100).toLocaleString('en-IN')}`}
                    {p.lastRejection.merchantId && ` · merchant ${p.lastRejection.merchantId}`}
                    {p.lastRejection.rejectedAt && ` · ${formatters.datetime(p.lastRejection.rejectedAt)}`}
                  </p>
                )}
                {p.lastRejection?.proofUrl ? (
                  <a href={p.lastRejection.proofUrl} target="_blank" rel="noopener noreferrer"
                    className="inline-block group">
                    <img src={p.lastRejection.proofUrl} alt="Merchant's proof"
                      className="max-h-56 rounded-lg border border-dark-600 group-hover:border-gray-500" />
                    <span className="mt-1 inline-flex items-center gap-1 text-xs text-gray-400 group-hover:text-gray-200">
                      <ExternalLink size={11} /> Open full size
                    </span>
                  </a>
                ) : (
                  // Rendered, not hidden: a complaint with no evidence is a
                  // reason to doubt it, and an admin cannot weigh what they
                  // are not shown.
                  <p className="flex items-center gap-2 text-xs text-yellow-500">
                    <AlertTriangle size={13} className="shrink-0" />
                    No proof image on this rejection.
                  </p>
                )}
              </div>

              <div className="flex items-center gap-2 flex-wrap">
                <button onClick={() => { setBlockTarget(p); setBlockReason(''); }}
                  disabled={busy !== null || p.isBlocked}
                  className="btn-danger text-sm flex items-center gap-1.5 disabled:opacity-40">
                  <Ban size={14} /> {p.isBlocked ? 'Already blocked' : 'Block player'}
                </button>
                <button onClick={() => { setClearTarget(p); setResetWarnings(false); }}
                  disabled={busy !== null}
                  className="btn-secondary text-sm flex items-center gap-1.5 disabled:opacity-40">
                  <CheckCircle2 size={14} /> Clear flag
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <Modal isOpen={!!blockTarget} onClose={() => setBlockTarget(null)}
        title={`Block ${blockTarget?.username ?? ''}`}>
        <div className="space-y-4">
          <p className="flex items-start gap-2 text-sm text-red-300 bg-red-500/10 rounded-lg p-3">
            <ShieldAlert size={16} className="shrink-0 mt-0.5" />
            <span>
              A blocked player is refused at sign-in. They cannot see their wallet, their
              orders, or this reason — so it needs to be one support can repeat to them.
            </span>
          </p>
          <div>
            <label className="label">Reason (shown in the audit trail)</label>
            <textarea value={blockReason} onChange={e => setBlockReason(e.target.value)}
              className="input resize-none w-full" rows={3}
              placeholder="e.g. Third unverified payment claim; proof shows no credit on any of them." />
          </div>
          <div className="flex justify-end gap-2">
            <button onClick={() => setBlockTarget(null)} className="btn-secondary text-sm">Cancel</button>
            <button onClick={doBlock} disabled={busy !== null || blockReason.trim().length < 10}
              className="btn-danger text-sm disabled:opacity-40">
              {busy ? 'Blocking…' : 'Block player'}
            </button>
          </div>
        </div>
      </Modal>

      <Modal isOpen={!!clearTarget} onClose={() => setClearTarget(null)}
        title={`Clear flag on ${clearTarget?.username ?? ''}`}>
        <div className="space-y-4">
          <p className="text-sm text-gray-400">
            The player stays exactly as they are — this only removes them from this queue.
          </p>
          <label className="flex items-start gap-2.5 text-sm text-gray-300 cursor-pointer">
            <input type="checkbox" checked={resetWarnings} className="mt-1"
              onChange={e => setResetWarnings(e.target.checked)} />
            <span>
              Also reset the warning count to zero.
              <span className="block text-xs text-gray-500 mt-0.5">
                Leave this off to dismiss one complaint while keeping the record of earlier
                ones. Tick it only for a player with a clean record.
              </span>
            </span>
          </label>
          <div className="flex justify-end gap-2">
            <button onClick={() => setClearTarget(null)} className="btn-secondary text-sm">Cancel</button>
            <button onClick={doClear} disabled={busy !== null} className="btn-primary text-sm disabled:opacity-40">
              {busy ? 'Clearing…' : 'Clear flag'}
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
};
