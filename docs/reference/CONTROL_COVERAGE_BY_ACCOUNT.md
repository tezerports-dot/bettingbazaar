# Control coverage by account and state

> **GENERATED** by `npm run report:control-gaps` from the control manifests `npm run test:browser`
> writes, one per account (`BB_PROFILE=<name>`) and screen size (`BB_VIEWPORT=phone`), and the drive
> report. Never edit by hand; re-run the inventories and regenerate.
>
> The drive and mutate passes press as ONE account per panel. A control another account is shown
> and the default is not has therefore never been pressed by anything — those are listed under
> **Only here**, and they are the gaps. Nothing here is a claim that a control WORKS (§35).

## Inputs

| Manifest | Account | Viewport | Screens | Controls | Taken |
|---|---|---|---|---|---|
| `controls.manifest.json` | default — the accounts the drive and mutate passes press as | desktop | 69 | 678 | 2026-10-01T09:03:05.401Z |
| `controls.manifest.merchant-offline.json` | **merchant-offline** — a cash merchant who is offline | desktop | 7 | 43 | 2026-10-01T08:51:37.853Z |
| `controls.manifest.merchant-paused.json` | **merchant-paused** — a cash merchant whose assignment is paused (three unpaid buys) | desktop | 7 | 43 | 2026-10-01T09:12:41.023Z |
| `controls.manifest.merchant-pending.json` | **merchant-pending** — a merchant not yet approved | desktop | 7 | 5 | 2026-10-01T08:56:37.113Z |
| `controls.manifest.merchant-suspended.json` | **merchant-suspended** — a merchant an admin has suspended | desktop | 7 | 0 | 2026-10-01T08:52:10.164Z |
| `controls.manifest.merchant-upi.json` | **merchant-upi** — an INR merchant on the UPI rail (no cash denomination) | desktop | 7 | 40 | 2026-10-01T08:51:05.426Z |
| `controls.manifest.merchant-usdt.json` | **merchant-usdt** — a USDT merchant with an address on both chains | desktop | 7 | 38 | 2026-10-01T08:51:21.777Z |
| `controls.manifest.phantom-agent.json` | **phantom-agent** — a phantom agent (phantom_access BOTH) — the only account that sees GHOST MODE | desktop | 16 | 142 | 2026-10-01T09:05:16.444Z |
| `controls.manifest.phone.json` | **default** — the accounts the drive and mutate passes press as | phone | 69 | 660 | 2026-10-01T08:38:06.947Z |
| `controls.manifest.player-blocked.json` | **player-blocked** — a player an admin has blocked | desktop | 16 | 139 | 2026-10-01T08:43:22.101Z |
| `controls.manifest.player-kyc-none.json` | **player-kyc-none** — a player who has not submitted Aadhaar | desktop | 16 | 140 | 2026-10-01T08:41:07.226Z |
| `controls.manifest.player-kyc-pending.json` | **player-kyc-pending** — a player whose Aadhaar is waiting for an admin | desktop | 16 | 140 | 2026-10-01T08:41:40.830Z |
| `controls.manifest.player-kyc-rejected.json` | **player-kyc-rejected** — a player whose Aadhaar was rejected (may resubmit) | desktop | 16 | 140 | 2026-10-01T09:12:57.052Z |
| `controls.manifest.player-unverified.json` | **player-unverified** — a player who has not shared their contact or joined the channel — the gate | desktop | 16 | 142 | 2026-10-01T08:42:48.112Z |
| `controls.manifest.player-zero-balance.json` | **player-zero-balance** — a verified player with no money | desktop | 16 | 140 | 2026-10-01T08:40:34.051Z |
| `controls.manifest.queue-manager.json` | **queue-manager** — a queue manager (no areas; works the payment queue) | desktop | 46 | 70 | 2026-10-01T09:11:18.881Z |
| `controls.manifest.subadmin-all.json` | **subadmin-all** — a sub-admin granted every area | desktop | 46 | 488 | 2026-10-01T09:09:55.598Z |
| `controls.manifest.subadmin-analytics.json` | **subadmin-analytics** — a sub-admin granted only "View analytics" | desktop | 46 | 97 | 2026-10-01T09:07:11.361Z |
| `controls.manifest.subadmin-none.json` | **subadmin-none** — a sub-admin granted no areas | desktop | 46 | 13 | 2026-10-01T09:05:49.554Z |
| `controls.manifest.subadmin-players.json` | **subadmin-players** — a sub-admin granted players, KYC and transactions, nothing that moves money | desktop | 46 | 104 | 2026-10-01T09:08:33.379Z |

Drive report: 991 presses, taken 2026-10-01T09:13:47.570Z.

## Summary

