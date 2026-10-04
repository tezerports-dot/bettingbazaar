// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Payment references — the operator's side of "one payment, one claim" (§27).
 *
 * A UTR or a chain transaction hash proves ONE real transfer, so
 * `utr_registry` gives each one to exactly one order, for good. A
 * second order quoting it is refused, and the refusal is COUNTED on the row
 * rather than lost in a 400 — because somebody quoting a reference that is
 * already spent is either a mistake or a fraud attempt, and both are what this
 * control exists to catch.
 *
 * ── Why this screen exists ─────────────────────────────────────────────────
 * The `canManageUtr` area could be granted to a sub-admin, and its seven routes
 * were tested, and there was no screen at all (measured 2026-10-01 by
 * `report:routes`: every UTR client method uncalled). A signal nobody can look
 * at is not a control.
 *
 * ── What it deliberately does NOT show ─────────────────────────────────────
 * The "orders held for review" queue (`GET /utr/flagged`, `POST /utr/resolve`).
 * It reads `requires_review`, and nothing on the platform sets that column, so
 * a tab for it would be a list that is empty forever and reads as "all clear".
 *
 * ── A flag does not reverse anything ───────────────────────────────────────
 * Flagging a reference FRAUD marks it; it does not cancel the order it belongs
 * to. Those are separate decisions with separate evidence, and the server keeps
 * them apart on purpose. The screen says so next to the button.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Fingerprint, RefreshCw, Search, ShieldAlert, ShieldCheck, History } from 'lucide-react';
import toast from 'react-hot-toast';
import api from '../../services/api';
import { EmptyState } from '../../components/EmptyState';
import { LoadingSpinner } from '../../components/LoadingSpinner';

/** One `utr_registry` row as `database/repositories/utr.js` `toEntry` maps it. */
interface Entry {
  utr: string;
  orderId: string;
  userId: string | null;
  amount: number | null;
  status: 'ACTIVE' | 'RELEASED' | 'FRAUD';
  registeredAt: string;
  releasedAt: string | null;
  flaggedAt: string | null;
  flaggedBy: string | null;
  flagReason: string | null;
  duplicateAttempts: number;
  lastContestedAt: string | null;
  // Only on the registry list and the single lookup, which join them on.
  user?: { username: string; mobile: string } | null;
  order?: { orderId: string; type: string; status: string; tokenAmount: number } | null;
}

interface Stats {
  total: number; active: number; released: number; fraud: number;
  contested: number; duplicateAttempts: number;
}

type Tab = 'contested' | 'registry';
const PAGE = 50;
const STATUSES = ['ALL', 'ACTIVE', 'RELEASED', 'FRAUD'] as const;

const when = (ts: string | null) => {
  if (!ts) return '—';
  try { return new Date(ts).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }); }
  catch { return String(ts); }
};

const statusTone: Record<Entry['status'], string> = {
  ACTIVE: 'bg-green-500/20 text-green-400',
  RELEASED: 'bg-gray-500/20 text-gray-300',
  FRAUD: 'bg-red-500/20 text-red-400',
};

const messageOf = (e: any, fallback: string) => e?.response?.data?.message || fallback;

