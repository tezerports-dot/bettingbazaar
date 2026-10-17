// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The order report as a table (owner, 2026-10-16): transaction ID, user, UTR,
 * amount, time, and the ✓ or ✗ pressed with who pressed it, one row per order.
 *
 * Every figure is the server's (GET /api/merchant/reports/orders): the totals
 * cover every row of the range, not this page, and nothing here adds them up
 * again. The CSV is the same rows from the server (…/orders.csv). A refusal
 * (a bad range) is said in the server's words.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Download } from 'lucide-react';
import { api } from '../services/api';
import { formatTokens } from '../utils/rail';
import type { OrderReport, OrderReportRow } from '../types';
import { Button, SegmentedControl, Skeleton, cardStyle } from './ui';

const PAGE = 50;
type Direction = '' | 'DEPOSIT' | 'WITHDRAWAL';

const errorText = (err: unknown, fallback: string): string =>
  (err as { message?: string } | null)?.message || fallback;

const when = (at: string): string =>
  new Date(at).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });

/** The ✓/✗ cell: the mark, then who pressed it; an order nobody marked shows its state. */
const ResultCell: React.FC<{ row: OrderReportRow }> = ({ row }) => {
  if (row.result === 'NONE') {
    return <span style={{ color: 'var(--muted)' }}>{row.state.charAt(0) + row.state.slice(1).toLowerCase()}</span>;
  }
  const ok = row.result === 'CONFIRMED';
  return (
    <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
      <span aria-label={ok ? 'Confirmed' : 'Rejected'} style={{ fontWeight: 800, color: ok ? 'var(--dep)' : 'var(--danger)' }}>
        {ok ? '✓' : '✗'}
      </span>
      <span style={{ color: 'var(--text-2)' }}>{row.actedBy?.name ?? ''}</span>
    </span>
  );
};

const cell: React.CSSProperties = { padding: '8px 10px', whiteSpace: 'nowrap' };

const OrderReportTable: React.FC<{ from?: string; to?: string }> = ({ from = '', to = '' }) => {
  const [type, setType] = useState<Direction>('');
  const [skip, setSkip] = useState(0);
  const [report, setReport] = useState<OrderReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [downloading, setDownloading] = useState(false);
  const [refusal, setRefusal] = useState('');

  const load = useCallback(async () => {
    setLoading(true); setRefusal('');
    try {
      setReport(await api.getOrderReport({ from, to, type }, { limit: PAGE, skip }));
    } catch (err) {
      setRefusal(errorText(err, 'Could not build the report.'));
    } finally {
      setLoading(false);
    }
  }, [from, to, type, skip]);

  useEffect(() => { void load(); }, [load]);
  // A new range or direction starts at the first page.
  useEffect(() => { setSkip(0); }, [from, to, type]);

  const download = async () => {
    setDownloading(true); setRefusal('');
    try {
      await api.downloadOrderReportCsv({ from, to, type });
    } catch (err) {
      setRefusal(errorText(err, 'Could not build the export.'));
    } finally {
      setDownloading(false);
    }
  };

  const total = report?.pagination.total ?? 0;
  const t = report?.totals;

  return (
    <div style={{ ...cardStyle, padding: 0, overflow: 'hidden' }}>
      <div style={{ padding: '12px 14px', display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', justifyContent: 'space-between', borderBottom: '1px solid var(--border)' }}>
        <SegmentedControl<Direction>
          value={type}
          onChange={setType}
          options={[{ value: '', label: 'All' }, { value: 'DEPOSIT', label: 'Buys' }, { value: 'WITHDRAWAL', label: 'Sells' }]}
        />
        <Button variant="outline" tone="neutral" onClick={() => void download()} busy={downloading} style={{ padding: '9px 14px', fontSize: 12.5 }}>
          <Download size={15} /> Download CSV
        </Button>
      </div>

      {refusal && (
        <div role="alert" style={{ padding: '10px 14px', color: 'var(--danger)', fontSize: 12.5, fontWeight: 600 }}>{refusal}</div>
      )}

      {t && (
        <div role="status" className="bb-mono" style={{ padding: '10px 14px', display: 'flex', flexWrap: 'wrap', gap: 16, fontSize: 12, fontWeight: 700, color: 'var(--text-2)', borderBottom: '1px solid var(--border)' }}>
          <span>{t.orders} orders</span>
          <span style={{ color: 'var(--dep)' }}>✓ {t.confirmed}</span>
          <span style={{ color: 'var(--danger)' }}>✗ {t.rejected}</span>
          <span>Buys confirmed {formatTokens(t.confirmedBuyPaise / 100)}</span>
          <span>Sells paid {formatTokens(t.confirmedSellPaise / 100)}</span>
        </div>
      )}

      {loading && !report && <div style={{ padding: 14 }}><Skeleton height={160} /></div>}

      {report && report.rows.length === 0 && (
        <div style={{ padding: 18, fontSize: 13, color: 'var(--muted)' }}>No orders in this range.</div>
      )}

      {report && report.rows.length > 0 && (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
            <thead>
              <tr style={{ color: 'var(--muted)', textAlign: 'left' }}>
                <th scope="col" style={cell}>Transaction ID</th>
                <th scope="col" style={cell}>User</th>
                <th scope="col" style={cell}>UTR</th>
                <th scope="col" style={{ ...cell, textAlign: 'right' }}>Amount</th>
                <th scope="col" style={cell}>Time</th>
                <th scope="col" style={cell}>✓ / ✗</th>
              </tr>
            </thead>
            <tbody>
              {report.rows.map((row) => (
                <tr key={row.orderId} style={{ borderTop: '1px solid var(--border-2)', color: 'var(--text)' }}>
                  <td className="bb-mono" style={cell}>
                    <span style={{ color: row.type === 'DEPOSIT' ? 'var(--dep)' : 'var(--wd)', marginRight: 6 }}>{row.type === 'DEPOSIT' ? '↓' : '↑'}</span>
                    {row.orderId}
                  </td>
                  <td className="bb-mono" style={cell}>{row.userId}</td>
                  <td className="bb-mono" style={cell}>{row.utr ?? '—'}</td>
                  <td className="bb-mono" style={{ ...cell, textAlign: 'right' }}>{formatTokens(row.tokenAmount)}</td>
                  <td className="bb-mono" style={cell}>{when(row.at)}</td>
                  <td style={cell}><ResultCell row={row} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {total > PAGE && (
        <div style={{ padding: '10px 14px', display: 'flex', gap: 10, alignItems: 'center', justifyContent: 'flex-end', borderTop: '1px solid var(--border)' }}>
          <span style={{ fontSize: 12, color: 'var(--muted)' }}>
            {skip + 1}–{Math.min(skip + PAGE, total)} of {total}
          </span>
          <Button variant="outline" tone="neutral" disabled={skip === 0 || loading} onClick={() => setSkip(Math.max(0, skip - PAGE))}>Previous</Button>
          <Button variant="outline" tone="neutral" disabled={skip + PAGE >= total || loading} onClick={() => setSkip(skip + PAGE)}>Next</Button>
        </div>
      )}
    </div>
  );
};

export default OrderReportTable;
