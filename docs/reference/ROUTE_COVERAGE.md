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
| unit | in-process route test | 147 | 2026-10-04T08:23:12.915Z |
| pg | in-process route test | 1728 | 2026-10-04T08:26:49.643Z |
| e2e | a running server, over HTTP | 187 | 2026-10-04T08:27:15.195Z |
| browser | a running server, over HTTP | 11581 | 2026-10-04T08:46:52.371Z |

Inventory: **300** method+route pairs the server mounts (`browser.jsonl.inventory.json`).

## Summary

| | Routes |
|---|---|
| Mounted by the server | 300 |
| Reached by any tier | 284 |
| **Never reached by anything** | **16** |
| Reached, but only ever REFUSED (no 2xx/3xx anywhere) | 53 |
| Reached only by in-process route tests, never through a running server | 122 |
| Answered a 5xx at least once | 9 |

Per tier (a route can count in several):

| Tier | Reached | Succeeded at least once | Only refused |
|---|---|---|---|
| unit | 2 | 2 | 0 |
| pg | 249 | 184 | 65 |
| e2e | 67 | 52 | 15 |
| browser | 120 | 114 | 6 |

## Never reached by any tier — 16

Nothing in any tier sent a request that this route answered. Each one is either a test that does not
exist yet, or a route nothing needs (§28: read it, do not count it).

### `backend/domains/casino/gameProvider.routes.js` — 4

| Method | Path | Registered at |
|---|---|---|
| POST | `/api/game/admin/game-providers` | `gameProvider.routes.js:479` |
| DELETE | `/api/game/admin/game-providers/:key` | `gameProvider.routes.js:522` |
| PUT | `/api/game/admin/game-providers/:key` | `gameProvider.routes.js:389` |
| POST | `/api/game/admin/game-providers/:key/test` | `gameProvider.routes.js:433` |

### `backend/domains/user/user.routes.js` — 1

| Method | Path | Registered at |
|---|---|---|
| GET | `/api/cycles/:cycleId` | `user.routes.js:96` |

### `backend/routes.js` — 1

| Method | Path | Registered at |
|---|---|---|
| POST | `/api/v1/auth/logout` | `routes.js:437` |

### `backend/routes/retention.routes.js` — 1

| Method | Path | Registered at |
|---|---|---|
| DELETE | `/api/admin/announcements/:id` | `retention.routes.js:229` |

### `backend/routes/upload.routes.js` — 1

| Method | Path | Registered at |
|---|---|---|
| POST | `/api/merchant/order-reject-proof/:orderId/upload-url` | `upload.routes.js:63` |

### `backend/server.js` — 8

| Method | Path | Registered at |
|---|---|---|
| GET | `/admin/*splat` | `server.js:722` |
| POST | `/api/admin/login/2fa` | `server.js:587` |
| GET | `/api/download/ios` | `server.js:611` |
| POST | `/api/internal/error-report` | `server.js:593` |
| GET | `/health` | `server.js:534` |
| GET | `/health/ready` | `server.js:519` |
| GET | `/merchant/*splat` | `server.js:727` |
| GET | `/metrics` | `server.js:358` |

## Reached, but only ever refused — 53

Every request this route answered, in every tier, was a 4xx. The refusal is tested; the work is not.

| Method | Path | Registered at | What it answered |
|---|---|---|---|
| DELETE | `/api/admin/app-assets/:name` | `branding.admin.routes.js:404` | pg: 403×1 |
| POST | `/api/admin/app-assets/upload` | `branding.admin.routes.js:351` | pg: 403×1 |
| POST | `/api/admin/branding/cdn-url` | `branding.admin.routes.js:201` | pg: 403×1 |
| POST | `/api/admin/branding/confirm-upload` | `branding.admin.routes.js:255` | pg: 403×1 |
| POST | `/api/admin/branding/images` | `branding.admin.routes.js:119` | pg: 403×1 |
| DELETE | `/api/admin/branding/images/:imageId` | `branding.admin.routes.js:166` | pg: 403×1 |
| POST | `/api/admin/branding/upload-url` | `branding.admin.routes.js:229` | pg: 403×1 |
| POST | `/api/admin/chat/ban` | `chat.admin.routes.js:106` | pg: 403×1 |
| DELETE | `/api/admin/chat/ban/:userId` | `chat.admin.routes.js:137` | pg: 403×1 |
| POST | `/api/admin/chat/messages/:id/delete` | `chat.admin.routes.js:61` | pg: 403×1 |
| DELETE | `/api/admin/content/faq/:faqId` | `content.admin.routes.js:121` | pg: 403×1 |
| PUT | `/api/admin/content/faq/:faqId` | `content.admin.routes.js:108` | pg: 403×1 |
| POST | `/api/admin/cycles/:cycleId/equalize` | `cycles.admin.routes.js:146` | pg: 403×1 |
| PUT | `/api/admin/deposit-policy/:currency` | `depositPolicy.admin.routes.js:88` | pg: 403×1 |
| POST | `/api/admin/deposit-policy/version/:versionId/approve` | `depositPolicy.admin.routes.js:149` | pg: 403×1 |
| POST | `/api/admin/deposit-policy/version/:versionId/rollback` | `depositPolicy.admin.routes.js:185` | pg: 403×1 |
| GET | `/api/admin/dispute-orders/:orderId` | `disputeResolution.admin.routes.js:117` | pg: 403×1 404×1 |
| POST | `/api/admin/dispute-orders/:orderId/escalate` | `disputeResolution.admin.routes.js:402` | pg: 403×1 |
| DELETE | `/api/admin/error-reports` | `system.admin.routes.js:516` | pg: 403×1 |
| POST | `/api/admin/login` | `server.js:578` | browser: 401×1 |
| GET | `/api/admin/merchants/:merchantId/earnings` | `merchant.admin.routes.js:261` | pg: 403×1 404×1 |
| PUT | `/api/admin/merchants/:merchantId/panel-url` | `merchant.admin.routes.js:542` | pg: 403×1 |
| PUT | `/api/admin/merchants/:merchantId/reject` | `merchant.admin.routes.js:411` | pg: 400×1 401×1 403×1 404×1 |
| POST | `/api/admin/merchants/create` | `merchant.admin.routes.js:444` | pg: 403×1 |
| POST | `/api/admin/payment-orders/:id/reassign` | `merchant.assignment.routes.js:51` | pg: 403×2 404×2 |
| POST | `/api/admin/promo` | `content.admin.routes.js:267` | pg: 403×1 |
| DELETE | `/api/admin/promo/:id` | `content.admin.routes.js:341` | pg: 403×1 |
| PUT | `/api/admin/promo/:id` | `content.admin.routes.js:306` | pg: 403×1 |
| POST | `/api/admin/promo/upload-url` | `content.admin.routes.js:226` | pg: 400×9 401×1 403×2 503×2 |
| POST | `/api/admin/queue/assign/:orderId` | `merchant.assignment.routes.js:151` | pg: 403×2 404×2 |
| POST | `/api/admin/referral/disburse` | `telegram.admin.routes.js:500` | pg: 403×1; e2e: 409×1 |
| GET | `/api/admin/support/documents` | `support.admin.routes.js:54` | pg: 403×1 503×1; browser: 503×9 |
| DELETE | `/api/admin/support/documents/:docId` | `support.admin.routes.js:59` | pg: 403×1 |
| POST | `/api/admin/support/ingest` | `support.admin.routes.js:36` | pg: 403×1 |
| POST | `/api/admin/support/ingest/knowledge-base` | `support.admin.routes.js:31` | pg: 403×1 |
| GET | `/api/admin/support/tickets/:id` | `chat.admin.routes.js:180` | pg: 403×1 404×1 |
| POST | `/api/admin/support/tickets/:id/reply` | `chat.admin.routes.js:204` | pg: 403×1 |
| POST | `/api/admin/telegram/bots` | `telegram.admin.routes.js:360` | pg: 403×1 |
| POST | `/api/admin/telegram/bots/:id/promote` | `telegram.admin.routes.js:383` | pg: 403×1 |
| POST | `/api/admin/telegram/bots/:id/retire` | `telegram.admin.routes.js:415` | pg: 403×1; browser: 409×3 |
| POST | `/api/admin/telegram/bots/:id/webhook` | `telegram.admin.routes.js:405` | pg: 403×1; browser: 502×3 |
| POST | `/api/admin/telegram/channel` | `telegram.admin.routes.js:250` | pg: 403×1 |
| POST | `/api/admin/telegram/config` | `telegram.admin.routes.js:138` | pg: 403×1 |
| PUT | `/api/admin/telegram/templates/:key` | `telegram.admin.routes.js:445` | pg: 403×1 |
| POST | `/api/bet/phantom` | `bet.routes.js:552` | pg: 400×1 403×3; e2e: 403×1 |
| POST | `/api/game/launch` | `gameProvider.routes.js:138` | pg: 400×1 403×2; browser: 400×18 |
| POST | `/api/game/wallet/:providerKey` | `gameProvider.routes.js:284` | e2e: 404×2 |
| DELETE | `/api/merchant/supervisor/teams/:teamId` | `team.merchant.routes.js:104` | pg: 404×1 |
| PUT | `/api/merchant/supervisor/teams/:teamId` | `team.merchant.routes.js:95` | pg: 400×1 404×1 |
| POST | `/api/support/ask` | `support.routes.js:68` | pg: 400×1 403×2 429×2 503×11 |
| POST | `/api/telegram/recovery/webhook/:botId` | `telegram.routes.js:492` | e2e: 401×1 |
| POST | `/api/user/profile/picture/confirm-upload` | `upload.routes.js:168` | pg: 400×1 403×2 |
| POST | `/api/user/profile/picture/upload-url` | `upload.routes.js:146` | pg: 400×1 403×2 |