| Account | Panel | Screens | Controls seen | **Only here (never pressed)** | Default's controls not shown | Screens that sent it elsewhere |
|---|---|---|---|---|---|---|
| merchant-offline | merchant-panel | 7 | 43 | **2** | 4 | 1 |
| merchant-paused | merchant-panel | 7 | 43 | **1** | 1 | 1 |
| merchant-pending | merchant-panel | 7 | 5 | **5** | 43 | 6 |
| merchant-suspended | merchant-panel | 7 | 0 | **0** | 43 | 6 |
| merchant-upi | merchant-panel | 7 | 40 | **1** | 4 | 1 |
| merchant-usdt | merchant-panel | 7 | 38 | **1** | 6 | 1 |
| phantom-agent | user-panel | 16 | 142 | **1** | 0 | 1 |
| default (phone) | user-panel, admin-panel, merchant-panel | 69 | 660 | **11** | 30 | 2 |
| player-blocked | user-panel | 16 | 139 | **3** | 5 | 1 |
| player-kyc-none | user-panel | 16 | 140 | **2** | 3 | 1 |
| player-kyc-pending | user-panel | 16 | 140 | **2** | 3 | 1 |
| player-kyc-rejected | user-panel | 16 | 140 | **1** | 1 | 1 |
| player-unverified | user-panel | 16 | 142 | **3** | 2 | 1 |
| player-zero-balance | user-panel | 16 | 140 | **2** | 3 | 1 |
| queue-manager | admin-panel | 46 | 70 | **9** | 476 | 1 |
| subadmin-all | admin-panel | 46 | 488 | **1** | 8 | 0 |
| subadmin-analytics | admin-panel | 46 | 97 | **1** | 435 | 0 |
| subadmin-none | admin-panel | 46 | 13 | **0** | 482 | 0 |
| subadmin-players | admin-panel | 46 | 104 | **15** | 445 | 1 |

Distinct controls that exist only for some non-default account or screen size, and that nothing has pressed: **52** (on 99 screen slots).

The default accounts: 678 controls inventoried; 3 never pressed by the drive at all (absent from its report, or DISABLED/GONE/UNREACHABLE), and 65 deferred to a mutating case (DRIVEN_ELSEWHERE — a pointer, not a proof, §35.1).

## Per account

### merchant-offline

a cash merchant who is offline — merchant-panel, desktop, taken 2026-10-01T08:51:37.853Z.

**Only here, never pressed by anything: 2 distinct control(s), on 4 screen slot(s).** Not shown to this account (the default sees them): 4. Screens that sent it elsewhere: 1.

| Screen(s) | Kind | Control |
|---|---|---|
| `(shell)` | button | E e2e-merch-ibr36c-1 INR operator |
| `/`, `/dashboard`, `(shell)` | button | Go online |

Screens that did not stay where they were opened:

| Opened | Landed on | What it said |
|---|---|---|
| `/` | `/merchant/dashboard` | Settlement: UPI settlement Buy orders are paid to your UPI and confirmed by UTR. Withdrawa |

### merchant-paused

a cash merchant whose assignment is paused (three unpaid buys) — merchant-panel, desktop, taken 2026-10-01T09:12:41.023Z.

**Only here, never pressed by anything: 1 distinct control(s), on 1 screen slot(s).** Not shown to this account (the default sees them): 1. Screens that sent it elsewhere: 1.

| Screen(s) | Kind | Control |
|---|---|---|
| `(shell)` | button | E e2e-merch-10eclj-1 INR operator |

Screens that did not stay where they were opened:

| Opened | Landed on | What it said |
|---|---|---|
| `/` | `/merchant/dashboard` | Settlement: UPI settlement Buy orders are paid to your UPI and confirmed by UTR. Withdrawa |

### merchant-pending

a merchant not yet approved — merchant-panel, desktop, taken 2026-10-01T08:56:37.113Z.

**Only here, never pressed by anything: 5 distinct control(s), on 5 screen slot(s).** Not shown to this account (the default sees them): 43. Screens that sent it elsewhere: 6.

| Screen(s) | Kind | Control |
|---|---|---|
| `/cash-links` | button | Login |
| `/cash-links` | button | Apply as Merchant |
| `/cash-links` | input:text | 10-digit mobile |
| `/cash-links` | input:password | Enter password |
| `/cash-links` | button | Sign in securely *(disabled)* |

Screens that did not stay where they were opened:

| Opened | Landed on | What it said |
|---|---|---|
| `/dashboard` | `/merchant/` |  |
| `/orders` | `/merchant/` |  |
| `/cash-links` | `/merchant/` | BB Token |
| `/history` | `/merchant/` |  |
| `/token-supply` | `/merchant/` |  |
| `/profile` | `/merchant/` |  |

<details><summary>Per screen: controls this account saw against the default</summary>

| Screen | This account | Default | What the screen said |
|---|---|---|---|
| `/` | 0 | 3 |  |
| `/dashboard` | 0 | 3 |  |
| `/orders` | 0 | 9 |  |
| `/cash-links` | 5 | 3 | BB Token |
| `/history` | 0 | 4 |  |
| `/token-supply` | 0 | 3 |  |
| `/profile` | 0 | 9 |  |

</details>

### merchant-suspended

