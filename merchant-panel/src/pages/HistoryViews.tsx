// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
//
// History — design handoff "BB Merchant Panel.dc.html": three totals, then one
// of three tabs (Volume, Earnings, Report). Report is the server's order table
// with ✓/✗ and who pressed it, and its CSV (`OrderReportTable`, owner 2026-10-16).
//
// The totals and series are the server's, over every completed order
// (GET /merchant/earnings and /merchant/earnings/weekly) — nothing here is a
// placeholder series (GOVERNANCE §2: no invented business figures).
import React, { useEffect, useMemo, useState } from 'react';
import { useLocation } from 'react-router';
import { api } from '../services/api';
import { useViewport } from '../hooks/useViewport';
import { formatMoney, formatMoneyCompact, formatTokens } from '../utils/rail';
import type { Earnings } from '../types';
import { Card, CardTitle, SegmentedControl, Skeleton, cardStyle } from '../components/ui';
import OrderReportTable from '../components/OrderReportTable';

type Tab = 'volume' | 'earnings' | 'ledger';

/** What another screen asks History to open on, as router state (a Dashboard tile). */
export interface HistoryLinkState { tab?: Tab }

interface WeeklyPoint { date: string; earnings: number; orders: number; depositVolume: number; withdrawalVolume: number; }

