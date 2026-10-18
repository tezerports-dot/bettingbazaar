# Cricket opinion trading: design (owner ask, 2026-10-18)

A new in-house game. Players back an opinion on a live cricket match; the odds
come from the money real players have put on each opinion; a player can claim
(cash out) any open position before the poll closes. The rules file (CLAUDE.md
§2, *Cricket opinion polls*) names the owners; this file says how it works and
why.

## 1. How the odds work

Every poll has options (Side A wins, Tie, Side B wins…). The house puts a seed
on every option when the poll opens. The odds shown for option *i* are

    odds_i = (1 − spread) × T / P_i

where `T` is all money on the poll (seeds included) and `P_i` the money on
that option. With a 10 % spread and 1,000 on A, 2,000 on B and 200 on Tie the
odds read A 2.88, B 1.44, Tie 14.40, which is the owner's example.

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
The defaults are 500 tokens per option for match result and toss, 200 for man
of the match and overs, 100 for the next ball. They are what the house can
lose at most on a poll, and Admin › Cricket shows that figure.

## 2. Claims (cash out) and live profit

The value of an open position is

    claim value = potential payout × q × (1 − claim margin)

where `q` is the option's current share of the pool once this position's own
stake is taken out (`(P_i − stake) / (T − stake)`). The claim margin is an
admin setting (default 5 %). The value is also held to the book cap above, and
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
| Man of the match | when the playing XIs arrive (after the toss) | when the result arrives | the official award; not announced in 24 h or not on the list: void |
| Best batsman | when the playing XIs arrive (after the toss), every player of both XIs | when the result arrives | most runs in the match (innings added up); level on runs, fewer balls faced; still level, nobody scored, or no scorecard: void, stakes back |
| Best bowler | as best batsman | when the result arrives | most wickets in the match; level on wickets, fewer runs conceded; still level, no wicket to a bowler, or no scorecard: void, stakes back |

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

**Test matches** get a fourth match-result option, Draw.

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

Provider: **Sportmonks Cricket API v2** (from €29 a month, ball by ball,
fixtures by season, toss, playing XI, man of the match). Only the server calls
it, through one adapter (`backend/domains/cricket/cricketFeed.js`); players
read our own API and SSE. The API token is saved on Admin › Cricket,
encrypted, and never sent back. One cron polls live matches every 4 s and the
fixture list every 10 minutes, so one plan serves any number of players.

## 6. Admin

Admin › Cricket: the switch (off by default), spread, claim margin, in-play
delay, windows, seeds per poll kind, the API token; a list of upcoming
fixtures to publish one by one or a whole series at once; the published
matches in order (drag up and down; unordered ones go by start time); each
match's polls with real money per option and the book; void a poll. Admin ›
Boards' RTP card gains the Cricket fund.

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