## Reached only by in-process route tests — 122

A route test mounts the router on its own. Nothing reached these through the real server, its
middleware stack and its mounts — the way a panel reaches them.

| Method | Path | Registered at | What it answered |
|---|---|---|---|
| GET | `/.well-known/assetlinks.json` | `wellKnown.routes.js:53` | unit: 200×4 404×3 |
| POST | `/api/2fa/activate` | `twoFactor.routes.js:129` | pg: 200×6 400×2 |
| POST | `/api/2fa/disable` | `twoFactor.routes.js:190` | pg: 200×1 400×1 403×1 |
| POST | `/api/2fa/setup` | `twoFactor.routes.js:90` | pg: 200×8 401×1 409×2 |
| POST | `/api/admin/android/releases` | `androidRelease.admin.routes.js:72` | pg: 201×16 400×9 403×2 |
| DELETE | `/api/admin/android/releases/:id` | `androidRelease.admin.routes.js:237` | pg: 200×4 403×1 409×1 |
| PATCH | `/api/admin/android/releases/:id` | `androidRelease.admin.routes.js:146` | pg: 200×3 403×1 |
| POST | `/api/admin/android/releases/:id/halt` | `androidRelease.admin.routes.js:201` | pg: 200×3 400×1 403×1 409×1 |
| POST | `/api/admin/android/releases/:id/publish` | `androidRelease.admin.routes.js:170` | pg: 200×9 403×1 409×4 |
| POST | `/api/admin/android/releases/:id/resume` | `androidRelease.admin.routes.js:225` | pg: 200×3 403×1 409×1 |
| PUT | `/api/admin/announcements/:id` | `retention.routes.js:201` | pg: 200×1 400×1 403×1 404×1 |
| DELETE | `/api/admin/app-assets/:name` | `branding.admin.routes.js:404` | pg: 403×1 |
| POST | `/api/admin/app-assets/upload` | `branding.admin.routes.js:351` | pg: 403×1 |
| POST | `/api/admin/balance-adjust` | `retention.routes.js:263` | pg: 200×13 400×16 401×1 403×1 404×1 409×1 |
| POST | `/api/admin/branding/cdn-url` | `branding.admin.routes.js:201` | pg: 403×1 |
| POST | `/api/admin/branding/confirm-upload` | `branding.admin.routes.js:255` | pg: 403×1 |
| POST | `/api/admin/branding/images` | `branding.admin.routes.js:119` | pg: 403×1 |
| DELETE | `/api/admin/branding/images/:imageId` | `branding.admin.routes.js:166` | pg: 403×1 |
| POST | `/api/admin/branding/upload-url` | `branding.admin.routes.js:229` | pg: 403×1 |
| POST | `/api/admin/chat/ban` | `chat.admin.routes.js:106` | pg: 403×1 |
| DELETE | `/api/admin/chat/ban/:userId` | `chat.admin.routes.js:137` | pg: 403×1 |
| POST | `/api/admin/chat/messages/:id/delete` | `chat.admin.routes.js:61` | pg: 403×1 |
| DELETE | `/api/admin/content/faq/:faqId` | `content.admin.routes.js:121` | pg: 403×1 |
| PUT | `/api/admin/content/faq/:faqId` | `content.admin.routes.js:108` | pg: 403×1 |
| POST | `/api/admin/cycles/:cycleId/equalize` | `cycles.admin.routes.js:146` | pg: 403×1 |
| PUT | `/api/admin/deposit-policy/:currency` | `depositPolicy.admin.routes.js:88` | pg: 403×1 |
| POST | `/api/admin/deposit-policy/version/:versionId/approve` | `depositPolicy.admin.routes.js:149` | pg: 403×1 |
| POST | `/api/admin/deposit-policy/version/:versionId/rollback` | `depositPolicy.admin.routes.js:185` | pg: 403×1 |
| GET | `/api/admin/dispute-orders/:orderId` | `disputeResolution.admin.routes.js:117` | pg: 403×1 404×1 |
| GET | `/api/admin/dispute-orders/:orderId/chat` | `disputeResolution.admin.routes.js:130` | pg: 200×2 403×1 |
| POST | `/api/admin/dispute-orders/:orderId/chat` | `disputeResolution.admin.routes.js:140` | pg: 200×1 403×1 |
| POST | `/api/admin/dispute-orders/:orderId/escalate` | `disputeResolution.admin.routes.js:402` | pg: 403×1 |
| DELETE | `/api/admin/error-reports` | `system.admin.routes.js:516` | pg: 403×1 |
| POST | `/api/admin/fake-winners` | `winners.routes.js:68` | pg: 200×7 400×3 403×1 |
| DELETE | `/api/admin/fake-winners/:id` | `winners.routes.js:134` | pg: 200×1 403×1 404×1 |
| PUT | `/api/admin/fake-winners/:id` | `winners.routes.js:101` | pg: 200×1 400×4 403×1 404×1 |
| POST | `/api/admin/manage-cycle` | `cycles.admin.routes.js:223` | pg: 200×1 403×1 |
| GET | `/api/admin/merchant-platform/:merchantId/funding-stats` | `merchantPlatform.admin.routes.js:31` | pg: 200×2 403×2 404×2 |
| GET | `/api/admin/merchant-platform/:merchantId/performance-history` | `merchantPlatform.admin.routes.js:44` | pg: 200×2 403×2 |
| GET | `/api/admin/merchants/:merchantId` | `merchant.admin.routes.js:95` | pg: 200×1 401×1 403×1 404×2 |
| PUT | `/api/admin/merchants/:merchantId/activate` | `merchant.admin.routes.js:159` | pg: 200×3 401×1 403×2 404×1 |
| GET | `/api/admin/merchants/:merchantId/earnings` | `merchant.admin.routes.js:261` | pg: 403×1 404×1 |
| PUT | `/api/admin/merchants/:merchantId/panel-url` | `merchant.admin.routes.js:542` | pg: 403×1 |
| PUT | `/api/admin/merchants/:merchantId/reject` | `merchant.admin.routes.js:411` | pg: 400×1 401×1 403×1 404×1 |
| PUT | `/api/admin/merchants/:merchantId/supervisor` | `team.admin.routes.js:46` | pg: 200×19 400×1 403×2 |
| POST | `/api/admin/merchants/create` | `merchant.admin.routes.js:444` | pg: 403×1 |
| POST | `/api/admin/operations/retention/run` | `operations.admin.routes.js:155` | pg: 200×4 403×2 500×1 |
| POST | `/api/admin/payment-orders/:id/reassign` | `merchant.assignment.routes.js:51` | pg: 403×2 404×2 |
| POST | `/api/admin/payment-orders/:orderId/action` | `paymentOrder.routes.js:49` | pg: 200×14 400×3 403×1 409×2 |
| POST | `/api/admin/payment-orders/:orderId/resolve` | `paymentOrder.routes.js:192` | pg: 200×10 400×5 403×1 |
| POST | `/api/admin/promo` | `content.admin.routes.js:267` | pg: 403×1 |
| DELETE | `/api/admin/promo/:id` | `content.admin.routes.js:341` | pg: 403×1 |
| PUT | `/api/admin/promo/:id` | `content.admin.routes.js:306` | pg: 403×1 |
| POST | `/api/admin/promo/upload-url` | `content.admin.routes.js:226` | pg: 400×9 401×1 403×2 503×2 |
| POST | `/api/admin/queue/assign/:orderId` | `merchant.assignment.routes.js:151` | pg: 403×2 404×2 |
| POST | `/api/admin/revenue/bonus-pool/fund` | `revenue.admin.routes.js:81` | pg: 200×1 403×1 |
| POST | `/api/admin/sub-admins` | `subadmins.admin.routes.js:80` | pg: 200×9 400×4 401×1 403×2 |
| DELETE | `/api/admin/sub-admins/:subAdminId` | `subadmins.admin.routes.js:188` | pg: 200×1 401×1 403×1 404×2 |
| PUT | `/api/admin/sub-admins/:subAdminId/permissions` | `subadmins.admin.routes.js:142` | pg: 200×4 400×5 401×1 403×1 404×1 |
| DELETE | `/api/admin/support/documents/:docId` | `support.admin.routes.js:59` | pg: 403×1 |
| POST | `/api/admin/support/ingest` | `support.admin.routes.js:36` | pg: 403×1 |
| POST | `/api/admin/support/ingest/knowledge-base` | `support.admin.routes.js:31` | pg: 403×1 |
| GET | `/api/admin/support/tickets/:id` | `chat.admin.routes.js:180` | pg: 403×1 404×1 |
| POST | `/api/admin/support/tickets/:id/reply` | `chat.admin.routes.js:204` | pg: 403×1 |
| DELETE | `/api/admin/team-members/:merchantId` | `team.admin.routes.js:86` | pg: 200×1 403×1 |
| POST | `/api/admin/team-members/:merchantId/approve` | `team.admin.routes.js:60` | pg: 200×2 403×2 |
| POST | `/api/admin/team-members/:merchantId/reject` | `team.admin.routes.js:73` | pg: 200×1 403×1 409×1 |
| POST | `/api/admin/team-pool-requests/:requestId/reject` | `team.admin.routes.js:157` | pg: 200×3 403×3 |
| POST | `/api/admin/telegram/bots` | `telegram.admin.routes.js:360` | pg: 403×1 |
| POST | `/api/admin/telegram/bots/:id/promote` | `telegram.admin.routes.js:383` | pg: 403×1 |
| POST | `/api/admin/telegram/channel` | `telegram.admin.routes.js:250` | pg: 403×1 |
| POST | `/api/admin/telegram/config` | `telegram.admin.routes.js:138` | pg: 403×1 |
| PUT | `/api/admin/telegram/templates/:key` | `telegram.admin.routes.js:445` | pg: 403×1 |
| DELETE | `/api/admin/users/:userId` | `users.admin.routes.js:383` | pg: 200×5 403×1 404×3 409×2 |
| GET | `/api/admin/users/:userId` | `users.admin.routes.js:203` | pg: 200×2 403×1 404×2 |
| POST | `/api/admin/users/:userId/clear-flag` | `users.admin.routes.js:176` | pg: 200×4 403×2 404×1 |
| POST | `/api/admin/users/:userId/phantom-access` | `users.admin.routes.js:466` | pg: 200×2 403×1 409×1 |
| POST | `/api/admin/users/:userId/queue-manager` | `users.admin.routes.js:558` | pg: 200×2 403×1 409×1 |
| GET | `/api/admin/utr-registry/:utr` | `utr.admin.routes.js:43` | pg: 200×1 403×1 404×2 |
| PUT | `/api/admin/utr-registry/:utr/clear` | `utr.admin.routes.js:89` | pg: 200×2 401×1 403×1 404×1 |
| PUT | `/api/admin/utr-registry/:utr/flag` | `utr.admin.routes.js:61` | pg: 200×7 400×4 401×1 403×2 404×1 |
| GET | `/api/admin/utr/user-history/:userId` | `utr.admin.routes.js:144` | pg: 200×2 401×1 403×1 |
| GET | `/api/app/android/update` | `androidRelease.routes.js:20` | pg: 200×18 |
| GET | `/api/download/android` | `androidRelease.routes.js:39` | pg: 302×2 404×1 |
| POST | `/api/game/admin/categories` | `gameRegistry.routes.js:209` | pg: 200×3 403×1 409×1 |
| DELETE | `/api/game/admin/categories/:id` | `gameRegistry.routes.js:250` | pg: 200×1 409×1 |
| PUT | `/api/game/admin/categories/:id` | `gameRegistry.routes.js:232` | pg: 200×2 404×1 |
| POST | `/api/game/admin/games` | `gameRegistry.routes.js:117` | pg: 200×5 400×1 403×1 409×2 |
| DELETE | `/api/game/admin/games/:id` | `gameRegistry.routes.js:185` | pg: 200×2 404×1 |
| PUT | `/api/game/admin/games/:id` | `gameRegistry.routes.js:155` | pg: 200×1 404×1 |
| POST | `/api/leaderboard/rebuild` | `retention.routes.js:72` | pg: 200×1 401×1 403×1 |
| POST | `/api/merchant/2fa/activate` | `merchant.routes.js:444` | pg: 200×2 400×2 |
| POST | `/api/merchant/auth/login` | `merchant.routes.js:225` | pg: 200×4 401×5 |
| POST | `/api/merchant/auth/login/2fa` | `merchant.routes.js:329` | pg: 200×1 401×2 |
| POST | `/api/merchant/auth/signup` | `merchant.routes.js:159` | pg: 200×1 400×2 |
| POST | `/api/merchant/orders/:id/red-flag` | `merchant.routes.js:1420` | pg: 200×16 400×1 404×1 |
| POST | `/api/merchant/orders/:id/reject` | `merchant.routes.js:1712` | pg: 200×32 400×6 403×1 409×2 |
| PUT | `/api/merchant/preferences` | `merchant.routes.js:682` | pg: 200×4 |
| PUT | `/api/merchant/profile` | `merchant.routes.js:521` | pg: 200×3 400×5 |
| POST | `/api/merchant/reject/:id` | `merchant.routes.js:1254` | pg: 200×14 |
| GET | `/api/merchant/supervisor/disputes/:orderId/chat` | `team.merchant.routes.js:246` | pg: 200×2 404×1 |
| POST | `/api/merchant/supervisor/disputes/:orderId/chat` | `team.merchant.routes.js:265` | pg: 201×1 400×1 404×1 409×2 |
| GET | `/api/merchant/supervisor/members/:merchantId/log` | `team.merchant.routes.js:210` | pg: 200×2 403×1 404×3 |
| DELETE | `/api/merchant/supervisor/pool-requests/:requestId` | `team.merchant.routes.js:195` | pg: 200×1 409×1 |
| POST | `/api/merchant/supervisor/teams` | `team.merchant.routes.js:85` | pg: 201×21 400×1 403×1 409×1 |
| DELETE | `/api/merchant/supervisor/teams/:teamId` | `team.merchant.routes.js:104` | pg: 404×1 |
| PUT | `/api/merchant/supervisor/teams/:teamId` | `team.merchant.routes.js:95` | pg: 400×1 404×1 |
| POST | `/api/merchant/supervisor/teams/:teamId/members` | `team.merchant.routes.js:114` | pg: 201×5 400×1 404×2 |
| DELETE | `/api/merchant/supervisor/teams/:teamId/members/:merchantId` | `team.merchant.routes.js:130` | pg: 200×1 404×2 |
| POST | `/api/payment/order/:orderId/retry` | `payment.routes.js:135` | pg: 200×2 403×2 404×2 409×2 |
| POST | `/api/payment/order/:orderId/utr-grace` | `payment.routes.js:193` | pg: 200×6 400×1 403×2 404×2 409×3 |
| POST | `/api/support/ask` | `support.routes.js:68` | pg: 400×1 403×2 429×2 503×11 |
| POST | `/api/support/tickets` | `support.routes.js:108` | pg: 200×15 400×3 401×1 403×2 429×3 |
| GET | `/api/support/tickets/:ticketId` | `support.routes.js:149` | pg: 200×1 401×1 403×2 404×2 |
| POST | `/api/support/tickets/:ticketId/reply` | `support.routes.js:161` | pg: 200×2 400×5 401×1 403×2 404×1 |
| POST | `/api/user/notifications/read` | `user.routes.js:537` | pg: 200×6 400×1 401×1 403×2 |
| POST | `/api/user/profile/picture/confirm-upload` | `upload.routes.js:168` | pg: 400×1 403×2 |
| POST | `/api/user/profile/picture/upload-url` | `upload.routes.js:146` | pg: 400×1 403×2 |
| GET | `/api/v1/auth/invite/:code` | `playerAuth.routes.js:260` | pg: 200×3 |
| POST | `/api/v1/auth/login/2fa` | `playerAuth.routes.js:244` | pg: 200×1 403×1 |
| POST | `/api/v1/auth/register` | `playerAuth.routes.js:136` | pg: 200×14 400×6 409×1 |
| GET | `/r/:code` | `referralRedirect.routes.js:51` | unit: 302×12 503×1 |

