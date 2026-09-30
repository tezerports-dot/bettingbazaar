// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * CDM slips — what is missing, and the one place a slip can be read.
 *
 * ── Why a screen for the MISSING ones ──────────────────────────────────────
 * On the cash rail a merchant deposits notes at a CDM into the player's bank
 * account. Their confirm COMPLETES the order, deliberately: the player is not
 * held up waiting for paperwork. The slip is chased afterwards — which means a
 * slip that never arrives blocks nobody and nothing would otherwise notice.
 *
 * That is exactly the gap somebody would exploit. A merchant who confirms
 * payouts they did not make looks identical, order by order, to one who did;
 * the only thing that separates them is a pattern of unevidenced settlements,
 * and this list is where that pattern becomes visible.
 *
 * ── Why the read is a button, never a load ─────────────────────────────────
 * A CDM slip carries an account number, a branch, a timestamp and a bank
 * reference. Neither the player nor the merchant who uploaded it may see it
 * again — the order mapper does not carry the columns, so no projection on the
 * platform can — and EVERY read here is written to the audit log.
 *
 * So a slip is fetched only when somebody asks for that order by name. Loading
 * one because a screen opened would record a view for every order anybody
 * glanced at, and "who looked at this player's bank slip" would stop being a
 * question with an answer.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Banknote, Eye, FileWarning, RefreshCw, Search } from 'lucide-react';
import toast from 'react-hot-toast';
import api from '../../services/api';
import { EmptyState } from '../../components/EmptyState';
import { LoadingSpinner } from '../../components/LoadingSpinner';
import { formatters } from '../../utils/formatters';

interface MissingRow {
  orderId: string;
  merchantId: string;
  userId: string;
  tokenAmount: number;
  completedAt: string;
}

interface Receipt {
  orderId: string;
  merchantId: string;
  transactionId: string;
  receiptUrl: string;
  submittedAt: string;
}

/**
 * The windows an admin actually asks for. ZERO is one of them and is the point
 * of the list during an incident — "everything missing a slip right now" — so
 * it is a real option rather than something the default swallows.
 */
const WINDOWS: Array<{ minutes: number; label: string }> = [
  { minutes: 0,    label: 'Everything' },
  { minutes: 15,   label: 'Over 15 min' },
  { minutes: 60,   label: 'Over 1 hour' },
  { minutes: 1440, label: 'Over 24 hours' },
];

const when = (ts: string) => {
  try { return new Date(ts).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }); }
  catch { return String(ts); }
};

