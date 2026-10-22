// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
//
// Dashboard — design handoff "BB Merchant Panel.dc.html": availability hero,
// the cash team's Ready switch, the swipeable pool, sell capacity, disputes and
// commission cards with their ledger profit and loss (owner, 2026-10-21),
// three KPI tiles, the weekly earnings bars, what is expiring soon, the orders
// to work (open buys, open sells, in process and disputed, approved or
// rejected in place) and the merchant's record.
//
// A merchant holds no tokens — their team's pool does (PROJECT_STATUS §3.10).
// "Your tokens" shows that pool, split by what it is locked in, beside what
// the merchant's own orders hold (GET /merchant/stats `money`).
//
// Every figure comes from the backend (GET /merchant/stats, /earnings,
// /earnings/weekly, /profile and the live order queue). Where a figure has no
// backend source the tile shows an em-dash rather than an invented number
// (GOVERNANCE §2/§3: no hardcoded business values).
import React, { useEffect, useMemo, useState } from 'react';
import { ArrowRight, Clock, Coins, Power, ShieldCheck } from 'lucide-react';
import { useNavigate } from 'react-router';
import toast from 'react-hot-toast';
import { useAuth } from '../services/AuthContext';
import { api } from '../services/api';
import { useOrders, needsAction } from '../hooks/useOrders';
import { useNow, formatCountdown, secondsLeft } from '../hooks/useCountdown';
import { useViewport } from '../hooks/useViewport';
import { ROUTES } from '../constants';
import { counterpartyOf, formatMoney, formatTokens } from '../utils/rail';
import { OrderStatus, type BusinessLedger, type Earnings, type PaymentOrder, type Stats } from '../types';
import { Card, CardTitle, SegmentedControl, Skeleton, cardStyle } from '../components/ui';
import { CashReadyCard } from '../components/CashReadyCard';
import { HomeCards } from '../components/HomeCards';
import OrderWorkList, { orderKey } from '../components/OrderWorkList';
import { mayReadReports } from '../utils/actor';
import { availabilityOf } from '../utils/availability';
import type { OrdersLinkState } from './OrderManagement';
import type { HistoryLinkState } from './HistoryViews';

interface WeeklyPoint { date: string; earnings: number; orders: number; }

const UPCOMING_WINDOW_SECONDS = 480; // "expiring soon" cut-off from the design

/**
 * The home orders card's tabs (owner, 2026-10-21): what waits on the merchant
 * by direction, what waits on someone else, and what is in dispute. Each test
 * is the queue's own (`needsAction`), so Home and Orders agree.
 */
type HomeOrdersTab = 'BUYS' | 'SELLS' | 'IN_PROCESS' | 'DISPUTED';
const HOME_ORDER_TABS: Array<{ value: HomeOrdersTab; label: string; empty: string; holds: (o: PaymentOrder) => boolean }> = [
  { value: 'BUYS', label: 'Open buys', empty: 'No buy waits on you.',
    holds: (o) => o.type === 'DEPOSIT' && needsAction(o) },
  { value: 'SELLS', label: 'Open sells', empty: 'No sell waits on you.',
    holds: (o) => o.type === 'WITHDRAWAL' && needsAction(o) },
  { value: 'IN_PROCESS', label: 'In process', empty: 'Nothing is waiting on a player or a hold window.',
    holds: (o) => (o.status === OrderStatus.PROCESSING || o.status === OrderStatus.PAID) && !needsAction(o) },
  { value: 'DISPUTED', label: 'Disputed', empty: 'No order of yours is in dispute.',
    holds: (o) => o.status === OrderStatus.DISPUTED },
];

/** Tokens from paise, for the commission figures (`toSummary` sends paise). */
const tokensOfPaise = (paise: number): string => formatTokens(paise / 100);

