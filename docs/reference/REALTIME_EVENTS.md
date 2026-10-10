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
- **SSE** — the public stream (`/api/sse/events`), the **player stream** (`/api/sse/player/events`: the public events plus one signed-in player's own, through `realtimeEmitters.emitToPlayer`), and the private staff and merchant streams (`/api/sse/admin/events`, `/api/sse/merchant/events`), fanned out by `global.sseManager`, cross-instance via `startup/realtimeBridge.js`.

**The player app opens no socket (2026-10-10).** Its one live connection is the
public or the player stream, and what it used to ask over the socket
(`request_cycle_snapshot`, `request_cycle_history`, `request_branding`,
`request_system_config`, `request_promo`, `watch_cycle`, `join_user_room`) is
either sent when the stream opens or asked over HTTP; those socket handlers are
deleted. No panel opens a socket now, so a "socket.io" row below names a
transport that reaches no client.
- **emitter** — `domains/notification/realtimeEmitters.js` (`emitOrderUpdate` / `emitMerchantUpdate` / `emitAdminUpdate`), which routes to the right room/stream for the recipient.

### Cycle & game

| Event | Transport | Direction | Emitted from |
|---|---|---|---|
| `new_cycle` | SSE + socket.io (public) | server→client | `cycleGenerator.service.js` |
| `cycle_snapshot` | SSE + socket.io (public) | server→client | `cycleGenerator.service.js` (each new round), `sse.routes.js` (when a stream opens, both audiences) |
| `cycle_phase` | SSE + socket.io (public) | server→client | Compact v2 (below). `realtimeEmitters.emitCyclePhase`, from `cycleGenerator.service.js` and `cycles.admin.routes.js` |
| `cycle_result` | SSE + socket.io (public) | server→client, server→admin | Compact v2 (below). `realtimeEmitters.emitCycleResult`, from `cycleGenerator.service.js` and `cycles.admin.routes.js` (forced) |
| `cycle_history` | SSE + socket.io (public) | server→client | `cycleGenerator.service.js` (after each result), `sse.routes.js` (when a stream opens). A deeper window is `GET /api/v1/game/cycles/history`. |
| `game_state` | socket.io | server→client | `startup/socketHandlers.js` |
| `phantom_equalized` | socket.io | server→client | `cycleGenerator.service.js`, `cycles.admin.routes.js` |
| `bet_placed` | **SSE only** (server→client) + socket.io (server→**admin** room) | The player app's ONLY live-pool feed since 2026-10-10 (it opens no socket): coalesced, ≤1 per live cycle per second. Do not delete it. | `cycleSnapshotPublisher.js` (coalesced), `markets/bet.routes.js` (admin) |
| `pool_update` | socket.io, room `cycle:<cycleId>` | server→watchers of that cycle | **No watcher since 2026-10-10**: `watch_cycle` went with the player app's socket; the SSE `bet_placed` carries the same totals. Goes with socket.io itself. The canonical coalesced pool snapshot, ≤1 per live cycle per second. From the merge until the result it carries `poolsHidden: true` and `totalPool` only (as do `cycle_snapshot` and the SSE `bet_placed`; `cyclePublicView.poolsHidden`). | `cycleSnapshotPublisher.js` |
| `admin_bet_placed` | socket.io | server→admin | `markets/bet.routes.js` |
| `payout_success` | SSE, player stream | server→user | `realtimeEmitters.emitPayoutSuccessBatch` → `emitToPlayer` (per-winner wallet credit) |
| `payout_complete` | socket.io | server→client | `gameEngine.js` (cycle payouts finished — distinct from the per-user event above) |

#### Compact lifecycle protocol, v2 (2026-10-09)

Owner: `backend/domains/notification/realtimeProtocol.js`; decoder mirror
`user-panel/src/services/realtimeProtocol.ts`. Same event names, smaller bodies.

| Field | Meaning | Values |
|---|---|---|
| `v` | protocol version | `2`. Adding a field keeps it; renaming, removing or re-coding one raises it. A client drops a payload whose `v` it does not support (the minimum-version gate moves old apps forward); a payload with no `v` is the legacy verbose form and still decodes. |
| `t` | event code | `1` cycle_phase · `2` cycle_result |
| `c` | cycle id | string |
| `k` | board key (the cycle's `type`) | string |
| `a` | audience | `1` VIP · `2` GENERAL |
| `p` | phase (cycle_phase) | `1` OPEN · `2` MERGED · `3` CLOSED · `4` PAUSED · `5` CANCELLED · `6` RESULT_DECLARED · `7` COMPLETED |
| `w` | winner (cycle_result) | `1` DELHI · `2` BOMBAY |
| `d`, `b` | combined Delhi / Bombay pool after the result (cycle_result), rupees | numbers — the same figures the verbose result carried; never a real or phantom pool |
| `ts` | server time | epoch ms |
| `f` | staff forced the result (cycle_result) | `1`, else absent |

Dropped from the wire: the fixed `message` sentence and the ISO timestamp string.
Never on it: anything per side before the result, any private field (the encoder
builds an allowlist and runs `assertPublicCycleSafe`). Per-user and per-cycle data
stays in the `user-<id>` and `cycle:<id>` rooms.

Measured serialized size (`backend/tests/unit/scaling/realtimeProtocol.test.js`
shapes; `bb_realtime_payload_bytes_total / bb_realtime_events_total` live):

| Event | Before (verbose) | After (v2) | Saved |
|---|---|---|---|
| `cycle_phase` MERGED | 155 B | 83 B | 46% |
| `cycle_phase` CLOSED | 173 B | 83 B | 52% |
| `cycle_result` | 202 B | 104 B | 49% |
| One round, one audience (2 phases + result) | 530 B | 270 B | 49% |

Each is sent once per client on each of SSE and socket.io, so per connected
client and round this is ~260 B less per transport, before compression.

### Wallet, user & withdrawals

| Event | Transport | Direction | Emitted from |
|---|---|---|---|
| `user_balance_update` | SSE, player stream | server→user | `realtimeEmitters.emitWalletUpdate`, `sseBalancePush` (every wallet movement; this one was `balance_update` until 2026-10-10, a second name for the same change that no panel heard) |
| `user_update` | SSE, player stream | server→user | `retention.routes.js` (an admin balance adjustment) |
| `new_withdrawal_request` | socket.io | server→admin | `domains/user/user.routes.js` |
| `withdrawal_approved` | socket.io | server→user | `system.admin.routes.js` |
| `withdrawal_rejected` | socket.io | server→user | `system.admin.routes.js` |

### Payment orders (P2P)

| Event | Transport | Direction | Emitted from |
|---|---|---|---|
| `new_order` | emitter | server→merchant | `paymentProcessing.service.js`, `merchant.assignment.routes.js` |
| `order_assigned` | emitter (as `order_update` with `event: 'order_assigned'` to the player) | server→user | `merchant.routes.js`, `merchant.assignment.routes.js` |
| `order_paid` | emitter | server→merchant | `paymentProcessing.service.js` — listened for by the merchant panel since 2026-10-01; before that it was sent and never delivered |
| `order_update` | emitter (merchant SSE) + player stream (`emitToPlayer`; `event` names what happened) | server→user/merchant | `merchant.routes.js`, `disputeResolution.admin.routes.js`, `paymentProcessing.service.js` (a moved UTR deadline — this was the unregistered typo `order_updated` until 2026-10-01), `rejectedBuyWindow.service.js` (a rejected buy's window closed: CANCELLED, 2c+) |
| `order_completed` | emitter (as `order_update` with `event: 'order_completed'` to the player) | server→user | `merchant.routes.js`, `paymentOrder.routes.js` |
| `order_rejected` | emitter (to the player it arrives as `order_update` with `event: 'order_rejected'`, which is what the player panel listens to) | server→user | `merchant.routes.js` — carries `status: 'REJECTED'` and `disputeUntil` since 2c+ (2026-10-03); the player panel's `RejectedBuyPopup` counts down to it |
| `order_expired` | emitter (as `order_update` with `event: 'order_expired'` to the player) | server→user | `paymentProcessing.service.js` |
| `order_red_flagged` | SSE | server→admin | `merchant.routes.js` |
| `queue_order_update` | SSE | server→admin | `disputeResolution.admin.routes.js` and others |
| `queue_snapshot` | SSE | server→admin | on connect to the admin stream |
| `merchant_orders_snapshot` | SSE | server→merchant | on connect to the merchant stream |

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
| `branding` | SSE + socket.io | server→client | `sse.routes.js` (when a stream opens), `brandingPayload.broadcastBranding` |
| `branding_updated` | SSE + socket.io | server→client | `brandingPayload.broadcastBranding` (an admin save) |
| `system_config` | SSE + socket.io | server→client | `sse.routes.js` (when a stream opens), `system.admin.routes.js` (an admin save); always `systemConfigPayload` |
| `deposit_policy_updated` | socket.io + SSE | server→admin | `depositPolicy.admin.routes.js` |

`promo_data` (socket.io, `request_promo`'s answer) was removed 2026-10-10 with the player app's socket; promos are `GET /api/v1/content/promo/:location`.

### Chat & support

| Event | Transport | Direction | Emitted from |
|---|---|---|---|
| `new_chat_message` | socket.io | server→participants | `merchant.routes.js` |
| `chat_message_deleted` | socket.io | server→participants | `chat.admin.routes.js` |
| `chat_banned` | SSE, player stream | server→user | `chat.admin.routes.js` |
| `support_reply` | SSE, player stream | server→user | `chat.admin.routes.js`, `disputeResolution.admin.routes.js` |

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
