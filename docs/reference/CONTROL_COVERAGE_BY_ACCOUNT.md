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
| `controls.manifest.json` | default — the accounts the drive and mutate passes press as | desktop | 64 | 609 | 2026-10-04T08:00:36.197Z |
| `controls.manifest.merchant-offline.json` | **merchant-offline** — a cash-team merchant who is offline | desktop | 6 | 37 | 2026-10-04T08:46:24.165Z |
| `controls.manifest.merchant-paused.json` | **merchant-paused** — a cash-team merchant whose assignment is paused (three unpaid buys) | desktop | 6 | 37 | 2026-10-04T08:46:38.796Z |
| `controls.manifest.merchant-supervisor.json` | **merchant-supervisor** — a supervisor running one full cash team, its members offline | desktop | 6 | 66 | 2026-10-04T08:45:39.672Z |
| `controls.manifest.merchant-suspended.json` | **merchant-suspended** — a cash-team merchant an admin suspended while they were signed in | desktop | 1 | 5 | 2026-10-04T08:45:33.210Z |
| `controls.manifest.merchant-upi.json` | **merchant-upi** — an INR merchant in a working UPI/bank team | desktop | 6 | 35 | 2026-10-04T08:45:54.426Z |
| `controls.manifest.merchant-usdt.json` | **merchant-usdt** — a USDT merchant in a working USDT team, with an address on both chains | desktop | 6 | 35 | 2026-10-04T08:46:09.333Z |
| `controls.manifest.phantom-agent.json` | **phantom-agent** — a phantom agent (phantom_access BOTH) — the only account that sees GHOST MODE | desktop | 16 | 147 | 2026-10-04T08:04:51.859Z |
| `controls.manifest.phone.json` | **default** — the accounts the drive and mutate passes press as | phone | 64 | 627 | 2026-10-04T08:02:43.196Z |
| `controls.manifest.player-blocked.json` | **player-blocked** — a player an admin has blocked | desktop | 16 | 137 | 2026-10-04T08:06:30.423Z |
| `controls.manifest.player-unverified.json` | **player-unverified** — a player who has not shared their contact or joined the channel — the gate | desktop | 16 | 147 | 2026-10-04T08:05:57.183Z |
| `controls.manifest.player-zero-balance.json` | **player-zero-balance** — a verified player with no money | desktop | 16 | 145 | 2026-10-04T08:05:24.476Z |
| `controls.manifest.queue-manager.json` | **queue-manager** — a queue manager (no areas; works the payment queue) | desktop | 42 | 62 | 2026-10-04T08:12:06.469Z |
| `controls.manifest.subadmin-all.json` | **subadmin-all** — a sub-admin granted every area | desktop | 42 | 443 | 2026-10-04T08:10:50.170Z |
| `controls.manifest.subadmin-analytics.json` | **subadmin-analytics** — a sub-admin granted only "View analytics" | desktop | 42 | 91 | 2026-10-04T08:08:18.808Z |
| `controls.manifest.subadmin-none.json` | **subadmin-none** — a sub-admin granted no areas | desktop | 42 | 10 | 2026-10-04T08:07:03.122Z |
| `controls.manifest.subadmin-players.json` | **subadmin-players** — a sub-admin granted players and transactions, nothing that moves money | desktop | 42 | 80 | 2026-10-04T08:09:34.846Z |

Drive report: 982 presses, taken 2026-10-04T08:23:03.423Z.

## Summary

| Account | Panel | Screens | Controls seen | **Only here (never pressed)** | Default's controls not shown | Screens that sent it elsewhere |
|---|---|---|---|---|---|---|
| merchant-offline | merchant-panel | 6 | 37 | **2** | 4 | 1 |
| merchant-paused | merchant-panel | 6 | 37 | **1** | 1 | 1 |
| merchant-supervisor | merchant-panel | 6 | 66 | **33** | 6 | 1 |
| merchant-suspended | merchant-panel | 1 | 5 | **5** | 37 | 0 |
| merchant-upi | merchant-panel | 6 | 35 | **1** | 3 | 1 |
| merchant-usdt | merchant-panel | 6 | 35 | **1** | 3 | 1 |
| phantom-agent | user-panel | 16 | 147 | **13** | 5 | 1 |
| default (phone) | user-panel, admin-panel, merchant-panel | 64 | 627 | **27** | 9 | 2 |
| player-blocked | user-panel | 16 | 137 | **13** | 14 | 1 |
| player-unverified | user-panel | 16 | 147 | **14** | 5 | 1 |
| player-zero-balance | user-panel | 16 | 145 | **13** | 6 | 1 |
| queue-manager | admin-panel | 42 | 62 | **7** | 417 | 1 |
| subadmin-all | admin-panel | 42 | 443 | **14** | 5 | 0 |
| subadmin-analytics | admin-panel | 42 | 91 | **2** | 377 | 0 |
| subadmin-none | admin-panel | 42 | 10 | **0** | 424 | 0 |
| subadmin-players | admin-panel | 42 | 80 | **12** | 403 | 1 |

Distinct controls that exist only for some non-default account or screen size, and that nothing has pressed: **94** (on 137 screen slots).

