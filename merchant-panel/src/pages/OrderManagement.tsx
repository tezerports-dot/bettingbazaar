// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
//
// Orders — the merchant's live queue. Design handoff "BB Merchant Panel.dc.html":
// four status tiles that double as filters, a search + type filter row, then the
// order cards, with the detail drawer/sheet over them.
import React, { useEffect, useMemo, useState } from 'react';
import { RefreshCw, Search } from 'lucide-react';
import { useAuth } from '../services/AuthContext';
import { useOrders } from '../hooks/useOrders';
import { useOrderActions } from '../hooks/useOrderActions';
import { useNow } from '../hooks/useCountdown';
import { useViewport } from '../hooks/useViewport';
import { railOf } from '../utils/rail';
import { OrderStatus, type PaymentOrder } from '../types';
import OrderCard from '../components/OrderCard';
import OrderDetail from '../components/OrderDetail';
import {
  Button, ConfirmDialog, EmptyState, ErrorState, SegmentedControl, Skeleton, inputStyle,
} from '../components/ui';

type StatusFilter = 'ALL' | 'ASSIGNED' | 'PROCESSING' | 'PAID' | 'DISPUTED';
type TypeFilter = 'ALL' | 'DEPOSIT' | 'WITHDRAWAL';

const orderKey = (order: PaymentOrder): string => String(order._id || order.id || order.orderId);

