# Route coverage — which routes any test actually reached

> **GENERATED** by `npm run report:routes` from what `backend/startup/routeCoverage.js` recorded
> while each tier ran. Never edit by hand; re-run the tiers and regenerate.
>
> A hit means a request REACHED the route and was answered. It is not an assertion that the
> answer was right (§35). A route reached only with refusals (4xx) has never been seen doing
> its work, and is listed apart.

## Inputs

| Tier | How it reaches a route | Requests recorded | Recorded at |
|---|---|---|---|
| unit | in-process route test | 236 | 2026-10-01T06:00:40.264Z |
| pg | in-process route test | 1237 | 2026-10-01T06:00:26.036Z |
| e2e | a running server, over HTTP | 166 | 2026-10-01T06:00:50.692Z |
| browser | a running server, over HTTP | 14810 | 2026-10-01T09:40:21.660Z |

Inventory: **335** method+route pairs the server mounts (`browser.jsonl.inventory.json`).

## Summary

| | Routes |
|---|---|
| Mounted by the server | 335 |
| Reached by any tier | 278 |
| **Never reached by anything** | **57** |
| Reached, but only ever REFUSED (no 2xx/3xx anywhere) | 57 |
| Reached only by in-process route tests, never through a running server | 90 |
| Answered a 5xx at least once | 8 |

Per tier (a route can count in several):

| Tier | Reached | Succeeded at least once | Only refused |
|---|---|---|---|
| unit | 2 | 2 | 0 |
| pg | 215 | 141 | 74 |
| e2e | 59 | 44 | 15 |
| browser | 160 | 151 | 9 |

## Never reached by any tier — 57

Nothing in any tier sent a request that this route answered. Each one is either a test that does not
exist yet, or a route nothing needs (§28: read it, do not count it).

### `backend/domains/casino/gameProvider.routes.js` — 3

| Method | Path | Registered at |
|---|---|---|
| POST | `/api/game/admin/game-providers` | `gameProvider.routes.js:479` |
| PUT | `/api/game/admin/game-providers/:key` | `gameProvider.routes.js:389` |
| POST | `/api/game/admin/game-providers/:key/test` | `gameProvider.routes.js:433` |

### `backend/domains/gameRegistry/gameRegistry.routes.js` — 5

| Method | Path | Registered at |
|---|---|---|
| POST | `/api/game/admin/categories` | `gameRegistry.routes.js:207` |
| DELETE | `/api/game/admin/categories/:id` | `gameRegistry.routes.js:242` |
| PUT | `/api/game/admin/categories/:id` | `gameRegistry.routes.js:224` |
| POST | `/api/game/admin/games` | `gameRegistry.routes.js:117` |
| PUT | `/api/game/admin/games/:id` | `gameRegistry.routes.js:153` |

### `backend/domains/identity/playerAuth.routes.js` — 2

| Method | Path | Registered at |
|---|---|---|
| POST | `/api/v1/auth/kyc/resubmit` | `playerAuth.routes.js:345` |
| POST | `/api/v1/auth/login/2fa` | `playerAuth.routes.js:262` |

### `backend/domains/merchant/merchant.routes.js` — 14

| Method | Path | Registered at |
|---|---|---|
| POST | `/api/merchant/2fa/activate` | `merchant.routes.js:483` |
| POST | `/api/merchant/admin-token-orders` | `merchant.routes.js:1132` |
| GET | `/api/merchant/admin-token-orders/quote` | `merchant.routes.js:1110` |
| POST | `/api/merchant/auth/login` | `merchant.routes.js:262` |
| POST | `/api/merchant/auth/login/2fa` | `merchant.routes.js:371` |
| POST | `/api/merchant/auth/signup` | `merchant.routes.js:202` |
| POST | `/api/merchant/cash-links` | `merchant.routes.js:778` |
| DELETE | `/api/merchant/cash-links/:linkId` | `merchant.routes.js:837` |
| POST | `/api/merchant/confirm/:id` | `merchant.routes.js:1522` |
| POST | `/api/merchant/orders/:id/cdm-receipt` | `merchant.routes.js:589` |
| POST | `/api/merchant/orders/:id/red-flag` | `merchant.routes.js:2079` |
| POST | `/api/merchant/orders/:id/reject` | `merchant.routes.js:2279` |
| PUT | `/api/merchant/profile` | `merchant.routes.js:885` |
| POST | `/api/merchant/reject/:id` | `merchant.routes.js:1901` |

### `backend/domains/payment/payment.routes.js` — 3

| Method | Path | Registered at |
|---|---|---|
| GET | `/api/payment/order/:orderId/batch` | `payment.routes.js:491` |
| POST | `/api/payment/order/:orderId/payment-reference` | `payment.routes.js:222` |
| POST | `/api/payment/order/:orderId/retry` | `payment.routes.js:179` |

### `backend/domains/user/user.routes.js` — 7

| Method | Path | Registered at |
|---|---|---|
| GET | `/api/cycles/:cycleId` | `user.routes.js:96` |
| GET | `/api/v1/content/ai-analysis` | `user.routes.js:584` |
| GET | `/api/v1/content/promo/:location` | `user.routes.js:511` |
| GET | `/api/v1/game/cycle/:type/:startTime` | `user.routes.js:112` |
| GET | `/api/v1/system/time` | `user.routes.js:499` |
| GET | `/api/v1/token/rates` | `user.routes.js:756` |
| GET | `/api/v1/tokens/rate` | `user.routes.js:733` |

### `backend/routes.js` — 2

| Method | Path | Registered at |
|---|---|---|
| GET | `/api/v1/auth/health` | `routes.js:462` |
| POST | `/api/v1/auth/logout` | `routes.js:432` |

### `backend/routes/app-bootstrap.routes.js` — 1

| Method | Path | Registered at |
|---|---|---|
| GET | `/api/app/bootstrap` | `app-bootstrap.routes.js:14` |

### `backend/routes/payment-config.routes.js` — 1

| Method | Path | Registered at |
|---|---|---|
| POST | `/api/payment/admin/test-gateway` | `payment-config.routes.js:110` |

### `backend/routes/retention.routes.js` — 3

| Method | Path | Registered at |
|---|---|---|
| PUT | `/api/admin/announcements/:id` | `retention.routes.js:199` |
| GET | `/api/bonuses/my` | `retention.routes.js:236` |
| POST | `/api/leaderboard/rebuild` | `retention.routes.js:70` |

### `backend/routes/sse.routes.js` — 1

| Method | Path | Registered at |
|---|---|---|
| GET | `/api/sse/stats` | `sse.routes.js:284` |

### `backend/routes/upload.routes.js` — 4

| Method | Path | Registered at |
|---|---|---|
| POST | `/api/merchant/cdm-receipt/:orderId/upload-url` | `upload.routes.js:114` |
| POST | `/api/merchant/order-reject-proof/:orderId/upload-url` | `upload.routes.js:63` |
| POST | `/api/user/profile/picture/confirm-upload` | `upload.routes.js:225` |
| POST | `/api/user/profile/picture/upload-url` | `upload.routes.js:203` |

### `backend/routes/winners.routes.js` — 3

| Method | Path | Registered at |
|---|---|---|
| POST | `/api/admin/fake-winners` | `winners.routes.js:68` |
| DELETE | `/api/admin/fake-winners/:id` | `winners.routes.js:115` |
| PUT | `/api/admin/fake-winners/:id` | `winners.routes.js:101` |

### `backend/server.js` — 8