The default accounts: 609 controls inventoried; 10 never pressed by the drive at all (absent from its report, or DISABLED/GONE/UNREACHABLE), and 64 deferred to a mutating case (DRIVEN_ELSEWHERE — a pointer, not a proof, §35.1).

## Per account

### merchant-offline

a cash-team merchant who is offline — merchant-panel, desktop, taken 2026-10-04T08:46:24.165Z.

**Only here, never pressed by anything: 2 distinct control(s), on 4 screen slot(s).** Not shown to this account (the default sees them): 4. Screens that sent it elsewhere: 1.

| Screen(s) | Kind | Control |
|---|---|---|
| `(shell)` | button | E e2e-merch-cdcp17-1 INR operator |
| `/`, `/dashboard`, `(shell)` | button | Go online |

Screens that did not stay where they were opened:

| Opened | Landed on | What it said |
|---|---|---|
| `/` | `/merchant/dashboard` | MERCHANT STATUS Offline · Not accepting Go online Ready for a cash buy Cash team · e2e-tea |

### merchant-paused

a cash-team merchant whose assignment is paused (three unpaid buys) — merchant-panel, desktop, taken 2026-10-04T08:46:38.796Z.

**Only here, never pressed by anything: 1 distinct control(s), on 1 screen slot(s).** Not shown to this account (the default sees them): 1. Screens that sent it elsewhere: 1.

| Screen(s) | Kind | Control |
|---|---|---|
| `(shell)` | button | E e2e-merch-1tuia7-1 INR operator |

Screens that did not stay where they were opened:

| Opened | Landed on | What it said |
|---|---|---|
| `/` | `/merchant/dashboard` | MERCHANT STATUS Online · New orders paused Go offline Ready for a cash buy Cash team · e2e |

### merchant-supervisor

a supervisor running one full cash team, its members offline — merchant-panel, desktop, taken 2026-10-04T08:45:39.672Z.

**Only here, never pressed by anything: 33 distinct control(s), on 35 screen slot(s).** Not shown to this account (the default sees them): 6. Screens that sent it elsewhere: 1.

| Screen(s) | Kind | Control |
|---|---|---|
| `(shell)` | button | E e2e-merch-6gqj34-1 INR operator |
| `/`, `/dashboard`, `(shell)` | button | Go online |
| `/team` | input:text | New team name |
| `/team` | button | Create team *(disabled)* |
| `/team` | select | Request for e2e-team-CASH-6gqj34-3 |
| `/team` | input:text | Tokens for e2e-team-CASH-6gqj34-3 |
| `/team` | input:text | Note for the admin (optional) |
| `/team` | button | Send e2e-team-CASH-6gqj34-3 request *(disabled)* |
| `/team` | button | Show e2e-team-CASH-6gqj34-3 pool history |
| `/team` | button | Log of e2e-merch-6gqj34-10 |
| `/team` | button | Log of e2e-merch-6gqj34-12 |
| `/team` | button | Log of e2e-merch-6gqj34-14 |
| `/team` | button | Log of e2e-merch-6gqj34-16 |
| `/team` | button | Log of e2e-merch-6gqj34-18 |
| `/team` | button | Log of e2e-merch-6gqj34-20 |
| `/team` | button | Log of e2e-merch-6gqj34-22 |
| `/team` | button | Log of e2e-merch-6gqj34-4 |
| `/team` | button | Log of e2e-merch-6gqj34-6 |
| `/team` | button | Log of e2e-merch-6gqj34-8 |
| `/team` | button | Remove e2e-merch-6gqj34-4 |
| `/team` | button | Remove e2e-merch-6gqj34-6 |
| `/team` | button | Remove e2e-merch-6gqj34-8 |
| `/team` | button | Remove e2e-merch-6gqj34-10 |
| `/team` | button | Remove e2e-merch-6gqj34-12 |
| `/team` | button | Remove e2e-merch-6gqj34-14 |
| `/team` | button | Remove e2e-merch-6gqj34-16 |
| `/team` | button | Remove e2e-merch-6gqj34-18 |
| `/team` | button | Remove e2e-merch-6gqj34-20 |
| `/team` | button | Remove e2e-merch-6gqj34-22 |
| `/team` | input:text | Add a member to e2e-team-CASH-6gqj34-3 — their merchant ID |
| `/team` | button | Add *(disabled)* |
| `/team` | input:text | Team name |
| `/team` | button | Rename *(disabled)* |

Screens that did not stay where they were opened:

| Opened | Landed on | What it said |
|---|---|---|
| `/` | `/merchant/dashboard` | MERCHANT STATUS Offline · Not accepting Go online Today's earnings 0 BB 0 orders completed |

<details><summary>Per screen: controls this account saw against the default</summary>

| Screen | This account | Default | What the screen said |
|---|---|---|---|
| `/` | 2 | 3 | MERCHANT STATUS Offline · Not accepting Go online Today's earnings 0 BB 0 orders completed |
| `/dashboard` | 2 | 3 | MERCHANT STATUS Offline · Not accepting Go online Today's earnings 0 BB 0 orders completed |
| `/team` | 32 | 1 | Refresh Your teams Supervisor · rail CASH · up to 4 teams of 10 Your commission 0 tokens N |

</details>

