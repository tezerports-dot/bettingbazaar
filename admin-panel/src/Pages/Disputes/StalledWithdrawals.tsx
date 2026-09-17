// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Withdrawals no merchant has taken.
 *
 * ── Why a payout can wait forever, and why that needs a screen ─────────────
 * A withdrawal that cannot find a merchant WAITS rather than failing. On the
 * cash rail that is the only safe answer: a payout too large for one
 * denomination is created as SEVERAL separate withdrawals, and the ones already
 * paid cannot be clawed back, so failing the outstanding one would mean
 * unwinding a payout that has partly happened.
 *
 * Deliberately not split-specific. One of those siblings is an ordinary queued
 * withdrawal, so the general question — which payouts have nobody working them
 * — covers it and every other stuck payout in one list.
 *
 * The price is a token lock with no deadline on it. An order with no deadline
 * and no owner is an order nobody is answerable for, which is exactly the shape
 * that goes unnoticed for weeks. This queue is the owner.
 *
 * The player has the other half of it: they can cancel a waiting part
 * themselves and take those tokens back. The two together are what make "wait
 * indefinitely" a decision rather than a leak.
 *
 * ── This screen does not act ───────────────────────────────────────────────
 * There is deliberately no button here. What unblocks a stalled leg is merchant
 * capacity at that denomination — approving one, or asking an approved one to
 * go to a machine — and neither is something to fake with a force-assign that
 * hands an order to somebody who cannot serve it. What an admin needs is to
 * KNOW, and to see which denomination is starved.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Clock, Hourglass, RefreshCw } from 'lucide-react';
import toast from 'react-hot-toast';
import api from '../../services/api';
import { EmptyState } from '../../components/EmptyState';
import { LoadingSpinner } from '../../components/LoadingSpinner';
import { formatters } from '../../utils/formatters';

interface StalledWithdrawal {
  orderId: string;
  userId: string;
  amount: number;
  tokenAmount: number;
  createdAt: string;
  /** The label grouping siblings of one request, when there was one. Context. */
  batchRef: string | null;
}

/**
 * The windows an admin asks for. ZERO is one of them and is the point of the
 * list during an incident — "every leg waiting right now" — which a falsy
 * default would silently answer differently.
 */
const WINDOWS: Array<{ minutes: number; label: string }> = [
  { minutes: 0,    label: 'Everything waiting' },
  { minutes: 25,   label: 'Past the assignment window (25 min)' },
  { minutes: 120,  label: 'Over 2 hours' },
  { minutes: 1440, label: 'Over 24 hours' },
];

const when = (ts: string) => {
  try { return new Date(ts).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }); }
  catch { return String(ts); }
};

const waitedFor = (ts: string) => {
  const mins = Math.floor((Date.now() - new Date(ts).getTime()) / 60000);
  if (!Number.isFinite(mins) || mins < 0) return '—';
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ${mins % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
};

export const StalledWithdrawals: React.FC = () => {
  const [legs, setLegs] = useState<StalledWithdrawal[]>([]);
  const [olderThan, setOlderThan] = useState(25);
  const [isLoading, setIsLoading] = useState(true);

  const load = useCallback(async () => {
    setIsLoading(true);
    try {
      const res = await api.disputes.stalledWithdrawals(olderThan);
      setLegs(res?.orders || []);
    } catch {
      toast.error('Failed to load stalled withdrawals');
    } finally {
      setIsLoading(false);
    }
  }, [olderThan]);

  useEffect(() => { void load(); }, [load]);

  // Which denomination is starved. A list of twenty legs says "something is
  // wrong"; "eleven of them are ₹40,000" says which merchants to approve.
  const byAmount = legs.reduce<Record<string, number>>((acc, leg) => {
    const key = String(leg.amount);
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});
  const locked = legs.reduce((sum, leg) => sum + Number(leg.amount || 0), 0);

  return (
    <div className="space-y-5">
      <div className="bg-dark-800 border border-dark-600 rounded-xl p-4">
        <div className="flex items-center justify-between flex-wrap gap-3 mb-1">
          <div className="flex items-center gap-2">
            <Hourglass size={17} className="text-yellow-500" />
            <h2 className="text-base font-semibold">Withdrawals waiting for a merchant</h2>
          </div>
          <div className="flex items-center gap-2">
            <select
              value={olderThan}
              onChange={(e) => setOlderThan(Number(e.target.value))}
              aria-label="How long the part has been waiting"
              className="bg-dark-700 border border-dark-600 rounded-lg px-3 py-1.5 text-xs"
            >
              {WINDOWS.map((w) => <option key={w.minutes} value={w.minutes}>{w.label}</option>)}
            </select>
            <button onClick={() => void load()} className="p-1.5 rounded-lg hover:bg-dark-700" aria-label="Refresh">
              <RefreshCw size={15} className="text-gray-400" />
            </button>
          </div>
        </div>
        <p className="text-xs text-gray-400 mb-3">
          A payout that cannot find a merchant waits rather than failing — on the
          cash rail a large one is several separate withdrawals, and the ones
          already paid cannot be clawed back. Each row here is a player&apos;s tokens
          locked with no deadline on them. What clears it is merchant capacity at
          that denomination; the player can also cancel and take the tokens back.
        </p>

        {legs.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-3">
            <span className="text-xs px-2.5 py-1 rounded-lg bg-dark-700 text-gray-300">
              {formatters.currency(locked)} locked across {legs.length} part{legs.length === 1 ? '' : 's'}
            </span>
            {Object.entries(byAmount)
              .sort((a, b) => Number(b[0]) - Number(a[0]))
              .map(([amount, count]) => (
                <span key={amount} className="text-xs px-2.5 py-1 rounded-lg bg-dark-700 text-yellow-400">
                  {count} × {formatters.currency(Number(amount))}
                </span>
              ))}
          </div>
        )}

        {isLoading ? (
          <LoadingSpinner />
        ) : legs.length === 0 ? (
          <EmptyState
            icon={Clock}
            title="Nothing is waiting"
            description="Every queued withdrawal has a merchant working it in this window."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-gray-400 border-b border-dark-600">
                  <th className="py-2 pr-3 font-medium">Withdrawal</th>
                  <th className="py-2 pr-3 font-medium">Player</th>
                  <th className="py-2 pr-3 font-medium">Amount</th>
                  <th className="py-2 pr-3 font-medium">Part of</th>
                  <th className="py-2 pr-3 font-medium">Waiting</th>
                  <th className="py-2 font-medium">Since</th>
                </tr>
              </thead>
              <tbody>
                {legs.map((leg) => (
                  <tr key={leg.orderId} className="border-b border-dark-700 last:border-0">
                    <td className="py-2 pr-3 font-mono text-xs">{leg.orderId}</td>
                    <td className="py-2 pr-3 font-mono text-xs">{leg.userId}</td>
                    <td className="py-2 pr-3">{formatters.currency(leg.amount)}</td>
                    {/* Context only: it says this player asked for a large
                        payout rather than several small ones. Nothing here or
                        anywhere else decides anything by it. */}
                    <td className="py-2 pr-3 font-mono text-xs text-gray-500">{leg.batchRef ?? '—'}</td>
                    <td className="py-2 pr-3 text-yellow-400 text-xs">{waitedFor(leg.createdAt)}</td>
                    <td className="py-2 text-xs text-gray-400">{when(leg.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};

export default StalledWithdrawals;
