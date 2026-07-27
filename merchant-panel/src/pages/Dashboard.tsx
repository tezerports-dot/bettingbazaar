// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
//
// Dashboard — design handoff "BB Merchant Panel.dc.html": availability hero,
// four KPI tiles, the weekly earnings bars, what is expiring soon, recent
// assignments and the merchant's live limits.
//
// Every figure comes from the backend (GET /merchant/stats, /earnings,
// /earnings/weekly, /profile and the live order queue). Where a figure has no
// backend source the tile shows an em-dash rather than an invented number
// (GOVERNANCE §2/§3: no hardcoded business values).
import React, { useEffect, useMemo, useState } from 'react';
import { ArrowRight, ChevronRight, Clock, Coins, Power, ShieldCheck, Wallet } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { useAuth } from '../services/AuthContext';
import { api } from '../services/api';
import { useOrders, needsAction } from '../hooks/useOrders';
import { useNow, formatCountdown, secondsLeft } from '../hooks/useCountdown';
import { useViewport } from '../hooks/useViewport';
import { ROUTES } from '../constants';
import { counterpartyOf, formatMoney, formatMoneyCompact, formatWallet, railCopy, railOf } from '../utils/rail';
import { OrderStatus, type Earnings, type PaymentOrder, type Stats } from '../types';
import { Card, CardTitle, Skeleton, StatusPill, cardStyle } from '../components/ui';

interface WeeklyPoint { date: string; earnings: number; orders: number; }

const UPCOMING_WINDOW_SECONDS = 480; // "expiring soon" cut-off from the design

const orderKey = (order: PaymentOrder): string => String(order._id || order.id || order.orderId);