const Dashboard: React.FC = () => {
  const { merchant, refreshProfile } = useAuth();
  const navigate = useNavigate();
  const { orders, state, counts, reload } = useOrders();
  const now = useNow();
  const { isMobile, isDesktop } = useViewport();

  // Online, and whether the platform paused new buy orders to them (§2:
  // three unpaid in a row) — one helper, shared with the sidebar (§5).
  const availability = availabilityOf(merchant);
  const { online, paused, switchable } = availability;

  const [stats, setStats] = useState<Stats | null>(null);
  const [earnings, setEarnings] = useState<Earnings | null>(null);
  const [weekly, setWeekly] = useState<WeeklyPoint[] | null>(null);
  const [metricsReady, setMetricsReady] = useState(false);
  // The last seven days of the business ledger, for the cards' profit and loss
  // lines: only for those who may read reports (`ownerOrAudit`).
  const readsLedger = mayReadReports(merchant);
  const [ledger, setLedger] = useState<BusinessLedger | null>(null);
  useEffect(() => {
    if (!readsLedger) { setLedger(null); return undefined; }
    let alive = true;
    api.getBusinessLedger('', '').then((l) => { if (alive) setLedger(l); }).catch(() => { /* the cards show no ledger line */ });
    return () => { alive = false; };
  }, [readsLedger]);
  const [ordersTab, setOrdersTab] = useState<HomeOrdersTab>('BUYS');

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

  // A tile or a row opens Orders on what it showed: the filter, or the order.
  const openOrders = (state: OrdersLinkState) => navigate(ROUTES.ORDERS, { state });
  // A tile opens the place its figure comes from, never a filter that shows
  // nothing: a filter matching no order sent the merchant to an empty list
  // they had to clear to see their orders (owner, 2026-10-20).
  const openHistory = (state: HistoryLinkState) => navigate(ROUTES.HISTORY, { state });
  const openOrder = (order: PaymentOrder) => openOrders({ orderId: orderKey(order) });

  // Why today's earnings may read 0 (order commission, §26): earned and
  // waiting for the platform's commission pool, or no completed order yet.
  const commission = stats?.commission ?? null;
  const commissionNote = !commission ? null
    : commission.owedPaise > 0
      ? `${tokensOfPaise(commission.owedPaise)} earned, waiting for the platform's commission pool`
      : commission.paidPaise === 0
        ? `Commission is ${commission.depositPercent}% of each completed buy and ${commission.withdrawalPercent}% of each completed sell`
        : `${tokensOfPaise(commission.paidPaise)} commission paid to your ${commission.supervisorSharePercent ? 'team' : 'account'} so far`;

  const expiring = useMemo(
    () => orders
      .map((order) => ({ order, left: secondsLeft(order.expiresAt, now) }))
      .filter((row) => row.left !== null && row.left > 0 && row.left < UPCOMING_WINDOW_SECONDS && needsAction(row.order))
      .sort((a, b) => (a.left ?? 0) - (b.left ?? 0))
      .slice(0, 3),
    [orders, now]
  );

  const tabbed = useMemo(
    () => Object.fromEntries(HOME_ORDER_TABS.map((tab) => [tab.value, orders.filter(tab.holds)])) as Record<HomeOrdersTab, PaymentOrder[]>,
    [orders]
  );
  const activeTab = HOME_ORDER_TABS.find((tab) => tab.value === ordersTab) ?? HOME_ORDER_TABS[0];

  const weeklyMax = useMemo(() => Math.max(1, ...(weekly ?? []).map((point) => point.earnings)), [weekly]);
  const weekTotal = useMemo(() => (weekly ?? []).reduce((sum, point) => sum + (point.earnings || 0), 0), [weekly]);

  const splitColumns = isDesktop ? '1.35fr 1fr' : '1fr';
  const gap = isMobile ? 14 : 16;

  const kpis = [
    {
      label: "Today's earnings",
      icon: <Coins size={16} style={{ color: 'var(--dep)' }} />,
      iconBg: 'var(--dep-bg)',
      // Counted in platform TOKENS — never in the currency the player
      // happened to pay with (trap 15).
      value: earnings ? formatTokens(earnings.today) : '—',
      sub: stats ? `${stats.completedToday ?? 0} orders completed today` : 'Awaiting data',
      subTone: 'var(--dep)',
      note: commissionNote,
      open: () => openHistory({ tab: 'earnings' }),
    },
    {
      label: 'Needs action',
      icon: <Clock size={16} style={{ color: 'var(--warn)' }} />,
      iconBg: 'var(--warn-bg)',
      value: String(counts.actionable),
      sub: `${counts.processing} in progress`,
      subTone: 'var(--muted)',
      note: null as string | null,
      open: () => openOrders(counts.actionable > 0 ? { statusFilter: 'ACTION' } : {}),
    },
    {
      label: 'Success rate',
      icon: <ShieldCheck size={16} style={{ color: 'var(--ok)' }} />,
      iconBg: 'var(--ok-bg)',
      value: typeof merchant?.successRate === 'number' ? `${(merchant.successRate * 100).toFixed(1)}%` : '—',
      sub: merchant?.avgResponseMinutes !== undefined
        ? `Avg response ${merchant.avgResponseMinutes.toFixed(1)}m`
        : 'Awaiting data',
      subTone: 'var(--muted)',
      note: null as string | null,
      open: () => openHistory({ tab: 'ledger' }),
    },
  ];
  // Derived from the tiles, so removing or adding one cannot leave a gap.
  const kpiColumns = isMobile ? '1fr 1fr' : `repeat(${kpis.length}, minmax(0, 1fr))`;

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
              {availability.long}
            </div>
          </div>
        </div>
        {/* A supervisor takes no orders (CLAUDE.md §2), so there is no switch to
            offer: their work, and their agents' online time, is on Team. A
            merchant account's sub-member has no switch either (the owner's,
            OWNER_ONLY): their work is on Orders. */}
        <button
          onClick={switchable ? toggleOnline : () => navigate(availability.subMember ? ROUTES.ORDERS : ROUTES.TEAM)}
          style={{
            display: 'flex', alignItems: 'center', gap: 8, padding: '11px 18px', borderRadius: 12,
            border: '1.5px solid rgba(255,255,255,.35)', background: 'rgba(255,255,255,.14)',
            color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer',
          }}
        >
          {switchable
            ? <><Power size={15} /> {online ? 'Go offline' : 'Go online'}</>
            : availability.subMember ? <>Open orders <ArrowRight size={15} /></>
            : <>Open your teams <ArrowRight size={15} /></>}
        </button>
      </div>

      {/* Directly under the online switch: for a cash team member, Ready is
          the other half of being available. Renders nothing for anybody else. */}
      <CashReadyCard />

      {paused && (
        <div role="alert" style={{
          padding: '14px 18px', borderRadius: 14, border: '1px solid var(--warn)',
          background: 'var(--warn-bg)', color: 'var(--text)', lineHeight: 1.5,
        }}>
          <div style={{ fontWeight: 800, marginBottom: 4 }}>New buy orders are paused for your account</div>
          <div style={{ fontSize: 13 }}>
            Several players in a row could not complete a payment to you, so the platform has stopped
            sending you new buy orders. This is not a suspension: your team and your current orders
            are untouched. Check that the bank details on your Profile are right (a 50,000-and-up buyer
            pays into them) and that you accept, and on a cash buy scan the machine's QR, promptly; then
            contact support to have new orders resumed.
          </div>
        </div>
      )}

      {/* The pool, its sell capacity, the disputes and the commission, side
          by side to swipe, each with its bar and its ledger line (owner,
          2026-10-21). What the merchant's own orders hold is under them. */}
      {metricsReady && (
        <HomeCards
          money={stats?.money}
          commission={stats?.commission}
          ledger={ledger}
          disputes={tabbed.DISPUTED}
          onOpenOrder={openOrder}
        />
      )}
      {stats?.money?.pool && (stats.money.own.openBuys + stats.money.own.openSells > 0) && (
        <div style={{ fontSize: 12, color: 'var(--muted)' }}>
          Your own orders: {formatTokens(stats.money.own.heldOpenPaise / 100)} locked in {stats.money.own.openBuys} open buy{stats.money.own.openBuys === 1 ? '' : 's'},
          {' '}{formatTokens(stats.money.own.heldDisputedPaise / 100)} in disputes,
          {' '}{formatTokens(stats.money.own.sellsSettlingPaise / 100)} incoming from sells.
        </div>
      )}

      {/* KPI row */}
      {!metricsReady ? (
        <div style={{ display: 'grid', gridTemplateColumns: kpiColumns, gap: 14 }}>
          {kpis.map((kpi) => <Skeleton key={kpi.label} height={104} />)}
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: kpiColumns, gap: 14 }}>
          {kpis.map((kpi) => {
            return (
            <button
              key={kpi.label}
              type="button"
              onClick={kpi.open}
              className="bb-lift"
              style={{ ...cardStyle, padding: 17, textAlign: 'left', cursor: 'pointer', width: '100%' }}
            >
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
              {kpi.note && <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)', marginTop: 4 }}>{kpi.note}</div>}
            </button>
            );
          })}
        </div>
      )}

      {/* Weekly earnings + expiring soon */}
      <div style={{ display: 'grid', gridTemplateColumns: splitColumns, gap: 14 }}>
        <Card>
          <CardTitle
            title="Weekly earnings"
            sub={weekly ? `Last 7 days · ${formatTokens(weekTotal)} total` : 'Last 7 days'}
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
                      title={`${label}: ${formatTokens(point.earnings)} · ${point.orders} orders`}
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
                onClick={() => openOrder(order)}
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
                    {formatMoney(order.fiatAmount ?? order.amount)}
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

      {/* Recent + record */}
      <div style={{ display: 'grid', gridTemplateColumns: splitColumns, gap: 14 }}>
        <Card>
          <CardTitle
            title="Your orders"
            sub="Approve or reject here; a tap opens the details"
            action={
              <button
                onClick={() => navigate(ROUTES.ORDERS)}
                style={{ fontSize: 12, fontWeight: 700, color: 'var(--brand)', background: 'none', border: 0, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 3 }}
              >
                View all <ArrowRight size={13} />
              </button>
            }
          />
          <SegmentedControl<HomeOrdersTab>
            value={ordersTab}
            onChange={setOrdersTab}
            style={{ marginBottom: 12, flexWrap: 'wrap' }}
            options={HOME_ORDER_TABS.map((tab) => ({ value: tab.value, label: `${tab.label} (${tabbed[tab.value].length})` }))}
          />
          {state === 'loading' ? (
            <Skeleton height={180} />
          ) : tabbed[activeTab.value].length === 0 ? (
            <div style={{ padding: '24px 0', textAlign: 'center', fontSize: 12.5, fontWeight: 600, color: 'var(--muted)' }}>
              {activeTab.empty}
            </div>
          ) : null}
          <OrderWorkList orders={state === 'loading' ? [] : tabbed[activeTab.value]} allOrders={orders} reload={reload} />
        </Card>

        <Card>
          <CardTitle title="Your record" sub="Kept by the platform from your completed orders" />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 9 }}>
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
