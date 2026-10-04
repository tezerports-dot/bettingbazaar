# BettingBazaar project handoff (2026-10-04)

This file is everything a new Claude session needs to carry on the
BettingBazaar redesign from Step 2f, the way the work has been done so far.
It assumes no access to the old project's threads, memory or files. The
owner is **Vikram**. Where this file and `CLAUDE.md` disagree on a coding
rule, `CLAUDE.md` wins. Where they disagree on a decision or on what is left,
this file is newer.

A prompt to start the new session is at the end (section 9).

---

## 1. Where things stand

- **Repository:** `tezerports-dot/bettingbazaar`. Default branch `main`.
- **Merged:** PR #201 was merged into `main` on 2026-10-04 as merge commit
  `8cf6083`. Its head was `68f5144`, with CI 9/9 green. It carries Step 1
  (KYC removed) and Steps 2a to 2e: teams, team token pools, routing orders
  to teams, escrow windows and disputes, fixed order sizes with the ATM QR,
  and team commission. `main` now has the trimmed `CLAUDE.md` (about 44 KB,
  rules only).
- **Step 2f** is on branch **`claude/2f-red-flags-wip`**, two commits on top
  of `68f5144` (which is already in `main`). It has no PR yet.
  - `e04c421` Step 2f: red flags and oversight (the build).
  - `e6006c0` 2f: fixes for the eight findings of an independent security
    review. None was high.
  - This file is committed on that branch too.