const Dashboard: React.FC = () => {
  const { merchant, refreshProfile } = useAuth();
  const navigate = useNavigate();
  const { orders, state, counts } = useOrders();
  const now = useNow();
  const { isMobile, isDesktop } = useViewport();

  const rail = railOf(merchant);
  const copy = railCopy(rail);
  const online = !!merchant?.isOnline;

  const [stats, setStats] = useState<Stats | null>(null);
  const [earnings, setEarnings] = useState<Earnings | null>(null);
  const [weekly, setWeekly] = useState<WeeklyPoint[] | null>(null);
  const [metricsReady, setMetricsReady] = useState(false);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const [statsResult, earningsResult, weeklyResult] = await Promise.allSettled([
        api.getStats(),
        api.getEarnings(),
        api.getWeeklyEarnings(),
      ]);
      if (!alive) return;
      if (statsResult.status === 'fulfilled') setStats(statsResult.value);
      if (earningsResult.status === 'fulfilled') setEarnings(earningsResult.value.earnings);
      if (weeklyResult.status === 'fulfilled') setWeekly(weeklyResult.value.weekly);
      setMetricsReady(true);
    })();
    return () => { alive = false; };
  }, []);

  const toggleOnline = async () => {
    try {
      await api.toggleOnlineStatus(!online);
      await refreshProfile();
      toast.success(!online ? 'You are now online — accepting orders' : 'You are now offline');
    } catch (error: any) {
      toast.error(error.message || 'Failed to update status');
    }
  };

  const expiring = useMemo(
    () => orders
      .map((order) => ({ order, left: secondsLeft(order.expiresAt, now) }))
      .filter((row) => row.left !== null && row.left > 0 && row.left < UPCOMING_WINDOW_SECONDS && needsAction(row.order))
      .sort((a, b) => (a.left ?? 0) - (b.left ?? 0))
      .slice(0, 3),
    [orders, now]
  );

  const recent = useMemo(
    () => orders.filter((o) => o.status !== OrderStatus.COMPLETED && o.status !== OrderStatus.CANCELLED).slice(0, 4),
    [orders]
  );

  const weeklyMax = useMemo(() => Math.max(1, ...(weekly ?? []).map((point) => point.earnings)), [weekly]);
  const weekTotal = useMemo(() => (weekly ?? []).reduce((sum, point) => sum + (point.earnings || 0), 0), [weekly]);

  const kpiColumns = isMobile ? '1fr 1fr' : 'repeat(4, minmax(0, 1fr))';
  const splitColumns = isDesktop ? '1.35fr 1fr' : '1fr';
  const gap = isMobile ? 14 : 16;

  const limits = merchant?.limits;
  const depositRange = limits
    ? `${formatMoneyCompact(limits.minDeposit, rail)} – ${formatMoneyCompact(limits.maxDeposit, rail)}`
    : '—';
  const withdrawRange = limits
    ? `${formatMoneyCompact(limits.minWithdraw, rail)} – ${formatMoneyCompact(limits.maxWithdraw, rail)}`
    : '—';

  const kpis = [
    {
      label: "Today's earnings",
      icon: <Coins size={16} style={{ color: 'var(--dep)' }} />,
      iconBg: 'var(--dep-bg)',
      value: earnings ? formatMoneyCompact(earnings.today, rail) : '—',
      sub: stats ? `${stats.completedToday ?? 0} orders completed` : 'Awaiting data',
      subTone: 'var(--dep)',
    },
    {
      label: 'Needs action',
      icon: <Clock size={16} style={{ color: 'var(--warn)' }} />,
      iconBg: 'var(--warn-bg)',
      value: String(counts.actionable),
      sub: `${counts.processing} in progress`,
      subTone: 'var(--muted)',
    },
    {
      label: 'Success rate',
      icon: <ShieldCheck size={16} style={{ color: 'var(--ok)' }} />,
      iconBg: 'var(--ok-bg)',
      value: merchant?.successRate !== undefined ? `${(merchant.successRate * 100).toFixed(1)}%` : '—',
      sub: merchant?.avgResponseMinutes !== undefined
        ? `Avg response ${merchant.avgResponseMinutes.toFixed(1)}m`
        : 'Awaiting data',
      subTone: 'var(--muted)',
    },
    {
      label: copy.walletLabel,
      icon: <Wallet size={16} style={{ color: 'var(--brand)' }} />,
      iconBg: 'var(--brand-bg)',
      value: formatWallet(merchant?.tokenBalance, rail),
      sub: copy.walletNote,
      subTone: 'var(--muted)',
    },
  ];

  return (
    <div style={{ maxWidth: 1120, margin: '0 auto', display: 'flex', flexDirection: 'column', gap }}>
      {/* Availability hero */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 14, flexWrap: 'wrap',
        padding: isMobile ? '16px 18px' : '20px 22px', borderRadius: 18, boxShadow: 'var(--shadow)',
        background: online
          ? 'linear-gradient(120deg, var(--dep) 0%, var(--ok) 100%)'
          : 'linear-gradient(120deg, var(--offline) 0%, var(--muted) 100%)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 13 }}>
          <span style={{
            width: 12, height: 12, borderRadius: '50%', background: '#fff', flexShrink: 0,
            animation: online ? 'bb-pulse 2s ease infinite' : 'none',
          }} />
          <div>
            <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.08em', textTransform: 'uppercase', color: 'rgba(255,255,255,.8)' }}>
              Merchant status
            </div>
            <div style={{ fontSize: 20, fontWeight: 800, color: '#fff', letterSpacing: '-.3px' }}>
              {online ? 'Online · Accepting orders' : 'Offline · Not accepting'}
            </div>
          </div>
        </div>
        <button
          onClick={toggleOnline}
          style={{
            display: 'flex', alignItems: 'center', gap: 8, padding: '11px 18px', borderRadius: 12,
            border: '1.5px solid rgba(255,255,255,.35)', background: 'rgba(255,255,255,.14)',
            color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer',
          }}
        >
          <Power size={15} /> {online ? 'Go offline' : 'Go online'}
        </button>
      </div>

      {/* KPI row */}
      {!metricsReady ? (
        <div style={{ display: 'grid', gridTemplateColumns: kpiColumns, gap: 14 }}>
          {[0, 1, 2, 3].map((i) => <Skeleton key={i} height={104} />)}
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: kpiColumns, gap: 14 }}>
          {kpis.map((kpi) => (
            <div key={kpi.label} style={{ ...cardStyle, padding: 17 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 11 }}>
                <span style={{
                  width: 30, height: 30, borderRadius: 9, background: kpi.iconBg, flexShrink: 0,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}>
                  {kpi.icon}
                </span>
                <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-2)' }}>{kpi.label}</span>
              </div>
              <div className="bb-mono" style={{ fontSize: 24, fontWeight: 700, color: 'var(--text)', letterSpacing: '-1px' }}>
                {kpi.value}
              </div>
              <div style={{ fontSize: 11.5, fontWeight: 600, color: kpi.subTone, marginTop: 3 }}>{kpi.sub}</div>
            </div>
          ))}
        </div>
      )}

      {/* Weekly earnings + expiring soon */}
      <div style={{ display: 'grid', gridTemplateColumns: splitColumns, gap: 14 }}>
        <Card>
          <CardTitle
            title="Weekly earnings"
            sub={weekly ? `Last 7 days · ${formatMoney(weekTotal, rail)} total` : 'Last 7 days'}
          />
          {weekly === null ? (
            <Skeleton height={130} />
          ) : (
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: isMobile ? 6 : 10, height: 130 }}>
              {weekly.map((point, index) => {
                const last = index === weekly.length - 1;
                const height = `${Math.max(3, Math.round((point.earnings / weeklyMax) * 100))}%`;
                const label = new Date(point.date).toLocaleDateString('en-IN', { weekday: 'short' });
                return (
                  <div key={point.date} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 7, height: '100%', justifyContent: 'flex-end' }}>
                    <div
                      title={`${label}: ${formatMoney(point.earnings, rail)} · ${point.orders} orders`}
                      style={{
                        width: '100%', maxWidth: 34, height, borderRadius: '7px 7px 3px 3px',
                        background: last ? 'var(--brand)' : 'var(--brand-bg)', transition: 'height .4s ease',
                      }}
                    />
                    <span style={{ fontSize: 10.5, fontWeight: 700, color: last ? 'var(--brand)' : 'var(--muted)' }}>{label}</span>
                  </div>
                );
              })}
            </div>
          )}
        </Card>

        <Card style={{ display: 'flex', flexDirection: 'column' }}>
          <CardTitle title="Expiring soon" />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 9, flex: 1 }}>
            {expiring.length === 0 ? (
              <div style={{
                flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                gap: 8, padding: '20px 0', textAlign: 'center',
              }}>
                <ShieldCheck size={26} style={{ color: 'var(--ok)' }} />
                <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--muted)' }}>
                  Nothing expiring. You're all caught up.
                </span>
              </div>
            ) : expiring.map(({ order, left }) => (
              <button
                key={orderKey(order)}
                onClick={() => navigate(ROUTES.ORDERS)}
                className="bb-lift"
                style={{
                  display: 'flex', alignItems: 'center', gap: 11, padding: '11px 12px', width: '100%',
                  background: 'var(--warn-bg)', border: '1px solid transparent', borderRadius: 12,
                  cursor: 'pointer', textAlign: 'left',
                }}
              >
                <span style={{
                  width: 34, height: 34, borderRadius: 9, flexShrink: 0,
                  background: order.type === 'DEPOSIT' ? 'var(--dep-bg)' : 'var(--wd-bg)',
                  color: order.type === 'DEPOSIT' ? 'var(--dep)' : 'var(--wd)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 15, fontWeight: 800,
                }}>
                  {order.type === 'DEPOSIT' ? '↓' : '↑'}
                </span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: 'block', fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>
                    {formatMoney(order.fiatAmount ?? order.amount, rail)}
                  </span>
                  <span style={{ display: 'block', fontSize: 11, fontWeight: 600, color: 'var(--text-2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {order.type === 'DEPOSIT' ? 'Deposit' : 'Withdrawal'} · {counterpartyOf(order).name}
                  </span>
                </span>
                <span className="bb-mono" style={{ fontSize: 13, fontWeight: 700, color: 'var(--warn)' }}>
                  {formatCountdown(left ?? 0)}
                </span>
              </button>
            ))}
          </div>
        </Card>
      </div>

      {/* Recent + capacity */}
      <div style={{ display: 'grid', gridTemplateColumns: splitColumns, gap: 14 }}>
        <Card>
          <CardTitle
            title="Recent assigned"
            action={
              <button
                onClick={() => navigate(ROUTES.ORDERS)}
                style={{ fontSize: 12, fontWeight: 700, color: 'var(--brand)', background: 'none', border: 0, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 3 }}
              >
                View all <ArrowRight size={13} />
              </button>
            }
          />
          {state === 'loading' ? (
            <Skeleton height={180} />
          ) : recent.length === 0 ? (
            <div style={{ padding: '28px 0', textAlign: 'center', fontSize: 12.5, fontWeight: 600, color: 'var(--muted)' }}>
              No active orders right now.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              {recent.map((order) => (
                <button
                  key={orderKey(order)}
                  onClick={() => navigate(ROUTES.ORDERS)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 12, padding: '11px 4px', width: '100%',
                    border: 0, borderBottom: '1px solid var(--border-2)', background: 'none',
                    cursor: 'pointer', textAlign: 'left',
                  }}
                >
                  <span style={{
                    width: 32, height: 32, borderRadius: 9, flexShrink: 0,
                    background: order.type === 'DEPOSIT' ? 'var(--dep-bg)' : 'var(--wd-bg)',
                    color: order.type === 'DEPOSIT' ? 'var(--dep)' : 'var(--wd)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14, fontWeight: 800,
                  }}>
                    {order.type === 'DEPOSIT' ? '↓' : '↑'}
                  </span>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ display: 'block', fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>
                      {formatMoney(order.fiatAmount ?? order.amount, rail)}
                      <span style={{ fontWeight: 600, color: 'var(--muted)', fontSize: 11 }}>
                        {' · '}{order.type === 'DEPOSIT' ? 'Deposit' : 'Withdrawal'}
                      </span>
                    </span>
                    <span className="bb-mono" style={{ display: 'block', fontSize: 10.5, fontWeight: 500, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {order.orderId || order._id}
                    </span>
                  </span>
                  <StatusPill status={order.status} />
                  <ChevronRight size={14} style={{ color: 'var(--muted)', flexShrink: 0 }} />
                </button>
              ))}
            </div>
          )}
        </Card>

        <Card>
          <CardTitle title="Order limits & capacity" sub="Live limits from your profile" />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 9 }}>
            <div style={{ background: 'var(--surface-2)', borderRadius: 11, padding: 11 }}>
              <div style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--muted)' }}>Min / Max deposit</div>
              <div className="bb-mono" style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)', marginTop: 2 }}>{depositRange}</div>
            </div>
            <div style={{ background: 'var(--surface-2)', borderRadius: 11, padding: 11 }}>
              <div style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--muted)' }}>Min / Max withdraw</div>
              <div className="bb-mono" style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)', marginTop: 2 }}>{withdrawRange}</div>
            </div>
            <div style={{ background: 'var(--surface-2)', borderRadius: 11, padding: 11 }}>
              <div style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--muted)' }}>Dispute rate</div>
              <div className="bb-mono" style={{ fontSize: 13, fontWeight: 700, color: 'var(--ok)', marginTop: 2 }}>
                {merchant?.disputeRate !== undefined ? `${(merchant.disputeRate * 100).toFixed(1)}%` : '—'}
              </div>
            </div>
            <div style={{ background: 'var(--surface-2)', borderRadius: 11, padding: 11 }}>
              <div style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--muted)' }}>Merchant rating</div>
              <div className="bb-mono" style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)', marginTop: 2 }}>
                {merchant?.rating !== undefined ? `${merchant.rating.toFixed(1)} ★` : '—'}
              </div>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
};

export default Dashboard;
