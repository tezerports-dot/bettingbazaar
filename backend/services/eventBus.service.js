// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * eventBus.service.js — Internal domain event bus.
 *
 * ARCHITECTURE
 * ─────────────
 *   HTTP requests  → route handlers (commands)
 *   Domain events  → eventBus.publish()  (this file)
 *   Realtime push  → sseManager.service.js  (one-way server → client)
 *   External push  → webhooks (client → server)
 *   Bidirectional  → Socket.IO (game broadcasts, future public chat)
 *
 * FUTURE SWAP (zero call-site changes required)
 *   Replace EventEmitter with Kafka:      swap publish/subscribe implementations
 *   Replace with NATS:                    same swap pattern
 *   Replace with Redis Streams:           same swap pattern
 *   Enable CQRS:                          commands stay in route handlers,
 *                                         projections subscribe to events here
 *
 * USAGE
 *   import { publish, subscribe, EVENTS } from '../services/eventBus.service.js';
 *
 *   // Emit after a payment order completes:
 *   publish(EVENTS.PAYMENT_ORDER_COMPLETED, { orderId, userId, amount });
 *
 *   // React to the event anywhere in the codebase:
 *   subscribe(EVENTS.PAYMENT_ORDER_COMPLETED, ({ payload }) => {
 *     emitWalletUpdate(payload.userId);
 *   });
 */

import { EventEmitter } from 'events';
// CAP-74: external event-backbone seam. forward() is a no-op unless a driver
// (e.g. Kafka) is attached via KAFKA_BROKERS — so this import costs nothing in
// the monolith and never affects in-process delivery.
import { forward as forwardToBackbone } from './eventBackbone.js';

const _bus = new EventEmitter();
_bus.setMaxListeners(200); // allow many subscribers across domains

// ── Event catalog ─────────────────────────────────────────────────────────────
// ALL domain events must be declared here.
// Consumers import EVENTS.* — never use raw string literals.
export const EVENTS = Object.freeze({

  // ── Payment domain ────────────────────────────────────────────────────────
  PAYMENT_ORDER_CREATED:    'payment.order.created',
  PAYMENT_ORDER_ASSIGNED:   'payment.order.assigned',
  PAYMENT_ORDER_PAID:       'payment.order.paid',
  PAYMENT_ORDER_COMPLETED:  'payment.order.completed',
  PAYMENT_ORDER_DISPUTED:   'payment.order.disputed',
  PAYMENT_ORDER_CANCELLED:  'payment.order.cancelled',
  PAYMENT_ORDER_EXPIRED:    'payment.order.expired',
  PAYMENT_ORDER_REJECTED:   'payment.order.rejected',

  // ── Wallet domain ─────────────────────────────────────────────────────────
  WALLET_CREDITED:          'wallet.credited',
  WALLET_DEBITED:           'wallet.debited',
  WALLET_RESERVE_ALLOCATED: 'wallet.reserve.allocated',

  // ── Betting domain ────────────────────────────────────────────────────────
  BET_PLACED:               'bet.placed',
  BET_SETTLED:              'bet.settled',
  BET_CANCELLED:            'bet.cancelled',

  // ── Casino domain (future — gated behind LIVE_CASINO feature flag) ────────
  CASINO_SESSION_STARTED:   'casino.session.started',
  CASINO_SESSION_ENDED:     'casino.session.ended',
  CASINO_GAME_RESULT:       'casino.game.result',
  CASINO_BALANCE_UPDATED:   'casino.balance.updated',

  // ── Sportsbook domain (future — gated behind SPORTSBOOK feature flag) ─────
  ODDS_UPDATED:             'sportsbook.odds.updated',
  MATCH_STARTED:            'sportsbook.match.started',
  MATCH_COMPLETED:          'sportsbook.match.completed',
  BET_SETTLED_SPORTS:       'sportsbook.bet.settled',

  // ── Notifications ─────────────────────────────────────────────────────────
  NOTIFICATION_CREATED:     'notification.created',

  // ── User / KYC ───────────────────────────────────────────────────────────
  USER_BLOCKED:             'user.blocked',
  KYC_APPROVED:             'kyc.approved',
  KYC_REJECTED:             'kyc.rejected',

  // ── System ───────────────────────────────────────────────────────────────
  MAINTENANCE_MODE_CHANGED: 'system.maintenance.changed',
  FEATURE_FLAG_CHANGED:     'system.feature_flag.changed',
});

/**
 * Publish a domain event.
 * @param {string} event    One of EVENTS.*
 * @param {object} payload  Event data
 */
export function publish(event, payload) {
  const envelope = { event, payload, ts: Date.now() };
  _bus.emit(event, envelope);
  // Also emit wildcard for logging / audit subscribers
  _bus.emit('*', envelope);
  // CAP-74: fan out to the external backbone (Kafka/etc.). No-op unless a driver
  // is attached; guarded internally so a backbone outage can't break publishing.
  forwardToBackbone(envelope);
}

/**
 * Subscribe to a domain event.
 * @param {string}   event    One of EVENTS.* or '*' for all
 * @param {function} handler  Called with { event, payload, ts }
 * @returns {function}        Unsubscribe function
 */
export function subscribe(event, handler) {
  _bus.on(event, handler);
  return () => _bus.off(event, handler);
}

/**
 * Subscribe to an event once, returns a Promise.
 * @returns {Promise<{event, payload, ts}>}
 */
export function once(event) {
  return new Promise(resolve => _bus.once(event, resolve));
}

/** Remove all listeners (for test isolation). */
export function reset() { _bus.removeAllListeners(); }
