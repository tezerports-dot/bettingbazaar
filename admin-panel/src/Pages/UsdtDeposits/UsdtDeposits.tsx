// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Admin › USDT Deposits (owner, 2026-10-18: USDT buys are paid to the platform
 * on BNB Smart Chain, one address per order, credited by the server).
 *
 * The server credits a buy by itself once enough confirmed USDT reaches its
 * address. What needs a person is shown here:
 *   - money it could not credit (late, overpaid, after credit), marked handled
 *     with a note once an admin has refunded or adjusted it;
 *   - the coins still sitting on deposit addresses, which the offline sweep tool
 *     (scripts/usdt-sweep.mjs) moves out: download its input, record its output;
 *   - whether the watcher is reading the chain at all.
 *
 * The list's filters and every figure are the server's (§2, §5): this screen
 * adds nothing up.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Coins, Copy, Download, RefreshCw } from 'lucide-react';
import toast from 'react-hot-toast';
import api, { type UsdtDeposit, type UsdtDepositsResponse, type UsdtTransfer } from '../../services/api';
import { EmptyState } from '../../components/EmptyState';
import { LoadingSpinner } from '../../components/LoadingSpinner';

const PAGE = 50;
const messageOf = (e: any, fallback: string) => e?.response?.data?.message || fallback;
const when = (ts: string | null) => (ts ? new Date(ts).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');
const usdt = (n: number) => `${(n ?? 0).toLocaleString('en-IN', { maximumFractionDigits: 6 })} USDT`;
const short = (v: string, head = 8, tail = 6) => (v && v.length > head + tail + 1 ? `${v.slice(0, head)}…${v.slice(-tail)}` : v);
const OPEN_STATES = ['PENDING_QUEUE', 'PROCESSING'];

const FILTER_LABEL: Record<string, string> = {
  ALL: 'All', WAITING: 'Waiting for payment', ATTENTION: 'Needs attention', UNSWEPT: 'Not swept',
};
const ATTENTION_LABEL: Record<NonNullable<UsdtDeposit['attention']>, string> = {
  LATE: 'Arrived after the order closed',
  OVERPAID: 'More than the order was sent',
  AFTER_CREDIT: 'More arrived after it was credited',
};

const copy = (text: string, what: string) => {
  navigator.clipboard?.writeText(text).then(() => toast.success(`${what} copied`), () => toast.error('Could not copy'));
};

// Out here, not inside the screen (§32 S23).
const Tile: React.FC<{ label: string; value: React.ReactNode }> = ({ label, value }) => (
  <div className="bg-dark-800 rounded-lg p-3">
    <p className="text-[11px] uppercase tracking-wider text-gray-500">{label}</p>
    <p className="text-sm text-gray-100 font-medium mt-0.5">{value}</p>
  </div>
);

/** One deposit's transfers and the two things an admin may do to it. */
const DepositDetail: React.FC<{ deposit: UsdtDeposit; onChanged: () => void }> = ({ deposit, onChanged }) => {
  const [transfers, setTransfers] = useState<UsdtTransfer[] | null>(null);
  const [note, setNote] = useState('');
  const [txHash, setTxHash] = useState('');
  const [busy, setBusy] = useState<'' | 'handled' | 'sweep'>('');
  const [problem, setProblem] = useState('');
  const ended = !OPEN_STATES.includes(deposit.state);

  useEffect(() => {
    api.usdtDeposits.transfers(deposit.orderId)
      .then((r) => setTransfers(r.transfers ?? []))
      .catch((e) => { setTransfers([]); setProblem(messageOf(e, 'Could not load the transfers.')); });
  }, [deposit.orderId]);

  const act = async (kind: 'handled' | 'sweep', call: () => Promise<unknown>, done: string) => {
    setBusy(kind); setProblem('');
    try { await call(); toast.success(done); onChanged(); }
    catch (e) { setProblem(messageOf(e, 'That did not go through.')); }
    finally { setBusy(''); }
  };

  return (
    <div className="bg-dark-900/60 rounded-lg p-3 space-y-3">
      {transfers === null ? <LoadingSpinner /> : transfers.length === 0 ? (
        <p className="text-sm text-gray-400">Nothing has arrived at this address.</p>
      ) : (
        <table className="w-full text-xs">
          <thead><tr className="text-gray-500 text-left">
            <th className="py-1">Transaction</th><th>From</th><th>Amount</th><th>Block</th><th>Order was</th><th>Handled</th>
          </tr></thead>
          <tbody>
            {transfers.map((t) => (
              <tr key={`${t.txHash}:${t.logIndex}`} className="border-t border-dark-700">
                <td className="py-1 font-mono">
                  <button type="button" className="hover:text-gold-300" onClick={() => copy(t.txHash, 'Transaction hash')}>{short(t.txHash, 10, 6)}</button>
                </td>
                <td className="font-mono">{short(t.from)}</td>
                <td>{usdt(t.usdt)}</td>
                <td>{t.blockNumber}</td>
                <td>{t.orderStateAtArrival}</td>
                <td>{t.handledAt ? `${when(t.handledAt)}: ${t.handledNote}` : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {deposit.attention && ended && (
        <div className="space-y-1">
          <label htmlFor={`note-${deposit.orderId}`} className="block text-xs text-gray-400">
            What was done with this money (a refund on chain, or a balance adjustment)
          </label>
          <div className="flex gap-2">
            <input id={`note-${deposit.orderId}`} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500}
              className="input flex-1" placeholder="e.g. Refunded 50 USDT to the sender, tx 0x…" />
            <button type="button" className="btn-primary disabled:opacity-50" disabled={!note.trim() || !!busy}
              onClick={() => void act('handled', () => api.usdtDeposits.markHandled(deposit.orderId, note.trim()), 'Marked handled')}>
              {busy === 'handled' ? 'Saving…' : 'Mark handled'}
            </button>
          </div>
        </div>
      )}

      {ended && !deposit.sweptAt && deposit.usdtReceived > 0 && (
        <div className="space-y-1">
          <label htmlFor={`sweep-${deposit.orderId}`} className="block text-xs text-gray-400">Sweep transaction hash</label>
          <div className="flex gap-2">
            <input id={`sweep-${deposit.orderId}`} value={txHash} onChange={(e) => setTxHash(e.target.value)}
              className="input flex-1 font-mono" placeholder="0x…" spellCheck={false} />
            <button type="button" className="btn-secondary disabled:opacity-50" disabled={!txHash.trim() || !!busy}
              onClick={() => void act('sweep', () => api.usdtDeposits.recordSweep(deposit.orderId, txHash.trim()), 'Sweep recorded')}>
              {busy === 'sweep' ? 'Saving…' : 'Record sweep'}
            </button>
          </div>
        </div>
      )}
      {problem && <p role="alert" className="text-sm text-red-400">{problem}</p>}
    </div>
  );
};

export const UsdtDeposits: React.FC = () => {
  const [filter, setFilter] = useState('ATTENTION');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<UsdtDepositsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadProblem, setLoadProblem] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const [results, setResults] = useState('');
  const [resultNote, setResultNote] = useState('');
  const [recording, setRecording] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setLoadProblem('');
    try { setData(await api.usdtDeposits.list(filter, page, PAGE)); }
    catch (e) { setData(null); setLoadProblem(messageOf(e, 'Could not load the USDT deposits.')); }
    finally { setLoading(false); }
  }, [filter, page]);
  useEffect(() => { void load(); }, [load]);

  const recordResults = async () => {
    setRecording(true); setResultNote('');
    try {
      const r = await api.usdtDeposits.recordSweeps(results);
      const missed = r.results.filter((x) => !x.recorded);
      setResultNote(`${r.recorded} recorded.${missed.length ? ` Not recorded: ${missed.map((x) => `${x.orderId} (${x.reason})`).join('; ')}.` : ''}`);
      if (missed.length === 0) setResults('');
      void load();
    } catch (e) { setResultNote(messageOf(e, 'Could not record the results.')); }
    finally { setRecording(false); }
  };

  const w = data?.watcher;
  const t = data?.totals;

  return (
    <div className="om-fade space-y-4">
      <div className="card p-4 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-base font-semibold text-gray-100 flex items-center gap-2"><Coins size={18} /> USDT on BNB Smart Chain</h2>
          <button type="button" className="btn-secondary flex items-center gap-1" onClick={() => void load()}><RefreshCw size={14} /> Refresh</button>
        </div>
        {w && (
          <p role="status" className={`text-sm ${!w.configured || w.lastError ? 'text-amber-400' : 'text-gray-400'}`}>
            {!w.configured
              ? 'Not set up: this server has no USDT_BEP20_XPUB or BSC_RPC_URL, so players cannot buy with USDT.'
              : w.lastError && (!w.lastOkAt || (w.lastErrorAt && w.lastErrorAt > w.lastOkAt))
                ? `The watcher cannot read the chain (${when(w.lastErrorAt)}): ${w.lastError}`
                : `Watcher reading the chain. Last read ${when(w.lastOkAt)}, up to block ${w.nextBlock ?? '—'} of ${w.headBlock ?? '—'}.`}
          </p>
        )}
        {w?.activeKeyId && (
          <p className="text-xs text-gray-500">
            New addresses come from key <span className="font-mono text-gray-300">{w.activeKeyId}</span>. Each address keeps
            the key it was made under, so after a key change the old addresses are still watched, and swept with the old phrase.
          </p>
        )}
        {t && (
          <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
            <Tile label="Waiting for payment" value={t.waiting} />
            <Tile label="Credited" value={t.credited} />
            <Tile label="Tokens credited" value={`${t.creditedTokens.toLocaleString('en-IN')} BB`} />
            <Tile label="USDT received" value={usdt(t.usdtReceived)} />
            <Tile label="USDT not swept" value={usdt(t.usdtUnswept)} />
          </div>
        )}
      </div>

      <div className="card p-4 space-y-3">
        <h3 className="text-sm font-semibold text-gray-100">Sweep</h3>
        <p className="text-xs text-gray-400">
          The server holds no private key. Download the addresses to sweep, run the sweep tool on the machine that holds the
          recovery phrase, then paste the results file it writes here.
        </p>
        <button type="button" className="btn-secondary flex items-center gap-1"
          onClick={() => api.usdtDeposits.downloadSweepFile().catch((e) => toast.error(messageOf(e, 'Could not download the sweep file.')))}>
          <Download size={14} /> Download sweep file
        </button>
        <label htmlFor="sweep-results" className="block text-xs text-gray-400">Sweep results (orderId,txHash per line)</label>
        <textarea id="sweep-results" value={results} onChange={(e) => setResults(e.target.value)} rows={4}
          className="input w-full font-mono text-xs" spellCheck={false} />
        <button type="button" className="btn-primary disabled:opacity-50" disabled={!results.trim() || recording} onClick={() => void recordResults()}>
          {recording ? 'Recording…' : 'Record results'}
        </button>
        {resultNote && <p role="status" className="text-sm text-gray-300">{resultNote}</p>}
      </div>

      <div className="card p-4 space-y-3">
        <div className="flex flex-wrap gap-2" role="group" aria-label="Show">
          {(data?.filters ?? ['ALL', 'WAITING', 'ATTENTION', 'UNSWEPT']).map((f) => (
            <button key={f} type="button" aria-pressed={filter === f}
              onClick={() => { setFilter(f); setPage(1); setOpenId(null); }}
              className={`px-3 py-1.5 rounded-lg text-sm border ${filter === f ? 'bg-gold-500/15 border-gold-500/60 text-gold-300' : 'bg-dark-800 border-dark-600 text-gray-400'}`}>
              {FILTER_LABEL[f] ?? f}
            </button>
          ))}
        </div>

        {loadProblem && <p role="alert" className="text-sm text-red-400">{loadProblem}</p>}
        {loading ? <LoadingSpinner /> : !data || data.deposits.length === 0 ? (
          <EmptyState icon={Coins} title="Nothing here" description={filter === 'ATTENTION' ? 'No USDT needs a person right now.' : 'No USDT deposits match.'} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-xs text-gray-500">
                <th className="py-2">Order</th><th>Player</th><th>Address</th><th>Asked</th><th>Received</th><th>State</th><th>Needs</th><th>Swept</th><th />
              </tr></thead>
              <tbody>
                {data.deposits.map((d) => (
                  <React.Fragment key={d.orderId}>
                    <tr className="border-t border-dark-700">
                      <td className="py-2 font-mono text-xs">{d.orderId}<div className="text-gray-500">{when(d.createdAt)}</div></td>
                      <td>{d.username ?? d.userId}</td>
                      <td className="font-mono text-xs">
                        <button type="button" className="flex items-center gap-1 hover:text-gold-300" onClick={() => copy(d.address, 'Address')}>
                          {short(d.address)} <Copy size={12} />
                        </button>
                      </td>
                      <td>{usdt(d.usdtRequired)}</td>
                      <td>{usdt(d.usdtReceived)}</td>
                      <td>{d.state}{d.creditedAt ? <div className="text-xs text-gray-500">credited {when(d.creditedAt)}</div> : null}</td>
                      <td className="text-amber-400 text-xs">{d.attention ? ATTENTION_LABEL[d.attention] : '—'}</td>
                      <td className="text-xs">{d.sweptAt ? when(d.sweptAt) : d.usdtReceived > 0 ? 'Not yet' : '—'}</td>
                      <td>
                        <button type="button" className="text-xs text-gold-300 hover:underline" aria-expanded={openId === d.orderId}
                          onClick={() => setOpenId(openId === d.orderId ? null : d.orderId)}>
                          {openId === d.orderId ? 'Close' : 'Open'}
                        </button>
                      </td>
                    </tr>
                    {openId === d.orderId && (
                      <tr><td colSpan={9} className="pb-3"><DepositDetail deposit={d} onChanged={() => void load()} /></td></tr>
                    )}
                  </React.Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {data && data.pages > 1 && (
          <div className="flex items-center gap-2 text-sm">
            <button type="button" className="btn-secondary disabled:opacity-50" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button>
            <span className="text-gray-400">Page {data.page} of {data.pages}</span>
            <button type="button" className="btn-secondary disabled:opacity-50" disabled={page >= data.pages} onClick={() => setPage(page + 1)}>Next</button>
          </div>
        )}
      </div>
    </div>
  );
};
