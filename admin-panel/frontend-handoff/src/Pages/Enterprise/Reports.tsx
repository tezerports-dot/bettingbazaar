// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * Reports.tsx — Reporting Platform console (Phase 012 APIs, UI shipped
 * Phase C 2026-07-10). Financial / settlement / merchant reports with a
 * date range, plus the regulatory ledger CSV export (one row per posting).
 * All read-only and derived — reports never re-compute business math.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Download, RefreshCw } from 'lucide-react';
import toast from 'react-hot-toast';
import api from '../../services/api';
import { usePermissions } from '../../hooks/usePermission';
import { Toolbar } from '../../components/design';

const inr = (n: number) =>
  '₹' + (n ?? 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });

type Tab = 'financial' | 'settlement' | 'merchants';

export const Reports: React.FC = () => {
  const { isAdmin } = usePermissions();
  const [tab, setTab] = useState<Tab>('financial');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [financial, setFinancial] = useState<any>(null);
  const [settlementDays, setSettlementDays] = useState<any[]>([]);
  const [merchants, setMerchants] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  const params = useCallback(() => ({
    ...(from ? { from } : {}), ...(to ? { to } : {}),
  }), [from, to]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [f, s, m] = await Promise.all([
        api.get<any>('/api/admin/reports/financial', { params: params() }),
        api.get<any>('/api/admin/reports/settlement', { params: params() }),
        api.get<any>('/api/admin/reports/merchants', { params: params() }),
      ]);
      if (f.data?.success) setFinancial(f.data.report);
      if (s.data?.success) setSettlementDays(s.data.days || []);
      if (m.data?.success) setMerchants(m.data.merchants || []);
    } catch {
      toast.error('Failed to load reports');
    } finally {
      setLoading(false);
    }
  }, [params]);

  useEffect(() => { load(); }, [load]);

  const downloadCsv = async () => {
    try {
      const res = await api.get('/api/admin/reports/ledger-export', {
        params: { ...params(), format: 'csv' },
        responseType: 'blob',
      });
      const url = URL.createObjectURL(new Blob([res.data as any], { type: 'text/csv' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `ledger-export-${from || 'start'}-${to || 'now'}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      toast.error('Export failed');
    }
  };

  return (
    <div className="om-fade space-y-6">
      <Toolbar
        tabs={[
          { label: 'Financial', active: tab === 'financial', onClick: () => setTab('financial') },
          { label: 'Settlement', active: tab === 'settlement', onClick: () => setTab('settlement') },
          { label: 'Merchants', active: tab === 'merchants', onClick: () => setTab('merchants') },
        ]}
      />
      <div className="flex items-end gap-2 flex-wrap">
        <div><label className="label">From</label><input type="date" className="input" style={{ width: 170 }} value={from} onChange={(e) => setFrom(e.target.value)} /></div>
        <div><label className="label">To</label><input type="date" className="input" style={{ width: 170 }} value={to} onChange={(e) => setTo(e.target.value)} /></div>
        <button onClick={load} className="btn-primary flex items-center h-10" disabled={loading}>
          <RefreshCw size={16} className={`mr-2 ${loading ? 'animate-spin' : ''}`} /> Run
        </button>
        {isAdmin && (
          <button onClick={downloadCsv} className="btn-primary flex items-center h-10" title="Regulatory export — one CSV row per journal posting">
            <Download size={16} className="mr-2" /> Ledger CSV
          </button>
        )}
      </div>

      {tab === 'financial' && financial && (
        <div className="card">
          <p className="text-xs text-gray-500 mb-3">
            {financial.entryCount} ledger entries in period
            {financial.period?.from ? ` from ${financial.period.from}` : ''}
            {financial.period?.to ? ` to ${financial.period.to}` : ''}.
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-gray-500 border-b border-dark-700">
                  <th className="py-2 pr-3">Account</th>
                  <th className="py-2 pr-3 text-right">Debits</th>
                  <th className="py-2 pr-3 text-right">Credits</th>
                  <th className="py-2 text-right">Net movement</th>
                </tr>
              </thead>
              <tbody>
                {(financial.accounts || []).map((a: any) => (
                  <tr key={a.account} className="border-b border-dark-800">
                    <td className="py-2 pr-3 text-gray-200">{a.account}</td>
                    <td className="py-2 pr-3 text-right font-mono">{inr(a.debit)}</td>
                    <td className="py-2 pr-3 text-right font-mono">{inr(a.credit)}</td>
                    <td className={`py-2 text-right font-mono ${a.netMovement >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                      {inr(a.netMovement)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            {(financial.eventTypes || []).map((e: any) => (
              <span key={e.eventType} className="px-2 py-1 bg-dark-800 rounded-sm text-xs text-gray-400">
                {e.eventType}: <span className="text-gray-200">{e.events}</span>
              </span>
            ))}
          </div>
        </div>
      )}

      {tab === 'settlement' && (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-gray-500 border-b border-dark-700">
                <th className="py-2 pr-3">Day</th>
                <th className="py-2 pr-3 text-right">Events</th>
                <th className="py-2">By event type (gross moved)</th>
              </tr>
            </thead>
            <tbody>
              {settlementDays.map((d: any) => (
                <tr key={d.day} className="border-b border-dark-800 align-top">
                  <td className="py-2 pr-3 font-mono text-gray-300">{d.day}</td>
                  <td className="py-2 pr-3 text-right">{d.totalEvents}</td>
                  <td className="py-2">
                    <div className="flex flex-wrap gap-2">
                      {(d.byEventType || []).map((e: any) => (
                        <span key={e.eventType} className="px-2 py-0.5 bg-dark-800 rounded-sm text-xs">
                          <span className="text-gray-400">{e.eventType}</span>{' '}
                          <span className="text-gray-200">×{e.events}</span>{' '}
                          <span className="text-gold-400/90 font-mono">{inr(e.gross)}</span>
                        </span>
                      ))}
                    </div>
                  </td>
                </tr>
              ))}
              {!loading && settlementDays.length === 0 && (
                <tr><td colSpan={3} className="py-6 text-center text-gray-500">No settlement activity in period.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {tab === 'merchants' && (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-gray-500 border-b border-dark-700">
                <th className="py-2 pr-3">Merchant</th>
                <th className="py-2 pr-3 text-right">Deposits</th>
                <th className="py-2 pr-3 text-right">Deposit volume</th>
                <th className="py-2 pr-3 text-right">Withdrawals</th>
                <th className="py-2 pr-3 text-right">Withdrawal volume</th>
                <th className="py-2 pr-3 text-right">Bonuses</th>
                <th className="py-2 text-right">Bonus total</th>
              </tr>
            </thead>
            <tbody>
              {merchants.map((m: any) => (
                <tr key={m.merchantId} className="border-b border-dark-800">
                  <td className="py-2 pr-3 text-gray-200">{m.username}</td>
                  <td className="py-2 pr-3 text-right">{m.deposits}</td>
                  <td className="py-2 pr-3 text-right font-mono">{inr(m.depositVolume)}</td>
                  <td className="py-2 pr-3 text-right">{m.withdrawals}</td>
                  <td className="py-2 pr-3 text-right font-mono">{inr(m.withdrawalVolume)}</td>
                  <td className="py-2 pr-3 text-right">{m.bonuses}</td>
                  <td className="py-2 text-right font-mono text-gold-400/90">{inr(m.bonusTotal)}</td>
                </tr>
              ))}
              {!loading && merchants.length === 0 && (
                <tr><td colSpan={7} className="py-6 text-center text-gray-500">No merchant activity in period.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};