### merchant-suspended

a cash-team merchant an admin suspended while they were signed in — merchant-panel, desktop, taken 2026-10-04T08:45:33.210Z.

**Only here, never pressed by anything: 5 distinct control(s), on 5 screen slot(s).** Not shown to this account (the default sees them): 37. Screens that sent it elsewhere: 0.

| Screen(s) | Kind | Control |
|---|---|---|
| `/` | button | Login |
| `/` | button | Apply as Merchant |
| `/` | input:text | 10-digit mobile |
| `/` | input:password | Enter password |
| `/` | button | Sign in securely *(disabled)* |

<details><summary>Per screen: controls this account saw against the default</summary>

| Screen | This account | Default | What the screen said |
|---|---|---|---|
| `/` | 5 | 3 | BB Token |

</details>

### merchant-upi

an INR merchant in a working UPI/bank team — merchant-panel, desktop, taken 2026-10-04T08:45:54.426Z.

**Only here, never pressed by anything: 1 distinct control(s), on 1 screen slot(s).** Not shown to this account (the default sees them): 3. Screens that sent it elsewhere: 1.

| Screen(s) | Kind | Control |
|---|---|---|
| `(shell)` | button | E e2e-merch-z1w7si-1 INR operator |

Screens that did not stay where they were opened:

| Opened | Landed on | What it said |
|---|---|---|
| `/` | `/merchant/dashboard` | MERCHANT STATUS Online · Accepting orders Go offline Today's earnings 0 BB 0 orders comple |

<details><summary>Per screen: controls this account saw against the default</summary>

| Screen | This account | Default | What the screen said |
|---|---|---|---|
| `/` | 2 | 3 | MERCHANT STATUS Online · Accepting orders Go offline Today's earnings 0 BB 0 orders comple |
| `/dashboard` | 2 | 3 | MERCHANT STATUS Online · Accepting orders Go offline Today's earnings 0 BB 0 orders comple |

</details>

### merchant-usdt

a USDT merchant in a working USDT team, with an address on both chains — merchant-panel, desktop, taken 2026-10-04T08:46:09.333Z.

**Only here, never pressed by anything: 1 distinct control(s), on 1 screen slot(s).** Not shown to this account (the default sees them): 3. Screens that sent it elsewhere: 1.

| Screen(s) | Kind | Control |
|---|---|---|
| `(shell)` | button | E e2e-merch-gyn0zf-1 USDT operator |

Screens that did not stay where they were opened:

| Opened | Landed on | What it said |
|---|---|---|
| `/` | `/merchant/dashboard` | MERCHANT STATUS Online · Accepting orders Go offline Today's earnings 0 BB 0 orders comple |

<details><summary>Per screen: controls this account saw against the default</summary>

| Screen | This account | Default | What the screen said |
|---|---|---|---|
| `/` | 2 | 3 | MERCHANT STATUS Online · Accepting orders Go offline Today's earnings 0 BB 0 orders comple |
| `/dashboard` | 2 | 3 | MERCHANT STATUS Online · Accepting orders Go offline Today's earnings 0 BB 0 orders comple |
| `/profile` | 10 | 9 | Two-factor authentication Required for every merchant account. Not set up Your account mov |

</details>

### phantom-agent

a phantom agent (phantom_access BOTH) — the only account that sees GHOST MODE — user-panel, desktop, taken 2026-10-04T08:04:51.859Z.

**Only here, never pressed by anything: 13 distinct control(s), on 14 screen slot(s).** Not shown to this account (the default sees them): 5. Screens that sent it elsewhere: 1.

| Screen(s) | Kind | Control |
|---|---|---|
| `/`, `/casino` | button | 👻 GHOST MODE OFF |
| `/faq` | button | ALL |
| `/faq` | button | ACCOUNT |
| `/faq` | button | GAMEPLAY |
| `/faq` | button | PAYMENTS |
| `/faq` | button | SUPPORT |
| `/faq` | button | How is my winnings balance different from deposit balance? + |
| `/faq` | button | What is Delhi Bazaar vs Bombay Bazaar? + |
| `/faq` | button | What is a 30-Min cycle? + |
| `/faq` | button | What is the Full-Day (24H) cycle? + |
| `/faq` | button | How do I buy tokens? + |
| `/faq` | button | How do I withdraw winnings? + |
| `/faq` | button | What happens if my deposit is stuck? + |

Screens that did not stay where they were opened:

| Opened | Landed on | What it said |
|---|---|---|
| `/casino` | `/#/` | DELHI BAZAAR vs BOMBAY BAZAAR |

<details><summary>Per screen: controls this account saw against the default</summary>

| Screen | This account | Default | What the screen said |
|---|---|---|---|
| `/` | 17 | 16 | DELHI BAZAAR vs BOMBAY BAZAAR |
| `/casino` | 17 | 16 | DELHI BAZAAR vs BOMBAY BAZAAR |
| `/faq` | 16 | 9 | Help Center |

</details>

### default (phone)

the accounts the drive and mutate passes press as — user-panel, admin-panel, merchant-panel, phone, taken 2026-10-04T08:02:43.196Z.