## Answered a 5xx at least once — 9

Some of these are tests provoking a failure on purpose. Each is still worth reading: a 5xx a
browser pass hit is a screen that broke.

| Method | Path | Registered at | What it answered |
|---|---|---|---|
| POST | `/api/admin/operations/retention/run` | `operations.admin.routes.js:155` | pg: 200×4 403×2 500×1 |
| POST | `/api/admin/promo/upload-url` | `content.admin.routes.js:226` | pg: 400×9 401×1 403×2 503×2 |
| GET | `/api/admin/support/documents` | `support.admin.routes.js:54` | pg: 403×1 503×1; browser: 503×9 |
| POST | `/api/admin/telegram/bots/:id/webhook` | `telegram.admin.routes.js:405` | pg: 403×1; browser: 502×3 |
| POST | `/api/bet/place` | `bet.routes.js:84` | pg: 200×6 400×4 403×2 500×1; e2e: 200×5 400×9 |
| POST | `/api/merchant/2fa/setup` | `merchant.routes.js:410` | pg: 200×3 400×1; browser: 500×1 |
| POST | `/api/support/ask` | `support.routes.js:68` | pg: 400×1 403×2 429×2 503×11 |
| GET | `/api/v1/system/config` | `user.routes.js:376` | e2e: 200×5 500×1; browser: 200×570 304×6 |
| GET | `/r/:code` | `referralRedirect.routes.js:51` | unit: 302×12 503×1 |

