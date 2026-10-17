// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * A merchant account's reports (owner, 2026-10-11 — Phase B): deposits and
 * withdrawals over a range of IST days, per payment account and per
 * sub-member — orders, completed, completed tokens, disputes and disputes
 * lost — and the orders behind them, one row each with who pressed ✓ or ✗
 * (`OrderReportTable`, owner 2026-10-16), downloadable as CSV.
 *
 * The figures are the server's (GET /api/merchant/account/reports); nothing
 * here adds them up again. The owner's and AUDIT's (`ownerOrAudit`); a range
 * the server refuses (INVALID_REPORT_RANGE) is said in its words.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { BarChart3 } from 'lucide-react';
import { api } from '../../services/api';
import { formatTokens } from '../../utils/rail';
import { Button, Card, CardTitle, Field, Skeleton, inputStyle } from '../../components/ui';
import AccountShell, { Refusal } from './AccountShell';
import OrderReportTable from '../../components/OrderReportTable';
import type { MerchantReport, ReportFigures } from '../../types';

const errorText = (err: any, fallback: string): string => err?.message || fallback;
const tokensOf = (paise: number) => formatTokens((Number(paise) || 0) / 100);

const COLUMNS: Array<{ key: keyof ReportFigures; label: string; render?: (v: number) => string }> = [
  { key: 'orders', label: 'Orders' },
  { key: 'completed', label: 'Completed' },
  { key: 'completedPaise', label: 'Completed tokens', render: tokensOf },
  { key: 'disputed', label: 'Disputed' },
  { key: 'disputesLost', label: 'Disputes lost' },
];

/** One table: a row per name, deposits and withdrawals side by side. */
const FiguresTable: React.FC<{
  caption: string;
  rows: Array<{ key: string; name: string; deposits: ReportFigures; withdrawals: ReportFigures }>;
}> = ({ caption, rows }) => (
  <div style={{ overflowX: 'auto' }}>
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
      <caption style={{ textAlign: 'left', fontSize: 13, fontWeight: 800, color: 'var(--text)', padding: '4px 0 8px' }}>{caption}</caption>
      <thead>
        <tr style={{ color: 'var(--muted)', textAlign: 'left' }}>
          <th scope="col" style={{ padding: '6px 8px' }}>Name</th>
          <th scope="col" style={{ padding: '6px 8px' }}>Direction</th>
          {COLUMNS.map((c) => <th key={c.key} scope="col" style={{ padding: '6px 8px', textAlign: 'right' }}>{c.label}</th>)}
        </tr>
      </thead>
      <tbody>
        {rows.flatMap((row) => (['deposits', 'withdrawals'] as const).map((side) => (
          <tr key={`${row.key}-${side}`} style={{ borderTop: '1px solid var(--border)' }}>
            {side === 'deposits' && <th scope="row" rowSpan={2} style={{ padding: '6px 8px', textAlign: 'left', color: 'var(--text)' }}>{row.name}</th>}
            <td style={{ padding: '6px 8px', color: 'var(--text-2)' }}>{side === 'deposits' ? 'Deposits' : 'Withdrawals'}</td>
            {COLUMNS.map((c) => (
              <td key={c.key} className="bb-mono" style={{ padding: '6px 8px', textAlign: 'right', color: 'var(--text)' }}>
                {c.render ? c.render(row[side][c.key]) : row[side][c.key]}
              </td>
            ))}
          </tr>
        )))}
      </tbody>
    </table>
  </div>
);

const ReportsBody: React.FC = () => {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [report, setReport] = useState<MerchantReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [refusal, setRefusal] = useState('');
  // The range the table shows: the one the figures were last built for.
  const [shown, setShown] = useState({ from: '', to: '' });

  const load = useCallback(async (f: string, t: string) => {
    setLoading(true); setRefusal('');
    try {
      setReport(await api.getMerchantReport(f, t));
      setShown({ from: f, to: t });
    } catch (err) {
      setRefusal(errorText(err, 'Could not build the report.'));
    } finally {
      setLoading(false);
    }
  }, []);

  // The server's default range (the last seven IST days) on arrival.
  useEffect(() => { void load('', ''); }, [load]);

  return (
    <>
      <Card>
        <CardTitle title="Range" sub="IST days. Leave both empty for the last seven days." />
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'flex-end' }}>
          <Field label="From" htmlFor="report-from">
            <input id="report-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} style={inputStyle} />
          </Field>
          <Field label="To" htmlFor="report-to">
            <input id="report-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} style={inputStyle} />
          </Field>
          <Button onClick={() => void load(from, to)} busy={loading}>Show report</Button>
        </div>
        <Refusal message={refusal} style={{ marginTop: 10 }} />
      </Card>

      {loading && !report && <Skeleton height={200} />}
      {report && (
        <Card>
          <div role="status" style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)', marginBottom: 10 }}>
            {report.range.from || report.range.to
              ? `From ${report.range.from ?? 'the start'} to ${report.range.to ?? 'today'}`
              : 'The last seven days'}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
            <FiguresTable caption="Totals" rows={[{ key: 'totals', name: 'All', ...report.totals }]} />
            <FiguresTable caption="Per payment account"
              rows={[
                ...report.byAccount.map((a) => ({
                  key: a.accountId, name: `${a.label}${a.status === 'REMOVED' ? ' (removed)' : ''}`,
                  deposits: a.deposits, withdrawals: a.withdrawals,
                })),
                { key: 'unattributed', name: 'No account recorded', ...report.unattributed },
              ]} />
            <FiguresTable caption="Per sub-member (their assigned accounts, for the duty they hold them for)"
              rows={report.bySubMember.map((s) => ({
                key: s.staffId, name: `${s.name}${s.status === 'REMOVED' ? ' (removed)' : ''}`,
                deposits: s.deposits, withdrawals: s.withdrawals,
              }))} />
          </div>
        </Card>
      )}
      <OrderReportTable from={shown.from} to={shown.to} />
    </>
  );
};

const ReportsPage: React.FC = () => (
  <AccountShell>
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 15, fontWeight: 800, color: 'var(--text)' }}>
      <BarChart3 size={18} /> Reports
    </div>
    <ReportsBody />
  </AccountShell>
);

export default ReportsPage;