**Only here, never pressed by anything: 27 distinct control(s), on 27 screen slot(s).** Not shown to this account (the default sees them): 9. Screens that sent it elsewhere: 2.

| Screen(s) | Kind | Control |
|---|---|---|
| `(shell)` | button | 🎲 GAME |
| `(shell)` | button | 📊 RESULTS |
| `(shell)` | button | 💰 WALLET |
| `(shell)` | button | 💡 PROMO |
| `(shell)` | button | 👤 PROFILE |
| `/faq` | button | ALL |
| `/faq` | button | ACCOUNT |
| `/faq` | button | GAMEPLAY |
| `/faq` | button | PAYMENTS |
| `/faq` | button | SUPPORT |
| `/faq` | button | How is my winnings balance different from deposit balance? + |
| `/faq` | button | What is Delhi Bazaar vs Bombay Bazaar? + |
| `/faq` | button | What is a 30-Min cycle? + |
| `/faq` | button | What is the Full-Day (24H) cycle? + |
| `/faq` | button | How do I buy tokens? + |
| `/faq` | button | How do I withdraw winnings? + |
| `/faq` | button | What happens if my deposit is stuck? + |
| `/teams` | button | Remove e2e-merch-krkvsz-1 |
| `/teams` | button | Remove e2e-merch-krkvsz-6 |
| `/teams` | button | Remove e2e-merch-krkvsz-8 |
| `/teams` | button | Remove e2e-merch-krkvsz-10 |
| `/teams` | button | Remove e2e-merch-krkvsz-12 |
| `/teams` | button | Remove e2e-merch-krkvsz-14 |
| `/teams` | button | Remove e2e-merch-krkvsz-16 |
| `/teams` | button | Remove e2e-merch-krkvsz-18 |
| `/teams` | button | Remove e2e-merch-krkvsz-20 |
| `/teams` | button | Remove e2e-merch-krkvsz-22 |

Screens that did not stay where they were opened:

| Opened | Landed on | What it said |
|---|---|---|
| `/casino` | `/#/` | DELHI BAZAAR vs BOMBAY BAZAAR |
| `/` | `/merchant/dashboard` | MERCHANT STATUS Online · Accepting orders Go offline Ready for a cash buy Cash team · e2e- |

<details><summary>Per screen: controls this account saw against the default</summary>

| Screen | This account | Default | What the screen said |
|---|---|---|---|
| `/` | 15 | 16 | DELHI BAZAAR vs BOMBAY BAZAAR |
| `/casino` | 15 | 16 | DELHI BAZAAR vs BOMBAY BAZAAR |
| `/faq` | 16 | 9 | Help Center |
| `/cycle-history` | 10 | 8 | Total Cycles 3 1-Min 3 30-Min 0 Full Day 0 Total Paid Out ₹0 Net Revenue ₹0 All 1-Min 30-M |
| `/users` | 29 | 17 | Total Users 4 Active 4 Blocked 0 All Active Blocked Suspended PLAYER DEPOSIT WINNINGS LOCK |
| `/merchants` | 95 | 51 | Merchants 22 Online 1 Approved 22 Pending 0 All Approved Pending Suspended Refresh Create  |
| `/teams` | 24 | 14 | Make a merchant a supervisor |

</details>

### player-blocked

a player an admin has blocked — user-panel, desktop, taken 2026-10-04T08:06:30.423Z.

**Only here, never pressed by anything: 13 distinct control(s), on 13 screen slot(s).** Not shown to this account (the default sees them): 14. Screens that sent it elsewhere: 1.

| Screen(s) | Kind | Control |
|---|---|---|
| `(shell)` | button | ₹ Sign in TO PLAY |
| `/faq` | button | ALL |
| `/faq` | button | ACCOUNT |
| `/faq` | button | GAMEPLAY |
| `/faq` | button | PAYMENTS |
| `/faq` | button | SUPPORT |
| `/faq` | button | How is my winnings balance different from deposit balance? + |
| `/faq` | button | What is Delhi Bazaar vs Bombay Bazaar? + |
| `/faq` | button | What is a 30-Min cycle? + |
| `/faq` | button | What is the Full-Day (24H) cycle? + |
| `/faq` | button | How do I buy tokens? + |
| `/faq` | button | How do I withdraw winnings? + |
| `/faq` | button | What happens if my deposit is stuck? + |

Screens that did not stay where they were opened:

| Opened | Landed on | What it said |
|---|---|---|
| `/casino` | `/#/` | DELHI BAZAAR vs BOMBAY BAZAAR |

<details><summary>Per screen: controls this account saw against the default</summary>

| Screen | This account | Default | What the screen said |
|---|---|---|---|
| `/wallet` | 10 | 17 | Wallet |
| `/faq` | 16 | 9 | Help Center |

</details>

### player-unverified

a player who has not shared their contact or joined the channel — the gate — user-panel, desktop, taken 2026-10-04T08:05:57.183Z.

**Only here, never pressed by anything: 14 distinct control(s), on 14 screen slot(s).** Not shown to this account (the default sees them): 5. Screens that sent it elsewhere: 1.