a merchant an admin has suspended — merchant-panel, desktop, taken 2026-10-01T08:52:10.164Z.

**Only here, never pressed by anything: 0 distinct control(s), on 0 screen slot(s).** Not shown to this account (the default sees them): 43. Screens that sent it elsewhere: 6.

Screens that did not stay where they were opened:

| Opened | Landed on | What it said |
|---|---|---|
| `/dashboard` | `/merchant/` |  |
| `/orders` | `/merchant/` |  |
| `/cash-links` | `/merchant/` |  |
| `/history` | `/merchant/` |  |
| `/token-supply` | `/merchant/` |  |
| `/profile` | `/merchant/` |  |

<details><summary>Per screen: controls this account saw against the default</summary>

| Screen | This account | Default | What the screen said |
|---|---|---|---|
| `/` | 0 | 3 |  |
| `/dashboard` | 0 | 3 |  |
| `/orders` | 0 | 9 |  |
| `/cash-links` | 0 | 3 |  |
| `/history` | 0 | 4 |  |
| `/token-supply` | 0 | 3 |  |
| `/profile` | 0 | 9 |  |

</details>

### merchant-upi

an INR merchant on the UPI rail (no cash denomination) — merchant-panel, desktop, taken 2026-10-01T08:51:05.426Z.

**Only here, never pressed by anything: 1 distinct control(s), on 1 screen slot(s).** Not shown to this account (the default sees them): 4. Screens that sent it elsewhere: 1.

| Screen(s) | Kind | Control |
|---|---|---|
| `(shell)` | button | E e2e-merch-y6bfli-1 INR operator |

Screens that did not stay where they were opened:

| Opened | Landed on | What it said |
|---|---|---|
| `/` | `/merchant/dashboard` | Settlement: UPI settlement Buy orders are paid to your UPI and confirmed by UTR. Withdrawa |

<details><summary>Per screen: controls this account saw against the default</summary>

| Screen | This account | Default | What the screen said |
|---|---|---|---|
| `/cash-links` | 0 | 3 | ATM cash rail Not enabled for this account You are not approved for the ATM cash rail. An  |

</details>

### merchant-usdt

a USDT merchant with an address on both chains — merchant-panel, desktop, taken 2026-10-01T08:51:21.777Z.

**Only here, never pressed by anything: 1 distinct control(s), on 1 screen slot(s).** Not shown to this account (the default sees them): 6. Screens that sent it elsewhere: 1.

| Screen(s) | Kind | Control |
|---|---|---|
| `(shell)` | button | E e2e-merch-7e7qrb-1 USDT operator |

Screens that did not stay where they were opened:

| Opened | Landed on | What it said |
|---|---|---|
| `/` | `/merchant/dashboard` | MERCHANT STATUS Online · Accepting orders Go offline Today's earnings 0 BB 0 orders comple |

<details><summary>Per screen: controls this account saw against the default</summary>

| Screen | This account | Default | What the screen said |
|---|---|---|---|
| `/` | 2 | 3 | MERCHANT STATUS Online · Accepting orders Go offline Today's earnings 0 BB 0 orders comple |
| `/dashboard` | 2 | 3 | MERCHANT STATUS Online · Accepting orders Go offline Today's earnings 0 BB 0 orders comple |
| `/cash-links` | 0 | 3 | ATM cash rail Not enabled for this account You are not approved for the ATM cash rail. An  |
| `/profile` | 10 | 9 | Two-factor authentication Required for every merchant account. Not set up Your account mov |

</details>

### phantom-agent

a phantom agent (phantom_access BOTH) — the only account that sees GHOST MODE — user-panel, desktop, taken 2026-10-01T09:05:16.444Z.

**Only here, never pressed by anything: 1 distinct control(s), on 2 screen slot(s).** Not shown to this account (the default sees them): 0. Screens that sent it elsewhere: 1.

| Screen(s) | Kind | Control |
|---|---|---|
| `/`, `/casino` | button | 👻 GHOST MODE OFF |

Screens that did not stay where they were opened:

| Opened | Landed on | What it said |
|---|---|---|
| `/casino` | `/#/` | DELHI BAZAAR vs BOMBAY BAZAAR |

<details><summary>Per screen: controls this account saw against the default</summary>

| Screen | This account | Default | What the screen said |
|---|---|---|---|
| `/` | 17 | 16 | DELHI BAZAAR vs BOMBAY BAZAAR |
| `/casino` | 17 | 16 | DELHI BAZAAR vs BOMBAY BAZAAR |

</details>

### default (phone)

the accounts the drive and mutate passes press as — user-panel, admin-panel, merchant-panel, phone, taken 2026-10-01T08:38:06.947Z.

**Only here, never pressed by anything: 11 distinct control(s), on 12 screen slot(s).** Not shown to this account (the default sees them): 30. Screens that sent it elsewhere: 2.

