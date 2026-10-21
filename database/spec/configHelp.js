// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * database/spec/configHelp.js — what every system setting MEANS, in words an
 * operator can act on, with an example (owner, 2026-10-14: "there was no
 * example no explanation, I need those").
 *
 * One entry per leaf of `SYSTEM_CONFIG_SPEC` (`config.spec.js`), keyed by its
 * dotted path. `configHelp.test.js` holds the two lists equal: a setting
 * declared without help, or help left behind for a removed setting, fails the
 * build. Served beside the config by `GET /api/admin/system/config` as `help`;
 * the admin Settings screens render it under each field (`SettingHelp`) and
 * keep no copy of their own.
 *
 * `what` says what the value changes on the platform; `example` is a value an
 * operator might type and what would happen.
 */

export const SYSTEM_CONFIG_HELP = Object.freeze({
  latestVersion: {
    what: 'The newest player web app version, shown to browser users on the update screen. It does not update the Android app (publish a release on the Android App page for that).',
    example: '1.4.0',
  },
  minVersion: {
    what: 'The oldest player web app version still allowed. A browser still running an older version sees a forced update screen until it reloads. Does not apply to the Android app.',
    example: '1.2.0: a browser on 1.1.9 must tap Update & Restart; 1.2.0 or newer carries on.',
  },
  maintenanceMode: {
    what: 'Switches the player app into maintenance: players see the maintenance message instead of the app, and the server refuses their requests. Staff and merchant panels keep working, and so do the players marked as maintenance testers on their page, so the team can test a release live first.',
    example: 'On during a planned database upgrade; off again when it is done.',
  },
  maintenanceMessage: {
    what: 'The text players read while maintenance mode is on.',
    example: '"We are upgrading our servers. Back by 3:00 PM IST."',
  },
  phantomBetsLabel: {
    what: 'The line players read at the end of the board rules, saying the totals include phantom bets that are never paid out. You can change the wording but not remove it (10 to 160 characters).',
    example: '"Pool totals include phantom bets, which are never paid out."',
  },
  demoResultsOn: {
    what: 'Whether the analytics fill each board’s 1,440-result window with demo results placed before its first real results. Each new real result replaces the oldest demo one; once a board has 1,440 real results none are shown. Demo results are never in the Results list and never affect a round.',
    example: 'On while the platform is new; off to show real results only.',
  },
  iosUrl: {
    what: 'Where iPhone users are sent to get the app. Leave empty while iPhone users install the web app (PWA) from the browser.',
    example: 'https://apps.apple.com/app/id1234567890, or empty.',
  },
  webUrl: {
    what: 'The address of the player web app. It is the link players share with the Share Link button. Update it when your public domain changes.',
    example: 'https://play.example.com',
  },
  apiHost: {
    what: 'Which approved server address player apps are told to use. Only addresses the deployment already serves can be picked; empty means each app keeps its built-in primary address.',
    example: 'api2.example.com, to move every player app to the standby address after api.example.com is blocked.',
  },
  buyOrderSizes: {
    what: 'The order sizes a player may BUY tokens in. Each size is one order and one payment; sizes not ticked are not offered.',
    example: 'Tick 500, 1,000 and 5,000 only: the Buy tab shows just those three buttons.',
  },
  sellOrderSizes: {
    what: 'The order sizes a player may SELL tokens in, the same way as buys.',
    example: 'Untick 500,000: no player can open a ₹5,00,000 sell order.',
  },
  maxBalanceAdjustment: {
    what: 'The most one admin may add to or take from a player in a single manual balance adjustment, in rupees.',
    example: '50000: an adjustment of ₹60,000 is refused; split it or raise this first.',
  },
  'adminTokenSupply.total': {
    what: 'How many tokens exist in total. The platform starts holding all of them; every pool and wallet balance is moved out of this supply, none are ever created.',
    example: '20000000000 (20 billion). Lowering it never takes tokens back from anyone.',
  },
  'merchantOrderLimits.maxConsecutiveRejections': {
    what: 'How many refusals in a row (declines, plus paid buys left unanswered) an agent may make before they are suspended. Any completed order resets the count. Only an admin lifts the suspension.',
    example: '3: an agent who declines three orders in a row is suspended on the third.',
  },
  'merchantOrderLimits.paidResponseMinutes': {
    what: 'After a player taps "I have paid" on a buy, how long the merchant has to confirm or reject it. After that the order goes to the dispute queue and counts as a refusal.',
    example: '30: a buy marked paid at 2:00 and still unanswered at 2:30 goes to a dispute manager.',
  },
  'merchantOrderLimits.utrAfterPaidMinutes': {
    what: 'On a cash buy, how long the player has after tapping Paid to enter the bank reference (UTR). If it never arrives, the order goes to an admin.',
    example: '15: a player who tapped Paid at 2:00 must give the reference by 2:15.',
  },
  'merchantOrderLimits.maxConsecutivePlayerPaymentFailures': {
    what: 'How many buy orders in a row a player may leave unpaid before they are paused from opening new orders for the cool-off below.',
    example: '3: the third unpaid buy in a row starts the cool-off.',
  },
  'merchantOrderLimits.playerOrderLockMinutes': {
    what: 'How long that cool-off lasts. The player cannot open a buy or a sell until it ends; it lifts by itself.',
    example: '60: a player paused at 2:00 can order again at 3:00.',
  },
  'merchantOrderLimits.maxConsecutiveMerchantExpiries': {
    what: 'How many buy orders in a row may expire unpaid at the same agent before orders stop being sent to them. It is not a suspension; an admin or their next completed order clears it.',
    example: '3: if three players in a row cannot pay one agent, that agent stops getting buys until someone checks their QR or bank.',
  },
  'usdtDeposits.paymentWindowMinutes': {
    what: 'How long a player has to send the USDT for a buy to its own address before the order expires.',
    example: '60: an order opened at 10:00 expires at 11:00 if not enough USDT has arrived by then.',
  },
  'usdtDeposits.confirmations': {
    what: 'How many BNB Smart Chain blocks must follow a USDT transfer before it counts and the tokens are credited.',
    example: '15 (about 10 to 45 seconds on BSC). More is safer against a chain reorganisation, and slower.',
  },
  'usdtDeposits.lateWatchHours': {
    what: 'How long after a USDT buy ends its address is still watched, so money sent late is recorded for an admin to sort out.',
    example: '72: a payment arriving two days after the order expired still shows on Admin › USDT Deposits.',
  },
  'usdtBuy.minUsdt': {
    what: 'The smallest USDT buy a player may place. Must be a multiple of 100.',
    example: '200: a 100 USDT buy is refused; 200 and up are allowed.',
  },
  'usdtBuy.maxUsdt': {
    what: 'The largest USDT buy a player may place. Must be a multiple of 100 and not below the minimum.',
    example: '5000: a 6,000 USDT buy is refused.',
  },
  'teamRouting.concurrency.CASH': {
    what: 'How many open cash (ATM) orders one agent may hold at the same time.',
    example: '1: an agent serving a cash order gets no second cash order until it finishes.',
  },
  'teamRouting.concurrency.UPI_BANK': {
    what: 'How many open UPI or bank orders one agent may hold at the same time.',
    example: '3: a fourth UPI order waits for another agent or for one of the three to finish.',
  },
  'teamRouting.assignmentWaitSeconds': {
    what: 'How long an order may wait in the queue for a free agent before it expires and the player is told nobody was available.',
    example: '1500 (25 minutes): an order nobody could take by then expires; nothing is charged.',
  },
  'teamRouting.processingWindowSeconds.CASH': {
    what: 'Once a cash order is assigned to an agent, how long it has to be completed before it expires.',
    example: '900 (15 minutes).',
  },
  'teamRouting.processingWindowSeconds.UPI_BANK': {
    what: 'Once a UPI or bank order is assigned to an agent, how long it has to be completed before it expires.',
    example: '900 (15 minutes).',
  },
  'teamRouting.utrSubmitSeconds': {
    what: 'Extra seconds a player gets to type the payment reference after the order window, so a payment made at the last moment is not lost.',
    example: '60: a reference sent 40 seconds after the window closed is still accepted.',
  },
  merchantBuySizes: {
    what: 'The buy sizes that go to merchant accounts, paid by UPI QR or bank transfer. Every other buy size goes to agents: 500 to 10,000 as cash at an ATM, 50,000 and up by UPI/bank. USDT always goes to agents. A change moves only orders still waiting for a first taker.',
    example: '[50000, 100000, 500000]: big buys to merchant accounts, small ones to agents at an ATM.',
  },
  merchantSellSizes: {
    what: 'The sell sizes that go to merchant accounts, paid out by bank transfer from a merchant account. Every other sell size goes to agents. A change moves only orders still waiting for a first taker.',
    example: '[] : every sell to agents.',
  },
  'merchantRouting.concurrency.DEPOSIT': {
    what: 'How many open buy orders one merchant account may hold at the same time.',
    example: '10: the 11th buy waits for another merchant account.',
  },
  'merchantRouting.concurrency.WITHDRAWAL': {
    what: 'How many open sell orders one merchant account may hold at the same time.',
    example: '10',
  },
  'merchantRouting.assignmentWaitSeconds': {
    what: 'How long an order for merchant accounts may wait for a free one before it expires.',
    example: '1500 (25 minutes).',
  },
  'merchantRouting.processingWindowSeconds.DEPOSIT': {
    what: 'Once a buy is assigned to a merchant account, how long it has to be completed before it expires.',
    example: '900 (15 minutes).',
  },
  'merchantRouting.processingWindowSeconds.WITHDRAWAL': {
    what: 'Once a sell is assigned to a merchant account, how long it has to pay the player before it expires.',
    example: '900 (15 minutes).',
  },
  'directMerchants.commissionPercent': {
    what: 'The commission a merchant account earns, as a percent of each rise in its matched volume, paid into its own pool.',
    example: '10: matched volume rising by ₹1,00,000 pays ₹10,000 commission.',
  },
  'directMerchants.dailyProblemFlagThreshold': {
    what: 'How many problems (refusals, unpaid buys that were its fault, lost disputes) a merchant account may have in one day before it is flagged to admins. A flag only warns; it stops nothing.',
    example: '5: the fifth problem today raises a flag.',
  },
  'referralRewards.levelRupees': {
    what: 'What each level up the invite chain earns, in rupees, when someone verifies with Telegram: level 1 is the person who invited them, level 2 that person\'s inviter, and so on. Add or remove levels (1 to 10). Paid into the General (bonus) balance when you fund the payout queue. 0 pays nothing at that level. Applies to new joiners only: people already in the queue keep the amount they were promised.',
    example: '50, 10: A invites B, B invites C; when C joins, B earns ₹50 (level 1) and A earns ₹10 (level 2).',
  },
  'referralRewards.turnoverMultiplier': {
    what: 'How many times its amount every General bonus (referral and first deposit) must be played (bet) before it unlocks into withdrawable winnings. Set on each bonus when it is paid, so bonuses already paid keep theirs.',
    example: '10: a ₹25 bonus unlocks after ₹250 of bets.',
  },
  'firstDepositBonus.rupees': {
    what: 'What a player receives, in rupees, in their General (bonus) balance when their first buy completes. Paid once per player, never into VIP. It unlocks into withdrawable winnings after the same play requirement as every General bonus. 0 turns it off.',
    example: '100: a new player\'s first buy completes and ₹100 lands in General; it unlocks after ₹1,000 of bets at 10×.',
  },
  'cricket.enabled': {
    what: 'Whether players see Cricket next to Delhi Bazaar and can bet on the published matches. Off hides the game; bets already placed still settle.',
    example: 'On once the data feed token is saved and a match is published.',
  },
  'cricket.spreadPercent': {
    what: 'The house spread on cricket odds: odds = (100% − spread) × all money on the poll ÷ money on that option. It is the house\'s income on every bet.',
    example: '10: 1,000 on A, 2,000 on B and 200 on Tie show A 2.88, B 1.44, Tie 14.40.',
  },
  'cricket.rtpBoostPoints': {
    what: 'While the Cricket RTP fund is on and above zero, new polls open with the spread lowered by this many points, returning the house\'s extra wins to players.',
    example: '5: with a 10% spread, boosted polls open at 5%.',
  },
  'cricket.inPlayDelaySec': {
    what: 'Seconds every cricket bet and claim waits before it is executed. A ball reported during the wait refuses it, so nobody can bet on a ball they have already seen on a faster stream.',
    example: '5: a bet pressed at 12:00:00 is executed at 12:00:05 unless a ball arrived in between.',
  },
  'cricket.comingSoon': {
    what: 'While cricket is switched off, show players the Cricket tab anyway, opening a full-screen "coming soon" image (set it on Admin › Images). Off hides the tab until the game is switched on.',
    example: 'Off (default): no Cricket tab at all until the game is switched on. On: players see Cricket beside Delhi Bazaar and get the coming-soon picture when they tap it.',
  },
  'cricket.claimHoldSec': {
    what: 'Seconds a new cricket bet must stand before it can be claimed, counted from when it was placed. Stops a bot from placing and claiming in the same instant.',
    example: '2: a bet placed at 12:00:05 can be claimed from 12:00:07.',
  },
  'cricket.nextBallWindowSec': {
    what: 'How long the next-ball poll takes bets after the previous ball\'s result arrives. Keep it well under the gap between balls (about 35 seconds).',
    example: '12: bets are taken for 12 seconds after each ball.',
  },
  'cricket.tossCloseMinutes': {
    what: 'The toss poll closes this many minutes before the scheduled start, or at the toss if the feed reports it earlier.',
    example: '30: for a 19:30 start, toss bets close at 19:00.',
  },
  'cricket.minStakeRupees': {
    what: 'The smallest cricket bet, in tokens.',
    example: '10.',
  },
  'cricket.maxStakeRupees': {
    what: 'The largest single cricket bet, in tokens.',
    example: '50000.',
  },
  'cricket.seedRupees.matchResult': {
    what: 'The house seed on every option of a match-result poll, in tokens. It gives the first odds and is the most the house can lose per option; the poll\'s worst case is this × the number of options.',
    example: '500: a three-option poll can cost the house at most 1,500.',
  },
  'cricket.seedRupees.toss': {
    what: 'The house seed on every option of the toss poll, in tokens (four options).',
    example: '500: at most 2,000 on one toss poll.',
  },
  'cricket.seedRupees.topBatsman': {
    what: 'The house seed on every player in the best-batsman poll (most runs in the match), in tokens. Both full squads are listed plus "Any other player", so expect 30 to 50 options.',
    example: '100: with 40 options, at most 4,000.',
  },
  'cricket.seedRupees.topBowler': {
    what: 'The house seed on every player in the best-bowler poll (most wickets in the match), in tokens. Both full squads are listed plus "Any other player", so expect 30 to 50 options.',
    example: '100: with 40 options, at most 4,000.',
  },
  'cricket.seedRupees.over': {
    what: 'The house seed on every option of a next-over odd / even / zero poll, in tokens.',
    example: '200: at most 600 per over.',
  },
  'cricket.seedRupees.ball': {
    what: 'The house seed on every option of a next-ball poll, in tokens (ten options: 0 to 5 runs, 6+, wide, no ball, wicket).',
    example: '100: at most 1,000 per ball.',
  },
  'cricket.seedRupees.powerplay': {
    what: 'The house seed on every runs range of a powerplay poll (runs in the first 6 overs of a T20, 10 of an ODI, 3 of a T10), in tokens.',
    example: '300: five ranges, at most 1,500 per innings.',
  },
  'cricket.seedRupees.mostSixes': {
    what: 'The house seed on every option of the "which team hits more sixes" poll (team A, level, team B), in tokens.',
    example: '300: at most 900 per match.',
  },
  'cricket.polls.toss': { what: 'Open a toss poll (who wins the toss and their choice) for each published match.', example: 'On.' },
  'cricket.polls.matchResult': { what: 'Open a match-result poll for each published match: team A, Draw (a tie counts as a draw), team B.', example: 'On.' },
  'cricket.polls.topBatsman': { what: 'Open a best-batsman poll (most runs in the match) when the teams are announced. Players level on runs and balls share the win (dead heat).', example: 'On.' },
  'cricket.polls.topBowler': { what: 'Open a best-bowler poll (most wickets in the match) when the teams are announced. Players level on wickets and runs share the win (dead heat).', example: 'On.' },
  'cricket.polls.mostSixes': { what: 'Open a "which team hits more sixes" poll when the teams are announced, settled from the scorecard at the result.', example: 'On.' },
  'cricket.polls.powerplay': { what: 'Open a powerplay runs poll for each innings of a T20, ODI or T10. Takes bets until the innings\' first ball.', example: 'On.' },
  'cricket.polls.over': { what: 'Open an odd / even / zero runs poll for every over.', example: 'On.' },
  'cricket.polls.ball': { what: 'Open a next-ball poll after every ball. The fastest poll and the most sensitive to feed delay.', example: 'On.' },
  'redFlags.lowActivityPercent': {
    what: 'An agent is flagged once a day when both their completed orders and their online time are this many percent below their team\'s average. A flag only warns the supervisor and admins.',
    example: '25: a team average of 40 orders flags a member who did fewer than 30 and was also online 25% less.',
  },
  'riskRules.enforceMultiplesOf10': {
    what: 'When on, buy, sell and bet amounts must be multiples of 10 tokens, which keeps cash handling simple.',
    example: 'On: a 45-token bet is refused; 40 or 50 is accepted.',
  },
  'riskRules.blockOppositeSideBetting': {
    what: 'When on, a player who has bet on one side of a round cannot also bet on the other side of the same round. The rules shown to players change with it.',
    example: 'On: after betting on Delhi, a bet on Bombay in the same round is refused.',
  },
  'riskRules.maxFundingOrdersPerHour': {
    what: 'How many buy or sell orders one player may create per hour. Cancelled orders count too. 0 means no limit.',
    example: '10: the 11th order inside one hour is refused.',
  },
  'riskRules.maxDepositOrdersPerMinute': {
    what: 'How many new buy orders one player may open per minute. 0 means no limit.',
    example: '1: a second buy within the same minute is refused as a double tap.',
  },
  'riskRules.maxWarnings': {
    what: "Each merchant rejection of a player's payment adds one warning. A player who reaches this many is marked for review at the top of Flagged Players. It blocks nobody; blocking stays your decision. 0 means never mark.",
    example: '3: the third rejection puts the player on the review list.',
  },
  payoutFeePercent: {
    what: 'A fee on each sell (withdrawal): the player receives the tokens minus this percent in rupees, and the fee is booked to the platform. 0 means no fee.',
    example: '2: selling 1,000 tokens pays the player ₹980.',
  },
  betReservePercent: {
    what: "The share of every bet stake taken from the player's reserve wallet; the rest comes from the deposit wallet first, then winnings. If the reserve is short, the other wallets cover the difference.",
    example: '1: a ₹100 bet takes ₹1 from reserve and ₹99 from deposit or winnings.',
  },
  winningsFeePercent: {
    what: 'The platform fee on a winning bet, as a percent of the payout. It is shown to players in the board rules.',
    example: '1: a ₹100 winning bet pays ₹200 minus ₹2, so ₹198.',
  },
  payoutMultiplier: {
    what: 'How many times the stake a winning bet pays back, before the winnings fee.',
    example: '2: a ₹100 winning bet pays ₹200 before the fee.',
  },
  generalPayoutMultiplier: {
    what: 'How many times the stake a winning bet pays back on GENERAL (bonus) boards, before the winnings fee. Up to two decimals. VIP boards use the payout multiplier above.',
    example: '1.8: a ₹100 winning General bet pays ₹180 before the fee.',
  },
  withdrawalHoldMinutes: {
    what: 'After an agent marks a sell as paid, how long the player\'s tokens stay in escrow, out of the team\'s pool, so a sell marked paid without paying can be recovered if the player disputes. Any whole number from 0 to 10,080 (7 days). At 0 the sell settles within a minute; a later dispute is refunded from the team\'s pool, or by the platform if the pool has spent it.',
    example: '120: a sell marked paid at 2:00 settles at 4:00 unless the player disputes.',
  },
  rejectedBuyDisputeMinutes: {
    what: 'After an agent rejects a paid buy as "not received", how long the player has to dispute it before the held tokens go back to the team.',
    example: '15: a buy rejected at 2:00 can be disputed until 2:15.',
  },
  'usdtPricing.userMerchantBuyInr': {
    what: 'How many rupees of tokens a player gets for 1 USDT when buying. 0 means not set, and USDT buys are refused until it is. Allowed between ₹10 and ₹1,000.',
    example: '90: a 100 USDT buy credits 9,000 tokens.',
  },
  'usdtPricing.merchantAdminBuyInr': {
    what: 'The rupee price of 1 USDT when a team buys tokens for its pool from the platform. 0 means not set, and USDT pool purchases are refused until it is. Allowed between ₹10 and ₹1,000.',
    example: '88: a team paying 1,000 USDT gets 88,000 tokens in its pool.',
  },
  retentionMonths: {
    what: 'How many months of bulky operational data (crash reports, expired referral clicks, expired notifications) are kept before the cleanup job deletes it. Money, bets and audit records are never deleted. Nothing younger than 30 days is ever deleted, whatever you set.',
    example: '6: crash reports older than six months are cleared.',
  },
  footerPages: {
    what: 'Which pages appear in the player app\'s bottom navigation bar, in order. At least two.',
    example: 'home, results, wallet, profile.',
  },
  alertWebhookUrl: {
    what: "A https web address that receives money-critical alerts (ledger reconciliation errors, settlement failures) as JSON in Slack webhook format. The same alert is sent at most once every 10 minutes. Empty uses the server's ALERT_WEBHOOK_URL, or sends nothing.",
    example: 'https://hooks.slack.com/services/T000/B000/XXXX',
  },
  'loadShedding.enabled': {
    what: 'When on, the server answers "busy, try again" quickly once it is overloaded, instead of slowing down for everyone.',
    example: 'On (recommended).',
  },
  'loadShedding.maxInFlight': {
    what: 'How many requests the server works on at once before new ones are turned away. 0 means no limit.',
    example: '300: the 301st request at the same moment is told to retry.',
  },
  'loadShedding.maxEventLoopLagMs': {
    what: 'If the server falls this many milliseconds behind, new requests are turned away until it catches up. 0 turns this check off.',
    example: '200',
  },
  'ipDefense.enabled': {
    what: 'When on, attackers rotating through many addresses on the same network are limited as one network, not one address at a time.',
    example: 'On (recommended).',
  },
  'ipDefense.subnetMultiplier': {
    what: 'How many times the single-address limit a whole network range is allowed, before every address in it is slowed down.',
    example: '8: if one address may try 5 sign-ins a minute, one network may try 40.',
  },
  'ipDefense.surge.auth.windowSec': {
    what: 'The time window, in seconds, over which platform-wide sign-in attempts are counted for the surge limit below.',
    example: '60',
  },
  'ipDefense.surge.auth.max': {
    what: 'The most sign-in attempts the whole platform accepts per window. 0 turns this off. Set it only once you know your normal traffic.',
    example: '2000: during a credential-stuffing attack, attempts above 2,000 a minute are turned away.',
  },
  'ipDefense.surge.withdrawal.windowSec': {
    what: 'The time window, in seconds, over which platform-wide sell orders are counted for the surge limit below.',
    example: '60',
  },
  'ipDefense.surge.withdrawal.max': {
    what: 'The most sell orders the whole platform accepts per window. 0 turns this off.',
    example: '500',
  },
  'ipDefense.surge.funding.windowSec': {
    what: 'The time window, in seconds, over which platform-wide buy orders are counted for the surge limit below.',
    example: '60',
  },
  'ipDefense.surge.funding.max': {
    what: 'The most buy orders the whole platform accepts per window. 0 turns this off.',
    example: '500',
  },
  'tlsFingerprintDefense.enabled': {
    what: 'When on, the server looks at each connection\'s TLS fingerprint (JA3) to spot automated tools.',
    example: 'On.',
  },
  'tlsFingerprintDefense.logOnly': {
    what: 'When on, suspicious fingerprints are only logged, never blocked. Turn it off only after checking the logs show no real players would be blocked.',
    example: 'On while you watch the logs for a week.',
  },
  'tlsFingerprintDefense.requireJa3Hash': {
    what: 'When on, a connection whose fingerprint the edge did not pass along is refused. Only use this if your proxy always sends it.',
    example: 'Off unless your Caddy/Cloudflare setup forwards the JA3 header.',
  },
  'tlsFingerprintDefense.blockJa3Hashes': {
    what: 'Fingerprints to refuse (when log-only is off). One 32-character hash per line.',
    example: 'e7d705a3286e19ea42f587b344ee6865',
  },
  'boardExtras.urgencyChips': {
    what: 'Shows the round timer turning amber then red, and a "Closing 0:09" chip on the betting cards near the close.',
    example: 'On.',
  },
  'boardExtras.closingWarnSeconds': {
    what: 'How many seconds before betting closes the timer turns red and the closing chip appears. It is amber for twice as long first. 0 hides the chip.',
    example: '10: red for the last 10 seconds, amber from 20 seconds.',
  },
  'boardExtras.resultCelebration': {
    what: 'Shows the winning side large and counts up the player\'s own payout when a round ends.',
    example: 'On.',
  },
  'boardExtras.bonusProgress': {
    what: 'Shows, in Wallet › General wallet, how much of the referral bonus\'s play requirement the player has completed, as a bar.',
    example: 'On.',
  },
  'boardExtras.promoCards': {
    what: 'Shows the cards set under Images › Promo cards: in the board\'s side columns on a laptop, as a swipeable banner under the header on a tablet or phone. Each screen shows its own image and each card opens its own link. Off, or with none published, the side columns show the built-in artwork.',
    example: 'Off to give the board the whole screen.',
  },
  registrationEnabled: {
    what: 'When off, new players cannot sign up. Existing players still sign in.',
    example: 'Off during a launch freeze.',
  },
  depositMethods: {
    what: 'A stored list of buy methods. Nothing on the platform reads it today: how a player pays is decided by the order size (cash or UPI/bank) and by who serves rupee orders.',
    example: 'UPI, BANK_TRANSFER (changing it has no effect).',
  },
  withdrawalMethods: {
    what: 'A stored list of sell methods. Nothing on the platform reads it today: every sell is paid by bank transfer to the player\'s account.',
    example: 'BANK_TRANSFER (changing it has no effect).',
  },
});

/** Every leaf path of a spec group, dotted (`teamRouting.concurrency.CASH`). */
export function leafPaths(node, prefix = []) {
  return Object.entries(node.fields ?? {}).flatMap(([key, decl]) => (
    decl.type === 'group' ? leafPaths(decl, [...prefix, key]) : [[...prefix, key].join('.')]
  ));
}