| Screen(s) | Kind | Control |
|---|---|---|
| `(shell)` | link | Open @bb_browser_player |
| `(shell)` | button | I've done it — check again |
| `/faq` | button | ALL |
| `/faq` | button | ACCOUNT |
| `/faq` | button | GAMEPLAY |
| `/faq` | button | PAYMENTS |
| `/faq` | button | SUPPORT |
| `/faq` | button | How is my winnings balance different from deposit balance? + |
| `/faq` | button | What is Delhi Bazaar vs Bombay Bazaar? + |
| `/faq` | button | What is a 30-Min cycle? + |
| `/faq` | button | What is the Full-Day (24H) cycle? + |
| `/faq` | button | How do I buy tokens? + |
| `/faq` | button | How do I withdraw winnings? + |
| `/faq` | button | What happens if my deposit is stuck? + |

Screens that did not stay where they were opened:

| Opened | Landed on | What it said |
|---|---|---|
| `/casino` | `/#/` | DELHI BAZAAR vs BOMBAY BAZAAR |

<details><summary>Per screen: controls this account saw against the default</summary>

| Screen | This account | Default | What the screen said |
|---|---|---|---|
| `/faq` | 16 | 9 | Help Center |

</details>

### player-zero-balance

a verified player with no money — user-panel, desktop, taken 2026-10-04T08:05:24.476Z.

**Only here, never pressed by anything: 13 distinct control(s), on 13 screen slot(s).** Not shown to this account (the default sees them): 6. Screens that sent it elsewhere: 1.

| Screen(s) | Kind | Control |
|---|---|---|
| `(shell)` | button | ₹ ₹0 WALLET |
| `/faq` | button | ALL |
| `/faq` | button | ACCOUNT |
| `/faq` | button | GAMEPLAY |
| `/faq` | button | PAYMENTS |
| `/faq` | button | SUPPORT |
| `/faq` | button | How is my winnings balance different from deposit balance? + |
| `/faq` | button | What is Delhi Bazaar vs Bombay Bazaar? + |
| `/faq` | button | What is a 30-Min cycle? + |
| `/faq` | button | What is the Full-Day (24H) cycle? + |
| `/faq` | button | How do I buy tokens? + |
| `/faq` | button | How do I withdraw winnings? + |
| `/faq` | button | What happens if my deposit is stuck? + |

Screens that did not stay where they were opened:

| Opened | Landed on | What it said |
|---|---|---|
| `/casino` | `/#/` | DELHI BAZAAR vs BOMBAY BAZAAR |

<details><summary>Per screen: controls this account saw against the default</summary>

| Screen | This account | Default | What the screen said |
|---|---|---|---|
| `/faq` | 16 | 9 | Help Center |

</details>

### queue-manager

a queue manager (no areas; works the payment queue) — admin-panel, desktop, taken 2026-10-04T08:12:06.469Z.

**Only here, never pressed by anything: 7 distinct control(s), on 45 screen slot(s).** Not shown to this account (the default sees them): 417. Screens that sent it elsewhere: 1.

| Screen(s) | Kind | Control |
|---|---|---|
| `/` | button | Pending Queue 0 |
| `/` | button | All Orders 0 |
| `/` | button | Refresh |
| `/` | button | ALL |
| `/` | button | DEPOSIT |
| `/` | button | WITHDRAWAL |
| 39 screens (`/live-cycles`, `/cycle-history`, `/profit-loss` …) | link | Go to a screen you can use |

Screens that did not stay where they were opened:

| Opened | Landed on | What it said |
|---|---|---|
| `/` | `/admin/#/queue-manager` | Pending Queue 0 All Orders 0 Refresh Pending 0 Deposits 0 Withdrawals 0 Filter: ALL DEPOSI |

<details><summary>Per screen: controls this account saw against the default</summary>

| Screen | This account | Default | What the screen said |
|---|---|---|---|
| `/` | 6 | 7 | Pending Queue 0 All Orders 0 Refresh Pending 0 Deposits 0 Withdrawals 0 Filter: ALL DEPOSI |
| `/live-cycles` | 1 | 10 | You don’t have access to this screen |
| `/cycle-history` | 1 | 8 | You don’t have access to this screen |
| `/profit-loss` | 1 | 6 | You don’t have access to this screen |
| `/users` | 1 | 17 | You don’t have access to this screen |
| `/merchants` | 1 | 51 | You don’t have access to this screen |
| `/teams` | 1 | 14 | You don’t have access to this screen |
| `/telegram` | 1 | 40 | You don’t have access to this screen |
| `/referrals` | 1 | 2 | You don’t have access to this screen |
| `/transactions` | 1 | 7 | You don’t have access to this screen |
| `/content/faq` | 1 | 15 | You don’t have access to this screen |
| `/content/slides` | 1 | 4 | You don’t have access to this screen |
| `/content/support` | 1 | 13 | You don’t have access to this screen |
| `/content/cdn` | 1 | 9 | You don’t have access to this screen |
| `/branding` | 1 | 24 | You don’t have access to this screen |
| `/app-assets` | 1 | 4 | You don’t have access to this screen |
| `/android-app` | 1 | 2 | You don’t have access to this screen |
| `/blocked-ips` | 1 | 6 | You don’t have access to this screen |
| `/revenue` | 1 | 7 | You don’t have access to this screen |
| `/operations` | 1 | 5 | You don’t have access to this screen |
| `/token-flow` | 1 | 4 | You don’t have access to this screen |
| `/support-assistant` | 1 | 7 | You don’t have access to this screen |
| `/reports` | 1 | 7 | You don’t have access to this screen |
| `/merchant-platform` | 1 | 2 | You don’t have access to this screen |
| `/business-policy/deposit` | 1 | 3 | You don’t have access to this screen |
| `/sub-admins` | 1 | 3 | You don’t have access to this screen |
| `/settings` | 1 | 85 | You don’t have access to this screen |
| `/audit-logs` | 1 | 3 | You don’t have access to this screen |
| `/disputes` | 1 | 2 | You don’t have access to this screen |
| `/disputes/stalled-withdrawals` | 1 | 2 | You don’t have access to this screen |
| `/payment-references` | 1 | 5 | You don’t have access to this screen |
| `/winners-manager` | 1 | 2 | You don’t have access to this screen |
| `/game-providers` | 1 | 21 | You don’t have access to this screen |
| `/games` | 1 | 47 | You don’t have access to this screen |
| `/promotions/announcements` | 1 | 2 | You don’t have access to this screen |
| `/users/balance-adjust` | 1 | 8 | You don’t have access to this screen |