| Screen(s) | Kind | Control |
|---|---|---|
| `(shell)` | button | 🎲 GAME |
| `(shell)` | button | 📊 RESULTS |
| `(shell)` | button | 💰 WALLET |
| `(shell)` | button | 💡 PROMO |
| `(shell)` | button | 👤 PROFILE |
| `/`, `/casino` | button | 30M D B ANALYTICS ▲ |
| `/` | button | KYC awaiting review 0 |
| `/` | button | Merchant approvals 0 |
| `/` | button | Blocked users 0 |
| `/` | button | Pending KYC 0 |
| `/` | button | Online merchants 3 |

Screens that did not stay where they were opened:

| Opened | Landed on | What it said |
|---|---|---|
| `/casino` | `/#/` | DELHI BAZAAR vs BOMBAY BAZAAR |
| `/` | `/merchant/dashboard` | Settlement: UPI settlement Buy orders are paid to your UPI and confirmed by UTR. Withdrawa |

<details><summary>Per screen: controls this account saw against the default</summary>

| Screen | This account | Default | What the screen said |
|---|---|---|---|
| `/` | 15 | 16 | DELHI BAZAAR vs BOMBAY BAZAAR |
| `/casino` | 15 | 16 | DELHI BAZAAR vs BOMBAY BAZAAR |
| `/live-cycles` | 7 | 10 | Active Cycles 3 Total Book ₹0 Phantom Exposure ₹0 Next Settlement 21:05 Refresh 1MIN_17908 |
| `/cycle-history` | 23 | 48 | Total Cycles 16 1-Min 14 30-Min 2 Full Day 0 Total Paid Out ₹0 Net Revenue ₹0 All 1-Min 30 |
| `/users` | 62 | 153 | Total Users 8 Active 8 Blocked 0 Pending KYC 0 All Active Blocked Suspended Pending KYC PL |
| `/merchants` | 19 | 49 | Merchants 3 Online 3 Approved 3 Pending 0 All Approved Pending Suspended Refresh Create Me |
| `/kyc` | 5 | 14 | Pending Review 3 Oldest In Queue 2h VERIFICATION QUEUE · 3 E e2e-merch-6e17h9-1 +91 91990- |
| `/telegram` | 34 | 40 | Panel User panel Merchant panel Admin panel Each panel has its own bot and its own channel |
| `/sub-admins` | 3 | 16 | Create Sub-Admin Queue managers (0) These accounts assign payment orders to merchants — th |

</details>

### player-blocked

a player an admin has blocked — user-panel, desktop, taken 2026-10-01T08:43:22.101Z.

**Only here, never pressed by anything: 3 distinct control(s), on 4 screen slot(s).** Not shown to this account (the default sees them): 5. Screens that sent it elsewhere: 1.

| Screen(s) | Kind | Control |
|---|---|---|
| `(shell)` | button | ₹ Sign in TO PLAY |
| `/`, `/casino` | button | 30M D B ANALYTICS ▲ |
| `/profile` | button | 🪪 KYC Verification Aadhaar verification status PENDING |

Screens that did not stay where they were opened:

| Opened | Landed on | What it said |
|---|---|---|
| `/casino` | `/#/` | DELHI BAZAAR vs BOMBAY BAZAAR |

### player-kyc-none

a player who has not submitted Aadhaar — user-panel, desktop, taken 2026-10-01T08:41:07.226Z.

**Only here, never pressed by anything: 2 distinct control(s), on 3 screen slot(s).** Not shown to this account (the default sees them): 3. Screens that sent it elsewhere: 1.

| Screen(s) | Kind | Control |
|---|---|---|
| `/`, `/casino` | button | 30M D B ANALYTICS ▲ |
| `/profile` | button | 🪪 KYC Verification Aadhaar verification status PENDING |

Screens that did not stay where they were opened:

| Opened | Landed on | What it said |
|---|---|---|
| `/casino` | `/#/` | DELHI BAZAAR vs BOMBAY BAZAAR |

### player-kyc-pending

a player whose Aadhaar is waiting for an admin — user-panel, desktop, taken 2026-10-01T08:41:40.830Z.

**Only here, never pressed by anything: 2 distinct control(s), on 3 screen slot(s).** Not shown to this account (the default sees them): 3. Screens that sent it elsewhere: 1.

| Screen(s) | Kind | Control |
|---|---|---|
| `/`, `/casino` | button | 30M D B ANALYTICS ▲ |
| `/profile` | button | 🪪 KYC Verification Aadhaar verification status IN REVIEW |

Screens that did not stay where they were opened:

| Opened | Landed on | What it said |
|---|---|---|
| `/casino` | `/#/` | DELHI BAZAAR vs BOMBAY BAZAAR |

### player-kyc-rejected

a player whose Aadhaar was rejected (may resubmit) — user-panel, desktop, taken 2026-10-01T09:12:57.052Z.

**Only here, never pressed by anything: 1 distinct control(s), on 1 screen slot(s).** Not shown to this account (the default sees them): 1. Screens that sent it elsewhere: 1.

