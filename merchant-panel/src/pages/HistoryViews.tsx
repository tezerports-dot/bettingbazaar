// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
//
// History — design handoff "BB Merchant Panel.dc.html": three totals, then one
// of three tabs (Volume, Earnings, Report). Report is the server's order table
// with ✓/✗ and who pressed it, and its CSV (`OrderReportTable`, owner 2026-10-16).
//
// The series are derived from the merchant's own completed orders
// (GET /merchant/orders) and GET /merchant/earnings/weekly — nothing here is a
// placeholder series (GOVERNANCE §2: no invented business figures).
import React, { useEffect, useMemo, useState } from 'react';
import { useAuth } from '../services/AuthContext';
import { api } from '../services/api';
import { useOrders } from '../hooks/useOrders';
import { useViewport } from '../hooks/useViewport';
import { formatMoney, formatMoneyCompact, formatTokens, railOf } from '../utils/rail';
import { OrderStatus } from '../types';
import { Card, CardTitle, ErrorState, SegmentedControl, Skeleton, cardStyle } from '../components/ui';
import OrderReportTable from '../components/OrderReportTable';

type Tab = 'volume' | 'earnings' | 'report';

interface WeeklyPoint { date: string; earnings: number; orders: number; }

const DAY_MS = 86400000;
const WINDOW_DAYS = 7;

/** Local YYYY-MM-DD, so buckets line up with what the operator sees on a clock. */
function dayKey(value: string | number | Date): string {
  const date = new Date(value);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

const HistoryViews: React.FC = () => {
  const { merchant } = useAuth();
  const { orders, state, reload } = useOrders();
  const { isMobile } = useViewport();
  const rail = railOf(merchant);

  const [tab, setTab] = useState<Tab>('volume');
  const [weekly, setWeekly] = useState<WeeklyPoint[] | null>(null);

  useEffect(() => {
    let alive = true;
    void api.getWeeklyEarnings()
      .then((res) => { if (alive) setWeekly(res.weekly); })
      .catch(() => { if (alive) setWeekly([]); });
    return () => { alive = false; };
  }, []);

  const completed = useMemo(
    () => orders
      .filter((order) => order.status === OrderStatus.COMPLETED)
      .sort((a, b) => new Date(b.completedAt || b.createdAt || 0).getTime() - new Date(a.completedAt || a.createdAt || 0).getTime()),
    [orders]
  );

  // ── These stay in the ORDER's currency, and that is correct ──────────────
  // They sum `order.fiatAmount`, which is what the PLAYER SENT — rupees on the
  // INR rail, USDT on a USDT order — so `formatMoney(…, rail)` is the right
  // formatter. Safe to add up only because a merchant settles on exactly one
  // rail (§2), so every order in this list shares a currency; the same sum
  // across merchants is trap 15 and is why the SERVER aggregates tokens.
  //
  // EARNINGS are the opposite: team commission is paid into the team's pool in
  // platform TOKENS and each share is recorded in tokens (2e), so those render
  // through `formatTokens` however the player paid.
  const totals = useMemo(() => {
    let deposits = 0;
    let withdrawals = 0;
    for (const order of completed) {
      const amount = Number(order.fiatAmount ?? order.amount) || 0;
      if (order.type === 'DEPOSIT') deposits += amount; else withdrawals += amount;
    }
    return { deposits, withdrawals, volume: deposits + withdrawals };
  }, [completed]);

  const earningsTotal = useMemo(
    () => (weekly ?? []).reduce((sum, point) => sum + (point.earnings || 0), 0),
    [weekly]
  );

  // Seven-day deposit/withdrawal split from the merchant's completed orders.
  const volumeSeries = useMemo(() => {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const days = Array.from({ length: WINDOW_DAYS }, (_, i) => {
      const date = new Date(start.getTime() - (WINDOW_DAYS - 1 - i) * DAY_MS);
      return { key: dayKey(date), label: date.toLocaleDateString('en-IN', { weekday: 'short' }), deposits: 0, withdrawals: 0 };
    });
    const index = new Map(days.map((day) => [day.key, day]));
    for (const order of completed) {
      const bucket = index.get(dayKey(order.completedAt || order.createdAt));
      if (!bucket) continue;
      const amount = Number(order.fiatAmount ?? order.amount) || 0;
      if (order.type === 'DEPOSIT') bucket.deposits += amount; else bucket.withdrawals += amount;
    }
    return days;
  }, [completed]);

  const volumeMax = Math.max(1, ...volumeSeries.flatMap((day) => [day.deposits, day.withdrawals]));
  const earningsMax = Math.max(1, ...(weekly ?? []).map((point) => point.earnings));

  const totalsColumns = isMobile ? '1fr' : 'repeat(3, minmax(0, 1fr))';

  if (state === 'error') {
    return (
      <div style={{ maxWidth: 1120, margin: '0 auto' }}>
        <ErrorState title="Couldn't load your history" body="The connection dropped. Your data is safe — this is just the view." onRetry={() => void reload()} />
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 1120, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: isMobile ? 14 : 16 }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap' }}>
        <SegmentedControl<Tab>
          value={tab}
          onChange={setTab}
          options={[
            { value: 'volume', label: 'Volume' },
            { value: 'earnings', label: 'Earnings' },
            { value: 'report', label: 'Report' },
          ]}
        />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: totalsColumns, gap: 12 }}>
        <div style={{ ...cardStyle, padding: 16 }}>
          <div style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--muted)' }}>Total volume</div>
          <div className="bb-mono" style={{ fontSize: 22, fontWeight: 700, color: 'var(--text)', letterSpacing: '-1px', marginTop: 3 }}>
            {formatMoneyCompact(totals.volume, rail)}
          </div>
          <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--muted)', marginTop: 2 }}>
            {completed.length} completed orders
          </div>
        </div>
        <div style={{ ...cardStyle, padding: 16 }}>
          <div style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--muted)' }}>Earnings (last 7 days)</div>
          <div className="bb-mono" style={{ fontSize: 22, fontWeight: 700, color: 'var(--dep)', letterSpacing: '-1px', marginTop: 3 }}>
            {weekly === null ? '—' : formatTokens(earningsTotal)}
          </div>
          <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--muted)', marginTop: 2 }}>
            Per-order profit recorded on completed orders
          </div>
        </div>
        <div style={{ ...cardStyle, padding: 16 }}>
          <div style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--muted)' }}>Deposits · Withdrawals</div>
          <div className="bb-mono" style={{ fontSize: 18, fontWeight: 700, letterSpacing: '-.5px', marginTop: 5 }}>
            <span style={{ color: 'var(--dep)' }}>{formatMoneyCompact(totals.deposits, rail)}</span>
            <span style={{ color: 'var(--muted)' }}> · </span>
            <span style={{ color: 'var(--wd)' }}>{formatMoneyCompact(totals.withdrawals, rail)}</span>
          </div>
        </div>
      </div>

      {state === 'loading' && <Skeleton height={230} />}

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
                    title={`Deposits ${formatMoney(day.deposits, rail)}`}
                    style={{ width: '44%', maxWidth: 26, height: `${Math.max(2, (day.deposits / volumeMax) * 100)}%`, borderRadius: '5px 5px 2px 2px', background: 'var(--dep)', transition: 'height .4s ease' }}
                  />
                  <div
                    title={`Withdrawals ${formatMoney(day.withdrawals, rail)}`}
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

      {tab === 'report' && <OrderReportTable />}
    </div>
  );
};

export default HistoryViews;