</details>

### subadmin-all

a sub-admin granted every area — admin-panel, desktop, taken 2026-10-04T08:10:50.170Z.

**Only here, never pressed by anything: 14 distinct control(s), on 14 screen slot(s).** Not shown to this account (the default sees them): 5. Screens that sent it elsewhere: 0.

| Screen(s) | Kind | Control |
|---|---|---|
| `/` | button | Blocked users 1 |
| `/sub-admins` | link | Go to a screen you can use |
| `/teams` | button | Remove e2e-merch-krkvsz-1 |
| `/teams` | button | Remove e2e-merch-krkvsz-6 |
| `/teams` | button | Remove e2e-merch-krkvsz-8 |
| `/teams` | button | Remove e2e-merch-krkvsz-10 |
| `/teams` | button | Remove e2e-merch-krkvsz-12 |
| `/teams` | button | Remove e2e-merch-krkvsz-14 |
| `/teams` | button | Remove e2e-merch-krkvsz-16 |
| `/teams` | button | Remove e2e-merch-krkvsz-18 |
| `/teams` | button | Remove e2e-merch-krkvsz-20 |
| `/teams` | button | Remove e2e-merch-krkvsz-22 |
| `/users` | button | Unblock |
| `/users/phantom-agents` | button | Change scope |

<details><summary>Per screen: controls this account saw against the default</summary>

| Screen | This account | Default | What the screen said |
|---|---|---|---|
| `/live-cycles` | 7 | 10 | Active Cycles 2 Total Book ₹0 Phantom Exposure ₹0 Next Settlement 19:01 Refresh 30MIN_1791 |
| `/cycle-history` | 18 | 8 | Total Cycles 11 1-Min 11 30-Min 0 Full Day 0 Total Paid Out ₹0 Net Revenue ₹0 All 1-Min 30 |
| `/users` | 77 | 17 | Total Users 12 Active 11 Blocked 1 All Active Blocked Suspended PLAYER DEPOSIT WINNINGS LO |
| `/merchants` | 95 | 51 | Merchants 22 Online 1 Approved 22 Pending 0 All Approved Pending Suspended Refresh Create  |
| `/teams` | 24 | 14 | Make a merchant a supervisor |
| `/users/phantom-agents` | 2 | 1 | Accounts with phantom access |
| `/sub-admins` | 1 | 3 | You don’t have access to this screen |

</details>

### subadmin-analytics

a sub-admin granted only "View analytics" — admin-panel, desktop, taken 2026-10-04T08:08:18.808Z.

**Only here, never pressed by anything: 2 distinct control(s), on 34 screen slot(s).** Not shown to this account (the default sees them): 377. Screens that sent it elsewhere: 0.

| Screen(s) | Kind | Control |
|---|---|---|
| `/` | button | Blocked users 1 |
| 33 screens (`/users`, `/users/flagged`, `/merchants` …) | link | Go to a screen you can use |

<details><summary>Per screen: controls this account saw against the default</summary>

