// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * ErrorLogs.tsx -- FIX-4h: reads from API
 * Admin Panel › System › Error Logs
 *
 * Replaces the broken localStorage approach (origin-scoped; crash reports
 * written by the user/merchant panel were silently discarded in the admin panel
 * because they run on different origins). Now reads from the backend DB via
 * GET /api/admin/error-reports (written by ErrorBoundary POST).
 */
import React, { useEffect, useState, useCallback } from 'react';
import { AlertTriangle, Trash2, RefreshCw, ChevronDown, ChevronRight } from 'lucide-react';
import api from '../../services/api';
import toast from 'react-hot-toast';

interface CrashReport {
  _id:        string;
  message:    string;
  stack?:     string;
  component?: string;
  url?:       string;
  panel:      'user' | 'merchant' | 'unknown';
  ts:         string;
}

const PANEL_BADGE: Record<string, { label: string; cls: string }> = {
  user:     { label: 'User Panel',     cls: 'bg-blue-900/40 text-blue-300 border-blue-800/50' },
  merchant: { label: 'Merchant Panel', cls: 'bg-purple-900/40 text-purple-300 border-purple-800/50' },
  unknown:  { label: 'Unknown',        cls: 'bg-slate-800 text-slate-400 border-slate-700' },
};

const ErrorLogs: React.FC = () => {
  const [reports, setReports]     = useState<CrashReport[]>([]);
  const [expanded, setExpanded]   = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const load = useCallback(async () => {
    setIsLoading(true);
    try {
      const res = await api.errorReports.getAll();
      if (res?.success && Array.isArray(res.data)) {
        setReports(res.data);
      } else {
        toast.error('Failed to load error reports');
      }
    } catch {
      toast.error('Failed to load error reports');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const clearAll = async () => {
    try {
      await api.errorReports.clearAll();
      setReports([]); setExpanded(null);
      toast.success('All error reports cleared');
    } catch {
      toast.error('Failed to clear reports');
    }
  };

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <AlertTriangle className="text-red-400" size={22} />
          <div>
            <h1 className="text-xl font-bold text-white">Frontend Error Logs</h1>
            <p className="text-xs text-gray-500 mt-0.5">
              Crash reports from user &amp; merchant panels — captured by ErrorBoundary, stored in DB
            </p>
          </div>
        </div>
        <div className="flex gap-2">
          <button onClick={load} disabled={isLoading}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs transition-colors disabled:opacity-50">
            <RefreshCw size={13} className={isLoading ? 'animate-spin' : ''} />
            {isLoading ? 'Loading\u2026' : 'Refresh'}
          </button>
          {reports.length > 0 && (
            <button onClick={clearAll}
              className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-red-900/40 hover:bg-red-900/60 text-red-400 text-xs transition-colors border border-red-900/50">
              <Trash2 size={13} /> Clear all
            </button>
          )}
        </div>
      </div>

      {isLoading && reports.length === 0 ? (
        <div className="text-center py-20 text-slate-600">
          <RefreshCw size={32} className="mx-auto mb-4 animate-spin opacity-40" />
          <div className="text-sm">Loading reports\u2026</div>
        </div>
      ) : reports.length === 0 ? (
        <div className="text-center py-20 text-slate-600">
          <div className="text-4xl mb-4">\u2705</div>
          <div className="font-semibold text-slate-500">No crash reports</div>
          <div className="text-xs mt-1">ErrorBoundary has not caught anything yet</div>
        </div>
      ) : (
        <div className="space-y-3">
          {reports.map((r) => {
            const badge = PANEL_BADGE[r.panel] ?? PANEL_BADGE.unknown;
            return (
              <div key={r._id} className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
                <div className="flex items-center justify-between px-4 py-3 cursor-pointer hover:bg-slate-800/50 transition-colors"
                  onClick={() => setExpanded(expanded === r._id ? null : r._id)}>
                  <div className="flex items-center gap-3 min-w-0">
                    {expanded === r._id
                      ? <ChevronDown  size={14} className="text-slate-400 flex-shrink-0" />
                      : <ChevronRight size={14} className="text-slate-400 flex-shrink-0" />}
                    <span className={`text-[10px] font-mono px-2 py-0.5 rounded border flex-shrink-0 ${badge.cls}`}>
                      {badge.label}
                    </span>
                    <span className="text-red-400 font-mono text-sm truncate">{r.message}</span>
                  </div>
                  <span className="text-[10px] text-slate-500 font-mono flex-shrink-0 ml-4">
                    {new Date(r.ts).toLocaleString()}
                  </span>
                </div>
                {expanded === r._id && (
                  <div className="border-t border-slate-800 px-4 py-4 space-y-4 bg-black/30">
                    {r.url && (
                      <div>
                        <div className="text-[10px] text-slate-500 uppercase tracking-widest font-mono mb-1">URL</div>
                        <div className="text-xs text-slate-400 font-mono break-all">{r.url}</div>
                      </div>
                    )}
                    {r.stack && (
                      <div>
                        <div className="text-[10px] text-slate-500 uppercase tracking-widest font-mono mb-1">Stack Trace</div>
                        <pre className="text-[10px] text-slate-400 font-mono whitespace-pre-wrap break-all max-h-64 overflow-y-auto bg-black/40 p-3 rounded-lg leading-relaxed">{r.stack}</pre>
                      </div>
                    )}
                    {r.component && (
                      <div>
                        <div className="text-[10px] text-slate-500 uppercase tracking-widest font-mono mb-1">Component Stack</div>
                        <pre className="text-[10px] text-slate-400 font-mono whitespace-pre-wrap break-all max-h-40 overflow-y-auto bg-black/40 p-3 rounded-lg leading-relaxed">{r.component}</pre>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default ErrorLogs;
