// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
//
// Orders — the merchant's live queue: a search + type filter row, then one
// line per order, with the detail drawer/sheet over them. The four count
// tiles that sat on top (Needs you, Processing, Paid, Disputed) are gone
// (owner, 2026-10-24); each line carries its own status.
import React, { useMemo, useState } from 'react';
import { RefreshCw, Search } from 'lucide-react';
import { useLocation } from 'react-router';
import { useOrders } from '../hooks/useOrders';
import { useViewport } from '../hooks/useViewport';
import OrderWorkList from '../components/OrderWorkList';
import {
  Button, EmptyState, ErrorState, SegmentedControl, Skeleton, inputStyle,
} from '../components/ui';

type TypeFilter = 'ALL' | 'DEPOSIT' | 'WITHDRAWAL';

/**
 * What another screen asks Orders to open with, as router state: one order.
 * The Dashboard's rows sent the merchant here with nothing, so a tap on an
 * order landed on the whole queue.
 */
export interface OrdersLinkState { orderId?: string }

const OrderManagement: React.FC = () => {
  const { orders, state, reload } = useOrders();
  const { isMobile } = useViewport();

  const link = (useLocation().state ?? null) as OrdersLinkState | null;
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('ALL');
  const [search, setSearch] = useState('');

  const visible = useMemo(() => {
    const query = search.trim().toLowerCase();
    return orders.filter((order) => {
      if (typeFilter !== 'ALL' && order.type !== typeFilter) return false;
      if (query) {
        const haystack = [order.orderId, order._id]
          .filter(Boolean).join(' ').toLowerCase();
        if (!haystack.includes(query)) return false;
      }
      return true;
    });
  }, [orders, typeFilter, search]);

  const filtersActive = typeFilter !== 'ALL' || !!search.trim();
  const clearFilters = () => { setTypeFilter('ALL'); setSearch(''); };

  return (
    <div style={{ maxWidth: 1120, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: isMobile ? 14 : 16 }}>
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
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {[0, 1, 2, 3, 4, 5].map((i) => <Skeleton key={i} height={50} />)}
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
            ? 'Try a different type or search, or clear filters to see everything.'
            : 'Nothing needs action right now. New assignments appear here instantly.'}
          action={filtersActive
            ? <Button variant="outline" tone="neutral" onClick={clearFilters} style={{ borderColor: 'var(--border)', color: 'var(--text)', display: 'inline-flex', margin: '0 auto' }}>Clear filters</Button>
            : undefined}
        />
      )}

      <OrderWorkList
        orders={state === 'ready' ? visible : []}
        allOrders={orders}
        reload={reload}
        openOrderId={link?.orderId ?? null}
      />
    </div>
  );
};

export default OrderManagement;