| Screen | This account | Default | What the screen said |
|---|---|---|---|
| `/live-cycles` | 1 | 10 | Active Cycles 3 Total Book ₹0 Phantom Exposure ₹0 Next Settlement 00:33 Refresh 1MIN_17911 |
| `/cycle-history` | 15 | 8 | Total Cycles 8 1-Min 8 30-Min 0 Full Day 0 Total Paid Out ₹0 Net Revenue ₹0 All 1-Min 30-M |
| `/users` | 1 | 17 | You don’t have access to this screen |
| `/merchants` | 1 | 51 | You don’t have access to this screen |
| `/teams` | 1 | 14 | You don’t have access to this screen |
| `/telegram` | 1 | 40 | You don’t have access to this screen |
| `/referrals` | 1 | 2 | You don’t have access to this screen |
| `/transactions` | 1 | 7 | You don’t have access to this screen |
| `/queue-manager` | 1 | 6 | You don’t have access to this screen |
| `/content/faq` | 1 | 15 | You don’t have access to this screen |
| `/content/slides` | 1 | 4 | You don’t have access to this screen |
| `/content/support` | 1 | 13 | You don’t have access to this screen |
| `/content/cdn` | 1 | 9 | You don’t have access to this screen |
| `/branding` | 1 | 24 | You don’t have access to this screen |
| `/app-assets` | 1 | 4 | You don’t have access to this screen |
| `/android-app` | 1 | 2 | You don’t have access to this screen |
| `/blocked-ips` | 1 | 6 | You don’t have access to this screen |
| `/revenue` | 4 | 7 | Refresh Ledger integrity: OK — all postings sum to zero Distributable platform revenue: ₹0 |
| `/support-assistant` | 1 | 7 | You don’t have access to this screen |
| `/reports` | 6 | 7 | Financial Settlement Merchants From To Run 0 ledger entries in period. Account Debits Cred |
| `/merchant-platform` | 1 | 2 | You don’t have access to this screen |
| `/business-policy/deposit` | 1 | 3 | You don’t have access to this screen |
| `/sub-admins` | 1 | 3 | You don’t have access to this screen |
| `/settings` | 1 | 85 | You don’t have access to this screen |
| `/audit-logs` | 1 | 3 | You don’t have access to this screen |
| `/disputes` | 1 | 2 | You don’t have access to this screen |
| `/disputes/stalled-withdrawals` | 1 | 2 | You don’t have access to this screen |
| `/payment-references` | 1 | 5 | You don’t have access to this screen |
| `/winners-manager` | 1 | 2 | You don’t have access to this screen |
| `/game-providers` | 1 | 21 | You don’t have access to this screen |
| `/games` | 1 | 47 | You don’t have access to this screen |
| `/promotions/announcements` | 1 | 2 | You don’t have access to this screen |
| `/users/balance-adjust` | 1 | 8 | You don’t have access to this screen |

</details>

### subadmin-none

a sub-admin granted no areas — admin-panel, desktop, taken 2026-10-04T08:07:03.122Z.

**Only here, never pressed by anything: 0 distinct control(s), on 0 screen slot(s).** Not shown to this account (the default sees them): 424. Screens that sent it elsewhere: 0.

<details><summary>Per screen: controls this account saw against the default</summary>

| Screen | This account | Default | What the screen said |
|---|---|---|---|
| `/` | 0 | 7 | You don’t have access to this screen |
| `/live-cycles` | 0 | 10 | You don’t have access to this screen |
| `/cycle-history` | 0 | 8 | You don’t have access to this screen |
| `/profit-loss` | 0 | 6 | You don’t have access to this screen |
| `/users` | 0 | 17 | You don’t have access to this screen |
| `/users/flagged` | 0 | 1 | You don’t have access to this screen |
| `/merchants` | 0 | 51 | You don’t have access to this screen |
| `/teams` | 0 | 14 | You don’t have access to this screen |
| `/users/phantom-agents` | 0 | 1 | You don’t have access to this screen |
| `/telegram` | 0 | 40 | You don’t have access to this screen |
| `/referrals` | 0 | 2 | You don’t have access to this screen |
| `/transactions` | 0 | 7 | You don’t have access to this screen |
| `/queue-manager` | 0 | 6 | You don’t have access to this screen |
| `/content/faq` | 0 | 15 | You don’t have access to this screen |
| `/content/slides` | 0 | 4 | You don’t have access to this screen |
| `/content/support` | 0 | 13 | You don’t have access to this screen |
| `/content/cdn` | 0 | 9 | You don’t have access to this screen |
| `/branding` | 0 | 24 | You don’t have access to this screen |
| `/app-assets` | 0 | 4 | You don’t have access to this screen |
| `/android-app` | 0 | 2 | You don’t have access to this screen |
| `/blocked-ips` | 0 | 6 | You don’t have access to this screen |
| `/revenue` | 0 | 7 | You don’t have access to this screen |
| `/operations` | 0 | 5 | You don’t have access to this screen |
| `/token-flow` | 0 | 4 | You don’t have access to this screen |
| `/support-assistant` | 0 | 7 | You don’t have access to this screen |
| `/reports` | 0 | 7 | You don’t have access to this screen |
| `/merchant-platform` | 0 | 2 | You don’t have access to this screen |
| `/business-policy/deposit` | 0 | 3 | You don’t have access to this screen |
| `/sub-admins` | 0 | 3 | You don’t have access to this screen |
| `/settings` | 0 | 85 | You don’t have access to this screen |
| `/audit-logs` | 0 | 3 | You don’t have access to this screen |
| `/error-logs` | 0 | 1 | You don’t have access to this screen |
| `/disputes` | 0 | 2 | You don’t have access to this screen |
| `/disputes/stalled-withdrawals` | 0 | 2 | You don’t have access to this screen |
| `/payment-references` | 0 | 5 | You don’t have access to this screen |
| `/winners-manager` | 0 | 2 | You don’t have access to this screen |
| `/chat-management` | 0 | 1 | You don’t have access to this screen |
| `/game-providers` | 0 | 21 | You don’t have access to this screen |
| `/games` | 0 | 47 | You don’t have access to this screen |
| `/promotions/announcements` | 0 | 2 | You don’t have access to this screen |
| `/users/balance-adjust` | 0 | 8 | You don’t have access to this screen |