| Method | Path | Registered at |
|---|---|---|
| GET | `/admin/*splat` | `server.js:720` |
| POST | `/api/admin/login/2fa` | `server.js:589` |
| GET | `/api/download/ios` | `server.js:613` |
| POST | `/api/internal/error-report` | `server.js:595` |
| GET | `/health` | `server.js:535` |
| GET | `/health/ready` | `server.js:520` |
| GET | `/merchant/*splat` | `server.js:725` |
| GET | `/metrics` | `server.js:359` |

## Reached, but only ever refused — 57

Every request this route answered, in every tier, was a 4xx. The refusal is tested; the work is not.

| Method | Path | Registered at | What it answered |
|---|---|---|---|
| POST | `/api/admin/app-assets/upload` | `branding.admin.routes.js:351` | pg: 403×1 |
| POST | `/api/admin/branding/cdn-url` | `branding.admin.routes.js:201` | pg: 403×1 |
| POST | `/api/admin/branding/confirm-upload` | `branding.admin.routes.js:255` | pg: 403×1 |
| POST | `/api/admin/branding/images` | `branding.admin.routes.js:119` | pg: 403×1 |
| POST | `/api/admin/branding/upload-url` | `branding.admin.routes.js:229` | pg: 403×1 |
| POST | `/api/admin/chat/ban` | `chat.admin.routes.js:106` | pg: 403×1 |
| DELETE | `/api/admin/chat/ban/:userId` | `chat.admin.routes.js:137` | pg: 403×1 |
| PUT | `/api/admin/content/faq/:faqId` | `content.admin.routes.js:111` | pg: 403×1 |
| POST | `/api/admin/cycles/:cycleId/equalize` | `cycles.admin.routes.js:146` | pg: 403×1 |
| PUT | `/api/admin/deposit-policy/:currency` | `depositPolicy.admin.routes.js:88` | pg: 403×1 |
| POST | `/api/admin/deposit-policy/version/:versionId/approve` | `depositPolicy.admin.routes.js:149` | pg: 403×1 |
| POST | `/api/admin/deposit-policy/version/:versionId/rollback` | `depositPolicy.admin.routes.js:185` | pg: 403×1 |
| GET | `/api/admin/dispute-orders/:orderId` | `disputeResolution.admin.routes.js:188` | pg: 403×1 404×1 |
| POST | `/api/admin/dispute-orders/:orderId/chat` | `disputeResolution.admin.routes.js:211` | pg: 403×1 |
| POST | `/api/admin/dispute-orders/:orderId/escalate` | `disputeResolution.admin.routes.js:453` | pg: 403×1 |
| DELETE | `/api/admin/error-reports` | `system.admin.routes.js:568` | pg: 403×1 |
| GET | `/api/admin/kyc/bulk/export` | `telegram.admin.routes.js:486` | pg: 403×1 404×1 |
| POST | `/api/admin/kyc/bulk/import` | `telegram.admin.routes.js:508` | pg: 403×1 |
| POST | `/api/admin/login` | `server.js:580` | browser: 401×2 |
| POST | `/api/admin/merchant-commission-policy/version/:versionId/rollback` | `merchantCommissionPolicy.admin.routes.js:88` | pg: 403×1 |
| GET | `/api/admin/merchant-platform/:merchantId/funding-stats` | `merchantPlatform.admin.routes.js:35` | pg: 403×1 404×1 |
| GET | `/api/admin/merchants/:merchantId` | `merchant.admin.routes.js:149` | pg: 403×1 404×1 |
| GET | `/api/admin/merchants/:merchantId/earnings` | `merchant.admin.routes.js:411` | pg: 403×1 404×1 |
| PUT | `/api/admin/merchants/:merchantId/panel-url` | `merchant.admin.routes.js:1175` | pg: 403×1 |
| PUT | `/api/admin/merchants/:merchantId/scoring` | `merchant.assignment.routes.js:634` | pg: 403×1 |
| POST | `/api/admin/merchants/create` | `merchant.admin.routes.js:594` | pg: 403×1 |
| POST | `/api/admin/operations/retention/run` | `operations.admin.routes.js:161` | pg: 403×1 |
| POST | `/api/admin/payment-orders/:id/reassign` | `merchant.assignment.routes.js:169` | pg: 403×2 404×2 |
| POST | `/api/admin/promo` | `content.admin.routes.js:270` | pg: 403×1 |
| DELETE | `/api/admin/promo/:id` | `content.admin.routes.js:344` | pg: 403×1 |
| PUT | `/api/admin/promo/:id` | `content.admin.routes.js:309` | pg: 403×1 |
| POST | `/api/admin/promo/upload-url` | `content.admin.routes.js:229` | pg: 400×9 401×1 403×2 503×2 |
| POST | `/api/admin/queue/assign/:orderId` | `merchant.assignment.routes.js:549` | pg: 403×2 404×2 |
| PUT | `/api/admin/queue/merchant-pool` | `merchant.assignment.routes.js:432` | pg: 400×2 403×2 |
| POST | `/api/admin/referral/disburse` | `telegram.admin.routes.js:555` | pg: 403×1; e2e: 409×1; browser: 409×1 |
| POST | `/api/admin/revenue/bonus-pool/fund` | `revenue.admin.routes.js:80` | pg: 403×1; browser: 400×1 |
| GET | `/api/admin/support/documents` | `support.admin.routes.js:54` | pg: 403×1 503×1; browser: 503×17 |
| DELETE | `/api/admin/support/documents/:docId` | `support.admin.routes.js:59` | pg: 403×1 |
| POST | `/api/admin/support/ingest` | `support.admin.routes.js:36` | pg: 403×1 |
| POST | `/api/admin/support/ingest/knowledge-base` | `support.admin.routes.js:31` | pg: 403×1; browser: 503×1 |
| GET | `/api/admin/support/tickets/:id` | `chat.admin.routes.js:180` | pg: 403×1 404×1 |
| POST | `/api/admin/support/tickets/:id/reply` | `chat.admin.routes.js:204` | pg: 403×1 |
| POST | `/api/admin/telegram/bots` | `telegram.admin.routes.js:364` | pg: 403×1 |
| POST | `/api/admin/telegram/bots/:id/promote` | `telegram.admin.routes.js:387` | pg: 403×1 |
| POST | `/api/admin/telegram/bots/:id/retire` | `telegram.admin.routes.js:419` | pg: 403×1; browser: 409×6 |
| POST | `/api/admin/telegram/bots/:id/webhook` | `telegram.admin.routes.js:409` | pg: 403×1; browser: 502×6 |
| POST | `/api/admin/telegram/channel` | `telegram.admin.routes.js:254` | pg: 403×1 |
| POST | `/api/admin/telegram/config` | `telegram.admin.routes.js:142` | pg: 403×1; browser: 400×1 |
| POST | `/api/admin/users/:userId/phantom-access` | `users.admin.routes.js:487` | pg: 403×1 |
| POST | `/api/admin/users/:userId/queue-manager` | `users.admin.routes.js:566` | pg: 403×1 |
| POST | `/api/game/launch` | `gameProvider.routes.js:138` | browser: 400×36 |
| POST | `/api/game/wallet/:providerKey` | `gameProvider.routes.js:284` | e2e: 404×2 |
| POST | `/api/payment/order/cancel` | `payment.routes.js:536` | pg: 401×1 |
| POST | `/api/support/ask` | `support.routes.js:68` | pg: 429×2 503×11 |
| POST | `/api/telegram/recovery/webhook/:botId` | `telegram.routes.js:518` | e2e: 401×1 |
| GET | `/api/user/:userId/bets` | `user.routes.js:166` | e2e: 403×1 |
| GET | `/api/user/:userId/transactions` | `user.routes.js:438` | e2e: 403×1 |

## Reached only by in-process route tests — 90