export const UtrMonitor: React.FC = () => {
  const [stats, setStats] = useState<Stats | null>(null);
  const [tab, setTab] = useState<Tab>('contested');
  const [status, setStatus] = useState<(typeof STATUSES)[number]>('ALL');
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<Entry[]>([]);
  const [total, setTotal] = useState(0);
  const [isLoading, setIsLoading] = useState(true);

  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Entry | null>(null);
  const [lookupNote, setLookupNote] = useState('');
  const [looking, setLooking] = useState(false);

  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const [history, setHistory] = useState<Entry[] | null>(null);

  const loadStats = useCallback(async () => {
    try {
      const res = await api.utr.getStats();
      if (res?.success) setStats(res.stats);
    } catch { /* the tiles simply do not render */ }
  }, []);

  const loadList = useCallback(async () => {
    setIsLoading(true);
    try {
      const res = tab === 'contested'
        ? await api.utr.getContested(page, PAGE)
        : await api.utr.getRegistry(status === 'ALL' ? undefined : status, page, PAGE);
      setRows((tab === 'contested' ? res?.contested : res?.entries) || []);
      setTotal(res?.pagination?.total ?? 0);
    } catch (e) {
      toast.error(messageOf(e, 'Failed to load payment references'));
      setRows([]); setTotal(0);
    } finally {
      setIsLoading(false);
    }
  }, [tab, status, page]);

  useEffect(() => { void loadStats(); }, [loadStats]);
  useEffect(() => { void loadList(); }, [loadList]);

  /** Open one reference in full: the player and the order are joined on here. */
  const open = async (reference: string) => {
    const ref = reference.trim();
    if (!ref) return;
    setLooking(true); setLookupNote(''); setHistory(null); setReason('');
    try {
      const res = await api.utr.lookup(ref);
      setSelected(res?.entry ?? null);
    } catch (e: any) {
      setSelected(null);
      // A 404 is an answer, not a fault: nobody has claimed that reference.
      if (e?.response?.status === 404) setLookupNote(`No order has claimed "${ref}".`);
      else toast.error(messageOf(e, 'Failed to look that reference up'));
    } finally {
      setLooking(false);
    }
  };

  const refresh = async (entry?: Entry) => {
    if (entry) setSelected((cur) => (cur ? { ...cur, ...entry } : cur));
    await Promise.all([loadStats(), loadList()]);
  };

  const flag = async () => {
    if (!selected) return;
    if (!reason.trim()) { toast.error('Write the reason first. It is what the player is shown if they appeal.'); return; }
    setBusy(true);
    try {
      const res = await api.utr.flag(selected.utr, reason.trim());
      toast.success('Reference flagged as fraud');
      setReason('');
      await refresh(res?.entry);
    } catch (e) {
      toast.error(messageOf(e, 'Failed to flag the reference'));
    } finally { setBusy(false); }
  };

  const clear = async () => {
    if (!selected) return;
    setBusy(true);
    try {
      const res = await api.utr.clear(selected.utr);
      toast.success('Flag cleared');
      await refresh(res?.entry);
    } catch (e) {
      toast.error(messageOf(e, 'Failed to clear the flag'));
    } finally { setBusy(false); }
  };

  const loadHistory = async () => {
    if (!selected?.userId) return;
    try {
      const res = await api.utr.getUserHistory(selected.userId);
      setHistory(res?.history || []);
    } catch (e) {
      toast.error(messageOf(e, "Failed to load the player's references"));
    }
  };

  const pages = Math.max(1, Math.ceil(total / PAGE));
  const tiles: Array<[string, number | undefined, string?]> = [
    ['Claimed', stats?.total],
    ['Active', stats?.active],
    ['Released', stats?.released],
    ['Flagged fraud', stats?.fraud, 'text-red-400'],
    ['Contested', stats?.contested, 'text-yellow-400'],
    ['Reuse attempts', stats?.duplicateAttempts, 'text-yellow-400'],
  ];

  return (
    <div className="space-y-5">
      {/* ── Totals ───────────────────────────────────────────────────────── */}
      {stats && (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          {tiles.map(([label, value, tone]) => (
            <div key={label} className="bg-dark-800 border border-dark-600 rounded-xl p-3">
              <div className="text-xs text-gray-400">{label}</div>
              <div className={`text-xl font-semibold ${tone ?? ''}`}>{(value ?? 0).toLocaleString('en-IN')}</div>
            </div>
          ))}
        </div>
      )}

      {/* ── Look one up ──────────────────────────────────────────────────── */}
      <div className="bg-dark-800 border border-dark-600 rounded-xl p-4">
        <div className="flex items-center gap-2 mb-1">
          <Fingerprint size={17} className="text-gold-500" />
          <h2 className="text-base font-semibold">Look up a reference</h2>
        </div>
        <p className="text-xs text-gray-400 mb-3">
          A bank UTR or a USDT transaction hash — as it was typed.
          Case and spaces do not matter.
        </p>
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Search size={15} className="absolute left-3 top-2.5 text-gray-500" />
            <input
              id="utr-lookup"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void open(query); }}
              placeholder="Reference"
              aria-label="Payment reference"
              className="w-full bg-dark-700 border border-dark-600 rounded-lg pl-9 pr-3 py-2 text-sm font-mono"
            />
          </div>
          <button onClick={() => void open(query)} disabled={!query.trim() || looking} className="btn-primary text-sm disabled:opacity-50">
            {looking ? 'Looking…' : 'Look up'}
          </button>
        </div>
        {lookupNote && <p role="status" className="text-sm text-gray-300 mt-3">{lookupNote}</p>}
      </div>

      {/* ── One reference ────────────────────────────────────────────────── */}
      {selected && (
        <div className="bg-dark-800 border border-dark-600 rounded-xl p-4 space-y-4" aria-label="Reference detail">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="font-mono text-sm break-all">{selected.utr}</div>
            <span className={`px-2 py-0.5 rounded text-xs font-medium ${statusTone[selected.status]}`}>{selected.status}</span>
          </div>

          <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2 text-sm">
            <div><dt className="text-gray-400 text-xs">Order</dt><dd className="font-mono break-all">{selected.orderId}</dd></div>
            <div><dt className="text-gray-400 text-xs">Order type / state</dt><dd>{selected.order ? `${selected.order.type} · ${selected.order.status}` : '— (no order row)'}</dd></div>
            <div><dt className="text-gray-400 text-xs">Tokens</dt><dd>{selected.order ? selected.order.tokenAmount.toLocaleString('en-IN') : '—'}</dd></div>
            <div><dt className="text-gray-400 text-xs">Player</dt><dd>{selected.user ? `${selected.user.username} · ${selected.user.mobile}` : '— (account not found)'}</dd></div>
            <div><dt className="text-gray-400 text-xs">Claimed</dt><dd>{when(selected.registeredAt)}</dd></div>
            <div><dt className="text-gray-400 text-xs">Reuse attempts</dt><dd className={selected.duplicateAttempts > 0 ? 'text-yellow-400' : ''}>{selected.duplicateAttempts}{selected.lastContestedAt ? ` · last ${when(selected.lastContestedAt)}` : ''}</dd></div>
            {selected.status === 'FRAUD' && (
              <div className="sm:col-span-2"><dt className="text-gray-400 text-xs">Flagged</dt><dd>{when(selected.flaggedAt)} by {selected.flaggedBy ?? '—'}: {selected.flagReason}</dd></div>
            )}
          </dl>

          {selected.status === 'FRAUD' ? (
            <button onClick={() => void clear()} disabled={busy} className="btn-secondary text-sm inline-flex items-center gap-1.5 disabled:opacity-50">
              <ShieldCheck size={15} /> Clear the flag
            </button>
          ) : (
            <div className="space-y-2">
              <label htmlFor="utr-flag-reason" className="block text-xs text-gray-400">
                Reason for flagging (required — the player is shown it if they appeal)
              </label>
              <textarea
                id="utr-flag-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={2}
                className="w-full bg-dark-700 border border-dark-600 rounded-lg px-3 py-2 text-sm"
              />
              <div className="flex flex-wrap items-center gap-3">
                <button onClick={() => void flag()} disabled={busy || !reason.trim()} className="btn-danger text-sm inline-flex items-center gap-1.5 disabled:opacity-50">
                  <ShieldAlert size={15} /> Flag as fraud
                </button>
                <span className="text-xs text-gray-500">Flagging marks the reference. It does not cancel or reverse the order.</span>
              </div>
            </div>
          )}

          {selected.userId && (
            <div>
              <button onClick={() => void loadHistory()} className="text-sm text-gold-500 inline-flex items-center gap-1.5">
                <History size={15} /> This player's references
              </button>
              {history && (
                history.length === 0 ? <p className="text-sm text-gray-400 mt-2">None.</p> : (
                  <ul className="mt-2 space-y-1 text-sm">
                    {history.map((h) => (
                      <li key={h.utr} className="flex flex-wrap gap-3">
                        <button onClick={() => void open(h.utr)} className="font-mono underline decoration-dotted">{h.utr}</button>
                        <span className={`px-1.5 rounded text-xs ${statusTone[h.status]}`}>{h.status}</span>
                        <span className="text-gray-400">{when(h.registeredAt)}</span>
                        {h.duplicateAttempts > 0 && <span className="text-yellow-400">{h.duplicateAttempts} reuse attempt(s)</span>}
                      </li>
                    ))}
                  </ul>
                )
              )}
            </div>
          )}
        </div>
      )}

      {/* ── Lists ────────────────────────────────────────────────────────── */}
      <div className="bg-dark-800 border border-dark-600 rounded-xl p-4">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
          <div className="flex gap-2" role="tablist">
            <button role="tab" aria-selected={tab === 'contested'} onClick={() => { setTab('contested'); setPage(1); }}
              className={`px-3 py-1.5 rounded-lg text-sm ${tab === 'contested' ? 'bg-gold-500 text-dark-900' : 'bg-dark-700'}`}>
              Review queue
            </button>
            <button role="tab" aria-selected={tab === 'registry'} onClick={() => { setTab('registry'); setPage(1); }}
              className={`px-3 py-1.5 rounded-lg text-sm ${tab === 'registry' ? 'bg-gold-500 text-dark-900' : 'bg-dark-700'}`}>
              All references
            </button>
          </div>
          <div className="flex items-center gap-2">
            {tab === 'registry' && (
              <>
                <label htmlFor="utr-status" className="text-xs text-gray-400">Status</label>
                <select id="utr-status" value={status} onChange={(e) => { setStatus(e.target.value as any); setPage(1); }}
                  className="bg-dark-700 border border-dark-600 rounded-lg px-2 py-1.5 text-sm">
                  {STATUSES.map((s) => <option key={s} value={s}>{s === 'ALL' ? 'All' : s}</option>)}
                </select>
              </>
            )}
            <button onClick={() => void refresh()} title="Refresh" aria-label="Refresh" className="p-2 rounded-lg bg-dark-700"><RefreshCw size={15} /></button>
          </div>
        </div>
        <p className="text-xs text-gray-400 mb-3">
          {tab === 'contested'
            ? 'References somebody tried to use again, and references flagged as fraud — newest first.'
            : 'Every reference any order has claimed — newest first.'}
        </p>

        {isLoading ? <LoadingSpinner /> : rows.length === 0 ? (
          <EmptyState
            icon={Fingerprint}
            title={tab === 'contested' ? 'Nothing contested' : 'No references'}
            description={tab === 'contested' ? 'Nobody has tried to reuse a reference, and none is flagged.' : 'No order has claimed a reference with this status.'}
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-xs text-gray-400 text-left">
                <tr>
                  <th className="py-2 pr-3">Reference</th>
                  <th className="py-2 pr-3">Status</th>
                  <th className="py-2 pr-3">Reuse attempts</th>
                  {tab === 'registry' && <th className="py-2 pr-3">Player</th>}
                  <th className="py-2 pr-3">{tab === 'contested' ? 'Last contested' : 'Claimed'}</th>
                  <th className="py-2" />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.utr} className="border-t border-dark-600">
                    <td className="py-2 pr-3 font-mono break-all">{r.utr}</td>
                    <td className="py-2 pr-3"><span className={`px-1.5 rounded text-xs ${statusTone[r.status]}`}>{r.status}</span></td>
                    <td className={`py-2 pr-3 ${r.duplicateAttempts > 0 ? 'text-yellow-400' : ''}`}>{r.duplicateAttempts}</td>
                    {tab === 'registry' && <td className="py-2 pr-3">{r.user?.username ?? '—'}</td>}
                    <td className="py-2 pr-3 text-gray-400">{when(tab === 'contested' ? (r.lastContestedAt ?? r.flaggedAt ?? r.registeredAt) : r.registeredAt)}</td>
                    <td className="py-2 text-right">
                      <button onClick={() => void open(r.utr)} className="text-gold-500 text-sm">Open</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {total > PAGE && (
          <div className="flex items-center justify-between mt-3 text-sm">
            <span className="text-gray-400">Page {page} of {pages} · {total.toLocaleString('en-IN')} references</span>
            <div className="flex gap-2">
              <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1} className="btn-secondary text-sm disabled:opacity-50">Previous</button>
              <button onClick={() => setPage((p) => Math.min(pages, p + 1))} disabled={page >= pages} className="btn-secondary text-sm disabled:opacity-50">Next</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
