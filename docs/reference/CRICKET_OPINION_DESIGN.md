# Cricket opinion trading: design (owner ask, 2026-10-18)

A new in-house game. Players back an opinion on a live cricket match; the odds
come from the money real players have put on each opinion; a player can claim
(cash out) any open position before the poll closes. The rules file (CLAUDE.md
§2, *Cricket opinion polls*) names the owners; this file says how it works and
why.

## 1. How the odds work

Every poll has options (Side A wins, Draw, Side B wins…). The house puts a seed
on every option when the poll opens. The odds shown for option *i* are

    odds_i = (1 − spread) × T / P_i

where `T` is all money on the poll (seeds included) and `P_i` the money on
that option. With a 10 % spread and 1,000 on A, 2,000 on B and 200 on Draw the
odds read A 2.88, B 1.44, Draw 14.40, which is the owner's example.

**A bet's odds are fixed when it is accepted** and are worked out with the
bet's own stake already in the pool, so a big stake moves its own price. That
is what makes a live profit possible: back A early at 2.88, and if A's pool
grows later, your position is worth more than you paid.

### Why the odds are capped

Odds fixed at entry, read straight from the pool ratio, can be farmed. With
10,000 on B, someone drip-feeding small bets onto A (each at A's then-high
price) builds about 40,000 of payouts on A while only 15,000 was ever
staked on the poll. If A wins, the house pays the difference from its own
pocket.

So every bet and every claim is checked against the poll's **book** under the
poll's lock: for every option, *what the house took in − what it has paid in
claims − what it owes if that option wins* must stay at or above
**− the house seed on the poll**. A bet that would break that gets shorter odds
(down to 1.01; below that the option is suspended). So:

* the most the house can lose on one poll is its seed (seed per option ×
  options), set per poll kind on Admin › Cricket;
* in an ordinary book the house keeps about the spread;
* the 1 % winning fee (global) is taken on every winning payout and every
  profitable claim, as on every other game.

A seed of 1 token is too thin: the first real bet would meet the cap at once.
The defaults are 500 tokens per option for match result and toss, 300 for
powerplay and more sixes, 200 for overs, 100 for each player in the player
polls (30 to 50 options) and for the next ball. They are what the house can
lose at most on a poll, and Admin › Cricket shows that figure.

## 2. Claims (cash out) and live profit

The value of an open position is

    claim value = potential payout × q × (1 − claim margin)

where `q` is the option's current share of the pool once this position's own
stake is taken out (`(P_i − stake) / (T − stake)`). The claim margin is an
admin setting, off (0) by default: the spread is already taken on entry, so a
bet claimed straight back loses about the spread (owner, 2026-10-19). The value is also held to the book cap above, and
never exceeds the potential payout. The player sees each position's live
profit or loss and, per match, one **net** figure with one **Claim all**
button.

### Odds and claims change while you tap

The odds on screen are a live reference only. Pressing Bet or Claim asks the
server for a **quote**; the confirm step shows the exact figure, and Confirm
sends it back as the player's minimum (minimum odds for a bet, minimum total
for a claim). The server then:

1. waits the **in-play delay** (admin, default 5 s) — the industry's defence
   against people watching a faster feed;