A route test mounts the router on its own. Nothing reached these through the real server, its
middleware stack and its mounts — the way a panel reaches them.

| Method | Path | Registered at | What it answered |
|---|---|---|---|
| GET | `/.well-known/assetlinks.json` | `wellKnown.routes.js:54` | unit: 200×4 404×3 |
| POST | `/api/2fa/activate` | `twoFactor.routes.js:123` | pg: 200×6 400×2 |
| POST | `/api/2fa/disable` | `twoFactor.routes.js:184` | pg: 200×1 400×1 403×1 |
| POST | `/api/2fa/setup` | `twoFactor.routes.js:90` | pg: 200×8 401×1 409×1 |
| POST | `/api/admin/android/releases` | `androidRelease.admin.routes.js:72` | pg: 201×16 400×9 403×2 |
| DELETE | `/api/admin/android/releases/:id` | `androidRelease.admin.routes.js:237` | pg: 200×4 403×1 409×1 |
| PATCH | `/api/admin/android/releases/:id` | `androidRelease.admin.routes.js:146` | pg: 200×3 403×1 |
| POST | `/api/admin/android/releases/:id/halt` | `androidRelease.admin.routes.js:201` | pg: 200×3 400×1 403×1 409×1 |
| POST | `/api/admin/android/releases/:id/publish` | `androidRelease.admin.routes.js:170` | pg: 200×9 403×1 409×4 |
| POST | `/api/admin/android/releases/:id/resume` | `androidRelease.admin.routes.js:225` | pg: 200×3 403×1 409×1 |
| POST | `/api/admin/app-assets/upload` | `branding.admin.routes.js:351` | pg: 403×1 |
| POST | `/api/admin/branding/cdn-url` | `branding.admin.routes.js:201` | pg: 403×1 |
| POST | `/api/admin/branding/confirm-upload` | `branding.admin.routes.js:255` | pg: 403×1 |
| POST | `/api/admin/branding/images` | `branding.admin.routes.js:119` | pg: 403×1 |
| POST | `/api/admin/branding/upload-url` | `branding.admin.routes.js:229` | pg: 403×1 |
| POST | `/api/admin/chat/ban` | `chat.admin.routes.js:106` | pg: 403×1 |
| DELETE | `/api/admin/chat/ban/:userId` | `chat.admin.routes.js:137` | pg: 403×1 |
| PUT | `/api/admin/content/faq/:faqId` | `content.admin.routes.js:111` | pg: 403×1 |
| POST | `/api/admin/cycles/:cycleId/equalize` | `cycles.admin.routes.js:146` | pg: 403×1 |
| PUT | `/api/admin/deposit-policy/:currency` | `depositPolicy.admin.routes.js:88` | pg: 403×1 |
| POST | `/api/admin/deposit-policy/version/:versionId/approve` | `depositPolicy.admin.routes.js:149` | pg: 403×1 |
| POST | `/api/admin/deposit-policy/version/:versionId/rollback` | `depositPolicy.admin.routes.js:185` | pg: 403×1 |
| GET | `/api/admin/dispute-orders/:orderId` | `disputeResolution.admin.routes.js:188` | pg: 403×1 404×1 |
| GET | `/api/admin/dispute-orders/:orderId/chat` | `disputeResolution.admin.routes.js:201` | pg: 200×1 403×1 |
| POST | `/api/admin/dispute-orders/:orderId/chat` | `disputeResolution.admin.routes.js:211` | pg: 403×1 |
| POST | `/api/admin/dispute-orders/:orderId/escalate` | `disputeResolution.admin.routes.js:453` | pg: 403×1 |
| DELETE | `/api/admin/error-reports` | `system.admin.routes.js:568` | pg: 403×1 |
| GET | `/api/admin/kyc/bulk/export` | `telegram.admin.routes.js:486` | pg: 403×1 404×1 |
| POST | `/api/admin/kyc/bulk/import` | `telegram.admin.routes.js:508` | pg: 403×1 |
| POST | `/api/admin/manage-cycle` | `cycles.admin.routes.js:223` | pg: 200×1 403×1 |
| POST | `/api/admin/merchant-commission-policy/version/:versionId/rollback` | `merchantCommissionPolicy.admin.routes.js:88` | pg: 403×1 |
| GET | `/api/admin/merchant-platform/:merchantId/funding-stats` | `merchantPlatform.admin.routes.js:35` | pg: 403×1 404×1 |
| GET | `/api/admin/merchant-platform/:merchantId/performance-history` | `merchantPlatform.admin.routes.js:49` | pg: 200×1 403×1 |
| GET | `/api/admin/merchant-platform/:merchantId/wallet-ledger` | `merchantPlatform.admin.routes.js:61` | pg: 200×1 403×1 |
| GET | `/api/admin/merchants/:merchantId` | `merchant.admin.routes.js:149` | pg: 403×1 404×1 |
| PUT | `/api/admin/merchants/:merchantId/activate` | `merchant.admin.routes.js:191` | pg: 200×1 403×1 |
| GET | `/api/admin/merchants/:merchantId/earnings` | `merchant.admin.routes.js:411` | pg: 403×1 404×1 |
| PUT | `/api/admin/merchants/:merchantId/limits` | `merchant.admin.routes.js:234` | pg: 200×2 400×2 403×2 409×1 |
| PUT | `/api/admin/merchants/:merchantId/panel-url` | `merchant.admin.routes.js:1175` | pg: 403×1 |
| GET | `/api/admin/merchants/:merchantId/profit-engine` | `merchant.admin.routes.js:1232` | pg: 200×1 403×1 404×1 |
| PUT | `/api/admin/merchants/:merchantId/scoring` | `merchant.assignment.routes.js:634` | pg: 403×1 |
| POST | `/api/admin/merchants/create` | `merchant.admin.routes.js:594` | pg: 403×1 |
| POST | `/api/admin/operations/retention/run` | `operations.admin.routes.js:161` | pg: 403×1 |
| GET | `/api/admin/orders/:orderId/cdm-receipt` | `disputeResolution.admin.routes.js:44` | pg: 200×4 403×2 |
| POST | `/api/admin/payment-orders/:id/reassign` | `merchant.assignment.routes.js:169` | pg: 403×2 404×2 |
| POST | `/api/admin/payment-orders/:orderId/action` | `paymentOrder.routes.js:44` | pg: 200×10 400×2 403×1 |
| POST | `/api/admin/promo` | `content.admin.routes.js:270` | pg: 403×1 |
| DELETE | `/api/admin/promo/:id` | `content.admin.routes.js:344` | pg: 403×1 |
| PUT | `/api/admin/promo/:id` | `content.admin.routes.js:309` | pg: 403×1 |
| POST | `/api/admin/promo/upload-url` | `content.admin.routes.js:229` | pg: 400×9 401×1 403×2 503×2 |
| POST | `/api/admin/queue/assign/:orderId` | `merchant.assignment.routes.js:549` | pg: 403×2 404×2 |
| PUT | `/api/admin/queue/merchant-pool` | `merchant.assignment.routes.js:432` | pg: 400×2 403×2 |
| POST | `/api/admin/sub-admins` | `subadmins.admin.routes.js:80` | pg: 200×9 400×4 401×1 403×2 |
| PUT | `/api/admin/sub-admins/:subAdminId/permissions` | `subadmins.admin.routes.js:146` | pg: 200×4 400×5 401×1 403×1 404×1 |
| DELETE | `/api/admin/support/documents/:docId` | `support.admin.routes.js:59` | pg: 403×1 |
| POST | `/api/admin/support/ingest` | `support.admin.routes.js:36` | pg: 403×1 |
| GET | `/api/admin/support/tickets/:id` | `chat.admin.routes.js:180` | pg: 403×1 404×1 |
| POST | `/api/admin/support/tickets/:id/reply` | `chat.admin.routes.js:204` | pg: 403×1 |
| POST | `/api/admin/telegram/bots` | `telegram.admin.routes.js:364` | pg: 403×1 |
| POST | `/api/admin/telegram/bots/:id/promote` | `telegram.admin.routes.js:387` | pg: 403×1 |
| POST | `/api/admin/telegram/channel` | `telegram.admin.routes.js:254` | pg: 403×1 |
| DELETE | `/api/admin/users/:userId` | `users.admin.routes.js:404` | pg: 200×1 403×1 409×2 |
| GET | `/api/admin/users/:userId` | `users.admin.routes.js:204` | pg: 200×1 403×1 404×2 |
| POST | `/api/admin/users/:userId/clear-flag` | `users.admin.routes.js:177` | pg: 200×4 403×2 404×1 |
| POST | `/api/admin/users/:userId/phantom-access` | `users.admin.routes.js:487` | pg: 403×1 |
| POST | `/api/admin/users/:userId/queue-manager` | `users.admin.routes.js:566` | pg: 403×1 |
| PUT | `/api/admin/users/:userId/roles` | `users.admin.routes.js:242` | pg: 200×1 403×1 |
| GET | `/api/admin/utr-registry` | `utr.admin.routes.js:30` | pg: 200×4 401×1 403×2 |
| GET | `/api/admin/utr-registry/:utr` | `utr.admin.routes.js:48` | pg: 200×1 403×1 404×2 |
| PUT | `/api/admin/utr-registry/:utr/clear` | `utr.admin.routes.js:94` | pg: 200×2 403×1 404×1 |
| PUT | `/api/admin/utr-registry/:utr/flag` | `utr.admin.routes.js:66` | pg: 200×7 400×4 401×1 403×2 404×1 |
| GET | `/api/admin/utr/contested` | `utr.admin.routes.js:144` | pg: 200×6 403×1 |
| GET | `/api/admin/utr/flagged` | `utr.admin.routes.js:110` | pg: 200×2 403×1 |
| POST | `/api/admin/utr/resolve/:orderId` | `utr.admin.routes.js:190` | pg: 200×5 400×5 401×1 403×1 404×1 409×1 |
| GET | `/api/admin/utr/stats` | `utr.admin.routes.js:160` | pg: 200×3 401×1 403×1 |
| GET | `/api/admin/utr/user-history/:userId` | `utr.admin.routes.js:170` | pg: 200×2 403×1 |
| GET | `/api/app/android/update` | `androidRelease.routes.js:20` | pg: 200×18 |
| GET | `/api/download/android` | `androidRelease.routes.js:39` | pg: 302×2 404×1 |
| POST | `/api/payment/deposit/:orderId/confirm` | `payment.routes.js:292` | pg: 200×13 400×3 403×1 404×5 409×3 |
| GET | `/api/payment/order/:orderId/status` | `payment.routes.js:545` | pg: 200×4 401×2 404×2 |
| POST | `/api/payment/order/:orderId/utr-grace` | `payment.routes.js:233` | pg: 200×5 400×1 404×1 409×3 |
| POST | `/api/payment/order/cancel` | `payment.routes.js:536` | pg: 401×1 |
| POST | `/api/support/ask` | `support.routes.js:68` | pg: 429×2 503×11 |
| POST | `/api/support/tickets` | `support.routes.js:108` | pg: 200×15 400×2 401×1 429×3 |
| GET | `/api/support/tickets/:ticketId` | `support.routes.js:149` | pg: 200×1 401×1 404×1 |
| POST | `/api/support/tickets/:ticketId/reply` | `support.routes.js:161` | pg: 200×2 400×4 401×1 404×1 |
| POST | `/api/user/notifications/read` | `user.routes.js:829` | pg: 200×5 400×1 401×1 |
| GET | `/api/v1/auth/invite/:code` | `playerAuth.routes.js:278` | pg: 200×3 |
| POST | `/api/v1/auth/register` | `playerAuth.routes.js:138` | pg: 200×14 400×7 409×2 |
| GET | `/r/:code` | `referralRedirect.routes.js:51` | unit: 302×12 503×1 |

