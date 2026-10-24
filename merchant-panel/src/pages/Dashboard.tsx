// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
//
// Home (owner, 2026-10-22: "a simple setup"): one big pool card a third of
// the screen high, with the online switch in its corner and its four small
// cards (locked in open buys, locked in disputes, incoming from sells, today's
// earnings); the button to buy tokens from the admin under it; then the orders
// to work, open buys, open sells, in process and disputed, each with its
// timer. The cash team's Ready switch and the paused notice stay where they
// were. Weekly earnings are on Reports and the record and success rate on
// Profile.
//
// A merchant holds no tokens; their team's pool does (PROJECT_STATUS §3.10).
// Every figure comes from the backend (GET /merchant/stats `money`,
// /earnings and the live order queue).
import React, { useEffect, useMemo, useState } from 'react';
import { ArrowRight, Coins, Power } from 'lucide-react';
import { useNavigate } from 'react-router';
import toast from 'react-hot-toast';
import { useAuth } from '../services/AuthContext';
import { api } from '../services/api';
import { useOrders, needsAction } from '../hooks/useOrders';
import { useViewport } from '../hooks/useViewport';
import { ROUTES } from '../constants';
import { formatTokens } from '../utils/rail';
import { OrderStatus, type Earnings, type PaymentOrder, type Stats } from '../types';
import { Card, CardTitle, SegmentedControl, Skeleton } from '../components/ui';
import { CashReadyCard } from '../components/CashReadyCard';
import { PoolStatusCard } from '../components/PoolStatusCard';
import OrderWorkList from '../components/OrderWorkList';
import { isMerchantAccountSession, isOwner } from '../utils/actor';
import { availabilityOf } from '../utils/availability';
import type { OrdersLinkState } from './OrderManagement';

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
  const { orders, state, reload } = useOrders();
  const { isMobile } = useViewport();

  // Online, and whether the platform paused new buy orders to them (§2:
  // three unpaid in a row): one helper, shared with the sidebar (§5).
  const availability = availabilityOf(merchant);
  const { online, paused, switchable } = availability;

  const [stats, setStats] = useState<Stats | null>(null);
  const [earnings, setEarnings] = useState<Earnings | null>(null);
  const [metricsReady, setMetricsReady] = useState(false);
  const [ordersTab, setOrdersTab] = useState<HomeOrdersTab>('BUYS');

  useEffect(() => {
    let alive = true;
    void (async () => {
      const [statsResult, earningsResult] = await Promise.allSettled([api.getStats(), api.getEarnings()]);
      if (!alive) return;
      if (statsResult.status === 'fulfilled') setStats(statsResult.value);
      if (earningsResult.status === 'fulfilled') setEarnings(earningsResult.value.earnings);
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

  const openOrders = (linkState: OrdersLinkState) => navigate(ROUTES.ORDERS, { state: linkState });

  // Why today's earnings may read 0 (order commission, §26): earned and
  // being paid (the sweep runs every few minutes), or no completed order yet.
  const commission = stats?.commission ?? null;
  const earningsNote = !commission ? null
    : commission.owedPaise > 0
      ? `${tokensOfPaise(commission.owedPaise)} earned, being paid into your pool within a few minutes`
      : `${commission.depositPercent}% of each completed buy, ${commission.withdrawalPercent}% of each completed sell`;

  // Who buys the pool's tokens: a merchant account's owner on Pool, a
  // supervisor on Team (USDT only, owner 2026-10-22). An agent's supervisor
  // buys for the team; a sub-member is not offered it (`ownerOnly`).
  const buyTokensAt = isMerchantAccountSession(merchant)
    ? (isOwner(merchant) ? ROUTES.ACCOUNT_POOL : null)
    : merchant?.isSupervisor ? ROUTES.TEAM : null;
  const noPoolLine = merchant?.isSupervisor
    ? 'Each of your teams has its own pool: open Team to see them.'
    : 'You have no pool yet: once a supervisor approves you into a team, its pool shows here.';

  const tabbed = useMemo(
    () => Object.fromEntries(HOME_ORDER_TABS.map((tab) => [tab.value, orders.filter(tab.holds)])) as Record<HomeOrdersTab, PaymentOrder[]>,
    [orders]
  );
  const activeTab = HOME_ORDER_TABS.find((tab) => tab.value === ordersTab) ?? HOME_ORDER_TABS[0];
  const gap = isMobile ? 14 : 16;

  // The online switch, in the pool card's corner. A supervisor takes no
  // orders (CLAUDE.md §2), so they get their teams instead; a merchant
  // account's sub-member has no switch (OWNER_ONLY): their work is on Orders.
  const status = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
      <span style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 13, fontWeight: 700, color: online ? 'var(--ok)' : 'var(--muted)' }}>
        <span style={{
          width: 10, height: 10, borderRadius: '50%', background: online ? 'var(--ok)' : 'var(--offline)',
          animation: online ? 'bb-pulse 2s ease infinite' : 'none',
        }} />
        {availability.long}
      </span>
      <button
        onClick={switchable ? toggleOnline : () => navigate(availability.subMember ? ROUTES.ORDERS : ROUTES.TEAM)}
        style={{
          display: 'flex', alignItems: 'center', gap: 7, padding: '9px 14px', borderRadius: 11,
          border: '1px solid var(--border-2)', background: online && switchable ? 'var(--surface-2)' : 'var(--brand)',
          color: online && switchable ? 'var(--text)' : '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer',
        }}
      >
        {switchable
          ? <><Power size={15} /> {online ? 'Go offline' : 'Go online'}</>
          : availability.subMember ? <>Open orders <ArrowRight size={15} /></>
          : <>Open your teams <ArrowRight size={15} /></>}
      </button>
    </div>
  );

  return (
    <div style={{ maxWidth: 1120, margin: '0 auto', display: 'flex', flexDirection: 'column', gap }}>
      {metricsReady ? (
        <PoolStatusCard
          pool={stats?.money?.pool}
          todayEarned={earnings ? earnings.today : null}
          earningsNote={earningsNote}
          noPoolLine={noPoolLine}
          status={status}
        />
      ) : <Skeleton height={260} />}

      {buyTokensAt && (
        <button
          type="button"
          onClick={() => navigate(buyTokensAt)}
          className="bb-lift"
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 9, width: '100%',
            padding: '14px 18px', borderRadius: 14, border: 0, background: 'var(--brand)', color: '#fff',
            fontSize: 15, fontWeight: 800, cursor: 'pointer', boxShadow: 'var(--shadow)',
          }}
        >
          <Coins size={18} /> Buy tokens from admin (USDT)
        </button>
      )}

      {/* For a cash team member, Ready is the other half of being available.
          Renders nothing for anybody else. */}
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

      <Card>
        <CardTitle
          title="Your orders"
          sub="Each with the time it has left; approve or reject here, a tap opens the details"
          action={
            <button
              onClick={() => openOrders({})}
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
    </div>
  );
};

export default Dashboard;