## Client methods no screen calls — 0

A method in a panel's API client that nothing else in that panel names. `check:ui-coverage` counts
its request as reaching a route; no person can make it. Each is either a feature with no button
(wire it) or code nothing needs (delete it, §30).

| Panel | Method | Requests |
|---|---|---|

## Every route

| Method | Path | unit | pg | e2e | browser |
|---|---|---|---|---|---|
| GET | `/.well-known/assetlinks.json` | 4✓ 3✗ | · | · | · |
| GET | `/{*splat}` | · | · | 1✓ | · |
| OPTIONS | `/{*splat}` | · | · | · | 1902✓ |
| GET | `/admin/*splat` | · | · | · | · |
| POST | `/api/2fa/activate` | · | 6✓ 2✗ | · | · |
| POST | `/api/2fa/disable` | · | 1✓ 2✗ | · | · |
| POST | `/api/2fa/setup` | · | 8✓ 3✗ | · | · |
| GET | `/api/2fa/status` | · | 4✓ 1✗ | · | 14✓ |
| GET | `/api/admin/analytics/dashboard` | · | 3✓ 2✗ | · | 810✓ |
| GET | `/api/admin/analytics/deposit-dashboard` | · | 1✓ 1✗ | · | 11✓ |
| GET | `/api/admin/analytics/financials` | · | 3✓ 2✗ | · | 18✓ |
| GET | `/api/admin/analytics/merchant-funding` | · | 3✓ 1✗ | · | 11✓ |
| GET | `/api/admin/analytics/phantom-stats` | · | 1✓ 1✗ | · | 18✓ |
| GET | `/api/admin/analytics/trends` | · | 1✓ 1✗ | · | 11✓ |
| GET | `/api/admin/analytics/withdrawal-dashboard` | · | 1✓ 1✗ | · | 11✓ |
| GET | `/api/admin/android/releases` | · | 7✓ 2✗ | · | 13✓ |
| POST | `/api/admin/android/releases` | · | 16✓ 11✗ | · | · |
| DELETE | `/api/admin/android/releases/:id` | · | 4✓ 2✗ | · | · |
| PATCH | `/api/admin/android/releases/:id` | · | 3✓ 1✗ | · | · |
| POST | `/api/admin/android/releases/:id/halt` | · | 3✓ 3✗ | · | · |
| POST | `/api/admin/android/releases/:id/publish` | · | 9✓ 5✗ | · | · |
| POST | `/api/admin/android/releases/:id/resume` | · | 3✓ 2✗ | · | · |
| GET | `/api/admin/announcements` | · | 2✓ | · | 11✓ |
| POST | `/api/admin/announcements` | · | 4✓ | 1✓ | · |
| DELETE | `/api/admin/announcements/:id` | · | · | · | · |
| PUT | `/api/admin/announcements/:id` | · | 1✓ 3✗ | · | · |
| GET | `/api/admin/app-assets` | · | 1✓ 1✗ | · | 9✓ |
| DELETE | `/api/admin/app-assets/:name` | · | 1✗ | · | · |
| POST | `/api/admin/app-assets/upload` | · | 1✗ | · | · |
| GET | `/api/admin/audit-logs` | · | 1✓ 1✗ | · | 139✓ 2✗ |
| POST | `/api/admin/balance-adjust` | · | 13✓ 20✗ | · | · |
| GET | `/api/admin/balance-adjust/players` | · | 3✓ 1✗ | · | 9✓ |
| GET | `/api/admin/balance-adjustments` | · | · | · | 8✓ |
| GET | `/api/admin/branding` | · | 1✓ 1✗ | 1✓ | 17✓ |
| PUT | `/api/admin/branding` | · | 2✗ | 2✓ | · |
| POST | `/api/admin/branding/cdn-url` | · | 1✗ | · | · |
| POST | `/api/admin/branding/confirm-upload` | · | 1✗ | · | · |
| GET | `/api/admin/branding/images` | · | 1✓ 1✗ | · | 17✓ |
| POST | `/api/admin/branding/images` | · | 1✗ | · | · |
| DELETE | `/api/admin/branding/images/:imageId` | · | 1✗ | · | · |
| POST | `/api/admin/branding/upload-url` | · | 1✗ | · | · |
| POST | `/api/admin/chat/ban` | · | 1✗ | · | · |
| DELETE | `/api/admin/chat/ban/:userId` | · | 1✗ | · | · |
| GET | `/api/admin/chat/bans` | · | 1✓ 1✗ | · | 8✓ |
| GET | `/api/admin/chat/messages` | · | 2✓ 1✗ | · | 8✓ |
| POST | `/api/admin/chat/messages/:id/delete` | · | 1✗ | · | · |
| GET | `/api/admin/communication/admin-activity` | · | 1✓ 1✗ | · | 11✓ |
| GET | `/api/admin/communication/audit-feed` | · | 1✓ 1✗ | · | 13✓ |
| GET | `/api/admin/communication/channels` | · | 1✓ 1✗ | · | 13✓ |
| GET | `/api/admin/content/faq` | · | 1✓ 1✗ | · | 24✓ |
| POST | `/api/admin/content/faq` | · | 2✗ | 1✓ | · |
| DELETE | `/api/admin/content/faq/:faqId` | · | 1✗ | · | · |
| PUT | `/api/admin/content/faq/:faqId` | · | 1✗ | · | · |
| GET | `/api/admin/content/support-links` | · | 1✓ 1✗ | 1✓ | 10✓ |
| PUT | `/api/admin/content/support-links` | · | 2✗ | 2✓ | · |
| POST | `/api/admin/cycles/:cycleId/equalize` | · | 1✗ | · | · |
| GET | `/api/admin/cycles/history` | · | 1✓ 1✗ | · | 26✓ |
| GET | `/api/admin/cycles/phases` | · | 1✓ 1✗ | · | 26✓ |
| GET | `/api/admin/deposit-policy/:currency` | · | 2✗ | · | 11✓ |
| PUT | `/api/admin/deposit-policy/:currency` | · | 1✗ | · | · |
| GET | `/api/admin/deposit-policy/:currency/history` | · | 2✗ | · | 11✓ |
| POST | `/api/admin/deposit-policy/version/:versionId/approve` | · | 1✗ | · | · |
| POST | `/api/admin/deposit-policy/version/:versionId/rollback` | · | 1✗ | · | · |
| GET | `/api/admin/dispute-orders` | · | 5✓ 1✗ | · | 10✓ |
| GET | `/api/admin/dispute-orders/:orderId` | · | 2✗ | · | · |
| GET | `/api/admin/dispute-orders/:orderId/chat` | · | 2✓ 1✗ | · | · |
| POST | `/api/admin/dispute-orders/:orderId/chat` | · | 1✓ 1✗ | · | · |
| POST | `/api/admin/dispute-orders/:orderId/escalate` | · | 1✗ | · | · |
| POST | `/api/admin/dispute-orders/:orderId/resolve` | · | 32✓ 19✗ | 1✓ | · |
| DELETE | `/api/admin/error-reports` | · | 1✗ | · | · |
| GET | `/api/admin/error-reports` | · | 1✓ 1✗ | · | 9✓ |
| GET | `/api/admin/fake-winners` | · | · | · | 11✓ |
| POST | `/api/admin/fake-winners` | · | 7✓ 4✗ | · | · |
| DELETE | `/api/admin/fake-winners/:id` | · | 1✓ 2✗ | · | · |
| PUT | `/api/admin/fake-winners/:id` | · | 1✓ 6✗ | · | · |
| POST | `/api/admin/login` | · | · | · | 1✗ |
| POST | `/api/admin/login/2fa` | · | · | · | · |
| POST | `/api/admin/manage-cycle` | · | 1✓ 1✗ | · | · |
| GET | `/api/admin/merchant-platform/:merchantId/funding-stats` | · | 2✓ 4✗ | · | · |
| GET | `/api/admin/merchant-platform/:merchantId/performance-history` | · | 2✓ 2✗ | · | · |
| GET | `/api/admin/merchant-platform/leaderboard` | · | 1✓ 1✗ | · | 10✓ |
| GET | `/api/admin/merchants` | · | 5✓ 5✗ | · | 44✓ |
| GET | `/api/admin/merchants/:merchantId` | · | 1✓ 4✗ | · | · |
| PUT | `/api/admin/merchants/:merchantId/activate` | · | 3✓ 4✗ | · | · |
| PUT | `/api/admin/merchants/:merchantId/approve` | · | 2✗ | 1✓ | · |
| PUT | `/api/admin/merchants/:merchantId/capabilities` | · | 1✗ | 1✓ | · |
| GET | `/api/admin/merchants/:merchantId/earnings` | · | 2✗ | · | · |
| PUT | `/api/admin/merchants/:merchantId/panel-url` | · | 1✗ | · | · |
| GET | `/api/admin/merchants/:merchantId/profile` | · | 2✗ | · | 9✓ |
| PUT | `/api/admin/merchants/:merchantId/reject` | · | 4✗ | · | · |
| PUT | `/api/admin/merchants/:merchantId/resume-assignment` | · | 1✗ | 1✓ | · |
| PUT | `/api/admin/merchants/:merchantId/supervisor` | · | 19✓ 3✗ | · | · |
| PUT | `/api/admin/merchants/:merchantId/suspend` | · | 1✓ 8✗ | 1✓ | · |
| GET | `/api/admin/merchants/:merchantId/transactions` | · | 2✗ | · | 3✓ |
| POST | `/api/admin/merchants/create` | · | 1✗ | · | · |
| GET | `/api/admin/operations/config-catalog` | · | 1✓ 1✗ | · | 13✓ |
| GET | `/api/admin/operations/overview` | · | 1✓ 1✗ | · | 13✓ |
| POST | `/api/admin/operations/retention/run` | · | 4✓ 2✗ 1‼ | · | · |
| GET | `/api/admin/orders/stalled-withdrawals` | · | 1✓ 1✗ | · | 10✓ |
| POST | `/api/admin/payment-orders/:id/reassign` | · | 4✗ | · | · |
| POST | `/api/admin/payment-orders/:orderId/action` | · | 14✓ 6✗ | · | · |
| POST | `/api/admin/payment-orders/:orderId/resolve` | · | 10✓ 6✗ | · | · |
| GET | `/api/admin/payment-queue` | · | 3✓ 3✗ | 2✓ | 19✓ |
| GET | `/api/admin/phantom-agents` | · | 1✓ 1✗ | · | 11✓ |
| GET | `/api/admin/promo` | · | 1✓ 1✗ | · | 12✓ |
| POST | `/api/admin/promo` | · | 1✗ | · | · |
| DELETE | `/api/admin/promo/:id` | · | 1✗ | · | · |
| PUT | `/api/admin/promo/:id` | · | 1✗ | · | · |
| POST | `/api/admin/promo/upload-url` | · | 12✗ 2‼ | · | · |
| GET | `/api/admin/queue-managers` | · | 1✗ | · | 20✓ |
| POST | `/api/admin/queue/assign/:orderId` | · | 4✗ | · | · |
| GET | `/api/admin/queue/pending-orders` | · | 3✓ 1✗ | · | 19✓ |
| POST | `/api/admin/referral/disburse` | · | 1✗ | 1✗ | · |
| GET | `/api/admin/referral/stats` | · | 1✓ 1✗ | · | 8✓ |
| GET | `/api/admin/reports/financial` | · | 1✓ 1✗ | · | 13✓ |
| GET | `/api/admin/reports/ledger-export` | · | 1✓ 1✗ | · | 1✓ |
| GET | `/api/admin/reports/merchants` | · | 1✓ 1✗ | · | 13✓ |
| GET | `/api/admin/reports/settlement` | · | 1✓ 1✗ | · | 13✓ |
| POST | `/api/admin/revenue/bonus-pool/fund` | · | 1✓ 1✗ | · | · |
| GET | `/api/admin/revenue/ledger` | · | 1✓ 1✗ | · | 12✓ |
| GET | `/api/admin/revenue/summary` | · | 1✓ 1✗ | · | 12✓ |
| GET | `/api/admin/security/ip-blocks` | · | 3✓ 3✗ | · | 10✓ |
| POST | `/api/admin/security/ip-blocks` | · | 10✓ 9✗ | 1✓ | · |
| POST | `/api/admin/security/ip-blocks/:blockId/release` | · | 1✓ 1✗ | 1✓ | · |
| GET | `/api/admin/staff-permissions` | · | 1✓ 2✗ | · | 20✓ |
| GET | `/api/admin/sub-admins` | · | 1✓ 2✗ | · | 20✓ |
| POST | `/api/admin/sub-admins` | · | 9✓ 7✗ | · | · |
| DELETE | `/api/admin/sub-admins/:subAdminId` | · | 1✓ 4✗ | · | · |
| PUT | `/api/admin/sub-admins/:subAdminId/permissions` | · | 4✓ 8✗ | · | · |
| GET | `/api/admin/support/documents` | · | 1✗ 1‼ | · | 0✗ 9‼ |
| DELETE | `/api/admin/support/documents/:docId` | · | 1✗ | · | · |
| POST | `/api/admin/support/ingest` | · | 1✗ | · | · |
| POST | `/api/admin/support/ingest/knowledge-base` | · | 1✗ | · | · |
| GET | `/api/admin/support/status` | · | 1✓ 1✗ | · | 9✓ |
| GET | `/api/admin/support/tickets` | · | 1✓ 2✗ | · | 8✓ |
| GET | `/api/admin/support/tickets/:id` | · | 2✗ | · | · |
| POST | `/api/admin/support/tickets/:id/reply` | · | 1✗ | · | · |
| GET | `/api/admin/system/config` | · | 14✓ 1✗ | 4✓ 1✗ | 14✓ |
| PUT | `/api/admin/system/config` | · | 11✓ 12✗ | 8✓ | · |
| DELETE | `/api/admin/team-members/:merchantId` | · | 1✓ 1✗ | · | · |
| POST | `/api/admin/team-members/:merchantId/approve` | · | 2✓ 2✗ | · | · |
| POST | `/api/admin/team-members/:merchantId/reject` | · | 1✓ 2✗ | · | · |
| GET | `/api/admin/team-pool-requests` | · | 2✓ 3✗ | 1✓ | 8✓ |
| POST | `/api/admin/team-pool-requests/:requestId/fulfil` | · | 18✓ 17✗ | 2✓ | · |
| POST | `/api/admin/team-pool-requests/:requestId/reject` | · | 3✓ 3✗ | · | · |
| GET | `/api/admin/team-red-flags` | · | 2✓ 1✗ | · | 8✓ |
| GET | `/api/admin/teams` | · | 2✓ 2✗ | · | 9✓ |
| GET | `/api/admin/telegram/bots` | · | 1✓ 1✗ | · | 24✓ |
| POST | `/api/admin/telegram/bots` | · | 1✗ | · | · |
| POST | `/api/admin/telegram/bots/:id/promote` | · | 1✗ | · | · |
| POST | `/api/admin/telegram/bots/:id/retire` | · | 1✗ | · | 3✗ |
| POST | `/api/admin/telegram/bots/:id/webhook` | · | 1✗ | · | 0✗ 3‼ |
| POST | `/api/admin/telegram/channel` | · | 1✗ | · | · |
| GET | `/api/admin/telegram/config` | · | 1✓ 1✗ | · | 23✓ |
| POST | `/api/admin/telegram/config` | · | 1✗ | · | · |
| GET | `/api/admin/telegram/templates` | · | 1✓ 1✗ | · | 24✓ |
| PUT | `/api/admin/telegram/templates/:key` | · | 1✗ | · | · |
| GET | `/api/admin/transactions` | · | 1✓ 1✗ | · | 16✓ |
| GET | `/api/admin/users` | · | 4✓ 4✗ | 2✗ | 60✓ |
| DELETE | `/api/admin/users/:userId` | · | 5✓ 6✗ | · | · |
| GET | `/api/admin/users/:userId` | · | 2✓ 3✗ | · | · |
| PUT | `/api/admin/users/:userId/block` | · | 6✓ 2✗ | 1✓ | · |
| POST | `/api/admin/users/:userId/clear-flag` | · | 4✓ 3✗ | · | · |
| POST | `/api/admin/users/:userId/phantom-access` | · | 2✓ 2✗ | · | · |
| POST | `/api/admin/users/:userId/queue-manager` | · | 2✓ 2✗ | · | · |
| GET | `/api/admin/users/:userId/transactions` | · | 1✓ 1✗ | · | 3✓ |
| PUT | `/api/admin/users/:userId/unblock` | · | 9✓ 2✗ | 1✓ | · |
| GET | `/api/admin/users/flagged` | · | 10✓ 1✗ | · | 11✓ |
| GET | `/api/admin/utr-registry` | · | 4✓ 3✗ | · | 1✓ |
| GET | `/api/admin/utr-registry/:utr` | · | 1✓ 3✗ | · | · |
| PUT | `/api/admin/utr-registry/:utr/clear` | · | 2✓ 3✗ | · | · |
| PUT | `/api/admin/utr-registry/:utr/flag` | · | 7✓ 8✗ | · | · |
| GET | `/api/admin/utr/contested` | · | 6✓ 2✗ | · | 11✓ |
| GET | `/api/admin/utr/stats` | · | 3✓ 2✗ | · | 11✓ |
| GET | `/api/admin/utr/user-history/:userId` | · | 2✓ 2✗ | · | · |
| GET | `/api/admin/verification` | · | · | · | 52✓ |
| GET | `/api/announcements` | · | · | 1✓ | 14✓ |
| GET | `/api/app/android/update` | · | 18✓ | · | · |
| POST | `/api/bet/phantom` | · | 4✗ | 1✗ | · |
| POST | `/api/bet/place` | · | 6✓ 6✗ 1‼ | 5✓ 9✗ | · |
| GET | `/api/bonuses/my` | · | 2✓ 2✗ | · | 1✓ |
| GET | `/api/cycles/:cycleId` | · | · | · | · |
| GET | `/api/cycles/active` | · | · | 1✓ | 260✓ |
| GET | `/api/download/android` | · | 2✓ 1✗ | · | · |
| GET | `/api/download/ios` | · | · | · | · |
| GET | `/api/game/admin/categories` | · | · | · | 56✓ |
| POST | `/api/game/admin/categories` | · | 3✓ 2✗ | · | · |
| DELETE | `/api/game/admin/categories/:id` | · | 1✓ 1✗ | · | · |
| PUT | `/api/game/admin/categories/:id` | · | 2✓ 1✗ | · | · |
| GET | `/api/game/admin/game-providers` | · | · | · | 81✓ |
| POST | `/api/game/admin/game-providers` | · | · | · | · |
| DELETE | `/api/game/admin/game-providers/:key` | · | · | · | · |
| PUT | `/api/game/admin/game-providers/:key` | · | · | · | · |
| POST | `/api/game/admin/game-providers/:key/test` | · | · | · | · |
| GET | `/api/game/admin/game-transactions` | · | · | · | 1✓ |
| GET | `/api/game/admin/games` | · | · | · | 56✓ |
| POST | `/api/game/admin/games` | · | 5✓ 4✗ | · | · |
| DELETE | `/api/game/admin/games/:id` | · | 2✓ 1✗ | · | · |
| PUT | `/api/game/admin/games/:id` | · | 1✓ 1✗ | · | · |
| GET | `/api/game/categories` | · | · | · | 22✓ |
| GET | `/api/game/games` | · | · | · | 70✓ |
| POST | `/api/game/launch` | · | 3✗ | · | 18✗ |
| GET | `/api/game/providers` | · | · | · | 39✓ |
| POST | `/api/game/wallet/:providerKey` | · | · | 2✗ | · |
| POST | `/api/internal/error-report` | · | · | · | · |
| GET | `/api/leaderboard/:period` | · | · | · | 14✓ |
| POST | `/api/leaderboard/rebuild` | · | 1✓ 2✗ | · | · |
| POST | `/api/merchant/2fa/activate` | · | 2✓ 2✗ | · | · |
| POST | `/api/merchant/2fa/setup` | · | 3✓ 1✗ | · | 0✗ 1‼ |
| GET | `/api/merchant/2fa/status` | · | 1✓ 1✗ | · | 13✓ |
| POST | `/api/merchant/accept/:id` | · | 80✓ 15✗ | 6✓ 3✗ | · |
| POST | `/api/merchant/auth/login` | · | 4✓ 5✗ | · | · |
| POST | `/api/merchant/auth/login/2fa` | · | 1✓ 2✗ | · | · |
| POST | `/api/merchant/auth/signup` | · | 1✓ 2✗ | · | · |
| PUT | `/api/merchant/cash-ready` | · | 2✓ | 1✓ 1✗ | 2✓ |
| POST | `/api/merchant/confirm/:id` | · | 74✓ 13✗ | 3✓ 2✗ | · |
| GET | `/api/merchant/earnings` | · | · | · | 35✓ |
| GET | `/api/merchant/earnings/weekly` | · | · | · | 47✓ |
| PUT | `/api/merchant/online-status` | · | · | 1✓ | 2✓ |
| POST | `/api/merchant/order-reject-proof/:orderId/upload-url` | · | · | · | · |
| GET | `/api/merchant/orders` | · | 6✓ 1✗ | 3✓ 1✗ | 104✓ |
| POST | `/api/merchant/orders/:id/cash-link` | · | 7✓ 9✗ | 2✓ 2✗ | · |
| POST | `/api/merchant/orders/:id/red-flag` | · | 16✓ 2✗ | · | · |
| POST | `/api/merchant/orders/:id/reject` | · | 32✓ 9✗ | · | · |
| PUT | `/api/merchant/preferences` | · | 4✓ | · | · |
| GET | `/api/merchant/profile` | · | 5✓ 4✗ | 6✓ 2✗ | 122✓ 1847✗ |
| PUT | `/api/merchant/profile` | · | 3✓ 5✗ | · | · |
| POST | `/api/merchant/reject/:id` | · | 14✓ | · | · |
| GET | `/api/merchant/stats` | · | · | · | 35✓ |
| GET | `/api/merchant/supervisor/disputes` | · | 2✓ | · | 1✓ |
| GET | `/api/merchant/supervisor/disputes/:orderId/chat` | · | 2✓ 1✗ | · | · |
| POST | `/api/merchant/supervisor/disputes/:orderId/chat` | · | 1✓ 4✗ | · | · |
| GET | `/api/merchant/supervisor/members/:merchantId/log` | · | 2✓ 4✗ | · | · |
| DELETE | `/api/merchant/supervisor/pool-requests/:requestId` | · | 1✓ 1✗ | · | · |
| POST | `/api/merchant/supervisor/teams` | · | 21✓ 3✗ | · | · |
| DELETE | `/api/merchant/supervisor/teams/:teamId` | · | 1✗ | · | · |
| PUT | `/api/merchant/supervisor/teams/:teamId` | · | 2✗ | · | · |
| POST | `/api/merchant/supervisor/teams/:teamId/members` | · | 5✓ 3✗ | · | · |
| DELETE | `/api/merchant/supervisor/teams/:teamId/members/:merchantId` | · | 1✓ 2✗ | · | · |
| GET | `/api/merchant/supervisor/teams/:teamId/pool` | · | 2✓ 1✗ | 3✓ | · |
| POST | `/api/merchant/supervisor/teams/:teamId/pool-requests` | · | 7✓ 4✗ | 2✓ | · |
| GET | `/api/merchant/team` | · | 14✓ | · | 48✓ |
| GET | `/api/merchant/verification` | · | · | · | 35✓ |
| POST | `/api/payment/deposit/create` | · | 2✓ 7✗ | 6✓ 4✗ | · |
| GET | `/api/payment/order/:orderId` | · | 13✓ 16✗ | 3✓ 2✗ | · |
| POST | `/api/payment/order/:orderId/dispute` | · | 34✓ 25✗ | 1✓ 1✗ | · |
| POST | `/api/payment/order/:orderId/mark-paid` | · | 7✓ 16✗ | 4✓ 4✗ | · |
| POST | `/api/payment/order/:orderId/payment-reference` | · | 3✓ 7✗ | 1✓ | · |
| POST | `/api/payment/order/:orderId/retry` | · | 2✓ 6✗ | · | · |
| GET | `/api/payment/order/:orderId/status` | · | 8✓ 7✗ | 2✓ | · |
| POST | `/api/payment/order/:orderId/utr-grace` | · | 6✓ 8✗ | · | · |
| POST | `/api/payment/order/cancel` | · | 2✓ 4✗ | 2✓ | · |
| GET | `/api/payment/orders` | · | 8✓ 3✗ | 1✗ | 12✓ 1✗ |
| POST | `/api/payment/usdt/deposit/create` | · | 3✗ | 1✓ 3✗ | · |
| POST | `/api/payment/withdrawal/create` | · | 5✗ | 2✓ 3✗ | · |
| GET | `/api/sse/admin/events` | · | 4✓ 1✗ | 2✗ | 9✓ |
| GET | `/api/sse/events` | · | · | 1✓ | 1984✓ |
| GET | `/api/sse/merchant/events` | · | 1✗ | 2✗ | 188✓ 1736✗ |
| POST | `/api/support/ask` | · | 5✗ 11‼ | · | · |
| GET | `/api/support/status` | · | · | · | 2✓ |
| GET | `/api/support/tickets` | · | 2✓ 3✗ | · | 2✓ |
| POST | `/api/support/tickets` | · | 15✓ 9✗ | · | · |
| GET | `/api/support/tickets/:ticketId` | · | 1✓ 5✗ | · | · |
| POST | `/api/support/tickets/:ticketId/reply` | · | 2✓ 9✗ | · | · |
| GET | `/api/telegram/public-config` | · | · | · | 7✓ |
| POST | `/api/telegram/recovery/webhook/:botId` | · | · | 1✗ | · |
| POST | `/api/telegram/webhook/:botId` | · | 3✓ | 2✗ | · |
| PUT | `/api/user/:userId/bank-details` | · | 5✓ 18✗ | 1✗ | · |
| PUT | `/api/user/:userId/profile` | · | 3✓ 6✗ | 1✓ 1✗ | · |
| GET | `/api/user/bet-limits` | · | 1✓ 2✗ | 7✓ 1✗ | 12✓ |
| GET | `/api/user/notifications` | · | 8✓ 3✗ | 1✓ | · |
| POST | `/api/user/notifications/read` | · | 6✓ 4✗ | · | · |
| GET | `/api/user/notifications/unread-count` | · | 3✓ 3✗ | · | 9✓ |
| POST | `/api/user/profile/picture/confirm-upload` | · | 3✗ | · | · |
| POST | `/api/user/profile/picture/upload-url` | · | 3✗ | · | · |
| GET | `/api/user/referrals` | · | 1✓ 2✗ | 2✓ | 9✓ 1✗ |
| GET | `/api/v1/auth/invite/:code` | · | 3✓ | · | · |
| POST | `/api/v1/auth/login` | · | 7✓ 10✗ | 6✗ | · |
| POST | `/api/v1/auth/login/2fa` | · | 1✓ 1✗ | · | · |
| POST | `/api/v1/auth/logout` | · | · | · | · |
| GET | `/api/v1/auth/me` | · | 4✓ 2✗ | 1✗ | 30✓ 2✗ |
| POST | `/api/v1/auth/password/reset` | · | 1✓ | 1✗ | · |
| POST | `/api/v1/auth/register` | · | 14✓ 7✗ | · | · |
| GET | `/api/v1/auth/verification` | · | 2✓ 3✗ | · | 14✓ |
| GET | `/api/v1/content/faq` | · | · | 1✓ | 32✓ |
| GET | `/api/v1/content/support-links` | · | · | 1✓ | 48✓ |
| GET | `/api/v1/game/cycles/history` | · | · | · | 23✓ |
| GET | `/api/v1/health` | · | · | 4✓ | · |
| GET | `/api/v1/system/config` | · | · | 5✓ 1‼ | 576✓ |
| GET | `/api/v1/user/:id/data` | · | 3✗ | 5✗ | 12✓ |
| GET | `/api/v1/user/profile` | · | 1✓ 2✗ | 1✓ 1✗ | 12✓ 1✗ |
| GET | `/api/v1/wallet/ledger` | · | 4✓ 2✗ | · | 1✓ |
| GET | `/api/v1/winners` | · | 1✓ | · | 21✓ |
| GET | `/app-assets/:name` | · | · | 2✗ | 32✓ 21✗ |
| GET | `/health` | · | · | · | · |
| GET | `/health/live` | · | · | · | 25✓ |
| GET | `/health/ready` | · | · | · | · |
| GET | `/merchant/*splat` | · | · | · | · |
| GET | `/metrics` | · | · | · | · |
| GET | `/r/:code` | 12✓ 1‼ | · | · | · |

`n✓` answered below 400, `n✗` refused (4xx), `n‼` 5xx, `·` never reached by that tier.

Requests to routers the server does not mount (a test's own router): 160 across 21 routes — not counted above.