| Screen(s) | Kind | Control |
|---|---|---|
| `/profile` | button | 🪪 KYC Verification Aadhaar verification status REJECTED |

Screens that did not stay where they were opened:

| Opened | Landed on | What it said |
|---|---|---|
| `/casino` | `/#/` | DELHI BAZAAR vs BOMBAY BAZAAR |

### player-unverified

a player who has not shared their contact or joined the channel — the gate — user-panel, desktop, taken 2026-10-01T08:42:48.112Z.

**Only here, never pressed by anything: 3 distinct control(s), on 4 screen slot(s).** Not shown to this account (the default sees them): 2. Screens that sent it elsewhere: 1.

| Screen(s) | Kind | Control |
|---|---|---|
| `(shell)` | link | Open @bb_browser_player |
| `(shell)` | button | I've done it — check again |
| `/`, `/casino` | button | 30M D B ANALYTICS ▲ |

Screens that did not stay where they were opened:

| Opened | Landed on | What it said |
|---|---|---|
| `/casino` | `/#/` | DELHI BAZAAR vs BOMBAY BAZAAR |

### player-zero-balance

a verified player with no money — user-panel, desktop, taken 2026-10-01T08:40:34.051Z.

**Only here, never pressed by anything: 2 distinct control(s), on 3 screen slot(s).** Not shown to this account (the default sees them): 3. Screens that sent it elsewhere: 1.

| Screen(s) | Kind | Control |
|---|---|---|
| `(shell)` | button | ₹ ₹0 WALLET |
| `/`, `/casino` | button | 30M D B ANALYTICS ▲ |

Screens that did not stay where they were opened:

| Opened | Landed on | What it said |
|---|---|---|
| `/casino` | `/#/` | DELHI BAZAAR vs BOMBAY BAZAAR |

### queue-manager

a queue manager (no areas; works the payment queue) — admin-panel, desktop, taken 2026-10-01T09:11:18.881Z.

**Only here, never pressed by anything: 9 distinct control(s), on 51 screen slot(s).** Not shown to this account (the default sees them): 476. Screens that sent it elsewhere: 1.

| Screen(s) | Kind | Control |
|---|---|---|
| `/` | button | Pending Queue 0 |
| `/` | button | All Orders 0 |
| `/` | button | Merchant Pool 0 |
| `/` | button | Refresh |
| `/` | button | ALL |
| `/` | button | DEPOSIT |
| `/` | button | WITHDRAWAL |
| `/` | button | Set up the Merchant Pool → |
| 43 screens (`/live-cycles`, `/cycle-history`, `/profit-loss` …) | link | Go to a screen you can use |

Screens that did not stay where they were opened:

| Opened | Landed on | What it said |
|---|---|---|
| `/` | `/admin/#/queue-manager` | Pending Queue 0 All Orders 0 Merchant Pool 0 Refresh Pending 0 Deposits 0 Withdrawals 0 On |

<details><summary>Per screen: controls this account saw against the default</summary>

| Screen | This account | Default | What the screen said |
|---|---|---|---|
| `/` | 8 | 9 | Pending Queue 0 All Orders 0 Merchant Pool 0 Refresh Pending 0 Deposits 0 Withdrawals 0 On |
| `/live-cycles` | 1 | 10 | You don’t have access to this screen |
| `/cycle-history` | 1 | 48 | You don’t have access to this screen |
| `/profit-loss` | 1 | 6 | You don’t have access to this screen |
| `/users` | 1 | 153 | You don’t have access to this screen |
| `/merchants` | 1 | 49 | You don’t have access to this screen |
| `/kyc` | 1 | 14 | You don’t have access to this screen |
| `/merchant-token-orders` | 1 | 2 | You don’t have access to this screen |
| `/users/phantom-agents` | 1 | 2 | You don’t have access to this screen |
| `/kyc/bulk` | 1 | 2 | You don’t have access to this screen |
| `/telegram` | 1 | 40 | You don’t have access to this screen |
| `/referrals` | 1 | 2 | You don’t have access to this screen |
| `/transactions` | 1 | 7 | You don’t have access to this screen |
| `/content/faq` | 1 | 17 | You don’t have access to this screen |
| `/content/slides` | 1 | 4 | You don’t have access to this screen |
| `/content/support` | 1 | 13 | You don’t have access to this screen |
| `/content/cdn` | 1 | 10 | You don’t have access to this screen |
| `/branding` | 1 | 24 | You don’t have access to this screen |
| `/app-assets` | 1 | 4 | You don’t have access to this screen |
| `/android-app` | 1 | 2 | You don’t have access to this screen |
| `/blocked-ips` | 1 | 6 | You don’t have access to this screen |
| `/revenue` | 1 | 7 | You don’t have access to this screen |
| `/operations` | 1 | 5 | You don’t have access to this screen |
| `/token-flow` | 1 | 4 | You don’t have access to this screen |
| `/support-assistant` | 1 | 7 | You don’t have access to this screen |
| `/reports` | 1 | 7 | You don’t have access to this screen |
| `/merchant-platform` | 1 | 19 | You don’t have access to this screen |
| `/business-policy/deposit` | 1 | 3 | You don’t have access to this screen |
| `/business-policy/settlement-rail` | 1 | 11 | You don’t have access to this screen |
| `/sub-admins` | 1 | 16 | You don’t have access to this screen |
| `/settings` | 1 | 78 | You don’t have access to this screen |
| `/audit-logs` | 1 | 3 | You don’t have access to this screen |
| `/disputes` | 1 | 2 | You don’t have access to this screen |
| `/disputes/cdm-receipts` | 1 | 4 | You don’t have access to this screen |
| `/disputes/stalled-withdrawals` | 1 | 2 | You don’t have access to this screen |
| `/winners-manager` | 1 | 2 | You don’t have access to this screen |
| `/game-providers` | 1 | 21 | You don’t have access to this screen |
| `/games` | 1 | 47 | You don’t have access to this screen |
| `/payment-control` | 1 | 14 | You don’t have access to this screen |
| `/promotions/announcements` | 1 | 2 | You don’t have access to this screen |
| `/users/balance-adjust` | 1 | 8 | You don’t have access to this screen |

