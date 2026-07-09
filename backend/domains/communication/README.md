# domains/communication/ — COMMUNICATION PLATFORM (BBEPS Phase 012)

Customer Platforms tier. Replaces channel-specific thinking (e.g.
"Telegram") with a channel-adapter notification engine.

| Capability | Where |
|---|---|
| Notification engine | `communication.service.js` — `notify()` fans out to channels; per-channel failure isolation; never throws into business flows |
| Channels | `channelRegistry.js` — IN_APP live (persists the existing Notification inbox); EMAIL / SMS / PUSH declared inactive adapters (PUSH also gates on FLAGS.PUSH_NOTIFICATIONS) |
| Internal messaging | Existing P2P order chat + system messages (domains/cms + chat routes) — Communication-owned; opportunistic consolidation queued |
| Audit Feed | GET /api/admin/communication/audit-feed (read-only projection over EnhancedAuditLog) |
| Admin Activity Feed | GET /api/admin/communication/admin-activity (per-admin recent actions) |

Single write path: callers use `notify()` — never `Notification.create`
directly (admin.service.js's four sites were rerouted in this slice).