</details>

### subadmin-players

a sub-admin granted players and transactions, nothing that moves money — admin-panel, desktop, taken 2026-10-04T08:09:34.846Z.

**Only here, never pressed by anything: 12 distinct control(s), on 49 screen slot(s).** Not shown to this account (the default sees them): 403. Screens that sent it elsewhere: 1.

| Screen(s) | Kind | Control |
|---|---|---|
| `/` | button | All |
| `/` | button | Active |
| `/` | button | Blocked |
| `/` | button | Suspended |
| `/` | input:text | Search name, mobile, ID… |
| `/` | button | Details |
| `/` | button | Tx History |
| `/` | button | Bank |
| `/` | button | Block |
| `/`, `/users` | button | Unblock |
| `/` | button | Delete Account |
| 37 screens (`/live-cycles`, `/cycle-history`, `/profit-loss` …) | link | Go to a screen you can use |

Screens that did not stay where they were opened:

| Opened | Landed on | What it said |
|---|---|---|
| `/` | `/admin/#/users` | Total Users 11 Active 10 Blocked 1 All Active Blocked Suspended PLAYER DEPOSIT WINNINGS LO |

<details><summary>Per screen: controls this account saw against the default</summary>

| Screen | This account | Default | What the screen said |
|---|---|---|---|
| `/` | 55 | 7 | Total Users 11 Active 10 Blocked 1 All Active Blocked Suspended PLAYER DEPOSIT WINNINGS LO |
| `/live-cycles` | 1 | 10 | You don’t have access to this screen |
| `/cycle-history` | 1 | 8 | You don’t have access to this screen |
| `/profit-loss` | 1 | 6 | You don’t have access to this screen |
| `/users` | 55 | 17 | Total Users 11 Active 10 Blocked 1 All Active Blocked Suspended PLAYER DEPOSIT WINNINGS LO |
| `/merchants` | 1 | 51 | You don’t have access to this screen |
| `/teams` | 1 | 14 | You don’t have access to this screen |
| `/telegram` | 1 | 40 | You don’t have access to this screen |
| `/referrals` | 1 | 2 | You don’t have access to this screen |
| `/queue-manager` | 1 | 6 | You don’t have access to this screen |
| `/content/faq` | 1 | 15 | You don’t have access to this screen |
| `/content/slides` | 1 | 4 | You don’t have access to this screen |
| `/content/support` | 1 | 13 | You don’t have access to this screen |
| `/content/cdn` | 1 | 9 | You don’t have access to this screen |
| `/branding` | 1 | 24 | You don’t have access to this screen |
| `/app-assets` | 1 | 4 | You don’t have access to this screen |
| `/android-app` | 1 | 2 | You don’t have access to this screen |
| `/blocked-ips` | 1 | 6 | You don’t have access to this screen |
| `/revenue` | 1 | 7 | You don’t have access to this screen |
| `/operations` | 1 | 5 | You don’t have access to this screen |
| `/token-flow` | 1 | 4 | You don’t have access to this screen |
| `/support-assistant` | 1 | 7 | You don’t have access to this screen |
| `/reports` | 1 | 7 | You don’t have access to this screen |
| `/merchant-platform` | 1 | 2 | You don’t have access to this screen |
| `/business-policy/deposit` | 1 | 3 | You don’t have access to this screen |
| `/sub-admins` | 1 | 3 | You don’t have access to this screen |
| `/settings` | 1 | 85 | You don’t have access to this screen |
| `/audit-logs` | 1 | 3 | You don’t have access to this screen |
| `/disputes` | 1 | 2 | You don’t have access to this screen |
| `/disputes/stalled-withdrawals` | 1 | 2 | You don’t have access to this screen |
| `/payment-references` | 1 | 5 | You don’t have access to this screen |
| `/winners-manager` | 1 | 2 | You don’t have access to this screen |
| `/game-providers` | 1 | 21 | You don’t have access to this screen |
| `/games` | 1 | 47 | You don’t have access to this screen |
| `/promotions/announcements` | 1 | 2 | You don’t have access to this screen |
| `/users/balance-adjust` | 1 | 8 | You don’t have access to this screen |

</details>

## The default accounts: controls the drive never pressed

| Screen | Kind | Control | Drive verdict |
|---|---|---|---|
| `admin-panel/` | button | Blocked users 0 | not in the report |
| `admin-panel/` | button | Merchant approvals 0 | not in the report |
| `admin-panel/` | button | Online merchants 1 | not in the report |
| `merchant-panel/dashboard` | button | Go offline | not in the report |
| `user-panel/casino` | button | 30M No results yet ANALYTICS ▲ | not in the report |
| `user-panel/faq` | button | How does Delhi vs Bombay Bazaar work? + | not in the report |
| `user-panel/faq` | button | Is there a minimum bet? + | not in the report |
| `user-panel/faq` | button | What are the two cycle types? + | not in the report |
| `user-panel/faq` | button | When can I withdraw my winnings? + | not in the report |
| `user-panel/faq` | button | Why did the pools disappear before results? + | not in the report |