</details>

### subadmin-all

a sub-admin granted every area — admin-panel, desktop, taken 2026-10-01T09:09:55.598Z.

**Only here, never pressed by anything: 1 distinct control(s), on 1 screen slot(s).** Not shown to this account (the default sees them): 8. Screens that sent it elsewhere: 0.

| Screen(s) | Kind | Control |
|---|---|---|
| `/sub-admins` | link | Go to a screen you can use |

<details><summary>Per screen: controls this account saw against the default</summary>

| Screen | This account | Default | What the screen said |
|---|---|---|---|
| `/cycle-history` | 55 | 48 | Total Cycles 48 1-Min 45 30-Min 3 Full Day 0 Total Paid Out ₹0 Net Revenue ₹0 All 1-Min 30 |
| `/users` | 188 | 153 | Total Users 26 Active 25 Blocked 1 Pending KYC 3 All Active Blocked Suspended Pending KYC  |
| `/users/phantom-agents` | 3 | 2 | Accounts with phantom access |
| `/sub-admins` | 1 | 16 | You don’t have access to this screen |

</details>

### subadmin-analytics

a sub-admin granted only "View analytics" — admin-panel, desktop, taken 2026-10-01T09:07:11.361Z.

**Only here, never pressed by anything: 1 distinct control(s), on 37 screen slot(s).** Not shown to this account (the default sees them): 435. Screens that sent it elsewhere: 0.

| Screen(s) | Kind | Control |
|---|---|---|
| 37 screens (`/users`, `/users/flagged`, `/merchants` …) | link | Go to a screen you can use |

<details><summary>Per screen: controls this account saw against the default</summary>

| Screen | This account | Default | What the screen said |
|---|---|---|---|
| `/live-cycles` | 1 | 10 | Active Cycles 3 Total Book ₹0 Phantom Exposure ₹0 Next Settlement 00:40 Refresh 1MIN_17908 |
| `/cycle-history` | 52 | 48 | Total Cycles 45 1-Min 42 30-Min 3 Full Day 0 Total Paid Out ₹0 Net Revenue ₹0 All 1-Min 30 |
| `/users` | 1 | 153 | You don’t have access to this screen |
| `/merchants` | 1 | 49 | You don’t have access to this screen |
| `/kyc` | 1 | 14 | You don’t have access to this screen |
| `/merchant-token-orders` | 1 | 2 | You don’t have access to this screen |
| `/users/phantom-agents` | 1 | 2 | You don’t have access to this screen |
| `/kyc/bulk` | 1 | 2 | You don’t have access to this screen |
| `/telegram` | 1 | 40 | You don’t have access to this screen |
| `/referrals` | 1 | 2 | You don’t have access to this screen |
| `/transactions` | 1 | 7 | You don’t have access to this screen |
| `/queue-manager` | 1 | 8 | You don’t have access to this screen |
| `/content/faq` | 1 | 17 | You don’t have access to this screen |
| `/content/slides` | 1 | 4 | You don’t have access to this screen |
| `/content/support` | 1 | 13 | You don’t have access to this screen |
| `/content/cdn` | 1 | 10 | You don’t have access to this screen |
| `/branding` | 1 | 24 | You don’t have access to this screen |
| `/app-assets` | 1 | 4 | You don’t have access to this screen |
| `/android-app` | 1 | 2 | You don’t have access to this screen |
| `/blocked-ips` | 1 | 6 | You don’t have access to this screen |
| `/revenue` | 4 | 7 | Refresh Ledger integrity: OK — all postings sum to zero Distributable platform revenue: ₹0 |
| `/support-assistant` | 1 | 7 | You don’t have access to this screen |
| `/reports` | 6 | 7 | Financial Settlement Merchants From To Run 0 ledger entries in period. Account Debits Cred |
| `/merchant-platform` | 1 | 19 | You don’t have access to this screen |
| `/business-policy/deposit` | 1 | 3 | You don’t have access to this screen |
| `/business-policy/settlement-rail` | 1 | 11 | You don’t have access to this screen |
| `/sub-admins` | 1 | 16 | You don’t have access to this screen |
| `/settings` | 1 | 78 | You don’t have access to this screen |
| `/audit-logs` | 1 | 3 | You don’t have access to this screen |
| `/disputes` | 1 | 2 | You don’t have access to this screen |
| `/disputes/cdm-receipts` | 1 | 4 | You don’t have access to this screen |
| `/disputes/stalled-withdrawals` | 1 | 2 | You don’t have access to this screen |
| `/winners-manager` | 1 | 2 | You don’t have access to this screen |
| `/game-providers` | 1 | 21 | You don’t have access to this screen |
| `/games` | 1 | 47 | You don’t have access to this screen |
| `/payment-control` | 1 | 14 | You don’t have access to this screen |
| `/promotions/announcements` | 1 | 2 | You don’t have access to this screen |
| `/users/balance-adjust` | 1 | 8 | You don’t have access to this screen |

