// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * ErrorLogs.tsx — Admin Panel › System › Error Logs (owner, 2026-10-20).
 *
 * Every failure the platform saw, server and all three panels, one row per
 * distinct error (`GET /api/admin/error-log`, database/repositories/errorLog.js):
 * when it was first and last seen, how often, where it came from, what kind it
 * is, how bad it is (red critical, yellow warning, green minor) and whether
 * somebody has fixed it. Marking a row fixed is a button on the row; the same
 * error coming back reopens it on the server, and the row says so.
 *
 * The filter choices are the server's vocabulary, sent with every answer;
 * this screen keeps no list of its own (§32 S25).
 */
import React, { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, RefreshCw, RotateCcw, Trash2 } from 'lucide-react';
import toast from 'react-hot-toast';
import api, { type ErrorLogEntry, type ErrorLogPage, type ErrorSeverity } from '../../services/api';

const SEVERITY: Record<ErrorSeverity, { label: string; dot: string; chip: string }> = {
  CRITICAL: { label: 'Critical', dot: 'bg-red-500',     chip: 'bg-red-500/15 text-red-300 border-red-500/40' },
  WARNING:  { label: 'Warning',  dot: 'bg-amber-400',   chip: 'bg-amber-400/15 text-amber-200 border-amber-400/40' },
  MINOR:    { label: 'Minor',    dot: 'bg-emerald-400', chip: 'bg-emerald-400/15 text-emerald-200 border-emerald-400/40' },
};

/** How each server word reads on screen; an unknown one is shown as sent. */
const SOURCE_LABEL: Record<string, string> = {
  SERVER: 'Server', PLAYER_APP: 'Player app', MERCHANT_PANEL: 'Merchant panel', ADMIN_PANEL: 'Admin panel',
};
const CATEGORY_LABEL: Record<string, string> = {
  API: 'Request failed', JOB: 'Background job', MONEY_ALERT: 'Money alert', SERVER_LOG: 'Server log',
  SCREEN_CRASH: 'Screen crashed', SCRIPT: 'Script error', PROMISE: 'Unhandled promise', UPDATE_LOAD: 'Old page after update',
};
const label = (map: Record<string, string>, k: string) => map[k] ?? k;

const when = (iso: string | null) => {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }) + ' IST';
};

type Filters = { source: string; category: string; severity: string; status: string };
const NO_FILTERS: Filters = { source: '', category: '', severity: '', status: '' };

const Select: React.FC<{ id: string; label: string; value: string; options: string[]; names?: Record<string, string>; onChange: (v: string) => void }> = ({
  id, label: text, value, options, names = {}, onChange,
}) => (
  <div>
    <label htmlFor={id} className="block text-[10px] uppercase tracking-widest text-slate-500 mb-1">{text}</label>
    <select id={id} value={value} onChange={(e) => onChange(e.target.value)} className="input text-xs py-1.5">
      <option value="">All</option>
      {options.map((o) => <option key={o} value={o}>{label(names, o)}</option>)}
    </select>
  </div>
);

