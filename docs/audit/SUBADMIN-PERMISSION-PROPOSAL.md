# Proposal: permission keys for the 47 sub-admin read routes

**Nothing here is shipped.** Sub-admin accounts are in use, so gating a read a
colleague depends on would blank their screen mid-shift. This is the table to
approve, reject or correct — say "ship it" and it goes in one change.

The four **writes** are already gated (`14e8e9b` and the commit this proposal
ships with). This is only the reads.

## How each row was decided

Not guessed. The admin panel's own `NAV_GROUPS` already declares which key each
screen requires, and `check:ui-coverage` knows which panel file calls which
route — so where a route is reached from a screen, **the proposed key is the key
that screen is already gated on in the panel.** The server was simply the half
that was missing.

Where no screen attribution exists, the rule you chose applies: **full admin,
flagged**. Those rows are marked ⚠ and are the ones worth your eye.

---

## A — Confirmed by the panel's own nav (33 routes)

The panel already refuses these screens without the key. Adding it server-side
changes nothing for anyone whose role is set up correctly.

| Key | Routes |
|---|---|
| `canViewAnalytics` | `/analytics/dashboard`, `/analytics/trends`, `/analytics/deposit-dashboard`, `/analytics/withdrawal-dashboard`, `/analytics/merchant-funding`, `/operations/overview`, `/operations/config-catalog`, `/communication/overview`→`/communication/audit-feed`, `/communication/channels`, `/reports/financial`, `/reports/settlement`, `/reports/merchants`, `/revenue/summary`, `/revenue/ledger`, `/cycles/history`, `/cycles/phases` |
| `canManageUsers` | `/users`, `/users/:userId`, `/users/:userId/transactions`, `/users/flagged`, `/admin/balance-adjustments` |
| `canManageMerchants` | `/merchant-platform/leaderboard`, `/merchant-platform/:merchantId/funding-stats`, `/merchant-platform/:merchantId/performance-history`, `/merchant-platform/:merchantId/wallet-ledger`, `/merchant-commission-policy`, `/merchant-commission-policy/history` |
| `canManageContent` (+ `canManageSupport` alias) | `/promo`, `/content/faq`, `/content/support-links`, `/branding/images`, `/admin/announcements`, `/admin/fake-winners` |
| `canViewTransactions` | `/transactions` |

## B — Full admin, because the panel already treats them as admin-only (11)

Each of these is reached from a screen whose nav entry is `adminOnly: true`.
The server being looser than the panel is the whole finding.

| Routes | The screen |
|---|---|
| `/system/config` | System Settings |
| `/payment-mode`, `/payment-mode/history` | Settlement Rail |
| `/deposit-policy/:currency`, `/deposit-policy/:currency/history` | Deposit Policy |
| `/admin/config` (payment gateway) | Payment System |
| `/admin/games`, `/admin/categories` | Game Registry |
| `/admin/game-providers`, `/admin/game-transactions` | Game Providers |

## C — ⚠ Full admin, flagged: no screen calls these (3)

Per your instruction, these fail closed. **Worth your eye** — if a sub-admin is
meant to use them, say which key and I will change it; if nothing uses them at
all they may be deletion candidates instead.

| Route | Why it is uncertain |
|---|---|

**C is resolved, not decided.** All three routes were gift-code routes, and
the gift-code feature was REMOVED on 2026-09-10 (F-014). The question they
raised — a payout instrument sitting behind `canManageContent`, so whoever
edits FAQ pages can read who was paid — no longer has a subject. It is kept
here because the shape recurs: when a new admin screen moves money, its
permission key is a money key, whatever the nav group it lands in.

---

## What this does not do

- It does not change the four writes — those are already gated.
- It does not add a **gate** that keeps new routes honest. Once this is approved
  I would add one: any route under `/api/admin` carrying bare
  `isAdminOrSubAdmin` fails the build unless it is in a reasoned allow-list.
  That closes the class rather than these 47 instances (audit map §1).
- It does not touch `isAdminOrSubAdminOrQueueManager` routes, which are a
  separate role question.
