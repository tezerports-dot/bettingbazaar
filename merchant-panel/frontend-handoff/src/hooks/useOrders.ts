// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
//
// The merchant's order queue: one fetch + the private merchant SSE stream.
// Dashboard and Orders both read from this so they never disagree about what
// is in the queue.
//
// GOVERNANCE §11 event names: merchant_orders_snapshot, new_order, order_update
// (constants.SOCKET_EVENTS is the canonical spelling — no string literals here).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../services/api';
import sseService from '../services/sse';
import { SOCKET_EVENTS, PAGINATION } from '../constants';
import { OrderStatus, type PaymentOrder } from '../types';

export type LoadState = 'loading' | 'ready' | 'error';

/** Queue order for the Orders screen: what needs attention first. */
const SORT_RANK: Record<string, number> = {
  [OrderStatus.ASSIGNED]: 0,
  [OrderStatus.PAID]: 1,
  [OrderStatus.PROCESSING]: 2,
  [OrderStatus.PENDING_QUEUE]: 3,
  [OrderStatus.DISPUTED]: 4,
  [OrderStatus.COMPLETED]: 5,
  [OrderStatus.REJECTED]: 6,
  [OrderStatus.CANCELLED]: 7,
  [OrderStatus.FAILED]: 8,
};

const orderKey = (order: PaymentOrder): string => String(order._id || order.id || order.orderId);

/**
 * needsAction — the merchant has something to do on this order right now:
 * accept a new assignment, verify a claimed deposit payment, or send a payout.
 * This drives the nav badge and the dashboard's "needs action" tile.
 */
export function needsAction(order: PaymentOrder): boolean {
  if (order.status === OrderStatus.ASSIGNED || order.status === OrderStatus.PENDING_QUEUE) return true;
  if (order.status === OrderStatus.PAID && order.type === 'DEPOSIT') return true;
  if (order.status === OrderStatus.PROCESSING && order.type === 'WITHDRAWAL') return true;
  return false;
}

export function useOrders() {
  const [orders, setOrders] = useState<PaymentOrder[]>([]);
  const [state, setState] = useState<LoadState>('loading');
  const mounted = useRef(true);

  useEffect(() => () => { mounted.current = false; }, []);

  const load = useCallback(async () => {
    setState('loading');
    try {
      const { orders: fetched } = await api.getOrders({ limit: PAGINATION.HISTORY_PER_PAGE });
      if (!mounted.current) return;
      setOrders(fetched);
      setState('ready');
    } catch {
      if (!mounted.current) return;
      setState('error');
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // Live updates. An order arriving on the stream replaces its stored copy;
  // an unknown id is prepended, so a new assignment appears without a refetch.
  useEffect(() => {
    const upsert = (incoming: any) => {
      if (!incoming) return;
      const next: PaymentOrder = incoming.order || incoming;
      const key = orderKey(next);
      if (!key || key === 'undefined') return;
      setOrders((current) => {
        const index = current.findIndex((o) => orderKey(o) === key);
        if (index === -1) return [next, ...current];
        const merged = [...current];
        // SSE payloads are partial snapshots — merge so fields the event omits
        // (user details, payment destinations) survive a status change.
        merged[index] = { ...merged[index], ...next };
        return merged;
      });
    };

    const onSnapshot = (payload: any) => {
      const list: PaymentOrder[] = payload?.orders || payload;
      if (Array.isArray(list)) setOrders(list);
    };

    sseService.on('merchant_orders_snapshot', onSnapshot);
    sseService.on(SOCKET_EVENTS.NEW_ORDER, upsert);
    sseService.on('new_order', upsert);
    sseService.on(SOCKET_EVENTS.ORDER_UPDATE, upsert);
    return () => {
      sseService.off('merchant_orders_snapshot', onSnapshot);
      sseService.off(SOCKET_EVENTS.NEW_ORDER, upsert);
      sseService.off('new_order', upsert);
      sseService.off(SOCKET_EVENTS.ORDER_UPDATE, upsert);
    };
  }, []);

  const sorted = useMemo(
    () => [...orders].sort((a, b) => {
      const rank = (SORT_RANK[a.status] ?? 9) - (SORT_RANK[b.status] ?? 9);
      if (rank !== 0) return rank;
      return new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime();
    }),
    [orders]
  );

  const counts = useMemo(() => ({
    assigned:   orders.filter((o) => o.status === OrderStatus.ASSIGNED || o.status === OrderStatus.PENDING_QUEUE).length,
    processing: orders.filter((o) => o.status === OrderStatus.PROCESSING).length,
    paid:       orders.filter((o) => o.status === OrderStatus.PAID).length,
    disputed:   orders.filter((o) => o.status === OrderStatus.DISPUTED).length,
    actionable: orders.filter(needsAction).length,
  }), [orders]);

  return { orders: sorted, state, counts, reload: load };
}
