// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The business ledger (owner, 2026-10-21): what the business did over a range
 * of IST days, one coloured table per kind (player buys, player sells,
 * commission, pool tokens bought from the platform, disputes
 * with what they cost), the transaction ID last in every row, and a block of
 * totals: net with the platform, net with players, net commission after
 * compensation, net profit, and the pool's tokens now.
 *
 * Every figure is the server's (GET /api/merchant/reports/ledger); a table's
 * total line is the server's total, never summed here. Cancelled, expired and
 * rejected orders are not business and the server leaves them out. The Excel
 * download is the same ledger from the server (…/ledger.xlsx). A refusal (a
 * bad range, a sub-member without AUDIT) is said in the server's words.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Download } from 'lucide-react';
import { api } from '../services/api';
import { formatTokens } from '../utils/rail';
import type { BusinessLedger as Ledger } from '../types';
import { Button, Field, Skeleton, cardStyle, inputStyle } from './ui';

const tokens = (paise: number) => formatTokens((Number(paise) || 0) / 100);
const when = (at: string) =>
  new Date(at).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
const errorText = (err: unknown, fallback: string): string =>
  (err as { message?: string } | null)?.message || fallback;

const cell: React.CSSProperties = { padding: '12px 14px', whiteSpace: 'nowrap', verticalAlign: 'middle' };
const right: React.CSSProperties = { ...cell, textAlign: 'right' };

type Column<R> = { label: string; render: (r: R) => React.ReactNode; align?: 'right'; mono?: boolean };

/** One kind of business: a coloured heading, its rows, the server's total, the ID last. */
function Section<R>({ title, tone, toneBg, rows, columns, idOf, total, empty }: {
  title: string; tone: string; toneBg: string; rows: R[]; columns: Array<Column<R>>;
  idOf: (r: R) => string; total?: React.ReactNode; empty: string;
}) {
  return (
    <section aria-label={title} style={{ ...cardStyle, padding: 0, overflow: 'hidden', borderTop: `4px solid ${tone}` }}>
      <div style={{ padding: '14px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, background: toneBg }}>
        <h3 style={{ margin: 0, fontSize: 14, fontWeight: 800, color: tone }}>{title}</h3>
        <span style={{ fontSize: 12, fontWeight: 700, color: tone }}>{rows.length} {rows.length === 1 ? 'entry' : 'entries'}</span>
      </div>
      {rows.length === 0 ? (
        <div style={{ padding: '16px', fontSize: 13, color: 'var(--muted)' }}>{empty}</div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table aria-label={title} style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ color: 'var(--muted)', textAlign: 'left', fontSize: 11.5, textTransform: 'uppercase', letterSpacing: '.04em' }}>
                {columns.map((c) => <th key={c.label} scope="col" style={c.align === 'right' ? right : cell}>{c.label}</th>)}
                <th scope="col" style={cell}>Transaction ID</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={idOf(r)} style={{ borderTop: '1px solid var(--border-2)', color: 'var(--text)' }}>
                  {columns.map((c) => (
                    <td key={c.label} className={c.mono ? 'bb-mono' : undefined} style={c.align === 'right' ? right : cell}>{c.render(r)}</td>
                  ))}
                  <td className="bb-mono" style={{ ...cell, color: 'var(--text-2)' }}>{idOf(r)}</td>
                </tr>
              ))}
            </tbody>
            {total !== undefined && (
              <tfoot>
                <tr style={{ borderTop: `2px solid ${tone}`, fontWeight: 800, color: tone }}>
                  <td style={cell}>Total</td>
                  <td colSpan={columns.length} className="bb-mono" style={right}>{total}</td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      )}
    </section>
  );
}

const Tile: React.FC<{ label: string; value: string; sub?: string; tone: string; toneBg: string; strong?: boolean }> = ({
  label, value, sub, tone, toneBg, strong,
}) => (
  <div style={{ borderRadius: 14, padding: '14px 16px', background: toneBg, border: `1px solid ${tone}`, display: 'flex', flexDirection: 'column', gap: 4 }}>
    <div style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--text-2)' }}>{label}</div>
    <div className="bb-mono" style={{ fontSize: strong ? 22 : 18, fontWeight: 800, color: tone, letterSpacing: '-.5px' }}>{value}</div>
    {sub && <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--muted)' }}>{sub}</div>}
  </div>
);

