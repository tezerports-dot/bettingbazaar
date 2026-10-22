// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The pool statement (owner, 2026-10-22): for today, this week, this month or
 * a range of IST days, the pool's opening balance, the buys and sells
 * processed, the commission earned, the tokens bought from the admin, the
 * closing balance and the net profit; then every order, one row each, with
 * the player, the UTR, buy or sell, its status, its commission, what it did
 * to the pool and the balance after, like a bank statement.
 *
 * Every figure is the server's (GET /api/merchant/reports/statement,
 * `poolStatement` in merchantLedger.js); nothing here adds them up. An agent
 * gets no balance (the team's pool is not theirs to read row by row), so
 * those lines are not drawn. The Excel download is the same statement.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Download } from 'lucide-react';
import { api } from '../services/api';
import { formatTokens } from '../utils/rail';
import type { PoolStatement as Statement } from '../types';
import { Button, Card, CardTitle, Field, SegmentedControl, Skeleton, inputStyle } from './ui';

const tokens = (paise: number) => formatTokens((Number(paise) || 0) / 100);
const signed = (paise: number) => `${paise > 0 ? '+' : paise < 0 ? '−' : ''}${tokens(Math.abs(paise))}`;
const when = (at: string) =>
  new Date(at).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' });
const errorText = (err: unknown, fallback: string): string => (err as { message?: string } | null)?.message || fallback;

type Preset = 'TODAY' | 'WEEK' | 'MONTH' | 'CUSTOM';

/** Today's IST day, YYYY-MM-DD. §11: the range's ends only; the server reads the days. */
export function istToday(now = Date.now()): string {
  return new Date(now + 330 * 60_000).toISOString().slice(0, 10);
}

/** The IST days a preset covers: this week starts on Monday, this month on the 1st. */
export function presetRange(preset: Exclude<Preset, 'CUSTOM'>, now = Date.now()): { from: string; to: string } {
  const to = istToday(now);
  const day = new Date(`${to}T00:00:00Z`);
  if (preset === 'TODAY') return { from: to, to };
  if (preset === 'MONTH') return { from: `${to.slice(0, 8)}01`, to };
  const back = (day.getUTCDay() + 6) % 7; // days since Monday
  return { from: new Date(day.getTime() - back * 86_400_000).toISOString().slice(0, 10), to };
}

const KIND = { BUY: 'Buy', SELL: 'Sell', TOKEN_BUY: 'Tokens bought', TOKEN_SELL_BACK: 'Tokens sold back' } as Record<string, string>;
const STATE: Record<string, string> = {
  COMPLETED: 'Completed', PAID: 'Paid, in hold', DISPUTED: 'Disputed', CANCELLED: 'Cancelled', EXPIRED: 'Expired',
  FAILED: 'Failed', REJECTED: 'Rejected', PROCESSING: 'In process', PENDING_QUEUE: 'Waiting',
};
const STATE_TONE: Record<string, string> = {
  COMPLETED: 'var(--ok)', PAID: 'var(--dep)', DISPUTED: 'var(--warn)', REJECTED: 'var(--danger)', FAILED: 'var(--danger)',
};

const cell: React.CSSProperties = { padding: '10px 12px', whiteSpace: 'nowrap' };
const right: React.CSSProperties = { ...cell, textAlign: 'right' };

