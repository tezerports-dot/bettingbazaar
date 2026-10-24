// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
//
// The merchant's order queue: one fetch + the private merchant SSE stream.
// Dashboard and Orders both read from this so they never disagree about what
// is in the queue.
//
// GOVERNANCE §11 event names: merchant_orders_snapshot, new_order, order_update, order_paid
// (constants.SOCKET_EVENTS is the canonical spelling — no string literals here).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../services/api';
import sseService from '../services/sse';
import { SOCKET_EVENTS, PAGINATION } from '../constants';
import { OrderStatus, type PaymentOrder } from '../types';

export type LoadState = 'loading' | 'ready' | 'error';

/** Queue order for the Orders screen: what needs attention first. */
const SORT_RANK: Record<string, number> = {
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
 * Every state an order can still need the merchant in. The queue loads these
 * on their own, beside the newest orders of any state: a busy merchant's
 * newest page was all finished orders, so an older order still PROCESSING,
 * PAID or DISPUTED fell off it, and the Needs you / Processing / Paid /
 * Disputed tiles counted and showed only what happened to be on that page.
 */
const OPEN_STATES = [OrderStatus.PENDING_QUEUE, OrderStatus.PROCESSING, OrderStatus.PAID, OrderStatus.DISPUTED];

/** The open states the stream's snapshot carries (sse.routes.js). */
const SNAPSHOT_STATES: string[] = [OrderStatus.PENDING_QUEUE, OrderStatus.PROCESSING, OrderStatus.PAID];

/** A push that is a whole order (the projection), not an id and a change. */
function isWholeOrder(order: PaymentOrder): boolean {
  return Boolean(order.type) && Boolean(order.status) && order.fiatAmount !== undefined;
}

/** `incoming` laid over `current` by order id: a known order is merged, a new one added. */
function mergeOrders(current: PaymentOrder[], incoming: PaymentOrder[]): PaymentOrder[] {
  const merged = [...current];
  const index = new Map(merged.map((o, i) => [orderKey(o), i]));
  for (const next of incoming) {
    const key = orderKey(next);
    if (!key || key === 'undefined') continue;
    const at = index.get(key);
    if (at === undefined) { index.set(key, merged.length); merged.push(next); }
    // SSE payloads are partial snapshots — merge so fields the event omits
    // (user details, payment destinations) survive a status change.
    else merged[at] = { ...merged[at], ...next };
  }
  return merged;
}

/**
 * needsAction — the merchant has something to do on this order right now:
 * scan a cash buy's machine QR, verify a claimed deposit payment, or send a
 * payout. There is no accept (owner, 2026-10-17). This drives the nav badge
 * and the dashboard's "needs action" tile.
 */
export function needsAction(order: PaymentOrder): boolean {
  if (order.status === OrderStatus.PROCESSING && order.type === 'DEPOSIT'
    && order.paymentMode === 'CASH_ATM' && !order.cashLink) return true;
  if (order.status === OrderStatus.PAID && order.type === 'DEPOSIT') return true;
  if (order.status === OrderStatus.PROCESSING && order.type === 'WITHDRAWAL') return true;
  return false;
}

export function useOrders() {
  const [orders, setOrders] = useState<PaymentOrder[]>([]);
  const [state, setState] = useState<LoadState>('loading');
  const mounted = useRef(true);

  useEffect(() => () => { mounted.current = false; }, []);

  // `quiet` re-reads without the loading skeleton: the stream asks for it
  // when what it holds cannot be trusted on its own (below).
  const load = useCallback(async (quiet = false) => {
    if (!quiet) setState('loading');
    try {
      const [recent, open] = await Promise.all([
        api.getOrders({ limit: PAGINATION.HISTORY_PER_PAGE }),
        api.getOrders({ status: OPEN_STATES.join(','), limit: PAGINATION.MAX_PAGE_SIZE }),
      ]);
      if (!mounted.current) return;
      setOrders(mergeOrders(recent.orders, open.orders));
      setState('ready');
    } catch {
      if (!mounted.current) return;
      if (!quiet) setState('error');
    }
  }, []);

  // One quiet re-read for a burst of events, not one per event.
  const refetchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refetchSoon = useCallback(() => {
    if (refetchTimer.current) return;
    refetchTimer.current = setTimeout(() => {
      refetchTimer.current = null;
      if (mounted.current) void load(true);
    }, 300);
  }, [load]);
  useEffect(() => () => { if (refetchTimer.current) clearTimeout(refetchTimer.current); }, []);

  useEffect(() => { void load(); }, [load]);

  // Live updates. An order arriving on the stream replaces its stored copy;
  // an unknown id is prepended, so a new assignment appears without a refetch.
  //
  // Most pushes are partial (an id and what changed: a status, a deadline, a
  // reference). Laid over an order the list holds, that is right. For an order
  // the list does NOT hold, it used to be added as it came, so a card with no
  // type, no amount and no timer appeared (a sell arrow and ₹0). Such a push
  // now re-reads the list instead, and only a whole order (one with its type
  // and amount) is added directly.
  //
  // An order put back in the queue (PENDING_QUEUE: reassigned or declined) is
  // no longer this member's, so it leaves their list.
  useEffect(() => {
    const upsert = (incoming: any) => {
      if (!incoming) return;
      const next: PaymentOrder = incoming.order || incoming;
      const key = orderKey(next);
      if (!key || key === 'undefined') return;
      if (next.status === OrderStatus.PENDING_QUEUE) {
        setOrders((current) => current.filter((o) => orderKey(o) !== key));
        return;
      }
      setOrders((current) => {
        if (current.some((o) => orderKey(o) === key)) return mergeOrders(current, [next]);
        if (isWholeOrder(next)) return [next, ...current];
        refetchSoon();
        return current;
      });
    };

    // The snapshot sent on (re)connect holds only the open buys and sells
    // (PENDING_QUEUE, PROCESSING, PAID). It REPLACED the list, so every time
    // the stream connected or reconnected the completed and disputed orders
    // vanished: History's totals fell to what was open and the Disputed tile
    // emptied. It is merged now, like every other push.
    //
    // An order that moved on while the stream was down (completed, rejected,
    // cancelled) is simply missing from the snapshot, so a merge alone left it
    // on screen as open, with its old status and timer. When the list holds
    // an open order the snapshot does not, the list is re-read.
    const onSnapshot = (payload: any) => {
      const list: PaymentOrder[] = payload?.orders || payload;
      if (!Array.isArray(list)) return;
      const inSnapshot = new Set(list.map(orderKey));
      setOrders((current) => {
        const stale = !payload?.hasMore && current.some((o) =>
          SNAPSHOT_STATES.includes(o.status) && !inSnapshot.has(orderKey(o)));
        if (stale) refetchSoon();
        return mergeOrders(current, list);
      });
    };

    sseService.on('merchant_orders_snapshot', onSnapshot);
    sseService.on(SOCKET_EVENTS.NEW_ORDER, upsert);
    sseService.on('new_order', upsert);
    sseService.on(SOCKET_EVENTS.ORDER_UPDATE, upsert);
    // The player's Paid tap: the payload is the order's own fields (id, status
    // PAID and the reference), so it merges like any update.
    sseService.on('order_paid', upsert);
    return () => {
      sseService.off('merchant_orders_snapshot', onSnapshot);
      sseService.off(SOCKET_EVENTS.NEW_ORDER, upsert);
      sseService.off('new_order', upsert);
      sseService.off(SOCKET_EVENTS.ORDER_UPDATE, upsert);
      sseService.off('order_paid', upsert);
    };
  }, [refetchSoon]);

  const sorted = useMemo(
    () => [...orders].sort((a, b) => {
      const rank = (SORT_RANK[a.status] ?? 9) - (SORT_RANK[b.status] ?? 9);
      if (rank !== 0) return rank;
      return new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime();
    }),
    [orders]
  );

  const counts = useMemo(() => ({
    processing: orders.filter((o) => o.status === OrderStatus.PROCESSING).length,
    paid:       orders.filter((o) => o.status === OrderStatus.PAID).length,
    disputed:   orders.filter((o) => o.status === OrderStatus.DISPUTED).length,
    actionable: orders.filter(needsAction).length,
  }), [orders]);

  const reload = useCallback(() => load(), [load]);
  return { orders: sorted, state, counts, reload };
}