## Answered a 5xx at least once — 8

Some of these are tests provoking a failure on purpose. Each is still worth reading: a 5xx a
browser pass hit is a screen that broke.

| Method | Path | Registered at | What it answered |
|---|---|---|---|
| POST | `/api/admin/promo/upload-url` | `content.admin.routes.js:229` | pg: 400×9 401×1 403×2 503×2 |
| GET | `/api/admin/support/documents` | `support.admin.routes.js:54` | pg: 403×1 503×1; browser: 503×17 |
| POST | `/api/admin/support/ingest/knowledge-base` | `support.admin.routes.js:31` | pg: 403×1; browser: 503×1 |
| POST | `/api/admin/telegram/bots/:id/webhook` | `telegram.admin.routes.js:409` | pg: 403×1; browser: 502×6 |
| POST | `/api/bet/place` | `bet.routes.js:88` | pg: 200×6 400×3 500×1; e2e: 200×5 400×9; browser: 200×1 |
| POST | `/api/support/ask` | `support.routes.js:68` | pg: 429×2 503×11 |
| GET | `/api/v1/system/config` | `user.routes.js:483` | e2e: 200×7 500×1; browser: 200×1093 304×10 |
| GET | `/r/:code` | `referralRedirect.routes.js:51` | unit: 302×12 503×1 |

## Client methods no screen calls — 20

A method in a panel's API client that nothing else in that panel names. `check:ui-coverage` counts
its request as reaching a route; no person can make it. Each is either a feature with no button
(wire it) or code nothing needs (delete it, §30).

| Panel | Method | Requests |
|---|---|---|
| user-panel | `getAIAnalysis` | `/v1/content/ai-analysis` |
| user-panel | `subscribeToTicker` | — |
| user-panel | `subscribeToAdminNotifications` | — |
| user-panel | `subscribeToChat` | — |
| user-panel | `getBetHistory` | — |
| user-panel | `getTransactionHistory` | — |
| user-panel | `getWinners` | `/v1/winners?period=${period}&limit=${limit}` |
| user-panel | `getPromoContent` | — |
| user-panel | `uploadImage` | — |
| user-panel | `getServerTime` | `/v1/system/time` |
| admin-panel | `getById` | `/api/admin/users/${userId}` |
| admin-panel | `updateRoles` | `/api/admin/users/${userId}/roles` |
| admin-panel | `deleteUser` | `/api/admin/users/${userId}` |
| admin-panel | `uploadLogo` | `/api/admin/branding/upload-url` |
| admin-panel | `uploadImage` | `/api/admin/branding/upload-url` |
| admin-panel | `getOne` | `/api/admin/dispute-orders/${id}` |
| admin-panel | `getStats` | `/api/admin/utr/stats` |
| admin-panel | `getUserHistory` | `/api/admin/utr/user-history/${userId}` |
| merchant-panel | `clearAuthData` | — |
| merchant-panel | `setMerchantData` | — |

## Every route

