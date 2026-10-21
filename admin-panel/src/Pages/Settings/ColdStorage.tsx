// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * ColdStorage.tsx — Admin Panel › Platform › Cold Storage (owner, 2026-10-20),
 * full admins only.
 *
 * Old rounds (past the 1,440 kept per board and profile), ended orders' chats
 * and players' notifications past the server's `coldAfterDays` leave every live
 * screen and are kept whole here (`GET /api/admin/cold-storage`,
 * database/repositories/coldArchive.js). The list carries no rows; opening an
 * entry fetches them and is audited on the server. Kinds and the day count are
 * the server's, sent with every answer (§32 S25).
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Archive, ChevronDown, ChevronRight, RefreshCw, Search } from 'lucide-react';
import api, { type ColdEntry, type ColdKind, type ColdPage } from '../../services/api';

const KIND_LABEL: Record<ColdKind, { name: string; ref: string }> = {
  CYCLE:        { name: 'Rounds',        ref: 'Round id' },
  CHAT:         { name: 'Order chats',   ref: 'Order id' },
  NOTIFICATION: { name: 'Notifications', ref: 'Player id' },
};

const when = (iso: string | null) => {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }) + ' IST';
};

type Rows = Array<{ table: string; row: Record<string, unknown> }>;

const EntryRows: React.FC<{ id: number }> = ({ id }) => {
  const [rows, setRows] = useState<Rows | null>(null);
  const [failed, setFailed] = useState('');
  useEffect(() => {
    let live = true;
    api.coldStorage.open(id)
      .then((e) => { if (live) setRows(e.rows); })
      .catch((e: any) => { if (live) setFailed(e?.response?.data?.message || 'This entry could not be opened.'); });
    return () => { live = false; };
  }, [id]);
  if (failed) return <div role="alert" className="text-xs text-red-300">{failed}</div>;
  if (!rows) return <div className="text-xs text-slate-500">Opening…</div>;
  return (
    <div className="space-y-2">
      {rows.map((r, i) => (
        <div key={i} className="rounded-lg border border-slate-800 bg-slate-950 p-2">
          <div className="text-[10px] uppercase tracking-widest text-slate-500 mb-1">{r.table}</div>
          <pre className="text-[11px] text-slate-300 whitespace-pre-wrap break-all">{JSON.stringify(r.row, null, 2)}</pre>
        </div>
      ))}
    </div>
  );
};