const HistoryViews: React.FC = () => {
  const { isMobile } = useViewport();

  const link = (useLocation().state ?? null) as HistoryLinkState | null;
  const [tab, setTab] = useState<Tab>(link?.tab ?? 'volume');
  const [weekly, setWeekly] = useState<WeeklyPoint[] | null>(null);
  // Lifetime totals, counted by the server over every completed order. The
  // tiles summed the orders the queue had loaded (its newest page), so a busy
  // merchant's "Total volume" was only their latest orders.
  const [lifetime, setLifetime] = useState<Earnings['lifetime'] | null>(null);

  useEffect(() => {
    let alive = true;
    void api.getWeeklyEarnings()
      .then((res) => { if (alive) setWeekly(res.weekly); })
      .catch(() => { if (alive) setWeekly([]); });
    void api.getEarnings()
      .then((res) => { if (alive) setLifetime(res.earnings.lifetime ?? null); })
      .catch(() => { if (alive) setLifetime(null); });
    return () => { alive = false; };
  }, []);

  // ── Tokens, and for these orders that is rupees too ───────────────────
  // Every order a merchant serves is INR (USDT buys are paid to the platform,
  // §25) and 1 token = ₹1, so the server's token volume is what players sent.
  const totals = lifetime ? {
    deposits: lifetime.deposits?.totalVolume ?? 0,
    withdrawals: lifetime.withdrawals?.totalVolume ?? 0,
    volume: lifetime.totalVolume,
    orders: lifetime.totalOrders,
  } : null;

  const earningsTotal = useMemo(
    () => (weekly ?? []).reduce((sum, point) => sum + (point.earnings || 0), 0),
    [weekly]
  );

  // Seven-day deposit/withdrawal split, cut in IST by the server over every
  // completed order of each day (GET /merchant/earnings/weekly). It was
  // bucketed here from the queue's loaded page, which a busy week outruns.
  const volumeSeries = useMemo(() => (weekly ?? []).map((point) => ({
    key: point.date,
    label: new Date(point.date).toLocaleDateString('en-IN', { weekday: 'short' }),
    deposits: point.depositVolume || 0,
    withdrawals: point.withdrawalVolume || 0,
  })), [weekly]);

  const volumeMax = Math.max(1, ...volumeSeries.flatMap((day) => [day.deposits, day.withdrawals]));
  const earningsMax = Math.max(1, ...(weekly ?? []).map((point) => point.earnings));

  const totalsColumns = isMobile ? '1fr' : 'repeat(3, minmax(0, 1fr))';

  const state = weekly === null ? 'loading' : 'ready';

  return (
    <div style={{ maxWidth: 1120, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: isMobile ? 14 : 16 }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap' }}>
        <SegmentedControl<Tab>
          value={tab}
          onChange={setTab}
          options={[
            { value: 'volume', label: 'Volume' },
            { value: 'earnings', label: 'Earnings' },
            { value: 'ledger', label: 'Ledger' },
          ]}
        />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: totalsColumns, gap: 12 }}>
        <div style={{ ...cardStyle, padding: 16 }}>
          <div style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--muted)' }}>Total volume</div>
          <div className="bb-mono" style={{ fontSize: 22, fontWeight: 700, color: 'var(--text)', letterSpacing: '-1px', marginTop: 3 }}>
            {totals ? formatMoneyCompact(totals.volume) : '—'}
          </div>
          <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--muted)', marginTop: 2 }}>
            {totals ? `${totals.orders} completed orders` : 'Awaiting data'}
          </div>
        </div>
        <div style={{ ...cardStyle, padding: 16 }}>
          <div style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--muted)' }}>Earnings (last 7 days)</div>
          <div className="bb-mono" style={{ fontSize: 22, fontWeight: 700, color: 'var(--dep)', letterSpacing: '-1px', marginTop: 3 }}>
            {weekly === null ? '—' : formatTokens(earningsTotal)}
          </div>
          <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--muted)', marginTop: 2 }}>
            Your share of team commission
          </div>
        </div>
        <div style={{ ...cardStyle, padding: 16 }}>
          <div style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--muted)' }}>Deposits · Withdrawals</div>
          <div className="bb-mono" style={{ fontSize: 18, fontWeight: 700, letterSpacing: '-.5px', marginTop: 5 }}>
            <span style={{ color: 'var(--dep)' }}>{totals ? formatMoneyCompact(totals.deposits) : '—'}</span>
            <span style={{ color: 'var(--muted)' }}> · </span>
            <span style={{ color: 'var(--wd)' }}>{totals ? formatMoneyCompact(totals.withdrawals) : '—'}</span>
          </div>
        </div>
      </div>

      {state === 'loading' && tab !== 'ledger' && <Skeleton height={230} />}

      {state === 'ready' && tab === 'volume' && (
        <Card>
          <CardTitle
            title="Transaction volume · last 7 days"
            action={
              <div style={{ display: 'flex', gap: 14 }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, fontWeight: 700, color: 'var(--text-2)' }}>
                  <span style={{ width: 10, height: 10, borderRadius: 3, background: 'var(--dep)' }} /> Deposits
                </span>
                <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, fontWeight: 700, color: 'var(--text-2)' }}>
                  <span style={{ width: 10, height: 10, borderRadius: 3, background: 'var(--wd)' }} /> Withdrawals
                </span>
              </div>
            }
          />
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: isMobile ? 5 : 11, height: 170 }}>
            {volumeSeries.map((day) => (
              <div key={day.key} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, height: '100%', justifyContent: 'flex-end' }}>
                <div style={{ display: 'flex', alignItems: 'flex-end', gap: 3, height: '100%', width: '100%', justifyContent: 'center' }}>
                  <div
                    title={`Deposits ${formatMoney(day.deposits)}`}
                    style={{ width: '44%', maxWidth: 26, height: `${Math.max(2, (day.deposits / volumeMax) * 100)}%`, borderRadius: '5px 5px 2px 2px', background: 'var(--dep)', transition: 'height .4s ease' }}
                  />
                  <div
                    title={`Withdrawals ${formatMoney(day.withdrawals)}`}
                    style={{ width: '44%', maxWidth: 26, height: `${Math.max(2, (day.withdrawals / volumeMax) * 100)}%`, borderRadius: '5px 5px 2px 2px', background: 'var(--wd)', transition: 'height .4s ease' }}
                  />
                </div>
                <span style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--muted)' }}>{day.label}</span>
              </div>
            ))}
          </div>
        </Card>
      )}

      {state === 'ready' && tab === 'earnings' && (
        <Card>
          <CardTitle title="Daily earnings · last 7 days" />
          {weekly === null ? (
            <Skeleton height={170} />
          ) : (
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: isMobile ? 5 : 11, height: 170 }}>
              {weekly.map((point, index) => {
                const last = index === weekly.length - 1;
                const label = new Date(point.date).toLocaleDateString('en-IN', { weekday: 'short' });
                return (
                  <div key={point.date} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, height: '100%', justifyContent: 'flex-end' }}>
                    <div
                      title={`${label}: ${formatTokens(point.earnings)} · ${point.orders} orders`}
                      style={{
                        width: '100%', maxWidth: 52, height: `${Math.max(2, (point.earnings / earningsMax) * 100)}%`,
                        borderRadius: '7px 7px 3px 3px', background: last ? 'var(--dep)' : 'var(--dep-bg)', transition: 'height .4s ease',
                      }}
                    />
                    <span style={{ fontSize: 10.5, fontWeight: 700, color: last ? 'var(--dep)' : 'var(--muted)' }}>{label}</span>
                  </div>
                );
              })}
            </div>
          )}
        </Card>
      )}

      {tab === 'ledger' && <OrderReportTable />}
    </div>
  );
};

export default HistoryViews;