| Method | Path | unit | pg | e2e | browser |
|---|---|---|---|---|---|
| GET | `/.well-known/assetlinks.json` | 4✓ 3✗ | · | · | · |
| GET | `/{*splat}` | · | · | 1✓ | · |
| OPTIONS | `/{*splat}` | · | · | · | 3924✓ |
| GET | `/admin/*splat` | · | · | · | · |
| POST | `/api/2fa/activate` | · | 6✓ 2✗ | · | · |
| POST | `/api/2fa/disable` | · | 1✓ 2✗ | · | · |
| POST | `/api/2fa/setup` | · | 8✓ 2✗ | · | · |
| GET | `/api/2fa/status` | · | 4✓ 1✗ | · | 22✓ |
| GET | `/api/admin/analytics/dashboard` | · | 1✓ 1✗ | · | 1690✓ 8✗ |
| GET | `/api/admin/analytics/deposit-dashboard` | · | 1✓ 1✗ | · | 25✓ |
| GET | `/api/admin/analytics/financials` | · | 1✓ 1✗ | · | 36✓ |
| GET | `/api/admin/analytics/merchant-funding` | · | 1✓ 1✗ | · | 25✓ |
| GET | `/api/admin/analytics/phantom-stats` | · | 1✓ 1✗ | · | 40✓ 4✗ |
| GET | `/api/admin/analytics/trends` | · | 1✓ 1✗ | · | 25✓ |
| GET | `/api/admin/analytics/withdrawal-dashboard` | · | 1✓ 1✗ | · | 25✓ |
| GET | `/api/admin/android/releases` | · | 7✓ 2✗ | · | 22✓ |
| POST | `/api/admin/android/releases` | · | 16✓ 11✗ | · | · |
| DELETE | `/api/admin/android/releases/:id` | · | 4✓ 2✗ | · | · |
| PATCH | `/api/admin/android/releases/:id` | · | 3✓ 1✗ | · | · |
| POST | `/api/admin/android/releases/:id/halt` | · | 3✓ 3✗ | · | · |
| POST | `/api/admin/android/releases/:id/publish` | · | 9✓ 5✗ | · | · |
| POST | `/api/admin/android/releases/:id/resume` | · | 3✓ 2✗ | · | · |
| GET | `/api/admin/announcements` | · | · | · | 20✓ |
| POST | `/api/admin/announcements` | · | · | 1✓ | · |
| DELETE | `/api/admin/announcements/:id` | · | · | · | 1✓ |
| PUT | `/api/admin/announcements/:id` | · | · | · | · |
| GET | `/api/admin/app-assets` | · | 1✓ 1✗ | · | 21✓ |
| DELETE | `/api/admin/app-assets/:name` | · | 1✗ | · | 1✓ |
| POST | `/api/admin/app-assets/upload` | · | 1✗ | · | · |
| GET | `/api/admin/audit-logs` | · | 1✓ 1✗ | · | 286✓ 8✗ |
| POST | `/api/admin/balance-adjust` | · | 6✓ 19✗ | · | 2✓ |
| GET | `/api/admin/balance-adjustments` | · | · | · | 17✓ |
| GET | `/api/admin/branding` | · | 1✓ 1✗ | 1✓ | 36✓ |
| PUT | `/api/admin/branding` | · | 2✗ | 2✓ | 3✓ |
| POST | `/api/admin/branding/cdn-url` | · | 1✗ | · | · |
| POST | `/api/admin/branding/confirm-upload` | · | 1✗ | · | · |
| GET | `/api/admin/branding/images` | · | 1✓ 1✗ | · | 39✓ |
| POST | `/api/admin/branding/images` | · | 1✗ | · | · |
| DELETE | `/api/admin/branding/images/:imageId` | · | 1✗ | · | 1✓ |
| POST | `/api/admin/branding/upload-url` | · | 1✗ | · | · |
| POST | `/api/admin/chat/ban` | · | 1✗ | · | · |
| DELETE | `/api/admin/chat/ban/:userId` | · | 1✗ | · | · |
| GET | `/api/admin/chat/bans` | · | 1✓ 1✗ | · | 16✓ |
| GET | `/api/admin/chat/messages` | · | 2✓ 1✗ | · | 16✓ |
| POST | `/api/admin/chat/messages/:id/delete` | · | 1✗ | · | 1✓ |
| GET | `/api/admin/communication/admin-activity` | · | 1✓ 1✗ | · | 19✓ 4✗ |
| GET | `/api/admin/communication/audit-feed` | · | 1✓ 1✗ | · | 23✓ |
| GET | `/api/admin/communication/channels` | · | 1✓ 1✗ | · | 23✓ |
| GET | `/api/admin/content/faq` | · | 1✓ 1✗ | · | 55✓ |
| POST | `/api/admin/content/faq` | · | 2✗ | 1✓ | · |
| DELETE | `/api/admin/content/faq/:faqId` | · | 1✗ | · | 1✓ |
| PUT | `/api/admin/content/faq/:faqId` | · | 1✗ | · | · |
| GET | `/api/admin/content/support-links` | · | 1✓ 1✗ | 1✓ | 25✓ |
| PUT | `/api/admin/content/support-links` | · | 2✗ | 2✓ | 3✓ |
| POST | `/api/admin/cycles/:cycleId/equalize` | · | 1✗ | · | · |
| GET | `/api/admin/cycles/history` | · | 1✓ 1✗ | · | 57✓ |
| GET | `/api/admin/cycles/phases` | · | 1✓ 1✗ | · | 57✓ |
| GET | `/api/admin/deposit-policy/:currency` | · | 2✗ | · | 17✓ |
| PUT | `/api/admin/deposit-policy/:currency` | · | 1✗ | · | · |
| GET | `/api/admin/deposit-policy/:currency/history` | · | 2✗ | · | 17✓ |
| POST | `/api/admin/deposit-policy/version/:versionId/approve` | · | 1✗ | · | · |
| POST | `/api/admin/deposit-policy/version/:versionId/rollback` | · | 1✗ | · | · |
| GET | `/api/admin/dispute-orders` | · | 1✓ 1✗ | · | 38✓ |
| GET | `/api/admin/dispute-orders/:orderId` | · | 2✗ | · | · |
| GET | `/api/admin/dispute-orders/:orderId/chat` | · | 1✓ 1✗ | · | · |
| POST | `/api/admin/dispute-orders/:orderId/chat` | · | 1✗ | · | · |
| POST | `/api/admin/dispute-orders/:orderId/escalate` | · | 1✗ | · | · |
| POST | `/api/admin/dispute-orders/:orderId/resolve` | · | 16✓ 11✗ | 1✓ | · |
| DELETE | `/api/admin/error-reports` | · | 1✗ | · | · |
| GET | `/api/admin/error-reports` | · | 1✓ 1✗ | · | 15✓ |
| GET | `/api/admin/fake-winners` | · | · | · | 17✓ |
| POST | `/api/admin/fake-winners` | · | · | · | · |
| DELETE | `/api/admin/fake-winners/:id` | · | · | · | · |
| PUT | `/api/admin/fake-winners/:id` | · | · | · | · |
| POST | `/api/admin/kyc/:userId/approve` | · | 5✓ 4✗ | 1✓ | 2✓ |
| POST | `/api/admin/kyc/:userId/reject` | · | 1✓ 6✗ | 1✓ | 1✓ |
| GET | `/api/admin/kyc/bulk/export` | · | 2✗ | · | · |
| POST | `/api/admin/kyc/bulk/import` | · | 1✗ | · | · |
| GET | `/api/admin/kyc/bulk/stats` | · | 1✓ 1✗ | · | 16✓ |
| GET | `/api/admin/kyc/queue` | · | 3✓ 4✗ | · | 34✓ |
| POST | `/api/admin/login` | · | · | · | 2✗ |
| POST | `/api/admin/login/2fa` | · | · | · | · |
| POST | `/api/admin/manage-cycle` | · | 1✓ 1✗ | · | · |
| GET | `/api/admin/merchant-commission-policy` | · | 1✓ 1✗ | · | 47✓ |
| PUT | `/api/admin/merchant-commission-policy` | · | 1✗ | · | 1✓ |
| GET | `/api/admin/merchant-commission-policy/history` | · | 1✓ 1✗ | · | 47✓ |
| POST | `/api/admin/merchant-commission-policy/version/:versionId/rollback` | · | 1✗ | · | · |
| GET | `/api/admin/merchant-platform/:merchantId/funding-stats` | · | 2✗ | · | · |
| GET | `/api/admin/merchant-platform/:merchantId/performance-history` | · | 1✓ 1✗ | · | · |
| GET | `/api/admin/merchant-platform/:merchantId/wallet-ledger` | · | 1✓ 1✗ | · | · |
| POST | `/api/admin/merchant-platform/commission-engine/run` | · | 1✗ | · | 4✓ |
| GET | `/api/admin/merchant-platform/leaderboard` | · | 1✓ 1✗ | · | 47✓ |
| GET | `/api/admin/merchant-token-orders` | · | 2✓ 1✗ | · | 26✓ |
| POST | `/api/admin/merchant-token-orders/:orderId/approve` | · | 7✓ 6✗ | · | 1✓ |
| POST | `/api/admin/merchant-token-orders/:orderId/reject` | · | 3✓ 3✗ | · | 1✓ |
| GET | `/api/admin/merchants` | · | 5✓ 4✗ | · | 93✓ |
| GET | `/api/admin/merchants/:merchantId` | · | 2✗ | · | · |
| PUT | `/api/admin/merchants/:merchantId/activate` | · | 1✓ 1✗ | · | · |
| PUT | `/api/admin/merchants/:merchantId/approve` | · | 1✗ | 1✓ | 1✓ |
| PUT | `/api/admin/merchants/:merchantId/capabilities` | · | 1✗ | 1✓ | · |
| POST | `/api/admin/merchants/:merchantId/deduct` | · | 6✓ 13✗ | 1✓ | · |
| GET | `/api/admin/merchants/:merchantId/earnings` | · | 2✗ | · | · |
| POST | `/api/admin/merchants/:merchantId/fund` | · | 20✓ 19✗ | 1✓ | · |
| PUT | `/api/admin/merchants/:merchantId/limits` | · | 2✓ 5✗ | · | · |
| PUT | `/api/admin/merchants/:merchantId/panel-url` | · | 1✗ | · | · |
| GET | `/api/admin/merchants/:merchantId/profile` | · | 2✗ | · | 15✓ |
| GET | `/api/admin/merchants/:merchantId/profit-engine` | · | 1✓ 2✗ | · | · |
| PUT | `/api/admin/merchants/:merchantId/reject` | · | 2✗ | · | 1✓ |
| PUT | `/api/admin/merchants/:merchantId/resume-assignment` | · | 1✗ | 1✓ | · |
| PUT | `/api/admin/merchants/:merchantId/scoring` | · | 1✗ | · | · |
| PUT | `/api/admin/merchants/:merchantId/suspend` | · | 1✓ 2✗ | 1✓ | 2✓ |
| GET | `/api/admin/merchants/:merchantId/transactions` | · | 2✗ | · | 5✓ |
| POST | `/api/admin/merchants/create` | · | 1✗ | · | · |
| GET | `/api/admin/operations/config-catalog` | · | 1✓ 1✗ | · | 23✓ |
| GET | `/api/admin/operations/overview` | · | 1✓ 1✗ | · | 23✓ |
| POST | `/api/admin/operations/retention/run` | · | 1✗ | · | · |
| GET | `/api/admin/orders/:orderId/cdm-receipt` | · | 4✓ 2✗ | · | · |
| GET | `/api/admin/orders/cdm-receipts/missing` | · | 2✓ 1✗ | · | 16✓ |
| GET | `/api/admin/orders/stalled-withdrawals` | · | 1✓ 1✗ | · | 16✓ |
| GET | `/api/admin/payment-mode` | · | 2✓ 3✗ | 4✓ | 20✓ |
| POST | `/api/admin/payment-mode` | · | 3✓ 5✗ | 2✓ | 1✓ |
| GET | `/api/admin/payment-mode/history` | · | 2✓ 1✗ | · | 20✓ |
| POST | `/api/admin/payment-orders/:id/reassign` | · | 4✗ | · | · |
| POST | `/api/admin/payment-orders/:orderId/action` | · | 10✓ 3✗ | · | · |
| POST | `/api/admin/payment-orders/:orderId/resolve` | · | 8✓ 3✗ | · | 2✓ |
| GET | `/api/admin/payment-queue` | · | 1✓ 1✗ | 2✓ | 34✓ 12✗ |
| GET | `/api/admin/phantom-agents` | · | 1✓ 1✗ | · | 24✓ |
| GET | `/api/admin/promo` | · | 1✓ 1✗ | · | 24✓ |
| POST | `/api/admin/promo` | · | 1✗ | · | · |
| DELETE | `/api/admin/promo/:id` | · | 1✗ | · | · |
| PUT | `/api/admin/promo/:id` | · | 1✗ | · | · |
| POST | `/api/admin/promo/upload-url` | · | 12✗ 2‼ | · | · |
| GET | `/api/admin/queue-managers` | · | 1✗ | · | 26✓ |
| POST | `/api/admin/queue/assign/:orderId` | · | 4✗ | · | · |
| GET | `/api/admin/queue/available-merchants` | · | 1✓ 1✗ | · | 92✓ |
| GET | `/api/admin/queue/eligible-merchants` | · | 1✓ 2✗ | · | 4✓ |
| GET | `/api/admin/queue/merchant-pool` | · | 1✓ 2✗ | · | 4✓ |
| PUT | `/api/admin/queue/merchant-pool` | · | 4✗ | · | · |
| GET | `/api/admin/queue/pending-orders` | · | 3✓ 1✗ | · | 46✓ |
| POST | `/api/admin/referral/disburse` | · | 1✗ | 1✗ | 1✗ |
| GET | `/api/admin/referral/stats` | · | 1✓ 1✗ | · | 18✓ |
| GET | `/api/admin/reports/financial` | · | 1✓ 1✗ | · | 23✓ |
| GET | `/api/admin/reports/ledger-export` | · | 1✓ 1✗ | · | 1✓ |
| GET | `/api/admin/reports/merchants` | · | 1✓ 1✗ | · | 23✓ |
| GET | `/api/admin/reports/settlement` | · | 1✓ 1✗ | · | 23✓ |
| POST | `/api/admin/revenue/bonus-pool/fund` | · | 1✗ | · | 1✗ |
| GET | `/api/admin/revenue/ledger` | · | 1✓ 1✗ | · | 26✓ |
| GET | `/api/admin/revenue/summary` | · | 1✓ 1✗ | · | 26✓ |
| GET | `/api/admin/security/ip-blocks` | · | 3✓ 3✗ | · | 20✓ |
| POST | `/api/admin/security/ip-blocks` | · | 10✓ 9✗ | 1✓ | · |
| POST | `/api/admin/security/ip-blocks/:blockId/release` | · | 1✓ 1✗ | 1✓ | · |
| GET | `/api/admin/staff-permissions` | · | 1✓ 2✗ | · | 26✓ |
| GET | `/api/admin/sub-admins` | · | 1✓ 2✗ | · | 27✓ |
| POST | `/api/admin/sub-admins` | · | 9✓ 7✗ | · | · |
| DELETE | `/api/admin/sub-admins/:subAdminId` | · | 1✓ 4✗ | · | 1✓ |
| PUT | `/api/admin/sub-admins/:subAdminId/permissions` | · | 4✓ 8✗ | · | · |
| GET | `/api/admin/support/documents` | · | 1✗ 1‼ | · | 0✗ 17‼ |
| DELETE | `/api/admin/support/documents/:docId` | · | 1✗ | · | · |
| POST | `/api/admin/support/ingest` | · | 1✗ | · | · |
| POST | `/api/admin/support/ingest/knowledge-base` | · | 1✗ | · | 0✗ 1‼ |
| GET | `/api/admin/support/status` | · | 1✓ 1✗ | · | 17✓ |
| GET | `/api/admin/support/tickets` | · | 1✓ 2✗ | · | 16✓ |
| GET | `/api/admin/support/tickets/:id` | · | 2✗ | · | · |
| POST | `/api/admin/support/tickets/:id/reply` | · | 1✗ | · | · |
| GET | `/api/admin/system/config` | · | 12✓ 1✗ | 4✓ 2✗ | 39✓ |
| PUT | `/api/admin/system/config` | · | 7✓ 7✗ | 8✓ | 1✓ 1✗ |
| GET | `/api/admin/telegram/bots` | · | 1✓ 1✗ | · | 52✓ |
| POST | `/api/admin/telegram/bots` | · | 1✗ | · | · |
| POST | `/api/admin/telegram/bots/:id/promote` | · | 1✗ | · | · |
| POST | `/api/admin/telegram/bots/:id/retire` | · | 1✗ | · | 6✗ |
| POST | `/api/admin/telegram/bots/:id/webhook` | · | 1✗ | · | 0✗ 6‼ |
| POST | `/api/admin/telegram/channel` | · | 1✗ | · | · |
| GET | `/api/admin/telegram/config` | · | 1✓ 1✗ | · | 50✓ |
| POST | `/api/admin/telegram/config` | · | 1✗ | · | 1✗ |
| GET | `/api/admin/telegram/templates` | · | 1✓ 1✗ | · | 53✓ |
| PUT | `/api/admin/telegram/templates/:key` | · | 1✗ | · | 1✓ |
| GET | `/api/admin/transactions` | · | 1✓ 1✗ | · | 32✓ |
| GET | `/api/admin/users` | · | 3✓ 4✗ | 3✗ | 137✓ |
| DELETE | `/api/admin/users/:userId` | · | 1✓ 3✗ | · | · |
| GET | `/api/admin/users/:userId` | · | 1✓ 3✗ | · | · |
| PUT | `/api/admin/users/:userId/block` | · | 6✓ 2✗ | 1✓ | 1✓ |
| POST | `/api/admin/users/:userId/clear-flag` | · | 4✓ 3✗ | · | · |
| POST | `/api/admin/users/:userId/phantom-access` | · | 1✗ | · | · |
| POST | `/api/admin/users/:userId/queue-manager` | · | 1✗ | · | · |
| PUT | `/api/admin/users/:userId/roles` | · | 1✓ 1✗ | · | · |
| GET | `/api/admin/users/:userId/transactions` | · | 1✓ 1✗ | · | 6✓ |
| PUT | `/api/admin/users/:userId/unblock` | · | 5✓ 1✗ | 1✓ | · |
| GET | `/api/admin/users/flagged` | · | 10✓ 1✗ | · | 22✓ |
| GET | `/api/admin/utr-registry` | · | 4✓ 3✗ | · | · |
| GET | `/api/admin/utr-registry/:utr` | · | 1✓ 3✗ | · | · |
| PUT | `/api/admin/utr-registry/:utr/clear` | · | 2✓ 2✗ | · | · |
| PUT | `/api/admin/utr-registry/:utr/flag` | · | 7✓ 8✗ | · | · |
| GET | `/api/admin/utr/contested` | · | 6✓ 1✗ | · | · |
| GET | `/api/admin/utr/flagged` | · | 2✓ 1✗ | · | · |
| POST | `/api/admin/utr/resolve/:orderId` | · | 5✓ 9✗ | · | · |
| GET | `/api/admin/utr/stats` | · | 3✓ 2✗ | · | · |
| GET | `/api/admin/utr/user-history/:userId` | · | 2✓ 1✗ | · | · |
| GET | `/api/admin/verification` | · | · | · | 115✓ |
| GET | `/api/announcements` | · | · | 1✓ | 36✓ |
| GET | `/api/app/android/update` | · | 18✓ | · | · |
| GET | `/api/app/bootstrap` | · | · | · | · |
| POST | `/api/bet/phantom` | · | 1✗ | 1✗ | 1✓ |
| POST | `/api/bet/place` | · | 6✓ 3✗ 1‼ | 5✓ 9✗ | 1✓ |
| GET | `/api/bonuses/my` | · | · | · | · |
| GET | `/api/cycles/:cycleId` | · | · | · | · |
| GET | `/api/cycles/active` | · | · | 1✓ | 554✓ |
| GET | `/api/download/android` | · | 2✓ 1✗ | · | · |
| GET | `/api/download/ios` | · | · | · | · |
| GET | `/api/game/admin/categories` | · | · | · | 68✓ |
| POST | `/api/game/admin/categories` | · | · | · | · |
| DELETE | `/api/game/admin/categories/:id` | · | · | · | · |
| PUT | `/api/game/admin/categories/:id` | · | · | · | · |
| GET | `/api/game/admin/game-providers` | · | · | · | 105✓ |
| POST | `/api/game/admin/game-providers` | · | · | · | · |
| DELETE | `/api/game/admin/game-providers/:key` | · | · | · | 2✓ |
| PUT | `/api/game/admin/game-providers/:key` | · | · | · | · |
| POST | `/api/game/admin/game-providers/:key/test` | · | · | · | · |
| GET | `/api/game/admin/game-transactions` | · | · | · | 1✓ |
| GET | `/api/game/admin/games` | · | · | · | 68✓ |
| POST | `/api/game/admin/games` | · | · | · | · |
| DELETE | `/api/game/admin/games/:id` | · | · | · | 2✓ |
| PUT | `/api/game/admin/games/:id` | · | · | · | · |
| GET | `/api/game/categories` | · | · | · | 46✓ |
| GET | `/api/game/games` | · | · | · | 144✓ |
| POST | `/api/game/launch` | · | · | · | 36✗ |
| GET | `/api/game/providers` | · | · | · | 57✓ |
| POST | `/api/game/wallet/:providerKey` | · | · | 2✗ | · |
| POST | `/api/internal/error-report` | · | · | · | · |
| GET | `/api/leaderboard/:period` | · | · | · | 28✓ |
| POST | `/api/leaderboard/rebuild` | · | · | · | · |
| POST | `/api/merchant/2fa/activate` | · | · | · | · |
| POST | `/api/merchant/2fa/setup` | · | · | · | 1✓ |
| GET | `/api/merchant/2fa/status` | · | · | · | 7✓ |
| POST | `/api/merchant/accept/:id` | · | · | · | 1✓ |
| GET | `/api/merchant/admin-token-orders` | · | · | · | 5✓ |
| POST | `/api/merchant/admin-token-orders` | · | · | · | · |
| GET | `/api/merchant/admin-token-orders/quote` | · | · | · | · |
| POST | `/api/merchant/auth/login` | · | · | · | · |
| POST | `/api/merchant/auth/login/2fa` | · | · | · | · |
| POST | `/api/merchant/auth/signup` | · | · | · | · |
| POST | `/api/merchant/cash-links` | · | · | · | · |
| DELETE | `/api/merchant/cash-links/:linkId` | · | · | · | · |
| GET | `/api/merchant/cash-links/current` | · | · | · | 5✓ |
| POST | `/api/merchant/cdm-receipt/:orderId/upload-url` | · | · | · | · |
| GET | `/api/merchant/cdm-receipts/outstanding` | · | · | · | 14✓ |
| POST | `/api/merchant/confirm/:id` | · | · | · | · |
| GET | `/api/merchant/earnings` | · | · | · | 23✓ |
| GET | `/api/merchant/earnings/weekly` | · | · | · | 27✓ |
| PUT | `/api/merchant/online-status` | · | · | · | 2✓ |
| POST | `/api/merchant/order-reject-proof/:orderId/upload-url` | · | · | · | · |
| GET | `/api/merchant/orders` | · | · | · | 66✓ |
| POST | `/api/merchant/orders/:id/cdm-receipt` | · | · | · | · |
| POST | `/api/merchant/orders/:id/red-flag` | · | · | · | · |
| POST | `/api/merchant/orders/:id/reject` | · | · | · | · |
| GET | `/api/merchant/payment-mode` | · | · | · | 25✓ |
| PUT | `/api/merchant/preferences` | · | · | · | 1✓ |
| GET | `/api/merchant/profile` | · | · | · | 8✓ |
| PUT | `/api/merchant/profile` | · | · | · | · |
| POST | `/api/merchant/reject/:id` | · | · | · | · |
| GET | `/api/merchant/stats` | · | · | · | 23✓ |
| GET | `/api/merchant/verification` | · | · | · | 26✓ |
| GET | `/api/payment/admin/config` | · | · | · | 21✓ |
| PUT | `/api/payment/admin/config` | · | · | · | 3✓ |
| POST | `/api/payment/admin/test-gateway` | · | · | · | · |
| POST | `/api/payment/deposit/:orderId/confirm` | · | 13✓ 12✗ | · | · |
| POST | `/api/payment/deposit/create` | · | 2✓ 4✗ | 4✓ 3✗ | · |
| GET | `/api/payment/order/:orderId` | · | 6✓ 12✗ | 1✓ 2✗ | · |
| GET | `/api/payment/order/:orderId/batch` | · | · | · | · |
| POST | `/api/payment/order/:orderId/dispute` | · | 13✓ 19✗ | 1✗ | · |
| POST | `/api/payment/order/:orderId/mark-paid` | · | 3✓ 7✗ | 2✓ 1✗ | · |
| POST | `/api/payment/order/:orderId/payment-reference` | · | · | · | · |
| POST | `/api/payment/order/:orderId/retry` | · | · | · | · |
| GET | `/api/payment/order/:orderId/status` | · | 4✓ 4✗ | · | · |
| POST | `/api/payment/order/:orderId/utr-grace` | · | 5✓ 5✗ | · | · |
| POST | `/api/payment/order/cancel` | · | 1✗ | · | · |
| GET | `/api/payment/orders` | · | 8✓ 1✗ | · | 23✓ 1✗ |
| POST | `/api/payment/usdt/deposit/create` | · | · | 1✓ 3✗ | · |
| POST | `/api/payment/withdrawal/create` | · | 4✗ | 1✓ 2✗ | · |
| GET | `/api/sse/admin/events` | · | 1✗ | 2✗ | 9✓ |
| GET | `/api/sse/events` | · | · | · | 28✓ |
| GET | `/api/sse/merchant/events` | · | 1✗ | 2✗ | 12✓ 1539✗ |
| GET | `/api/sse/stats` | · | · | · | · |
| POST | `/api/support/ask` | · | 2✗ 11‼ | · | · |
| GET | `/api/support/status` | · | · | · | 4✓ |
| GET | `/api/support/tickets` | · | 1✓ 1✗ | · | 4✓ |
| POST | `/api/support/tickets` | · | 15✓ 6✗ | · | · |
| GET | `/api/support/tickets/:ticketId` | · | 1✓ 2✗ | · | · |
| POST | `/api/support/tickets/:ticketId/reply` | · | 2✓ 6✗ | · | · |
| GET | `/api/telegram/public-config` | · | · | · | 14✓ |
| POST | `/api/telegram/recovery/webhook/:botId` | · | · | 1✗ | · |
| POST | `/api/telegram/webhook/:botId` | · | 3✓ | 2✗ | · |
| PUT | `/api/user/:userId/bank-details` | · | 3✓ 6✗ | 1✗ | · |
| GET | `/api/user/:userId/bets` | · | · | 1✗ | · |
| PUT | `/api/user/:userId/profile` | · | 3✓ 3✗ | 1✓ 1✗ | · |
| GET | `/api/user/:userId/transactions` | · | · | 1✗ | · |
| GET | `/api/user/bet-limits` | · | · | 7✓ 1✗ | 23✓ |
| GET | `/api/user/notifications` | · | 7✓ 1✗ | 1✓ | · |
| POST | `/api/user/notifications/read` | · | 5✓ 2✗ | · | · |
| GET | `/api/user/notifications/unread-count` | · | 2✓ 1✗ | · | 22✓ |
| POST | `/api/user/profile/picture/confirm-upload` | · | · | · | · |
| POST | `/api/user/profile/picture/upload-url` | · | · | · | · |
| GET | `/api/user/referrals` | · | · | 2✓ | 19✓ 1✗ |
| GET | `/api/v1/auth/health` | · | · | · | · |
| GET | `/api/v1/auth/invite/:code` | · | 3✓ | · | · |
| POST | `/api/v1/auth/kyc/resubmit` | · | · | · | · |
| POST | `/api/v1/auth/login` | · | 3✓ 9✗ | 6✗ | · |
| POST | `/api/v1/auth/login/2fa` | · | · | · | · |
| POST | `/api/v1/auth/logout` | · | · | · | · |
| GET | `/api/v1/auth/me` | · | 2✓ | · | 73✓ 4✗ |
| POST | `/api/v1/auth/password/reset` | · | 1✓ | 1✗ | · |
| POST | `/api/v1/auth/register` | · | 14✓ 9✗ | · | · |
| GET | `/api/v1/auth/verification` | · | 1✓ 1✗ | · | 31✓ |
| GET | `/api/v1/branding` | · | · | 1✓ | · |
| GET | `/api/v1/content/ai-analysis` | · | · | · | · |
| GET | `/api/v1/content/faq` | · | · | 1✓ | 64✓ |
| GET | `/api/v1/content/promo/:location` | · | · | · | · |
| GET | `/api/v1/content/support-links` | · | · | 1✓ | 100✓ |
| GET | `/api/v1/game/cycle/:type/:startTime` | · | · | · | · |
| GET | `/api/v1/game/cycles/history` | · | · | · | 46✓ |
| GET | `/api/v1/health` | · | · | 4✓ | 2✓ |
| GET | `/api/v1/system/config` | · | · | 7✓ 1‼ | 1103✓ |
| GET | `/api/v1/system/time` | · | · | · | · |
| GET | `/api/v1/token/rates` | · | · | · | · |
| GET | `/api/v1/tokens/rate` | · | · | · | · |
| GET | `/api/v1/user/:id/data` | · | · | 1✓ 5✗ | 32✓ |
| GET | `/api/v1/user/profile` | · | · | 2✓ | 23✓ 1✗ |
| GET | `/api/v1/wallet/ledger` | · | · | · | 2✓ |
| GET | `/api/v1/winners` | · | · | · | 42✓ |
| GET | `/app-assets/:name` | · | · | 2✗ | 80✓ 53✗ |
| GET | `/health` | · | · | · | · |
| GET | `/health/live` | · | · | · | 35✓ |
| GET | `/health/ready` | · | · | · | · |
| GET | `/merchant/*splat` | · | · | · | · |
| GET | `/metrics` | · | · | · | · |
| GET | `/r/:code` | 12✓ 1‼ | · | · | · |

`n✓` answered below 400, `n✗` refused (4xx), `n‼` 5xx, `·` never reached by that tier.

Requests to routers the server does not mount (a test's own router): 2250 across 40 routes — not counted above.