const ColdStorage: React.FC = () => {
  const [kind, setKind] = useState<ColdKind | ''>('');
  const [ref, setRef] = useState('');
  const [search, setSearch] = useState('');
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<ColdPage | null>(null);
  const [failed, setFailed] = useState('');
  const [open, setOpen] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      setPage(await api.coldStorage.list({ kind: kind || undefined, ref: search || undefined, offset }));
      setFailed('');
    } catch (e: any) {
      setFailed(e?.response?.data?.message || 'Cold storage could not be loaded.');
    }
  }, [kind, search, offset]);
  useEffect(() => { void load(); }, [load]);

  const entries: ColdEntry[] = page?.entries ?? [];
  const pageSize = 100;

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <p className="text-xs text-slate-400 max-w-3xl">
          Rounds past the newest 1,440 per board and profile, ended orders&apos; chats and players&apos; notifications
          older than {page?.coldAfterDays ?? '…'} days move here from the live tables. Players, merchants and other
          staff cannot see them; balances, bets, orders and the ledger are never moved. Only a full admin can open an
          entry, and every opening is recorded in the audit log.
        </p>
        <button type="button" onClick={() => void load()} className="btn-secondary text-xs flex items-center gap-1.5 shrink-0">
          <RefreshCw size={12} /> Refresh
        </button>
      </div>

      {page && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {page.kinds.map((k) => (
            <button key={k} type="button" onClick={() => { setKind(kind === k ? '' : k); setOffset(0); }}
              className={`text-left rounded-xl border p-3 ${kind === k ? 'border-amber-400/60 bg-amber-400/10' : 'border-slate-700 bg-slate-900'}`}>
              <div className="flex items-center gap-2 text-[11px] uppercase tracking-widest text-slate-400"><Archive size={12} /> {KIND_LABEL[k]?.name ?? k}</div>
              <div className="text-2xl font-bold mt-1 text-slate-100">{page.totals[k]?.entries.toLocaleString('en-IN') ?? 0}</div>
              <div className="text-[11px] text-slate-500">{page.totals[k]?.rows.toLocaleString('en-IN') ?? 0} rows</div>
            </button>
          ))}
        </div>
      )}

      <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); setSearch(ref.trim()); setOffset(0); }}>
        <div>
          <label htmlFor="cold-ref" className="block text-[10px] uppercase tracking-widest text-slate-500 mb-1">
            {kind ? KIND_LABEL[kind].ref : 'Round, order or player id'}
          </label>
          <input id="cold-ref" value={ref} onChange={(e) => setRef(e.target.value)} className="input text-xs py-1.5 w-72" placeholder="Exact id" />
        </div>
        <button type="submit" className="btn-secondary text-xs flex items-center gap-1.5"><Search size={12} /> Find</button>
        {(search || kind) && (
          <button type="button" onClick={() => { setRef(''); setSearch(''); setKind(''); setOffset(0); }} className="text-xs text-slate-400 hover:text-white underline pb-2">Clear</button>
        )}
      </form>

      {failed && <div role="alert" className="rounded-lg border border-red-900/50 bg-red-900/20 px-4 py-3 text-sm text-red-300">{failed}</div>}

      {!failed && page && entries.length === 0 && (
        <div className="text-center py-16 text-slate-500">
          <Archive size={32} className="mx-auto mb-3" />
          <div className="font-semibold">Nothing in cold storage here</div>
        </div>
      )}

      {entries.length > 0 && (
        <div className="overflow-x-auto rounded-xl border border-slate-800">
          <table className="w-full text-xs">
            <thead className="bg-slate-900 text-slate-400 uppercase tracking-wider text-[10px]">
              <tr>
                <th className="px-3 py-2.5 text-left" />
                <th className="px-3 py-2.5 text-left">Kind</th>
                <th className="px-3 py-2.5 text-left">Id</th>
                <th className="px-3 py-2.5 text-right">Rows</th>
                <th className="px-3 py-2.5 text-left">From</th>
                <th className="px-3 py-2.5 text-left">To</th>
                <th className="px-3 py-2.5 text-left">Moved</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <React.Fragment key={e.id}>
                  <tr className="border-t border-slate-800 hover:bg-slate-900/60 cursor-pointer" onClick={() => setOpen(open === e.id ? null : e.id)}>
                    <td className="px-3 py-2.5 text-slate-500">
                      <button type="button" aria-label={open === e.id ? 'Close entry' : 'Open entry'} onClick={(ev) => { ev.stopPropagation(); setOpen(open === e.id ? null : e.id); }}>
                        {open === e.id ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                      </button>
                    </td>
                    <td className="px-3 py-2.5 text-slate-300">{KIND_LABEL[e.kind]?.name ?? e.kind}</td>
                    <td className="px-3 py-2.5 font-mono text-slate-200">{e.ref}</td>
                    <td className="px-3 py-2.5 text-right font-mono text-slate-200">{e.rowCount.toLocaleString('en-IN')}</td>
                    <td className="px-3 py-2.5 text-slate-400">{when(e.firstAt)}</td>
                    <td className="px-3 py-2.5 text-slate-400">{when(e.lastAt)}</td>
                    <td className="px-3 py-2.5 text-slate-400">{when(e.archivedAt)}</td>
                  </tr>
                  {open === e.id && (
                    <tr className="bg-slate-950/60"><td colSpan={7} className="px-3 py-3"><EntryRows id={e.id} /></td></tr>
                  )}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {page && (offset > 0 || entries.length === pageSize) && (
        <div className="flex gap-2">
          <button type="button" disabled={offset === 0} onClick={() => setOffset(Math.max(offset - pageSize, 0))} className="btn-secondary text-xs disabled:opacity-40">Newer</button>
          <button type="button" disabled={entries.length < pageSize} onClick={() => setOffset(offset + pageSize)} className="btn-secondary text-xs disabled:opacity-40">Older</button>
        </div>
      )}
    </div>
  );
};

export default ColdStorage;
