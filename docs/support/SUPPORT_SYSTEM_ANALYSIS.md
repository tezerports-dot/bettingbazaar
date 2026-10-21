<!-- GOVERNANCE: Read CLAUDE.md before editing this file. -->
# Support system: what it needs, and what we are building

Written 2026-10-21 for Betting Bazaar. Short version first, details after.

## The short version

- **Two separate desks**: Player Support and Merchant Support. Different queues, different staff permissions, different Telegram support accounts. A player agent never sees merchant tickets and the other way round.
- **The form is the ticket.** The player (or merchant) fills a short form in the app: topic, an optional order/bet ID, and what happened. The server stores it, gives it a short code like `S-7K4Q2`, and assigns it to one of the support Telegram accounts.
- **The conversation happens on Telegram, for free.** After the form, the app shows one button: **Chat on Telegram**. It opens the player's own Telegram with the assigned support account and the message pre-filled with the ticket code. No bot, no webhook, nothing our server has to carry.
- **The agent sees who it really is.** On the desk the agent sees the ticket, the player's Telegram @username (to match the chat), and a masked number `98•••••210`. One click on **Show verified number** shows the full Telegram-verified mobile, and that click is logged.
- **One ticket per day.** A player or merchant can open one support ticket per India day. The database refuses a second one, so it cannot be bypassed by double-tapping or by two phones.
- **Disputes are not chat.** Payment problems on a buy or sell go to the order's Dispute button and the Dispute Managers, as today. The support form says so and has no "payment dispute" topic. Dispute Managers get their own Telegram accounts, shown only on a disputed order, so a player or merchant can reach them when a dispute needs a word.

## Which Telegram option, and why

| Option | What it needs | Verdict |
|---|---|---|
| A. Several support **bots** that receive and forward messages | A webhook or polling loop, bots that message people, storing every chat on our server | Not chosen. CLAUDE.md §2 forbids a webhook and bots that message anybody; it would also make our server carry and store every chat, which costs storage and is a privacy liability. |
| B. **Mini App** chat (chat screen inside our app) | Our server carries every message, live sockets, storage, moderation | Not chosen. This is what costs money per chat, which is what you want to avoid. |
| C. **Form in our app + chat on real Telegram accounts** (one per agent or team, e.g. `@BB_Help_1`, `@BB_Merchant_Help`) | A list of support accounts in the admin panel; a `t.me/<account>?text=<ticket code>` link | **Chosen.** Free, nothing new on the server, works the same in the APK, Android/iOS web app and inside Telegram. Fits §2: no bot, no webhook, nobody is messaged by us. |

Option C needs one rule change in CLAUDE.md, written into the PR: a list of support Telegram accounts (public chat handles the business runs) is allowed. It is not a staff sign-in (staff still have no Telegram login), and no bot sends anything.

**Use dedicated accounts, not personal ones.** Each support Telegram account should be registered on a SIM the business owns, with 2-step verification on, so an agent who leaves does not walk away with the player chats. Telegram Business features (greeting message, quick replies, away hours) are free-to-cheap on these accounts and do the job a support bot would.

## How a ticket flows

1. Player taps **Support**. The help assistant (if switched on) answers common questions first.
2. Player fills the form: topic (Account, Deposit, Withdrawal, Bets & results, Bonus & referral, App problem, Other), optional reference, description (20 to 1,000 characters).
3. The server checks: signed in, Telegram-verified, no ticket opened today. It saves the ticket and assigns the support account with the fewest open tickets for that desk.
4. The app shows the ticket code and **Chat on Telegram**. The message is pre-filled: `Ticket S-7K4Q2`.
5. The agent finds the ticket on the desk by code, matches the @username, clicks **Show verified number** only if needed, helps, and writes a short closing note.
6. The ticket closes. The player sees the status and the closing note in the app, and can rate it 1 to 5.

## How much data moves

| Step | Our server | Telegram |
|---|---|---|
| Open a ticket (form) | about 1 to 2 KB in, 1 KB out | none |
| Player checks ticket status | about 1 KB | none |
| The whole chat (text, photos, voice) | **zero** | all of it, free |
| Agent opens desk (50 tickets) | about 20 KB | none |
| Reveal number | under 1 KB, plus one audit row | none |

So 1,000 tickets a day is roughly 2 to 3 MB of database rows a day. The chat media that would have been the expensive part never touches our storage.

## How much access support staff get (least privilege)

| Data | Support agent | Dispute Manager | Admin |
|---|---|---|---|
| Ticket form, status, notes | Own desk only | No | Yes |
| Telegram @username, account ID, sign-up date | Yes | Yes (on disputes) | Yes |
| Mobile number | Masked; one-click reveal, logged with who and when | Masked; same reveal | Yes |
| Wallet balance, bets, orders | Not on the support desk (the reference the player typed is shown as text) | Full order detail (existing) | Yes |
| Change money, balance, bonus, orders | **Never** | Only through the dispute decision (existing rules) | Yes |
| Bank details, UPI IDs | **Never** | Only on the order in dispute (existing) | Yes |
| Merchant desk tickets | Only with the merchant-support permission | No | Yes |

Rules that go with it:
- Agents never ask for an OTP, password, or money, and never send a payment link. The app tells players this on the ticket screen, and the agent's Telegram greeting says it too. This is the main defence against fake "support" accounts.
- The app only ever shows support accounts from the server, so a player can check that the account they are chatting with is the one their ticket names.
- Every number reveal is stored (agent, ticket, time), so an admin can see who looked at what.

## What kinds of support to start with

Start small and add later:

1. **Self-help first**: the help assistant and FAQ (already built, switched on by API keys).
2. **Ticket + Telegram chat** for account, app, bets, bonus and referral questions (this PR).
3. **Disputes** for any buy/sell money problem (already built; Dispute Managers now also reachable on Telegram from the disputed order).
4. **Merchant support** for pool requests, account approval, routing and payout questions (this PR, separate desk).

Later, when volume needs it: canned replies on the Telegram accounts, published support hours, a first-reply target (for example under 30 minutes in hours), and a weekly report of tickets by topic so the FAQ can answer the top questions.

## History: do we keep 7 days?

Today support tickets are kept forever and the player sees all of them. This PR changes what people see, not what the server keeps:
- The player and merchant see their tickets from the **last 7 days**.
- The desk shows open tickets plus the last 7 days by default. Older closed tickets stay on the server and an admin can still open them with an "Older" filter.
- The chat itself is on Telegram, so the server stores only the form, status and notes. That keeps storage small without losing the record.

The wider "cold history" idea (old rounds, chats and notifications kept only for the server and the admin) is a separate piece of work and is not changed here.