</details>

### subadmin-none

a sub-admin granted no areas — admin-panel, desktop, taken 2026-10-01T09:05:49.554Z.

**Only here, never pressed by anything: 0 distinct control(s), on 0 screen slot(s).** Not shown to this account (the default sees them): 482. Screens that sent it elsewhere: 0.

<details><summary>Per screen: controls this account saw against the default</summary>

| Screen | This account | Default | What the screen said |
|---|---|---|---|
| `/` | 3 | 9 | Live metrics are unavailable right now. Cashflow & Settlement Token buy (inflow) vs token  |
| `/live-cycles` | 0 | 10 | You don’t have access to this screen |
| `/cycle-history` | 0 | 48 | You don’t have access to this screen |
| `/profit-loss` | 0 | 6 | You don’t have access to this screen |
| `/users` | 0 | 153 | You don’t have access to this screen |
| `/users/flagged` | 0 | 1 | You don’t have access to this screen |
| `/merchants` | 0 | 49 | You don’t have access to this screen |
| `/kyc` | 0 | 14 | You don’t have access to this screen |
| `/merchant-token-orders` | 0 | 2 | You don’t have access to this screen |
| `/users/phantom-agents` | 0 | 2 | You don’t have access to this screen |
| `/kyc/bulk` | 0 | 2 | You don’t have access to this screen |
| `/telegram` | 0 | 40 | You don’t have access to this screen |
| `/referrals` | 0 | 2 | You don’t have access to this screen |
| `/transactions` | 0 | 7 | You don’t have access to this screen |
| `/queue-manager` | 0 | 8 | You don’t have access to this screen |
| `/content/faq` | 0 | 17 | You don’t have access to this screen |
| `/content/slides` | 0 | 4 | You don’t have access to this screen |
| `/content/support` | 0 | 13 | You don’t have access to this screen |
| `/content/cdn` | 0 | 10 | You don’t have access to this screen |
| `/branding` | 0 | 24 | You don’t have access to this screen |
| `/app-assets` | 0 | 4 | You don’t have access to this screen |
| `/android-app` | 0 | 2 | You don’t have access to this screen |
| `/blocked-ips` | 0 | 6 | You don’t have access to this screen |
| `/revenue` | 0 | 7 | You don’t have access to this screen |
| `/operations` | 0 | 5 | You don’t have access to this screen |
| `/token-flow` | 0 | 4 | You don’t have access to this screen |
| `/support-assistant` | 0 | 7 | You don’t have access to this screen |
| `/reports` | 0 | 7 | You don’t have access to this screen |
| `/merchant-platform` | 0 | 19 | You don’t have access to this screen |
| `/business-policy/deposit` | 0 | 3 | You don’t have access to this screen |
| `/business-policy/settlement-rail` | 0 | 11 | You don’t have access to this screen |
| `/sub-admins` | 0 | 16 | You don’t have access to this screen |
| `/settings` | 0 | 78 | You don’t have access to this screen |
| `/audit-logs` | 0 | 3 | You don’t have access to this screen |
| `/error-logs` | 0 | 1 | You don’t have access to this screen |
| `/disputes` | 0 | 2 | You don’t have access to this screen |
| `/disputes/cdm-receipts` | 0 | 4 | You don’t have access to this screen |
| `/disputes/stalled-withdrawals` | 0 | 2 | You don’t have access to this screen |
| `/winners-manager` | 0 | 2 | You don’t have access to this screen |
| `/chat-management` | 0 | 1 | You don’t have access to this screen |
| `/game-providers` | 0 | 21 | You don’t have access to this screen |
| `/games` | 0 | 47 | You don’t have access to this screen |
| `/payment-control` | 0 | 14 | You don’t have access to this screen |
| `/promotions/announcements` | 0 | 2 | You don’t have access to this screen |
| `/users/balance-adjust` | 0 | 8 | You don’t have access to this screen |