const ErrorLogs: React.FC = () => {
  const [page, setPage] = useState<ErrorLogPage | null>(null);
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  const load = useCallback(async (f: Filters) => {
    setLoading(true);
    try {
      const wanted = Object.fromEntries(Object.entries(f).filter(([, v]) => v));
      setPage(await api.errorLog.list(wanted));
      setFailed(null);
    } catch (e: any) {
      setFailed(e?.response?.data?.message || 'The error log could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(filters); }, [load, filters]);

  const setStatus = async (entry: ErrorLogEntry, status: 'OPEN' | 'FIXED') => {
    setBusyId(entry.id);
    try {
      const next = await api.errorLog.setStatus(entry.id, status);
      setPage((p) => p && { ...p, entries: p.entries.map((e) => (e.id === next.id ? next : e)) });
      toast.success(status === 'FIXED' ? 'Marked fixed' : 'Opened again');
      void load(filters);
    } catch (e: any) {
      toast.error(e?.response?.data?.message || 'Could not change that error');
    } finally {
      setBusyId(null);
    }
  };

  const clearFixed = async () => {
    try {
      const res = await api.errorLog.clearFixed();
      toast.success(res.message);
      void load(filters);
    } catch (e: any) {
      toast.error(e?.response?.data?.message || 'Could not remove the fixed errors');
    }
  };

  const totals = page?.totals;
  const entries = page?.entries ?? [];

  return (
    <div className="om-fade max-w-6xl mx-auto space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <AlertTriangle className="text-red-400" size={22} />
          <div>
            <h1 className="text-xl font-bold text-white">Error Logs</h1>
            <p className="text-xs text-gray-500 mt-0.5">
              Server, player app, merchant panel and admin panel. Each error is one row; repeats are counted.
            </p>
          </div>
        </div>
        <div className="flex gap-2">
          <button type="button" onClick={() => void load(filters)} disabled={loading}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs disabled:opacity-50">
            <RefreshCw size={13} className={loading ? 'animate-spin' : ''} /> Refresh
          </button>
          {!!totals?.fixed && (
            <button type="button" onClick={() => void clearFixed()}
              className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs">
              <Trash2 size={13} /> Remove fixed ({totals.fixed})
            </button>
          )}
        </div>
      </div>

      {totals && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3" aria-label="Open errors by severity">
          {([['CRITICAL', totals.critical], ['WARNING', totals.warning], ['MINOR', totals.minor]] as const).map(([sev, n]) => (
            <button key={sev} type="button" onClick={() => setFilters({ ...filters, severity: filters.severity === sev ? '' : sev, status: 'OPEN' })}
              className={`text-left rounded-xl border p-3 ${SEVERITY[sev].chip}`}>
              <div className="flex items-center gap-2 text-[11px] uppercase tracking-widest">
                <span className={`w-2.5 h-2.5 rounded-full ${SEVERITY[sev].dot}`} /> {SEVERITY[sev].label} open
              </div>
              <div className="text-2xl font-bold mt-1">{n}</div>
            </button>
          ))}
          <button type="button" onClick={() => setFilters({ ...filters, status: filters.status === 'FIXED' ? '' : 'FIXED', severity: '' })}
            className="text-left rounded-xl border border-slate-700 bg-slate-900 p-3 text-slate-300">
            <div className="flex items-center gap-2 text-[11px] uppercase tracking-widest"><CheckCircle2 size={12} /> Fixed</div>
            <div className="text-2xl font-bold mt-1">{totals.fixed}</div>
          </button>
        </div>
      )}

      {page && (
        <div className="flex flex-wrap items-end gap-3">
          <Select id="el-source" label="Where" value={filters.source} options={page.sources} names={SOURCE_LABEL} onChange={(v) => setFilters({ ...filters, source: v })} />
          <Select id="el-category" label="Kind" value={filters.category} options={page.categories} names={CATEGORY_LABEL} onChange={(v) => setFilters({ ...filters, category: v })} />
          <Select id="el-severity" label="Severity" value={filters.severity} options={page.severities} names={Object.fromEntries(Object.entries(SEVERITY).map(([k, v]) => [k, v.label]))} onChange={(v) => setFilters({ ...filters, severity: v })} />
          <Select id="el-status" label="Status" value={filters.status} options={page.statuses} names={{ OPEN: 'Not fixed', FIXED: 'Fixed' }} onChange={(v) => setFilters({ ...filters, status: v })} />
          {JSON.stringify(filters) !== JSON.stringify(NO_FILTERS) && (
            <button type="button" onClick={() => setFilters(NO_FILTERS)} className="text-xs text-slate-400 hover:text-white underline pb-2">Clear filters</button>
          )}
        </div>
      )}

      {failed && <div role="alert" className="rounded-lg border border-red-900/50 bg-red-900/20 px-4 py-3 text-sm text-red-300">{failed}</div>}

      {!failed && page && entries.length === 0 && (
        <div className="text-center py-16 text-slate-500">
          <CheckCircle2 size={32} className="mx-auto mb-3 text-emerald-400" />
          <div className="font-semibold">No errors here</div>
          <div className="text-xs mt-1">Nothing matches these filters.</div>
        </div>
      )}

      {entries.length > 0 && (
        <div className="overflow-x-auto rounded-xl border border-slate-800">
          <table className="w-full text-xs">
            <thead className="bg-slate-900 text-slate-400 uppercase tracking-wider text-[10px]">
              <tr>
                <th className="px-3 py-2.5 text-left">Severity</th>
                <th className="px-3 py-2.5 text-left">Error</th>
                <th className="px-3 py-2.5 text-left">Where</th>
                <th className="px-3 py-2.5 text-left">Kind</th>
                <th className="px-3 py-2.5 text-right">Times</th>
                <th className="px-3 py-2.5 text-left">Last seen</th>
                <th className="px-3 py-2.5 text-left">First seen</th>
                <th className="px-3 py-2.5 text-left">Status</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => {
                const sev = SEVERITY[e.severity] ?? SEVERITY.WARNING;
                const open = expanded === e.id;
                const fixed = e.status === 'FIXED';
                return (
                  <React.Fragment key={e.id}>
                    <tr className={`border-t border-slate-800 align-top ${fixed ? 'opacity-60' : ''}`}>
                      <td className="px-3 py-2.5">
                        <span className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-semibold ${sev.chip}`}>
                          <span className={`w-2 h-2 rounded-full ${sev.dot}`} /> {sev.label}
                        </span>
                      </td>
                      <td className="px-3 py-2.5 max-w-[28rem]">
                        <button type="button" onClick={() => setExpanded(open ? null : e.id)}
                          aria-expanded={open} className="flex items-start gap-1.5 text-left text-slate-200 hover:text-white">
                          {open ? <ChevronDown size={13} className="mt-0.5 shrink-0" /> : <ChevronRight size={13} className="mt-0.5 shrink-0" />}
                          <span className="font-mono break-all line-clamp-2">{e.message}</span>
                        </button>
                        {e.reopened > 0 && <div className="mt-1 text-[10px] text-amber-300">Came back after a fix ({e.reopened}×)</div>}
                      </td>
                      <td className="px-3 py-2.5 whitespace-nowrap text-slate-300">{label(SOURCE_LABEL, e.source)}</td>
                      <td className="px-3 py-2.5 whitespace-nowrap text-slate-300">{label(CATEGORY_LABEL, e.category)}</td>
                      <td className="px-3 py-2.5 text-right font-mono text-slate-200">{e.occurrences.toLocaleString('en-IN')}</td>
                      <td className="px-3 py-2.5 whitespace-nowrap text-slate-300">{when(e.lastSeenAt)}</td>
                      <td className="px-3 py-2.5 whitespace-nowrap text-slate-500">{when(e.firstSeenAt)}</td>
                      <td className="px-3 py-2.5 whitespace-nowrap">
                        {fixed ? (
                          <div className="space-y-1">
                            <div className="flex items-center gap-1 text-emerald-300"><CheckCircle2 size={12} /> Fixed</div>
                            <div className="text-[10px] text-slate-500">{when(e.fixedAt)}{e.fixedBy ? ` · ${e.fixedBy}` : ''}</div>
                            <button type="button" disabled={busyId === e.id} onClick={() => void setStatus(e, 'OPEN')}
                              className="flex items-center gap-1 text-[10px] text-slate-400 hover:text-white disabled:opacity-50">
                              <RotateCcw size={10} /> Not fixed
                            </button>
                          </div>
                        ) : (
                          <div className="space-y-1">
                            <div className="text-red-300">Not fixed</div>
                            <button type="button" disabled={busyId === e.id} onClick={() => void setStatus(e, 'FIXED')}
                              className="rounded-md bg-emerald-600/80 hover:bg-emerald-600 text-white px-2 py-1 text-[10px] font-semibold disabled:opacity-50">
                              Mark fixed
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                    {open && (
                      <tr className="border-t border-slate-800 bg-black/30">
                        <td colSpan={8} className="px-4 py-4 space-y-3">
                          <div>
                            <div className="text-[10px] text-slate-500 uppercase tracking-widest mb-1">Full message</div>
                            <div className="font-mono text-slate-200 break-all">{e.message}</div>
                          </div>
                          {e.location && (
                            <div>
                              <div className="text-[10px] text-slate-500 uppercase tracking-widest mb-1">Location</div>
                              <div className="font-mono text-slate-400 break-all">{e.location}</div>
                            </div>
                          )}
                          {e.detail && (
                            <div>
                              <div className="text-[10px] text-slate-500 uppercase tracking-widest mb-1">Stack / detail</div>
                              <pre className="text-[10px] text-slate-400 font-mono whitespace-pre-wrap break-all max-h-64 overflow-y-auto bg-black/40 p-3 rounded-lg">{e.detail}</pre>
                            </div>
                          )}
                          {e.component && (
                            <div>
                              <div className="text-[10px] text-slate-500 uppercase tracking-widest mb-1">Screen components</div>
                              <pre className="text-[10px] text-slate-400 font-mono whitespace-pre-wrap break-all max-h-40 overflow-y-auto bg-black/40 p-3 rounded-lg">{e.component}</pre>
                            </div>
                          )}
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

export default ErrorLogs;