export const PoolStatement: React.FC = () => {
  const [preset, setPreset] = useState<Preset>('TODAY');
  const [custom, setCustom] = useState({ from: '', to: '' });
  const [statement, setStatement] = useState<Statement | null>(null);
  const [loading, setLoading] = useState(true);
  const [refusal, setRefusal] = useState('');
  const [downloading, setDownloading] = useState(false);

  const range = preset === 'CUSTOM' ? custom : presetRange(preset);

  const load = useCallback(async (from: string, to: string) => {
    setLoading(true); setRefusal('');
    try {
      setStatement(await api.getPoolStatement(from, to));
    } catch (err) {
      setRefusal(errorText(err, 'Could not build the statement.'));
    } finally {
      setLoading(false);
    }
  }, []);

  // A preset loads at once; a custom range waits for its button.
  useEffect(() => {
    if (preset !== 'CUSTOM') { const r = presetRange(preset); void load(r.from, r.to); }
  }, [preset, load]);

  const download = async () => {
    setDownloading(true);
    try { await api.downloadPoolStatement(range.from, range.to); } catch (err) { setRefusal(errorText(err, 'Could not download the statement.')); } finally { setDownloading(false); }
  };

  const t = statement?.totals;
  const hasBalance = t ? t.openingPaise !== null : false;
  const figures = t ? [
    ...(hasBalance ? [{ label: 'Opening pool balance', value: tokens(t.openingPaise ?? 0) }] : []),
    { label: `Buys processed (${t.buysProcessed})`, value: tokens(t.buysProcessedPaise) },
    { label: `Sells processed (${t.sellsProcessed})`, value: tokens(t.sellsProcessedPaise) },
    { label: 'Commission earned', value: tokens(t.commissionPaise), tone: 'var(--dep)' },
    ...(hasBalance ? [
      { label: 'Tokens bought from admin', value: tokens(t.tokensBoughtPaise) },
      { label: 'Closing pool balance', value: tokens(t.closingPaise ?? 0) },
    ] : []),
    { label: 'Net profit', value: signed(t.netProfitPaise), tone: t.netProfitPaise >= 0 ? 'var(--ok)' : 'var(--danger)' },
  ] : [];

  return (
    <Card>
      <CardTitle
        title="Pool statement"
        sub="Every order with its commission and what it did to your pool, between the opening and closing balance"
        action={
          <Button variant="outline" onClick={() => void download()} busy={downloading} style={{ padding: '8px 12px' }}>
            <Download size={15} /> Download
          </Button>
        }
      />
      <SegmentedControl<Preset>
        value={preset}
        onChange={setPreset}
        style={{ marginBottom: 12, flexWrap: 'wrap' }}
        options={[
          { value: 'TODAY', label: 'Today' }, { value: 'WEEK', label: 'This week' },
          { value: 'MONTH', label: 'This month' }, { value: 'CUSTOM', label: 'Custom range' },
        ]}
      />
      {preset === 'CUSTOM' && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'flex-end', marginBottom: 12 }}>
          <Field label="From" htmlFor="statement-from">
            <input id="statement-from" type="date" value={custom.from} onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))} style={inputStyle} />
          </Field>
          <Field label="To" htmlFor="statement-to">
            <input id="statement-to" type="date" value={custom.to} onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))} style={inputStyle} />
          </Field>
          <Button onClick={() => void load(custom.from, custom.to)} busy={loading}>Show statement</Button>
        </div>
      )}
      {refusal && <div role="alert" style={{ color: 'var(--danger)', fontSize: 13, fontWeight: 600, marginBottom: 10 }}>{refusal}</div>}

      {loading && !statement ? <Skeleton height={220} /> : statement && t && (
        <>
          <div role="status" style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)', marginBottom: 10 }}>
            {statement.range.from === statement.range.to && statement.range.from
              ? `IST day ${statement.range.from}`
              : `From ${statement.range.from ?? 'the start'} to ${statement.range.to ?? 'today'} (IST days)`}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10, marginBottom: 14 }}>
            {figures.map((f) => (
              <div key={f.label} style={{ background: 'var(--surface-2)', borderRadius: 12, padding: 11 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)' }}>{f.label}</div>
                <div className="bb-mono" style={{ fontSize: 16, fontWeight: 800, color: f.tone ?? 'var(--text)', marginTop: 3 }}>{f.value}</div>
              </div>
            ))}
          </div>
          {statement.rows.length === 0 ? (
            <div style={{ padding: '18px 0', textAlign: 'center', fontSize: 12.5, fontWeight: 600, color: 'var(--muted)' }}>
              Nothing happened in your pool in this range.
            </div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
                <thead>
                  <tr style={{ color: 'var(--muted)', textAlign: 'left' }}>
                    <th scope="col" style={cell}>Time</th>
                    <th scope="col" style={cell}>Type</th>
                    <th scope="col" style={cell}>Player</th>
                    <th scope="col" style={cell}>UTR</th>
                    <th scope="col" style={cell}>Status</th>
                    <th scope="col" style={right}>Amount</th>
                    <th scope="col" style={right}>Commission</th>
                    <th scope="col" style={right}>Pool change</th>
                    {hasBalance && <th scope="col" style={right}>Balance after</th>}
                    <th scope="col" style={cell}>Transaction ID</th>
                  </tr>
                </thead>
                <tbody>
                  {hasBalance && (
                    <tr style={{ borderTop: '1px solid var(--border)', fontWeight: 700 }}>
                      <td style={cell} colSpan={8}>Opening balance</td>
                      <td className="bb-mono" style={right}>{tokens(t.openingPaise ?? 0)}</td>
                      <td style={cell} />
                    </tr>
                  )}
                  {statement.rows.map((r) => (
                    <tr key={`${r.kind}-${r.ref}`} style={{ borderTop: '1px solid var(--border)' }}>
                      <td style={cell}>{when(r.at)}</td>
                      <td style={{ ...cell, fontWeight: 700, color: r.kind === 'BUY' ? 'var(--dep)' : r.kind === 'SELL' ? 'var(--wd)' : 'var(--text)' }}>{KIND[r.kind] ?? r.kind}</td>
                      <td className="bb-mono" style={cell}>{r.userId ?? ''}</td>
                      <td className="bb-mono" style={cell}>{r.utr ?? ''}</td>
                      <td style={{ ...cell, color: (r.state && STATE_TONE[r.state]) || 'var(--text-2)', fontWeight: 600 }}>{r.state ? (STATE[r.state] ?? r.state) : ''}</td>
                      <td className="bb-mono" style={right}>{tokens(r.tokensPaise)}</td>
                      <td className="bb-mono" style={{ ...right, color: r.commissionPaise > 0 ? 'var(--dep)' : 'var(--muted)' }}>{r.commissionPaise ? signed(r.commissionPaise) : '—'}</td>
                      <td className="bb-mono" style={{ ...right, color: r.poolChangePaise > 0 ? 'var(--ok)' : r.poolChangePaise < 0 ? 'var(--danger)' : 'var(--muted)' }}>{r.poolChangePaise ? signed(r.poolChangePaise) : '—'}</td>
                      {hasBalance && <td className="bb-mono" style={right}>{r.balanceAfterPaise === null ? '' : tokens(r.balanceAfterPaise)}</td>}
                      <td className="bb-mono" style={{ ...cell, color: 'var(--muted)' }}>{r.ref}</td>
                    </tr>
                  ))}
                  {hasBalance && (
                    <tr style={{ borderTop: '2px solid var(--border-2)', fontWeight: 800 }}>
                      <td style={cell} colSpan={8}>Closing balance</td>
                      <td className="bb-mono" style={right}>{tokens(t.closingPaise ?? 0)}</td>
                      <td style={cell} />
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
          {statement.truncated && (
            <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 8 }}>
              Over 5,000 orders in this range: the first 5,000 are listed and the totals count them all. Download for the workbook.
            </div>
          )}
        </>
      )}
    </Card>
  );
};

export default PoolStatement;