</details>

### subadmin-players

a sub-admin granted players, KYC and transactions, nothing that moves money — admin-panel, desktop, taken 2026-10-01T09:08:33.379Z.

**Only here, never pressed by anything: 15 distinct control(s), on 54 screen slot(s).** Not shown to this account (the default sees them): 445. Screens that sent it elsewhere: 1.

| Screen(s) | Kind | Control |
|---|---|---|
| `/` | button | All |
| `/` | button | Active |
| `/` | button | Blocked |
| `/` | button | Suspended |
| `/` | button | Pending KYC |
| `/` | input:text | Search name, mobile, ID… |
| `/` | button | Details |
| `/` | button | Add Balance |
| `/` | button | Deduct |
| `/` | button | Tx History |
| `/` | button | Bank |
| `/` | button | Phantom Access |
| `/` | button | Block |
| `/` | button | Unblock |
| 40 screens (`/live-cycles`, `/cycle-history`, `/profit-loss` …) | link | Go to a screen you can use |

Screens that did not stay where they were opened:

| Opened | Landed on | What it said |
|---|---|---|
| `/` | `/admin/#/users` | Total Users 25 Active 24 Blocked 1 Pending KYC 3 All Active Blocked Suspended Pending KYC  |

<details><summary>Per screen: controls this account saw against the default</summary>

| Screen | This account | Default | What the screen said |
|---|---|---|---|
| `/` | 181 | 9 | Total Users 25 Active 24 Blocked 1 Pending KYC 3 All Active Blocked Suspended Pending KYC  |
| `/live-cycles` | 1 | 10 | You don’t have access to this screen |
| `/cycle-history` | 1 | 48 | You don’t have access to this screen |
| `/profit-loss` | 1 | 6 | You don’t have access to this screen |
| `/users` | 181 | 153 | Total Users 25 Active 24 Blocked 1 Pending KYC 3 All Active Blocked Suspended Pending KYC  |
| `/merchants` | 1 | 49 | You don’t have access to this screen |
| `/merchant-token-orders` | 1 | 2 | You don’t have access to this screen |
| `/users/phantom-agents` | 1 | 2 | You don’t have access to this screen |
| `/kyc/bulk` | 1 | 2 | You don’t have access to this screen |
| `/telegram` | 1 | 40 | You don’t have access to this screen |
| `/referrals` | 1 | 2 | You don’t have access to this screen |
| `/queue-manager` | 1 | 8 | You don’t have access to this screen |
| `/content/faq` | 1 | 17 | You don’t have access to this screen |
| `/content/slides` | 1 | 4 | You don’t have access to this screen |
| `/content/support` | 1 | 13 | You don’t have access to this screen |
| `/content/cdn` | 1 | 10 | You don’t have access to this screen |
| `/branding` | 1 | 24 | You don’t have access to this screen |
| `/app-assets` | 1 | 4 | You don’t have access to this screen |
| `/android-app` | 1 | 2 | You don’t have access to this screen |
| `/blocked-ips` | 1 | 6 | You don’t have access to this screen |
| `/revenue` | 1 | 7 | You don’t have access to this screen |
| `/operations` | 1 | 5 | You don’t have access to this screen |
| `/token-flow` | 1 | 4 | You don’t have access to this screen |
| `/support-assistant` | 1 | 7 | You don’t have access to this screen |
| `/reports` | 1 | 7 | You don’t have access to this screen |
| `/merchant-platform` | 1 | 19 | You don’t have access to this screen |
| `/business-policy/deposit` | 1 | 3 | You don’t have access to this screen |
| `/business-policy/settlement-rail` | 1 | 11 | You don’t have access to this screen |
| `/sub-admins` | 1 | 16 | You don’t have access to this screen |
| `/settings` | 1 | 78 | You don’t have access to this screen |
| `/audit-logs` | 1 | 3 | You don’t have access to this screen |
| `/disputes` | 1 | 2 | You don’t have access to this screen |
| `/disputes/cdm-receipts` | 1 | 4 | You don’t have access to this screen |
| `/disputes/stalled-withdrawals` | 1 | 2 | You don’t have access to this screen |
| `/winners-manager` | 1 | 2 | You don’t have access to this screen |
| `/game-providers` | 1 | 21 | You don’t have access to this screen |
| `/games` | 1 | 47 | You don’t have access to this screen |
| `/payment-control` | 1 | 14 | You don’t have access to this screen |
| `/promotions/announcements` | 1 | 2 | You don’t have access to this screen |
| `/users/balance-adjust` | 1 | 8 | You don’t have access to this screen |

</details>

## The default accounts: controls the drive never pressed

| Screen | Kind | Control | Drive verdict |
|---|---|---|---|
| `admin-panel/` | button | Online merchants 7 | not in the report |
| `merchant-panel/dashboard` | button | Go offline | not in the report |
| `user-panel/casino` | button | 30M B D B ANALYTICS ▲ | not in the report |