const OrderManagement: React.FC = () => {
  const { merchant } = useAuth();
  const { orders, state, counts, reload } = useOrders();
  const now = useNow();
  const { isMobile, isDesktop } = useViewport();
  const rail = railOf(merchant);

  const [statusFilter, setStatusFilter] = useState<StatusFilter>('ALL');
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('ALL');
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const { actions, confirmRequest, dismissConfirm, shouldCloseDetail, acknowledgeCloseDetail } =
    useOrderActions(rail, reload);

  useEffect(() => {
    if (shouldCloseDetail) {
      setSelectedId(null);
      acknowledgeCloseDetail();
    }
  }, [shouldCloseDetail, acknowledgeCloseDetail]);

  const visible = useMemo(() => {
    const query = search.trim().toLowerCase();
    return orders.filter((order) => {
      if (typeFilter !== 'ALL' && order.type !== typeFilter) return false;
      if (statusFilter === 'ASSIGNED' && !(order.status === OrderStatus.ASSIGNED || order.status === OrderStatus.PENDING_QUEUE)) return false;
      if (statusFilter !== 'ALL' && statusFilter !== 'ASSIGNED' && order.status !== statusFilter) return false;
      if (query) {
        const haystack = [order.orderId, order.shortId, order._id, order.user?.username, order.userPhone]
          .filter(Boolean).join(' ').toLowerCase();
        if (!haystack.includes(query)) return false;
      }
      return true;
    });
  }, [orders, statusFilter, typeFilter, search]);

  const filtersActive = statusFilter !== 'ALL' || typeFilter !== 'ALL' || !!search.trim();
  const clearFilters = () => { setStatusFilter('ALL'); setTypeFilter('ALL'); setSearch(''); };

  const selected = selectedId ? orders.find((o) => orderKey(o) === selectedId) ?? null : null;
  const cardActions = { ...actions, onOpen: (order: PaymentOrder) => setSelectedId(orderKey(order)) };

  const tiles: Array<{ key: StatusFilter; label: string; count: number; color: string; bg: string }> = [
    { key: 'ASSIGNED',   label: 'Assigned',   count: counts.assigned,   color: 'var(--info)',    bg: 'var(--info-bg)' },
    { key: 'PROCESSING', label: 'Processing', count: counts.processing, color: 'var(--warn)',    bg: 'var(--warn-bg)' },
    { key: 'PAID',       label: 'Paid',       count: counts.paid,       color: 'var(--dep)',     bg: 'var(--dep-bg)' },
    { key: 'DISPUTED',   label: 'Disputed',   count: counts.disputed,   color: 'var(--dispute)', bg: 'var(--dispute-bg)' },
  ];

  const columns = isDesktop ? 'repeat(2, minmax(0, 1fr))' : isMobile ? '1fr' : 'repeat(2, minmax(0, 1fr))';

  return (
    <div style={{ maxWidth: 1120, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: isMobile ? 14 : 16 }}>
      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr 1fr' : 'repeat(4, 1fr)', gap: isMobile ? 10 : 12 }}>
        {tiles.map((tile) => {
          const active = statusFilter === tile.key;
          return (
            <button
              key={tile.key}
              onClick={() => setStatusFilter(active ? 'ALL' : tile.key)}
              className="bb-lift"
              style={{
                display: 'flex', flexDirection: 'column', gap: 2, textAlign: 'left', cursor: 'pointer',
                padding: isMobile ? '12px 14px' : '14px 16px', borderRadius: 14,
                border: `1.5px solid ${active ? tile.color : 'var(--border)'}`,
                background: active ? tile.bg : 'var(--surface)',
                color: tile.color, boxShadow: active ? 'none' : 'var(--shadow)',
              }}
            >
              <span className="bb-mono" style={{ fontSize: 22, fontWeight: 700 }}>{tile.count}</span>
              <span style={{ fontSize: 11.5, fontWeight: 700 }}>{tile.label}</span>
            </button>
          );
        })}
      </div>

      <div style={{ display: 'flex', gap: 9, alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={{ position: 'relative', flex: 1, minWidth: 180 }}>
          <Search size={16} style={{ position: 'absolute', left: 12, top: 11, color: 'var(--muted)' }} />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search order ID or user…"
            style={{ ...inputStyle, padding: '10px 12px 10px 37px', fontSize: 13 }}
          />
        </div>
        <SegmentedControl<TypeFilter>
          value={typeFilter}
          onChange={setTypeFilter}
          options={[
            { value: 'ALL', label: 'All' },
            { value: 'DEPOSIT', label: 'Deposits' },
            { value: 'WITHDRAWAL', label: 'Withdrawals' },
          ]}
        />
        <Button variant="outline" tone="neutral" onClick={() => void reload()} style={{ borderColor: 'var(--border)', padding: '10px 14px', fontSize: 12.5 }}>
          <RefreshCw size={15} /> Refresh
        </Button>
      </div>

      {filtersActive && state === 'ready' && (
        <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)' }}>
          Showing {visible.length} of {orders.length} orders
          <button
            onClick={clearFilters}
            style={{ color: 'var(--brand)', background: 'none', border: 0, fontWeight: 700, cursor: 'pointer', fontSize: 12 }}
          >
            {' '}· Clear filters
          </button>
        </div>
      )}

      {state === 'loading' && (
        <div style={{ display: 'grid', gridTemplateColumns: columns, gap: 14 }}>
          {[0, 1, 2, 3].map((i) => <Skeleton key={i} height={250} />)}
        </div>
      )}

      {state === 'error' && (
        <ErrorState
          title="Couldn't load your orders"
          body="The live connection dropped. Your data is safe — this is just the view."
          onRetry={() => void reload()}
        />
      )}

      {state === 'ready' && visible.length === 0 && (
        <EmptyState
          title={filtersActive ? 'No orders match your filters' : 'Your queue is clear'}
          body={filtersActive
            ? 'Try a different status or type, or clear filters to see everything.'
            : 'Nothing needs action right now. New assignments appear here instantly.'}
          action={filtersActive
            ? <Button variant="outline" tone="neutral" onClick={clearFilters} style={{ borderColor: 'var(--border)', color: 'var(--text)', display: 'inline-flex', margin: '0 auto' }}>Clear filters</Button>
            : undefined}
        />
      )}

      {state === 'ready' && visible.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: columns, gap: 14, alignItems: 'start' }}>
          {visible.map((order) => (
            <OrderCard key={orderKey(order)} order={order} merchant={merchant} now={now} actions={cardActions} />
          ))}
        </div>
      )}

      <OrderDetail
        order={selected}
        merchant={merchant}
        now={now}
        isMobile={isMobile}
        onClose={() => setSelectedId(null)}
        actions={cardActions}
      />
      <ConfirmDialog request={confirmRequest} onClose={dismissConfirm} />
    </div>
  );
};

export default OrderManagement;
