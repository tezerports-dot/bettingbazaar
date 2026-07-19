// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file.
/**
 * sseEvents.types.ts — Typed catalog of all SSE events.
 *
 * Every SSE event the server can push to clients is defined here.
 * Import SSEEventType to get autocomplete and type-safety on event names.
 *
 * The realtime standard:
 *   SSE     — one-way server push (wallet updates, order status, notifications)
 *   Webhook — external providers push to server  (payment gateways, casino callbacks)
 *   WS      — only for bidirectional: game pool broadcasts, future public chat
 *   HTTP    — all commands (user actions)
 */

// ── Event names ────────────────────────────────────────────────────────────────
export const SSE_EVENTS = {
  // Wallet
  WALLET_UPDATE:            'wallet_update',
  RESERVE_BALANCE_UPDATE:   'reserve_balance_update',

  // Payment Orders
  ORDER_STATUS_CHANGED:     'order_status_changed',
  ORDER_ASSIGNED:           'order_assigned',
  ORDER_COMPLETED:          'order_completed',
  ORDER_EXPIRED:            'order_expired',

  // Merchant panel
  MERCHANT_NEW_ORDER:       'merchant_new_order',
  MERCHANT_ORDER_PAID:      'merchant_order_paid',

  // Admin queue
  ADMIN_QUEUE_UPDATE:       'admin_queue_update',
  ADMIN_NEW_ORDER:          'admin_new_order',

  // Game / Betting
  CYCLE_UPDATE:             'cycle_update',
  BET_RESULT:               'bet_result',

  // Casino (future — LIVE_CASINO flag)
  CASINO_SESSION_EVENT:     'casino_session_event',
  CASINO_BALANCE:           'casino_balance',

  // Sportsbook (future — SPORTSBOOK flag)
  ODDS_UPDATE:              'odds_update',
  MATCH_EVENT:              'match_event',

  // Notifications
  NOTIFICATION:             'notification',
  PUSH_NOTIFICATION:        'push_notification',

  // System
  MAINTENANCE:              'maintenance',
  FEATURE_FLAG:             'feature_flag',
} as const;

export type SSEEventName = typeof SSE_EVENTS[keyof typeof SSE_EVENTS];

// ── Payload types ──────────────────────────────────────────────────────────────

export interface WalletUpdatePayload {
  userId:          string;
  depositBalance:  number;
  winningsBalance: number;
  reserveBalance:  number;
  totalBalance:    number;
  ts:              number;
}

export interface OrderStatusPayload {
  orderId:    string;
  _id:        string;
  status:     string;
  type:       'DEPOSIT' | 'WITHDRAWAL';
  updatedAt:  string;
  ts:         number;
}

export interface CycleUpdatePayload {
  cycleId:     string;
  phase:       string;
  endTime:     number;
  pot:         number;
  ts:          number;
}

export interface NotificationPayload {
  id:      string;
  type:    string;
  title:   string;
  body:    string;
  data?:   Record<string, unknown>;
  ts:      number;
}

// Casino & Sportsbook payloads — defined but not used until flags are enabled.
export interface CasinoSessionPayload {
  providerId: string;
  userId:     string;
  event:      'started' | 'ended' | 'result';
  gameId?:    string;
  amount?:    number;
  ts:         number;
}

export interface OddsUpdatePayload {
  eventId:  string;
  market:   string;
  odds:     Array<{ name: string; odds: number }>;
  ts:       number;
}

// ── Generic SSE envelope ───────────────────────────────────────────────────────
export interface SSEEnvelope<T = unknown> {
  event:   SSEEventName;
  payload: T;
  ts:      number;
}