export const CdmReceiptQueue: React.FC = () => {
  const [rows, setRows] = useState<MissingRow[]>([]);
  const [olderThan, setOlderThan] = useState(60);
  const [isLoading, setIsLoading] = useState(true);

  const [lookupId, setLookupId] = useState('');
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [lookupNote, setLookupNote] = useState('');
  const [looking, setLooking] = useState(false);

  const load = useCallback(async () => {
    setIsLoading(true);
    try {
      const res = await api.disputes.missingCdmReceipts(olderThan);
      setRows(res?.orders || []);
    } catch {
      toast.error('Failed to load payouts missing a receipt');
    } finally {
      setIsLoading(false);
    }
  }, [olderThan]);

  useEffect(() => { void load(); }, [load]);

  /**
   * Read one slip. Only from this click — see the file header on why.
   */
  const lookup = async (orderId: string) => {
    const id = orderId.trim();
    if (!id) return;
    setLooking(true);
    setReceipt(null);
    setLookupNote('');
    try {
      const res = await api.disputes.getCdmReceipt(id);
      if (res?.receipt) {
        setReceipt(res.receipt);
      } else {
        // Not an error. The confirm completes the order and the slip follows,
        // so a settled payout with none yet is an ordinary state — and saying
        // "none submitted" is a different fact from "no such order".
        setLookupNote(res?.message || 'No CDM receipt has been submitted for this order.');
      }
    } catch {
      toast.error('Failed to read that receipt');
    } finally {
      setLooking(false);
    }
  };

  return (
    <div className="space-y-5">
      {/* ── Look one up ──────────────────────────────────────────────────── */}
      <div className="bg-dark-800 border border-dark-600 rounded-xl p-4">
        <div className="flex items-center gap-2 mb-1">
          <Banknote size={17} className="text-gold-500" />
          <h2 className="text-base font-semibold">Read a CDM slip</h2>
        </div>
        <p className="text-xs text-gray-400 mb-3">
          The only way to see one. The merchant who uploaded it cannot, and neither
          can the player. Every read is recorded against your account.
        </p>
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Search size={15} className="absolute left-3 top-2.5 text-gray-500" />
            <input
              value={lookupId}
              onChange={(e) => setLookupId(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void lookup(lookupId); }}
              placeholder="Order ID"
              aria-label="Order ID"
              className="w-full bg-dark-700 border border-dark-600 rounded-lg pl-9 pr-3 py-2 text-sm font-mono"
            />
          </div>
          <button
            onClick={() => void lookup(lookupId)}
            disabled={looking || !lookupId.trim()}
            className="btn-primary flex items-center gap-1.5 text-sm disabled:opacity-40"
          >
            <Eye size={15} /> {looking ? 'Reading…' : 'Read slip'}
          </button>
        </div>

        {lookupNote && <p className="mt-3 text-xs text-gray-400">{lookupNote}</p>}

        {receipt && (
          <div className="mt-4 bg-dark-700 rounded-lg p-3 space-y-2">
            <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
              <div className="flex justify-between"><span className="text-gray-400">Order</span><span className="font-mono">{receipt.orderId}</span></div>
              <div className="flex justify-between"><span className="text-gray-400">Merchant</span><span className="font-mono">{receipt.merchantId}</span></div>
              <div className="flex justify-between"><span className="text-gray-400">Bank txn</span><span className="font-mono text-green-400">{receipt.transactionId}</span></div>
              <div className="flex justify-between"><span className="text-gray-400">Submitted</span><span>{when(receipt.submittedAt)}</span></div>
            </div>
            <a href={receipt.receiptUrl} target="_blank" rel="noreferrer" className="block">
              <img src={receipt.receiptUrl} alt="CDM deposit slip" className="w-full rounded-lg border border-dark-600" />
            </a>
          </div>
        )}
      </div>

      {/* ── What is missing ──────────────────────────────────────────────── */}
      <div className="bg-dark-800 border border-dark-600 rounded-xl p-4">
        <div className="flex items-center justify-between flex-wrap gap-3 mb-1">
          <div className="flex items-center gap-2">
            <FileWarning size={17} className="text-yellow-500" />
            <h2 className="text-base font-semibold">Payouts settled without a slip</h2>
          </div>
          <div className="flex items-center gap-2">
            <select
              value={olderThan}
              onChange={(e) => setOlderThan(Number(e.target.value))}
              aria-label="How long ago the payout completed"
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
          The slip is chased after the payout completes, so a missing one blocks
          nobody. A merchant appearing here repeatedly is asserting payments they
          are not evidencing.
        </p>

        {isLoading ? (
          <LoadingSpinner />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={Banknote}
            title="Every cash payout is evidenced"
            description="No completed ATM payout in this window is missing its CDM slip."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-gray-400 border-b border-dark-600">
                  <th className="py-2 pr-3 font-medium">Order</th>
                  <th className="py-2 pr-3 font-medium">Merchant</th>
                  <th className="py-2 pr-3 font-medium">Player</th>
                  <th className="py-2 pr-3 font-medium">Amount</th>
                  <th className="py-2 font-medium">Completed</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.orderId} className="border-b border-dark-700 last:border-0">
                    <td className="py-2 pr-3 font-mono text-xs">{row.orderId}</td>
                    <td className="py-2 pr-3 font-mono text-xs">{row.merchantId}</td>
                    <td className="py-2 pr-3 font-mono text-xs">{row.userId}</td>
                    <td className="py-2 pr-3">{formatters.currency(row.tokenAmount)}</td>
                    <td className="py-2 text-xs text-gray-400">{when(row.completedAt)}</td>
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

export default CdmReceiptQueue;