const signed = (paise: number) => `${paise < 0 ? '−' : ''}${tokens(Math.abs(paise))}`;
const DECISION_SAID: Record<string, string> = { DISPUTED: 'Open' };

const BusinessLedger: React.FC<{ from?: string; to?: string }> = (props) => {
  // With a range from the page (Reports), the page's; else its own inputs.
  const controlled = props.from !== undefined || props.to !== undefined;
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [asked, setAsked] = useState({ from: '', to: '' });
  const range = controlled ? { from: props.from ?? '', to: props.to ?? '' } : asked;
  const [ledger, setLedger] = useState<Ledger | null>(null);
  const [loading, setLoading] = useState(true);
  const [downloading, setDownloading] = useState(false);
  const [refusal, setRefusal] = useState('');

  const load = useCallback(async (f: string, t: string) => {
    setLoading(true); setRefusal('');
    try {
      setLedger(await api.getBusinessLedger(f, t));
    } catch (err) {
      setRefusal(errorText(err, 'Could not build the ledger.'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(range.from, range.to); }, [load, range.from, range.to]);

  const download = async () => {
    setDownloading(true); setRefusal('');
    try {
      await api.downloadBusinessLedger(range.from, range.to);
    } catch (err) {
      setRefusal(errorText(err, 'Could not build the ledger.'));
    } finally {
      setDownloading(false);
    }
  };

  const t = ledger?.totals;
  const rangeSaid = ledger && (ledger.range.from || ledger.range.to
    ? `From ${ledger.range.from ?? 'the start'} to ${ledger.range.to ?? 'today'}`
    : 'The last seven days');

  const orderColumns: Array<Column<Ledger['buys'][number]>> = [
    { label: 'Time', render: (r) => when(r.at), mono: true },
    { label: 'Paid by', render: (r) => r.rail },
    { label: 'Account', render: (r) => r.account ?? '—' },
    { label: 'State', render: (r) => (r.state === 'PAID' ? 'Paid, in hold window' : 'Completed') },
    { label: 'Amount', render: (r) => tokens(r.tokensPaise), align: 'right', mono: true },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div style={{ ...cardStyle, padding: '14px 16px', display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'flex-end', justifyContent: 'space-between' }}>
        <div>
          <div style={{ fontSize: 15, fontWeight: 800, color: 'var(--text)' }}>Business ledger</div>
          <div role="status" style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)', marginTop: 2 }}>
            {rangeSaid ?? 'Loading…'} · cancelled, expired and rejected orders are left out
          </div>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'flex-end' }}>
          {!controlled && (
            <>
              <Field label="From" htmlFor="ledger-from">
                <input id="ledger-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} style={inputStyle} />
              </Field>
              <Field label="To" htmlFor="ledger-to">
                <input id="ledger-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} style={inputStyle} />
              </Field>
              <Button onClick={() => setAsked({ from, to })} busy={loading}>Show ledger</Button>
            </>
          )}
          <Button variant="outline" tone="neutral" onClick={() => void download()} busy={downloading} style={{ padding: '9px 14px', fontSize: 12.5 }}>
            <Download size={15} /> Download ledger (Excel)
          </Button>
        </div>
      </div>

      {refusal && <div role="alert" style={{ color: 'var(--danger)', fontSize: 12.5, fontWeight: 600 }}>{refusal}</div>}
      {loading && !ledger && <Skeleton height={220} />}

      {ledger && t && (
        <>
          <section aria-label="Totals" style={{ ...cardStyle, padding: 16 }}>
            <h3 style={{ margin: '0 0 12px', fontSize: 14, fontWeight: 800, color: 'var(--text)' }}>Totals</h3>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 12 }}>
              <Tile label="Bought from the platform" value={tokens(t.boughtPaise)} tone="var(--warn)" toneBg="var(--warn-bg)"
                sub={`Paid ₹${tokens(t.paidToAdminPaise)} for them`} />
              <Tile label="Net with players" value={signed(t.netUserPaise)} tone="var(--info)" toneBg="var(--info-bg)"
                sub={`${t.userBuys} buys ${tokens(t.userBuysPaise)} · ${t.userSells} sells ${tokens(t.userSellsPaise)}`} />
              <Tile label="Net commission" value={signed(t.netCommissionPaise)} tone="var(--dep)" toneBg="var(--dep-bg)"
                sub={`Earned ${tokens(t.commissionPaise)} · compensation paid ${tokens(t.compensationPaise)}`} />
              <Tile label="Net profit" value={signed(t.netProfitPaise)} tone={t.netProfitPaise < 0 ? 'var(--danger)' : 'var(--ok)'}
                toneBg={t.netProfitPaise < 0 ? 'var(--danger-bg)' : 'var(--ok-bg)'} strong
                sub="Commission less compensation, plus any gain on tokens bought from the platform" />
              <Tile label="Pool tokens now" value={tokens(t.poolAvailablePaise + t.poolHeldPaise)} tone="var(--wd)" toneBg="var(--wd-bg)"
                sub={`${tokens(t.poolAvailablePaise)} free · ${tokens(t.poolHeldPaise)} held for open buys`} />
            </div>
            {ledger.truncated && (
              <div style={{ marginTop: 10, fontSize: 12, color: 'var(--muted)' }}>
                A table over 5,000 entries shows its first 5,000; the totals count every one.
              </div>
            )}
          </section>

          <Section title="Player buys" tone="var(--dep)" toneBg="var(--dep-bg)" rows={ledger.buys} columns={orderColumns}
            idOf={(r) => r.orderId} total={tokens(t.userBuysPaise)} empty="No completed buys in this range." />
          <Section title="Player sells" tone="var(--danger)" toneBg="var(--danger-bg)" rows={ledger.sells} columns={orderColumns}
            idOf={(r) => r.orderId} total={tokens(t.userSellsPaise)} empty="No paid sells in this range." />
          <Section title="Commission" tone="var(--info)" toneBg="var(--info-bg)" rows={ledger.commission}
            columns={[
              { label: 'Time', render: (r) => when(r.at), mono: true },
              { label: 'Team', render: (r) => r.team },
              { label: 'Share as', render: (r) => r.role.charAt(0) + r.role.slice(1).toLowerCase() },
              { label: 'Commission', render: (r) => tokens(r.sharePaise), align: 'right', mono: true },
            ]}
            idOf={(r) => r.commissionId} total={tokens(t.commissionPaise)} empty="No commission in this range." />
          <Section title="Pool tokens bought from the platform" tone="var(--wd)" toneBg="var(--wd-bg)" rows={ledger.pool}
            columns={[
              { label: 'Time', render: (r) => when(r.at), mono: true },
              { label: 'Pool', render: (r) => r.team },
              { label: 'Paid', render: (r) => (r.amountMinor === null ? '—' : `${(r.amountMinor / 100).toLocaleString('en-IN')} ${r.currency}`), mono: true },
              { label: 'Tokens', render: (r) => tokens(r.tokensPaise), align: 'right', mono: true },
            ]}
            idOf={(r) => r.requestId} empty="No pool trades with the platform in this range." />
          <Section title="Disputes" tone="var(--dispute)" toneBg="var(--dispute-bg)" rows={ledger.disputes}
            columns={[
              { label: 'Raised', render: (r) => when(r.at), mono: true },
              { label: 'Order', render: (r) => (r.type === 'BUY' ? 'Buy' : 'Sell') },
              { label: 'Amount', render: (r) => tokens(r.tokensPaise), align: 'right', mono: true },
              { label: 'Decision', render: (r) => r.decision ?? DECISION_SAID[r.state] ?? r.state },
              { label: 'Lost by', render: (r) => (r.lostBy ? r.lostBy.charAt(0) + r.lostBy.slice(1).toLowerCase() : 'Nobody') },
              { label: 'Compensation', render: (r) => tokens(r.compensationPaise), align: 'right', mono: true },
            ]}
            idOf={(r) => r.orderId} total={`Compensation ${tokens(t.compensationPaise)}`} empty="No disputes in this range." />
        </>
      )}
    </div>
  );
};

export default BusinessLedger;