2. locks the poll (all of a match's polls, in a fixed order, for Claim all);
3. refuses if the poll closed, or if a match event (a ball) reached the
   server after the player pressed: the answer is a fresh quote;
4. recomputes; executes if the figure is at least what the player confirmed
   (a better figure is always given), otherwise answers with the new figure to
   confirm again.

There is no escrow step: the bet or claim and its wallet movement are one
transaction under the poll's lock, so nothing is half done and nothing waits
in a pool that changes underneath it. One poll's operations queue on its row
lock (a few milliseconds each); different polls never wait for each other.

## 3. When each poll takes bets

| Poll | Opens | Closes | Settles |
|---|---|---|---|
| Toss | when the match is published | at the toss, or `tossCloseMinutes` (30) before the start, whichever is first | toss winner and their choice |
| Match result | when the match is published | when the result arrives | official result, Super Over included; abandoned or no result: void, stakes back |
| Next over: odd / even / zero | when the over before it starts | when this over's first ball arrives | runs conceded in the over, extras included; 0 is "Zero", not "Even" |
| Next ball | when the previous delivery's result arrives | after `nextBallWindowSec` (12 s), or when the next delivery arrives | the delivery's result |
| Best batsman | when the playing XIs arrive (after the toss) | when the result arrives | most runs in the match (innings added up); level on runs, fewer balls faced; still level: a dead heat. Void only with no scorecard or no run scored |
| Best bowler | as best batsman | when the result arrives | most wickets in the match; level on wickets, fewer runs conceded; still level: a dead heat. Void only with no scorecard or no wicket to a bowler |
| More sixes | as best batsman | when the result arrives | team A, Level or team B, from the scorecard's sixes |
| Powerplay runs | innings 1 at the toss, innings 2 at the innings break (T20, ODI, T10 only) | at the innings' first ball | runs conceded in overs 1–6 (T20), 1–10 (ODI) or 1–3 (T10), extras included, in ranges (T20 and ODI: under 40, 40–49, 50–59, 60–69, 70+) |

**Player polls never refund for a missing name** (owner, 2026-10-19). The man
of the match, best batsman and best bowler polls list both teams' whole squads
(the playing XIs first, then the rest of each squad, marked "squad", so an
impact or concussion substitute is there), read once from the provider before
the toss, then **Any other player** last. A named winner on neither squad wins
"Any other player". A bet on a squad player who never takes the field simply
loses: the XIs are known when these polls open.

**Dead heat** (owner, 2026-10-19). Players level on both figures share the
win, as bookmakers settle it: each winning bet is paid its odds on its stake
divided by the number of winners (`cricket_bets.dead_heat`), less the winnings
fee on any profit. It costs the house no more than one winner would (the book
bound holds: the dead-heat payout is at most the largest single option's).
An admin can settle any poll as a dead heat by ticking several options.

**Which polls run** is the admin's (`SystemConfig.cricket.polls`, one switch
per kind on Admin › Cricket › Polls & settings). A kind switched off opens no
new poll; polls already open run to their end.

**Why overs close before they start.** Pool odds do not know the score. An
over poll still open at the fifth ball would pay pool odds on a result anyone
counting runs already knows. The over poll therefore takes bets during the
over before it, exactly like the next-ball poll takes bets between balls.

**Next ball.** A delivery is decided in seconds, so the poll takes bets only
in the gap after the previous ball, and every bet also waits the in-play
delay. A bet placed after a ball the feed had not yet reported is refused when
that ball arrives during the delay. The window must be shorter than the gap
between balls (about 35 s), so the default is 12 s plus a 5 s delay.

**Next-ball options** (one wins, in this order of priority): Wicket, No ball,
Wide, then the runs off the delivery (bat, byes and leg byes): 0 (dot), 1, 2,
3, 4, 5 and 6+. A wide or no ball is its own delivery; the next poll is for
the re-bowled ball. Each next-ball poll is named by innings, over and ball
("Innings 1, over 3, ball 4"): the ball number counts the legal balls of the
over so far, so after a wide it stays, and after the sixth legal ball the next
over starts at ball 1 (`nextBallAfter`).

**Claiming.** A player claims one poll's positions with that poll's Claim
button, or every claimable position of the match with Claim all; both are the
same claim (`claimPositions`), the first naming that poll's bets.

**Odd / even / zero.** Zero is even in arithmetic, but a maiden is a different
opinion from "2, 4, 6…", so the three options are Odd, Even (2 or more) and
Zero.

The match result has three options in every format: team A, Draw, team B. A tie
settles on Draw (owner, 2026-10-19). There is no man of the match poll (removed
the same day).

**Only three ball and three over polls on screen** (owner, 2026-10-18). The
match screen shows, for next ball and for overs, the last one settled, the one
live and the one next, never the full list (`playerPolls`, the server sends no
more):

| | Settled | Live | Next |
|---|---|---|---|
| Next ball | the last ball decided, with its result | the ball taking bets now | a placeholder: opens when the live ball is bowled |
| Over | the last over completed, with odd/even/zero | the over being bowled (bets closed, result pending) | the following over, taking bets |

## 4. RTP

The spread is the house's income, and the book cap stops the house losing
more than a seed on any poll, so RTP is not needed to protect the house. It is
kept for the reason the owner gave: when the house wins more than its spread
(its seeds win, or the book lands its way), that extra belongs back to the
players. Cricket has its own fund (`rtp_funds`, game `CRICKET`, VIP; never
shared with a board). Each settled poll adds `RTP × real stakes − paid back`
(wins and claims, net of the fee), one entry per poll. While the fund is on and
above zero, a new poll opens with a lower spread (`spread − RTP boost`, admin,
default 5 points), and the boosted payouts draw the fund down.

## 5. Data feed

Two providers (owner, 2026-10-19), each an adapter in
`backend/domains/cricket/feeds/` behind one door
(`backend/domains/cricket/cricketFeed.js`, `FEED_PROVIDERS`):

* **Sportmonks Cricket API v2** (ball by ball, fixtures by season, toss,
  playing XI, squads by season).
* **EntitySport Cricket API v2** (an Indian provider built for fantasy apps;
  Pro plan for IPL and T20 leagues; scorecard, squads with the XIs marked,
  innings commentary). Built from its documented sample answers and not yet
  run against a live account: watch the first match's feed health.

Others compared (2026-10-19): CricketData.org is cheapest but names the toss
winner by team name, marks no XI; Roanuz and
Sportradar quote prices only on request; Goalserve is an option at about
$125 a month. Adding one is a new adapter and a row in `cricket_feed`.

Each provider's token is saved on Admin › Cricket › Data feed, encrypted, and
never sent back. The fixture list is read from the provider marked active; a
match is always read from the provider it came from
(`cricket_matches.feed_provider`), so switching never strands a match under
way. Only the server calls a provider; players read our own API and SSE. One
cron polls live matches every 4 s and the fixture list every 10 minutes, so
one plan serves any number of players.

## 6. Admin

Admin › Cricket, in four tabs:

* **Matches:** the published matches in order (up and down; unordered ones go
  by start time), each with its polls, real money per option and the book,
  settle (several options for a dead heat) and void; then every fixture the
  active provider lists for two weeks, searched by team, series or ground,
  filtered by format and date, grouped by series, with Publish and Publish the
  whole series, and Read fixtures now.
* **Polls & settings:** the switch (off by default), which poll kinds run and
  their seeds, spread, claim margin, in-play delay, windows, stakes.
* **Data feed:** each provider's token and health, and which one lists the
  fixtures.
* **Report:** what the house kept per poll.

Admin › Boards' RTP card gains the Cricket fund.

## 7. Wallet and books

VIP wallet only; the General wallet plays boards only. A stake is taken from
the pockets by the board rule and goes to the house (`HOUSE_RESERVE`) in the
same transaction; wins, claims and refunds come back from the house, into
winnings. The ledger cron books each settled poll's net to the house
(`CRICKET_POLL_NET`); the P&L, token ledger, player and token CSVs count it.

## 8. Illustrations

None are needed to start: cards use the team logos the feed sends and a
cricket icon. Later, one wide banner per tournament (uploaded on Admin ›
Images) would lift the match cards.
