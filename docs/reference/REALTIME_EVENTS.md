# Realtime event registry

> **This document holds data and history, never rules.** Every rule lives in
> `CLAUDE.md`, which is the single rules file and outranks this document.
> Extracted from the former `CLAUDE.md` on 2026-09-09.

The rule that governs this registry is `CLAUDE.md` §12: one name per logical
change, unique across all three transports, and **any new event is added here in
the same change that introduces it**.

Every realtime event the backend emits, across all three transports. **One name
per logical change.** Any new event must be added here in the same PR that
introduces it.

> **Regenerated 2026-07-27 from the code.** The previous table had drifted in
> both directions: it listed three names the backend never emits (`cycle_update`,
> `chat_message`, `merchant_stats` — the merchant panel was subscribed to that
> last one, receiving nothing) and omitted roughly twenty names that are emitted.
> A registry that is wrong is worse than no registry, because §4 tells you to
> grep it before adding an event. Re-derive it with:
> `grep -rhoE "\.emit\(\s*'[a-z_]+'" backend --include='*.js'` plus the
> `broadcastTo*` and `emit(Order|Merchant|Admin)Update` call sites.

**Three transports, one namespace.** Names are unique across all three — never
reuse a name on a different transport for a different meaning.

- **socket.io** — public, browser-connected clients (`startup/socketHandlers.js`).
- **SSE** — private authenticated streams (`/api/sse/admin/events`, `/api/sse/merchant/events`), fanned out by `global.sseManager`, cross-instance via `startup/realtimeBridge.js`.
- **emitter** — `domains/notification/realtimeEmitters.js` (`emitOrderUpdate` / `emitMerchantUpdate` / `emitAdminUpdate`), which routes to the right room/stream for the recipient.

### Cycle & game

| Event | Transport | Direction | Emitted from |
|---|---|---|---|
| `new_cycle` | socket.io | server→client | `cycleGenerator.service.js` |
| `cycle_snapshot` | socket.io | server→client | `cycleGenerator.service.js` |
| `cycle_phase` | socket.io | server→client | `cycles.admin.routes.js` |
| `cycle_result` | socket.io + SSE | server→client, server→admin | `cycles.admin.routes.js` |
| `cycle_history` | socket.io | server→client | `startup/socketHandlers.js` |
| `game_state` | socket.io | server→client | `startup/socketHandlers.js` |
| `phantom_equalized` | socket.io | server→client | `cycleGenerator.service.js`, `cycles.admin.routes.js` |
| `bet_placed` | **SSE only** (server→client) + socket.io (server→**admin** room) | The global socket.io broadcast was removed 2026-08-31. Player clients on a socket use `pool_update` instead; the SSE copy is the ONLY live-pool path for a client whose WebSocket is blocked, and `sseManager` has no room concept to scope it to. Do not "finish the cleanup" by deleting it. | `cycleSnapshotPublisher.js` (coalesced), `markets/bet.routes.js` (admin) |
| `pool_update` | socket.io, room `cycle:<cycleId>` | server→watchers of that cycle | The canonical coalesced pool snapshot, ≤1 per live cycle per second. Requires the client to `watch_cycle`. | `cycleSnapshotPublisher.js` |
| `admin_bet_placed` | socket.io | server→admin | `markets/bet.routes.js` |
| `payout_success` | socket.io | server→user room | `realtimeEmitters.js` (per-winner wallet credit) |
| `payout_complete` | socket.io | server→client | `gameEngine.js` (cycle payouts finished — distinct from the per-user event above) |

### Wallet, user & withdrawals

| Event | Transport | Direction | Emitted from |
|---|---|---|---|
| `user_balance_update` | socket.io | server→user | `realtimeEmitters.js` |
| `user_update` | socket.io | server→admin | `users.admin.routes.js`, `kyc.admin.routes.js` |
| `new_withdrawal_request` | socket.io | server→admin | `domains/user/user.routes.js` |
| `withdrawal_approved` | socket.io | server→user | `system.admin.routes.js` |
| `withdrawal_rejected` | socket.io | server→user | `system.admin.routes.js` |
| `kyc_update` | socket.io | server→admin | `kyc.admin.routes.js` |