- **What 2f contains:**
  - Online-time log: `merchant_online_sessions`, written only by triggers on
    `merchants.is_online`.
  - Daily LOW_ACTIVITY red flag: a member whose completed orders AND online
    time are both more than `SystemConfig.redFlags.lowActivityPercent`
    (default 25%) below the team average. It goes to the supervisor and the
    admin. The hourly cron `team-red-flags` evaluates each IST day once.
  - A COMMISSION_FARMING red flag, admin only. **To be removed, see section 2.**
  - Supervisor views: each member's activity, a member's log, and the
    disputes on their teams, with a thread to the dispute manager.
  - Members see team performance.
  - Admins see the red flags and can edit the red-flag settings.
  - The security fixes:
    - Supervisors never see a mobile number, UPI handle, UTR, account
      number, player message or staff notice.
    - One mobile-number rule (`backend/domains/identity/mobileInText.js` plus
      the database's `bb_text_has_a_mobile`) catches every spelling:
      Indian-script digits, two separators, 091.
    - Merchant usernames and team names may not contain a mobile.
    - A supervisor's dispute post is checked in one locked INSERT and capped
      at 50 per dispute.
    - Switching Online off can no longer fail.
    - Only approved members' logs open.
    - A team of two shows its members no team totals.
- **Verified on the branch:**
  - All 72 mutations on changed files KILLED.
  - All 18 gates exit 0, and `audit:map` was regenerated.
  - `test:unit` 892/892 at `e6006c0`.
  - `test:pg` 1,582/1,582 (129 files) at `e6006c0`.
  - Merchant panel 102/102 at `e6006c0` and admin panel 176/176 at
    `e04c421`, both building.
  - Changed tests after the fixes: TeamPage 20/20, teamOversightPg 7/7,
    mobileInText unit and pg, cashLink 21/21.

## 2. What is left in Step 2f, exactly

1. **Remove the commission-farming red flag.**
   - *Why:* on 2026-10-04 at 05:10Z Vikram said the 90:10 deposit/reserve
     split and the winnings fee stop commission farming. The 2e analysis
     agreed at 06:51Z (section 7). Vikram can ask to keep the flag; if he
     does, skip this item.
   - *What to remove:*
     - The `COMMISSION_FARMING` kind: `RED_FLAG_KINDS`, `FARMING_SQL`,
       `TEAM_DAY_SQL` and the farming half of `evaluateRedFlags` in
       `database/repositories/teamOversight.js`. Also the kind in the
       `team_red_flags` CHECK and its `(kind='LOW_ACTIVITY') = (merchant_id
       IS NOT NULL)` CHECK in `database/schema.sql`, written as DROP/ADD so
       the schema converges (CLAUDE.md §32 S31).
     - `farmingMinRounds` and `farmingHedgePercent` from `redFlags` in
       `database/spec/config.spec.js` and from `redFlagSettings`.
     - The two farming inputs in `admin-panel/src/Pages/Settings/SystemSettings.tsx`
       and in `SystemSettingsRedFlags.test.tsx`.
     - "Possible commission farming" in
       `admin-panel/src/Pages/Teams/TeamsManager.tsx` and its test; the
       `FarmingPair` type in `admin-panel/src/types.ts`.
     - The team T farming cases in `backend/tests/routes/teamOversightPg.test.js`
       (players pa to ph and their bets).
     - Mutations M394, M395 and M396. M401's anchor (the supervisor's
       `kinds: [RED_FLAG_KINDS.LOW_ACTIVITY]` filter) can stay if the filter
       stays.
     - The farming wording in CLAUDE.md §2 ("Red flags" row),
       `docs/reference/RULES_BACKGROUND.md` §2 ("Red flags, and what they
       mean") and `docs/PROJECT_STATUS.md` (2f entry).
   - *Keep:* the `kinds` filter on `listRedFlags`, the once-a-day claim and
     everything else.
2. **Run everything:**
   - `npm run test:unit`
   - `DATABASE_URL=postgresql://postgres:postgres@localhost:5432/bb_test npm run test:pg`
   - In `merchant-panel` and `admin-panel`: `npm run build && npx vitest run`
   - The 18 gates in CLAUDE.md "Commands", including `npm run audit:map -- --check`
     (run `npm run audit:map` first if routes or SQL changed).
   - Every mutation whose file or test changed (section 6).
3. **Open a PR** from `claude/2f-red-flags-wip` to `main`. Use the
   description pattern in section 6. Subscribe to its activity, drive CI to
   9/9 green, and fix failures at once. Vikram merges.
4. **Tell Vikram** in one reply: what finished, overall progress, what is
   left, the security findings and their fixes, and the CLAUDE.md §31 table.

## 3. The plan after 2f

- **2g Close-out:**
  - Rewrite the CLAUDE.md §2 rows marked "⚠2c", plus §25 and §26, for the
    new owners (team routing and pool holds replaced per-merchant wallets,
    escrow, ranking, the cash-link queue and the payment-mode switch).
  - Update the docs: PROJECT_STATUS, OPERATIONS_MAP, PANEL_WORKFLOWS and the
    generated reports.
  - Run every gate and every tier (`test:e2e`, the browser tiers if a server
    can be started).
- **Step 3, Telegram Mini App** replaces every bot, on all three panels:
  - One bot per panel, which sends no messages. The Mini App does the
    contact share (proves the mobile), the channel-membership check and
    password reset.
  - "Login with Telegram" beside the password form signs in only when the
    Telegram account is the one whose shared contact matches the account's
    mobile. The Mini App's `initData` is verified on the server with the bot
    token.
  - Delete the sign-in bot fleet, rotation, per-bot webhooks, bot message
    templates and the recovery bots.
  - The Mini App must keep the 2d rule: a buying player sees where to pay
    only after the member accepts.
- **Five notification bots** (transaction status and dispute deadline) are
  a separate later step, and they change Step 3. Nothing more is decided;
  ask Vikram before designing them.

## 4. Decisions and defaults, with dates

All times are UTC. "Owner" means Vikram. A "default" was chosen by Claude and
Vikram can change it.

**Step 2 design (owner, 2026-10-02, two rounds):**
- **Supervisors and members:**
  - A supervisor is a MERCHANT login with a supervisor role, created and
    approved by the admin, on the merchant panel. A supervisor does no
    transactions.
  - Members sign up as merchants; the supervisor adds them by merchant ID
    and the admin approves. A member is in exactly one team.
- **Teams:**
  - Up to 4 teams per supervisor, exactly 10 members each.
  - A team works only with 10. Below 10 it works until midnight IST, then
    takes no new orders until full again. Open orders always finish.
- **Rail:** each supervisor is approved for ONE rail: CASH, UPI_BANK or
  USDT. This replaced the platform payment-mode switch and the gateway
  settings.
- **Team token pool:**
  - There is no security deposit. Each TEAM has a token pool.
  - The supervisor buys tokens from the admin (paid off-platform in INR or
    USDT, recorded by the admin) and can sell them back.
  - A buy holds pool tokens at assignment. A confirmed buy moves them to the
    player; a completed sell moves the player's tokens into the pool.
  - Individual merchants hold no tokens.
- **Routing:**
  - Auto-assign inside the team to an eligible online member with the fewest
    open orders, ties to the one assigned least recently.
  - CASH buys also need the member to press Ready.
  - Concurrency per member: CASH 1, UPI_BANK 3, USDT admin-editable.
  - A CASH member with an open buy gets no sell until it is done.
- **Commission (2e):**
  - Matched volume = min(completed buys, completed sells) in tokens per team.
  - Each rise above the team's high-water mark pays 10% of the rise into the
    team pool from the platform's commission pool.
  - The pay is recorded 16% to the supervisor and 84% equally to the
    members. The tokens stay in the pool.
  - Never partial: a short pool pays nothing and the rise waits.
  - No clawback on a reversed sell.
  - This replaces the old per-merchant engine.
- **Red flag (2f):**
  - Computed daily. A member whose transaction count and active time are
    below the team average by the threshold (admin-editable, default 25%)
    is flagged to the supervisor and the admin.
  - It is a flag only; the supervisor decides.
- **Visibility:**
  - Members see their team's performance.
  - The supervisor sees and manages members, sees all their transaction
    logs, and talks to the dispute manager on members' behalf.
- **Cash link by QR:** on a CASH buy the member scans the ATM's QR in the
  order screen, and the player gets one "Pay ₹amount" button.

**Defaults taken in Step 2:**
- One pool per team.
- A sell holds no pool tokens.
- The USDT order maximum is 10,000 USDT.
- "Until the next day" means until 00:00 IST.
- 2b: admins cannot add pool tokens without a supervisor request first.

**Escrow and disputes (owner, 2026-10-02 21:13):** recorded in
`docs/PROJECT_STATUS.md` §3.10, in the window rows of CLAUDE.md §2. A buy the
member rejects stays in escrow for `rejectedBuyDisputeMinutes`. A sell
marked paid waits at least 60 minutes (`withdrawalHoldMinutes`) before it
settles.

**2d, order sizes and payment (owner, 2026-10-03):**
- **Order sizes:** seven fixed INR sizes, which the admin toggles: CASH
  500, 1,000, 5,000 and 10,000; UPI_BANK 50,000, 1,00,000 and 5,00,000. No
  min/max, no splitting, no CDM.
- **USDT:** buys only, in steps of 100 between 100 and 10,000
  (admin-editable bounds).
- **16:25Z:** every sell (withdrawal) is paid to the player's bank account
  by bank transfer, cash-link sells included. No CDM deposits for sells.
- **16:56Z:** the QR cash link is for buy orders only. The 50,000,
  1,00,000 and 5,00,000 orders are all bank transfer.
- **16:58Z:**
  - On those big orders the buying player sees the assigned member's bank
    account, and a member handling a sell sees the player's bank details.
    This relaxed the privacy rule for bank details only.
  - **Nobody's mobile number may be exposed anywhere.**
- **21:15Z (default from that rule):**
  - Payments-bank accounts (Paytm, Airtel, Jio and the like, whose account
    number is the mobile) are refused.
  - An account number equal to the person's own mobile is refused at any
    bank.
  - A cash QR that pays a mobile handle is refused.
- **21:41Z:**
  - Mobiles typed into account names or a QR's text are refused.
  - Security rule: a buying player sees the payment target (bank account,
    cash QR or USDT address) only after the member accepts. Until then the
    screen says "Waiting for the member to accept…".
    - *Reason:* otherwise a member could take a payment, decline, and the
      order would move to someone else.
    - Step 3 must keep this.

**Security audit (owner, 2026-10-03 11:45Z):**
- The `audit` CI check has ONE recorded exception, for the "braces"
  advisory: a dev/build-tool dependency with no fixed version yet. It lives
  in `scripts/audit-exceptions.json` and is removed once braces ships a fix.
- Auditing runtime dependencies only was rejected as too broad. Never widen
  the exception.

**2e questions (answered 2026-10-04):** see section 7.

**2f defaults chosen by Claude (2026-10-04; Vikram may change any):**
- **Active time:**
  - "Active time" is the time the Online switch is on.
  - The flag needs both measures below the average.
  - A team of fewer than 2 members is skipped.
  - A member approved after the day is not counted.
- **Schedule:** flags are computed once per IST day by an hourly job that
  catches up the last 3 ended days.
- **Who sees what:**
  - Members see team totals, the average and their own figures, never a
    teammate's row.
  - Team totals show only from 3 approved members.
- **Supervisors:**
  - They see member orders with no player detail.
  - They see their own, their member's and the dispute manager's messages.
  - They post only while the dispute is open, at most 50 messages per
    dispute.
- **Notifications:**
  - Flags show on screens only; nothing is sent (notify() is for players).
  - There is no realtime push to the admin for supervisor messages.
- **Names:** merchant usernames and team names may not contain a mobile
  number.

## 5. How Vikram wants work done

These are his standing instructions:
- **After EVERY finished task, send him a reply,** not just a status update:
  what finished, how much is done overall, what is left, and any security
  finding and its fix. He complained when progress only appeared in status
  updates (2026-10-02).
- **Ask him** when a decision is needed. Keep the question short, with
  options and a recommendation.
- **Check every change for security problems before pushing.** An
  independent review pass (a fresh reviewer reading the diff) found real
  issues in both 2d and 2f.
- **Fix problems at once** (CI failures, bugs) without waiting to be asked.
- **Usage:**
  - He is sensitive to plan usage; keep sessions lean.
  - On 2026-10-02 a thread with 7 parallel high-effort helpers used a
    5-hour window in minutes.
  - On 2026-10-02 21:13 he allowed parallel helpers only if quality and
    safety are never compromised. Prefer working alone or with one helper.
- **One fresh session (or thread) per step,** to keep context small. He
  chose this on 2026-10-02 20:26.
- He wanted all remaining work done in as few 5-hour windows as possible.
- He writes informally and quickly. Read for intent, and confirm anything
  that would be hard to undo.

## 6. Practical lessons

- **CLAUDE.md loads at session start from the files on disk.** Start the
  session in a checkout of the branch you will work on, or run
  `git checkout` before the session reads `CLAUDE.md`.
  - In a project thread, clone and check out the branch before
    `register_repo_root`.
  - `main` now has the trimmed CLAUDE.md, about 11k tokens instead of 48k.
- **Local database:** PostgreSQL at
  `postgresql://postgres:postgres@localhost:5432/bb_test`. Set
  `DATABASE_URL` for `test:pg`, the mutation check and any pg test. Tests
  re-apply `database/schema.sql`, which must converge when re-run (§32 S31).
- **Mutation testing** (`node scripts/mutation-check.mjs <ID>`, one id at a
  time; CI runs all of them):
  - After changing code, run EVERY mutation whose file OR test changed.
    Compute the list from `git diff --name-only` against the mutations'
    `file` and `test` fields.
  - A mutation suite must clean up whatever a broken rule let through.
    - Example from 2f: under M412 a signup with a mobile in the username
      succeeded. The leftover row made every later schema apply fail, so all
      following mutations read NOT-MEASURED.
    - The fix: tests delete what they created in `finally`/`afterAll`, even
      when an assertion fails.
  - Never edit or commit files while a mutation run is in flight: it
    rewrites source files temporarily (trap 12).
  - Each anchor must match exactly once (trap 13). The harness applies
    replacements literally.
  - New mutations go at the end of `MUTATIONS`. The last id is **M422**.
- **Tests clean up:**
  - Tests that create orders delete them (a leftover PENDING_QUEUE row
    breaks `retryAndMatchPg`).
  - Tests that write config restore it.
  - Never assert over a shared table without a baseline (trap 10).
  - UTRs in tests must be unique per run, because `utr_registry` keeps every
    claim forever.
- **CI (GitHub Actions, `.github/workflows/ci.yml`), 9 check runs:**
  - `single-store`.
  - `test`: unit, pg, redis, the full mutation check, then every gate.
  - `typecheck-build`: the three panels.
  - `audit (.)`, `audit (user-panel)`, `audit (admin-panel)` and
    `audit (merchant-panel)`, each with the braces exception only.
  - `sbom` and `secret-scan`.
  - The admin panel's `npm run lint` crashes locally (eslint 8 config); it
    is not in CI.
- **Rules worth re-reading in CLAUDE.md before coding:**
  - §2 (one owner per value) and §24 (privacy both ways; no mobile
    anywhere).
  - §31 (every change reports the table) and §32 (ask each shape question).
  - Trap 16 (scope in the WHERE) and S6 (guards in the statement that
    writes).
- **Commit messages:**
  - Plain summary, then the §31 table.
  - End with the attribution lines the session's harness gives.
  - Never put a model name in a commit, PR or code.
- **PR descriptions:**
  - Open with "Before:" and "After:" paragraphs, then "How", a security
    review list, and a verification table (tests, gates, panels, mutations).
  - Say plainly what was not covered, and that the PR is not independently
    reviewed by a human.
- **Pushing:** `git push -u origin <branch>`. Retry only on network errors
  (2s, 4s, 8s, 16s).

## 7. The 2e questions and Vikram's answers

1. **Commission farming.**
   - *The question:* two player accounts run by one team betting against
     each other to grow matched volume.
   - *Vikram (2026-10-04 05:10Z):* "first there is a payout or like fees on
     winning which is admin editable currently at 1%, and to protect from
     commisdsion farming we are using deposit and reserve 90:10 ration and
     reserve is only used 1% ot total bet value so this way no useror
     merchant can exploit our app."
   - *Conclusion (2e thread, 06:51Z):* farming loses money, so no red flag
     is needed.
     - For every ₹100 a fake account deposits, ₹10 goes to its reserve,
       which comes back only as 1% of each later bet.
     - At most about ₹89 can be cashed out after the 1% fee. The team earns
       10% of that, about ₹8.90, but leaves ₹10 stuck in the reserve: down
       about ₹2 per round.
     - This holds even at a 0% fee, as long as the reserve stays at about 9%
       or more.
   - *Result:* the farming flag 2f built is to be removed (section 2,
     item 1) unless Vikram asks to keep it.
   - **Note for Vikram:** the winnings fee is taken when a player sells, and
     the setting starts at 0%, so 1% must be entered in the admin settings.
2. **USDT teams.** There is no USDT sell rail, so USDT teams have no matched
   volume. Vikram picked **"No commission"** on the decision card at
   2026-10-04 05:41Z. That is already how the code works; nothing to change.

## 8. Project instructions to paste (if starting a new project)

```
Project: BettingBazaar redesign, repo tezerports-dot/bettingbazaar (main).
Owner: Vikram. Read docs/HANDOFF.md first, then CLAUDE.md (the only rules
file; it wins on coding rules).
Working rules:
- After every finished task, send me a reply: what finished, overall
  progress, what is left, and any security finding with its fix.
- Ask me when a decision is needed: short question, options, your
  recommendation.
- Check every change for security problems before pushing (an independent
  review pass of the diff).
- Fix CI failures and bugs right away without waiting to be asked.
- Keep usage lean: one fresh session per step, at most one helper, short
  outputs, targeted tests before the full suites.
- Never expose anyone's mobile number anywhere. The audit check's only
  exception is the braces advisory; never widen it.
- PostgreSQL only. Money is integer paise. Run every mutation whose file or
  test changed, and keep CI 9/9 green.
```

## 9. Prompt to start the new session

```
Continue the BettingBazaar redesign from Step 2f. Repo
tezerports-dot/bettingbazaar. Check out branch claude/2f-red-flags-wip
before reading anything, then read docs/HANDOFF.md end to end and follow
it (it records every decision, my working rules and what is left), then
CLAUDE.md. Do section 2 of the handoff: remove the commission-farming red
flag, run all suites, gates and the affected mutations, open a PR from
that branch to main and drive CI green, then report to me as section 5
says. After 2f, do 2g in a fresh session, then Step 3.
```