### Payment orders (P2P)

| Event | Transport | Direction | Emitted from |
|---|---|---|---|
| `new_order` | emitter | server→merchant | `paymentProcessing.service.js`, `merchant.assignment.routes.js` |
| `order_assigned` | emitter | server→user | `merchant.routes.js`, `merchant.assignment.routes.js` |
| `order_paid` | emitter | server→merchant | `paymentProcessing.service.js` |
| `order_update` | emitter + socket.io | server→user/merchant | `merchant.routes.js`, `disputeResolution.admin.routes.js` |
| `order_completed` | emitter | server→user | `merchant.routes.js`, `paymentOrder.routes.js` |
| `order_rejected` | emitter | server→user | `merchant.routes.js` |
| `order_expired` | emitter | server→user | `paymentProcessing.service.js` |
| `order_red_flagged` | SSE | server→admin | `merchant.routes.js` |
| `queue_order_update` | SSE | server→admin | `disputeResolution.admin.routes.js` and others |
| `queue_snapshot` | SSE | server→admin | on connect to the admin stream |
| `merchant_orders_snapshot` | SSE | server→merchant | on connect to the merchant stream |
| `bulk_payout_completed` | SSE | server→admin | `merchant.routes.js` |

### Merchant lifecycle

| Event | Transport | Direction | Emitted from |
|---|---|---|---|
| `merchant_status_changed` | SSE | server→admin | `merchant.routes.js`, `merchant.admin.routes.js` |
| `merchant_approved` | SSE | server→admin | `merchant.admin.routes.js` |
| `merchant_rejected` | SSE | server→admin | `merchant.admin.routes.js` |
| `merchant_limits_updated` | SSE | server→admin | `merchant.admin.routes.js` |
| `merchant_config_updated` | socket.io | server→merchant | `merchant.admin.routes.js` |
| `merchant_score_update` | emitter | server→merchant | `merchant.routes.js` (after a completed order) |

### Configuration & content

| Event | Transport | Direction | Emitted from |
|---|---|---|---|
| `branding` | socket.io | server→client | `startup/socketHandlers.js` (on connect), `branding.admin.routes.js` |
| `branding_updated` | socket.io | server→client | `branding.admin.routes.js` |
| `system_config` | socket.io + SSE | server→client | `startup/socketHandlers.js`, `system.admin.routes.js` |
| `deposit_policy_updated` | socket.io + SSE | server→admin | `depositPolicy.admin.routes.js` |
| `promo_data` | socket.io | server→client | `startup/socketHandlers.js` |

### Chat & support

| Event | Transport | Direction | Emitted from |
|---|---|---|---|
| `new_chat_message` | socket.io | server→participants | `merchant.routes.js` |
| `chat_message_deleted` | socket.io | server→participants | `chat.admin.routes.js` |
| `chat_banned` | socket.io | server→user | `chat.admin.routes.js` |
| `support_reply` | socket.io | server→user | `chat.admin.routes.js`, `disputeResolution.admin.routes.js` |

### Admin telemetry & plumbing

| Event | Transport | Direction | Emitted from |
|---|---|---|---|
| `admin_stats_update` | socket.io | server→admin | `gameEngine.js` |
| `admin_stats_delta` | socket.io | server→admin | `users.admin.routes.js` |
| `admin_new_cycle` | SSE | server→admin | admin stream |
| `admin_cycle_result` | SSE | server→admin | admin stream |
| `joined_admin_room` | socket.io | server→admin | `startup/socketHandlers.js` (room-join ack) |

Per-order chat also emits a dynamic `chat_<orderId>` channel to the
`order_<orderId>` room — a per-order channel, not a distinct event name.

**Merchant panel `SOCKET_EVENTS.ORDER_UPDATE` must equal `'order_update'`** (H-02 fix). The
constant in `merchant-panel/src/constants.ts` is the canonical value — do not use string
literals in OrderManagement.tsx or any other merchant file.

---
