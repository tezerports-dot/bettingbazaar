// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * postgres/moneyAuthority.js — WHICH STORE IS THE SOURCE OF TRUTH, per money path.
 *
 * The hybrid-DB plan (LAUNCH_READINESS.md §E, postgres/DATA_ROLLBACK_PLAN.md)
 * does not flip Postgres on in one step. It flips **one money path at a time**,
 * reads before writes, wallet/ledger first and KYC last, with a rollback ready
 * at every step. Until this module existed there was no mechanism to express
 * that — the code had exactly one hard-wired answer (Mongo), so steps 2 and 3
 * of the documented cutover were not executable at all.
 *
 * This is the switch. It stores no data and performs no I/O; it answers one
 * question — "for path P, who is authoritative right now?" — and every money
 * path asks it instead of assuming.
 *
 * ── Phases (per path, from DATA_ROLLBACK_PLAN) ──────────────────────────────
 *   MONGO     Phase A. Mongo is write-first and the read path; Postgres is a
 *             fire-and-forget mirror (dualWrite.js). Rollback is trivial.
 *             THIS IS THE DEFAULT AND THE ONLY PHASE ANY PATH SHIPS IN.
 *   POSTGRES  Phase B. Postgres is authoritative for reads and writes on this
 *             path; Mongo is kept complete by the reverse mirror
 *             (reverseMirror.js) so falling back stays lossless (RPO zero).
 *
 * Phase C (Mongo write path removed entirely) is deliberately NOT modelled
 * here. It is a data-retention decision plus a PITR-restore drill, not a
 * routing flag, and the plan requires a full staging drill before any path
 * enters it.
 *
 * ── How a flip actually happens ─────────────────────────────────────────────
 * Environment only, one variable per path, so a flip is a deploy-time decision
 * an operator makes deliberately and can revert by redeploying:
 *
 *     MONEY_AUTHORITY_WALLET=postgres
 *     MONEY_AUTHORITY_LEDGER=postgres
 *     MONEY_AUTHORITY_ORDERS=postgres
 *     MONEY_AUTHORITY_KYC=postgres
 *
 * Unset (or any unrecognised value) means MONGO. There is no "flip everything"
 * switch by design — the plan's whole point is that paths move one at a time.
 *
 * ── The gate this module CANNOT enforce ─────────────────────────────────────
 * LAUNCH_READINESS §E: "Do not flip authority until reconciliation has been
 * clean in production repeatedly" — `bb_pg_reconcile_consecutive_clean` green
 * for ≥24h of 5-minute passes, `bb_pg_drift_rows` at 0, and
 * `bb_pg_trial_balance_ok` at 1. That is an operational judgement made by a
 * human reading Grafana; code cannot verify it happened. What this module DOES
 * enforce is that a flip cannot happen *accidentally* or *incoherently*:
 * Postgres authority without DATABASE_URL is refused outright, and an
 * inconsistent combination (ledger on Postgres while wallet is still on Mongo)
 * is refused at boot rather than discovered halfway through a settlement.
 */
import { pgConfigured } from './pgClient.js';

export const STORE = Object.freeze({ MONGO: 'mongo', POSTGRES: 'postgres' });

/**
 * The money paths, in the order the plan flips them. Order matters: `dependsOn`
 * encodes that a path cannot be authoritative in Postgres while a path it reads
 * from is still authoritative in Mongo — that would split a single settlement
 * across two sources of truth.
 */
export const MONEY_PATHS = Object.freeze({
  WALLET: 'wallet',
  LEDGER: 'ledger',
  ORDERS: 'orders',
  KYC:    'kyc',
  // Declared so the registry can report them as UNIMPLEMENTED rather than
  // leaving them invisible. An audit found `moneyAuthority` listing four paths
  // while only `wallet` had a Postgres implementation — the other three would
  // have accepted `=postgres`, passed every check, and changed nothing, which
  // is a worse failure than refusing. These five were not modelled at all even
  // though they move money, so their absence could not be seen.
  MERCHANT_WALLET:         'merchant_wallet',
  MERCHANT_SETTLEMENT:     'merchant_settlement',
  ADMIN_ISSUANCE:          'admin_issuance',
  BETS:                    'bets',
  SETTLEMENTS:             'settlements',
  BONUSES_AND_COMMISSIONS: 'bonuses_and_commissions',
  // Added 2026-08-03. Casino provider callbacks move real money —
  // domains/casino/gameProvider.routes.js calls debitForGameProviderBet,
  // creditWinnings and refundOrder — but no path described them, so the
  // matrix showed ten domains while eleven moved money. Same omission the six
  // above were added to fix, found the same way: by listing what actually
  // touches a balance rather than what the registry already knew about.
  CASINO_SETTLEMENT:       'casino_settlement',
});

/**
 * CAPABILITIES — what actually EXISTS for each path, independent of what an
 * operator has asked for.
 *
 * This is the registry that makes "false authority" impossible. Authority is
 * not a wish expressed in an environment variable; it is a claim that must be
 * backed by four things being true at once:
 *
 *   implemented  a real Postgres reader AND writer exist, and every production
 *                call site routes through the authority resolver
 *   dualWrite    Mongo writes are mirrored to Postgres, so Postgres has the
 *                data a cutover would start reading
 *   reconciled   a reconciliation pass compares the two stores for this path
 *                and can prove they agree
 *   rollback     a reverse mirror or equivalent keeps Mongo current after the
 *                flip, so reverting is lossless
 *
 * A path is eligible for cutover only when all four hold. `authorityFor()`
 * refuses to return Postgres for an ineligible path however the environment is
 * set, and `validateAuthorityConfig()` makes a production boot fail loudly
 * rather than run with a config that lies about where money lives.
 *
 * Keep this honest. A `true` here is a claim that someone can point at the
 * code, the reconciliation query and the rollback path. If you are tempted to
 * flip one to unblock a deploy, the deploy is the thing that is wrong.
 */
const CAPABILITIES = Object.freeze({
  [MONEY_PATHS.WALLET]: {
    implemented: true,  // postgres/walletPg.js + walletPgAuthority.js
    dualWrite:   true,  // postgres/dualWrite.js mirrorWalletLedger
    reconciled:  true,  // postgres/reconcile.js
    rollback:    true,  // postgres/reverseMirror.js
    notes: 'User balances + wallet_ledger. The only path with a complete implementation.',
  },
  [MONEY_PATHS.LEDGER]: {
    // Flipped on CI evidence at 121a8e5, not on the implementation alone.
    // revenueSettlement.service.js — the only writer — asks the resolver, and
    // reads route too: a trial balance derived from Mongo while writes go to
    // Postgres would read clean the whole time it was wrong.
    implemented: true,  // postgres/ledgerPgAuthority.js, routed from revenueSettlement.service.js
    dualWrite:   true,
    reconciled:  true,
    rollback:    true,
    notes: 'Global accounting ledger. postgres/ledgerPg.js EXISTS: an authoritative reader and writer over accounting_events, double entry enforced per event by the DATABASE and across the ledger by a derived trial balance, balances never stored, idempotency by a single INSERT … ON CONFLICT DO NOTHING RETURNING with no pre-read to race. reconcileAgainstSubLedgers compares the summary accounts against the actual wallet, merchant and treasury sums — a trial balance proves internal consistency and says nothing about whether the ledger describes reality. 16 tests. Remaining: route revenueSettlement.service.js through the resolver. Gated on ORDERS becoming authoritative — order state produces most ledger events, so routing the consequence while the cause still writes Mongo would post events into Postgres for transitions Postgres never saw. See docs/ORDERS_ROUTING_DESIGN.md.',
  },
  [MONEY_PATHS.ORDERS]: {
    // Flipped on CI evidence at 38f8703 — the commit whose anti-skip guard
    // proves orderCrossStore.integration.test.js RAN rather than reporting
    // green by skipping. All 31 status writes go through one guarded seam and
    // orderPgAuthority routes it; stages 1-3 of docs/ORDERS_ROUTING_DESIGN.md.
    implemented: true,
    dualWrite:   true,  // mirrorPaymentOrder, mirrorUtr
    reconciled:  true,
    rollback:    true,
    notes: 'Order lifecycle. postgres/orderPg.js EXISTS: order_states + append-only order_transitions, expected-previous-state guards in the UPDATE, and the accounting event posted in the SAME transaction as the state change (the Mongo path writes status first and the event afterwards, so a failure between them leaves an order COMPLETED with nothing in the books). 22 tests including a 100-copy callback storm, a racing complete-vs-dispute, 60 concurrent completions with no pool exhaustion, and both gap checks — orders missing their ledger event, and order-shaped events no transition produced. NOTE payment_orders remains a MIRROR: overwritten in place, no history, no guard. These tables are the authoritative lifecycle; that one is a projection. Remaining: see docs/ORDERS_ROUTING_DESIGN.md. This is NOT a normal routing job and was stopped deliberately rather than started piecemeal: the Mongo order lifecycle has NO choke point — 31 status writes across 8 files — so wiring the resolver into some of them and not others would leave some transitions authoritative in Postgres and others in Mongo, which no reconciliation can tell apart from genuine disagreement. It needs a seam built first (one guarded transition service, stage 1), then routing (stage 2), then cross-store reconcile (stage 3). Stage 1 also closes a LIVE hole: Mongo has no expected-previous-state guard, so a cancelled order can be completed today and only incidental ordering in the routes prevents it. ORDERS is the gate for the whole cutover — six fully-built domains report it as their only blocker.',
  },
  [MONEY_PATHS.KYC]: {
    // Flipped on CI evidence at f3f9fec. kycDecision.service.js is the single
    // seam and kycPgAuthority routes it. KYC still cuts over LAST: dependsOn
    // holds it behind WALLET, LEDGER and ORDERS.
    implemented: true,
    dualWrite:   true,  // mirrorUserKyc
    reconciled:  true,  // reconcile.reconcileKycDecisions (cross-store, status AND reason)
    rollback:    true,  // reverseMirror.reverseMirrorUserKycStatus, live per decision
    notes: 'KYC decisions. postgres/kycPg.js EXISTS: user_kyc + append-only kyc_transitions, expected-previous-status guards in the UPDATE, and the reviewer and reason written in the SAME statement as the status. It exists to remove three defects rather than port them. (1) NO GUARD: routes/admin/kyc.admin.routes.js read the user, assigned kycStatus and saved — a read-modify-write on a stale read, so two reviewers acting at once both passed and the last save won with no record that the other decision happened. (2) THE REJECTION REASON WAS DISCARDED: that route assigned it to `user.kyc.rejectionReason`, and the User schema has NO `kyc` subdocument — only `kycData` — so `user.kyc` was undefined and the guarded block NEVER RAN. Verified against the compiled schema: `kyc.rejectionReason` is not a path, `kycData.rejectionReason` is, and the latter is what domains/user/kycPublicData.js shows the user. Every rejected user was told they were rejected and never told why, so they could not fix the submission. (3) NO REVIEWER AND NO HISTORY: reviewedBy/reviewedAt were lost to the same dead branch, so every approval on the Mongo path is anonymous, and a single status field cannot answer "was this user ever rejected, and why?" once a resubmission overwrites it. A REJECTED decision with no reason is now refused rather than defaulted, because inventing "Rejected by admin" satisfies the constraint and tells the user nothing. 18 tests including a racing approve-vs-reject where exactly one wins and the stored record matches whichever did, a 100-copy approval storm applied once, 60 users decided at once with pool.waitingCount at zero and every rejection keeping its reason, and a 40-copy resubmission storm. Resubmission makes PENDING_APPROVAL and REJECTED reachable twice, so a repeat decision needs its own key — same derivation as the order lifecycle, docs/ORDERS_REQUEUE_CYCLE.md. domains/user/kycDecision.service.js is the single seam and kycPgAuthority.js the routed adapter; the seam ALSO fixes the live Mongo bug by writing the reason to kycData.rejectionReason. Documents: services/kycDocuments.service.js puts them in a PRIVATE R2 bucket with per-review presigned reads — see docs/KYC_DOCUMENT_STORAGE.md, and note the migration steps there are NOT done, so the existing public CDN URLs still resolve. Remaining: CI evidence, then this flag; and KYC waits on WALLET, LEDGER and ORDERS by design.',
  },
  [MONEY_PATHS.MERCHANT_WALLET]: {
    // Flipped 2026-08-03, after all four were separately evidenced — not on the
    // strength of the implementation alone, which was the reason this stayed
    // false while merchantWalletPg.js already existed.
    implemented: true,  // merchantWalletPg.js + merchantWalletPgAuthority.js, routed from merchantWallet.service.js
    dualWrite:   true,  // mirrorMerchantBalance (balance) + mirrorMerchantWalletLedger (rows)
    reconciled:  true,  // reconcile.js reconcileMerchantBalances + reconcileMerchantLedgers
    rollback:    true,  // reverseMirrorMerchantMovement, live per movement
    notes: 'Merchant token balances. Movements are Postgres-authoritative when flipped: one transaction, row-locked, guard in the UPDATE, entry in the same transaction, UNIQUE tx_id idempotency. READS for display, scoring and assignment eligibility still come from the live-mirrored Mongo document — the authoritative sufficiency check is the debit itself, which refuses transactionally, so a stale read can only misroute an order, never move money wrongly. Reserved/settlement pockets are structurally zero until merchant_settlement lands; that domain must revisit the single-tokenBalance projection before writing them.',
  },
  [MONEY_PATHS.MERCHANT_SETTLEMENT]: {
    // Flipped 2026-08-04, on evidence rather than on the implementation.
    //
    // The state inversion this flag was blocked on is done: settleHold and
    // reverseHold gate on the settlement's own expected-previous-state guard
    // and write Mongo afterwards as a mirror. The last thing held back was the
    // suite that proves the two stores AGREE
    // (tests/integration/withdrawalHoldPgAuthority.integration.test.js), which
    // needs a MongoDB replica set this environment cannot run — so flipping on
    // the strength of the two suites that DO run here would have been marking a
    // pass on code inspection of the third. CI ran it green on 1a084a0, having
    // failed it four times first, every one a real fixture defect.
    //
    // This changes no runtime behaviour on its own: the path also waits on
    // ORDERS (see dependsOn), so authorityFor still resolves to Mongo.
    implemented: true,
    dualWrite:   true,  // dualWrite.mirrorMerchantSettlement, hooked on PaymentOrder
    reconciled:  true,  // reconcile.reconcileMerchantSettlementStates (cross-store) + findUnexplainedSettlementPockets
    rollback:    true,  // reverseMirror.reverseMirrorMerchantSettlement + reverseMirrorMerchantMovement, live per transition
    notes: 'User↔merchant settlement lifecycle. postgres/merchantSettlementPg.js: merchant_settlements + merchant_settlement_transitions, expected-previous-state guards in the UPDATE, the transition and its pocket movement composed into ONE transaction under a single merchant lock, two UNIQUE idempotency gates, append-only history. STATE AUTHORITY IS INVERTED: settleHold completes the settlement FIRST and Mongo follows, so the source of truth decides the race; the price is that a failed player-side release must be compensated, which it is — SETTLED→REVERSED as a recorded movement, allowed to drive the merchant negative because the tokens may already have been spent. reverseHold moved the same way, deliberately together: two outcomes of one race decided by two different databases is worse than either alone. Mongo\'s status is now consulted for ONE thing only — whether a settlement may be OPENED — which is what stops a stray sweep manufacturing a liability against a long-completed order, and a lagging mirror is self-healing because re-mirroring is what removes an order from the sweep queue. 57 tests: 26 against PostgreSQL (200-way reservation race, retry storms, racing complete-vs-cancel, a backend killed mid-transition), 12 on the rollback leg (100 racing completions mirror exactly once; nothing mirrors while Mongo is authoritative; no transition ever holds two pooled connections), and 19 on the routing (call ORDER, the compensating reverse, and that creditMerchantTokens is never called on this path — the settlement IS the credit). Remaining: CI evidence for the cross-store integration suite, then this flag; and the path still waits on ORDERS.',
  },
  [MONEY_PATHS.ADMIN_ISSUANCE]: {
    // Routed and flipped 2026-08-04, on CI evidence (180f01a) rather than on
    // the implementation. merchant.admin.routes.js calls the resolver
    // (adminIssuanceAuthority) rather than the Mongo counter inline, and all
    // three legs — forward mirror, reconciliation, reverse mirror — exist and
    // are exercised across both stores.
    //
    // That cross-store suite earned its keep before it ever guarded a flip: it
    // found M-6, a shipped defect that made admin token issuance throw on EVERY
    // call ($expr combined with upsert, which MongoDB refuses). Nothing had run
    // that path against a real MongoDB before.
    //
    // No runtime change on its own — this path waits on MERCHANT_WALLET, which
    // is eligible but not flipped, so authorityFor still resolves to Mongo.
    implemented: true,
    dualWrite:   true,  // dualWrite.mirrorAdminSupply, called by the adapter after the Mongo counter moves
    reconciled:  true,  // reconcile.reconcileAdminSupply — running counter vs derived double-entry total
    rollback:    true,  // reverseMirror.reverseMirrorAdminSupply, live per mint and per burn
    notes: 'Admin treasury and token issuance. postgres/treasuryPg.js: treasury_accounts + treasury_entries as DOUBLE ENTRY across TOKEN_SUPPLY / MERCHANT_FLOAT / USER_FLOAT / HOUSE_RESERVE / COMMISSION_POOL / BONUS_POOL / REFERRAL_POOL / OPERATIONAL_FLOAT. Every movement\'s legs sum to zero so the whole ledger sums to zero; minting is TOKEN_SUPPLY going negative rather than value appearing; the supply cap is enforced inside the transaction behind a row lock; accounts are locked in a fixed order so movements between the same pair in opposite directions cannot deadlock. postgres/adminIssuanceAuthority.js is the routed adapter, and it exists to FIX three defects rather than port them: (1) the Mongo original\'s reserveAdminMint(amount) has NO idempotency key, so two deliveries of one admin request mint twice — every mint here carries a caller-supplied movementId that collides inside the transaction; (2) its rollback is `$inc: {minted: -amount}` with `.catch(() => {})`, so a retried rollback invents headroom under the cap and a swallowed failure is unrecoverable — here a rollback is a BURN with its own key, idempotent, and the mint AND its reversal both stay in the history; (3) a counter cannot say where tokens went — every movement names the merchant and the order. reconcileAdminSupply compares the running counter against the derived total, which is only meaningful BECAUSE the rollback is a burn rather than an erasure. The /fund route\'s credit also had a fresh ObjectId per attempt as its txId, so its idempotency gate could never fire; mint and credit now share one key. Remaining: CI evidence for the cross-store suite, then this flag.',
  },
  [MONEY_PATHS.BETS]: {
    // Flipped on CI evidence at 1bd5de8 (run 31456526949, all 8 jobs green
    // including the integration leg) — the commit that routed SETTLEMENT, the
    // half of the lifecycle that was still writing Bet.status directly.
    // Placement had been routed since 2026-08-04; a routing that covered half
    // the lifecycle was deliberately not called `implemented`.
    //
    // Both sides move together, from ONE decision read once per settlement
    // pass and passed down — the losing side in gameEngine and the winning side
    // in settlementService. Routing one and not the other would leave some bet
    // transitions authoritative in Postgres and others in Mongo, which is the
    // split no reconciliation can tell apart from genuine disagreement.
    implemented: true,
    dualWrite:   true,  // dualWrite.mirrorBet, hooked on the Bet model
    reconciled:  true,  // reconcile.reconcileBetStates (cross-store)
    rollback:    true,  // reverseMirror.reverseMirrorBet, live per placement, + REVERSE_TABLES repair
    notes: 'Bet lifecycle and stake reservation. postgres/betPg.js EXISTS: bets + append-only bet_transitions, expected-previous-state guards in the UPDATE, and the bet row, its stake movement and its ledger rows composed into ONE transaction under a single wallet lock via walletPg.applyMovementWithin. It exists to REMOVE the two Mongo defects rather than port them. M-2 (no idempotency key on the balance move): bet_id is UNIQUE and collides inside the transaction, so a replayed request debits nothing further — the Mongo call site hides the defect by minting bet_<userId>_<randomUUID()> per request, but a fresh id per attempt is not idempotency, it is a NEW BET, so a dropped connection leaves the user with two bets and two debits. M-4 (ledger written outside the transaction): impossible here by construction; a settled bet with no ledger row behind it can only be manufactured by raw INSERT, which is how findBetsMissingStakeMovement is tested. Returns go back to the pockets the stake CAME from, and settling without the funding slices is refused rather than defaulted — returning a deposit-funded stake into winningsBalance would silently convert non-withdrawable money into withdrawable, which is a cash-out route. A win credits its payout as a SEPARATE movement so the books distinguish "stake consumed" from "house paid out". 25 tests including a 100-copy placement storm (exactly one bet), 60 concurrent bets against a balance that fits 20 (exactly 20), racing win-vs-lose, and 50 users placing at once with pool.waitingCount at zero. postgres/betPgAuthority.js is the routed adapter; bet.routes.js calls it and the Mongo two-step is the other branch. The Mongo document\'s _id is DERIVED from the idempotency key (sha256, first 24 hex) rather than generated, because Mongo types _id as an ObjectId and a fresh one per attempt would let a replay create a SECOND Mongo document behind the one Postgres bet. THE ONE THING STILL OPEN, documented rather than hidden: bet.routes.js prefers a client-supplied Idempotency-Key but falls back to a random UUID, so without the header a retry is still a second bet — unlike the /fund bug this resembles, the fallback id is genuinely new and the gate genuinely fires for the id it is given, and enforcing the header outright would break any client that does not send it on the highest-traffic endpoint in the system. reconcileBetStates carries more weight than the other state checks because the Mongo settlement path is Bet.updateMany, a bulk update Mongoose gives no documents to hand a post hook — those transitions reach Postgres through the reconcile or not at all. The cross-store suite EXISTS now (tests/integration/betCrossStore.integration.test.js): it pins the derived ObjectId\'s stability, proves a replayed placement collides rather than creating a second Mongo document, and asserts the updateMany blind spot directly — that the forward mirror does not see a bulk settlement, that reconcileBetStates reports the resulting disagreement, and that --backfill closes it. SETTLEMENT IS NOW ROUTED TOO, both sides from one decision per pass: gameEngine loops settleBetOnPostgres over the losing bets instead of unlockLostBet + updateMany, and executeSettlementBatch settles each winner\'s bets instead of creditWinnings + releaseLockedStake + bulkWrite. The earlier "one statement becomes N transactions" objection was WITHDRAWN and the correction is in docs/BETS_SETTLEMENT_ROUTING.md: the per-bet loop already existed one function above the bulk statement, so routing replaces N wallet operations plus a bulk stamp with N transactions that do both atomically — the same order of work, with the state and the money now committing together. On the Postgres branch the bulk updateMany/bulkWrite are SUPPRESSED, because the reverse mirror has already written each status and re-stamping would overwrite the bets Postgres deliberately refused, turning a reported failure into a silent one; refusals are collected, paged, and left for findIncompleteSettlements as the second detector. Three things had to be fixed before either side could route, all of them recorded as blockers rather than discovered late: the winner aggregation projected the funding split under names that were not the Bet document\'s and omitted fromReserveBalance entirely (so slicesFromBet read undefined and a reserve-funded bet threw against requireSlices); betStamps carried three scalars and no bet document; and the Transaction log needed a decision, which is that it stays Mongo-side and runs on BOTH branches — it is the user\'s history feed, not the ledger, and the auditable record is wallet_ledger + accounting_events which betPg writes inside the settling transaction. A FOURTH turned up in the wiring: bets now carries platform_fee_paise, because the Mongo path stamps status, payout and fee in one $set and Cycle.totalPlatformFees is summed from Bet.platformFee, so routing the first two and not the third would make that accounting number read zero for every Postgres-settled cycle with every state check still green. Phantom bets are no longer mirrored at all — synthetic, zero funding provenance, unsettleable by betPg, and they inflated reconcileUserStakes against a lockedBalance that never moved. And reconcileBetStates\' backfill leg fetched documents with .select(\'status\') and handed them to mirrorBet, whose ON CONFLICT DO UPDATE writes what it is given, so repairing a status disagreement ZEROED that bet\'s payout and fee — demonstrated against a real PostgreSQL in betSettlementPg.test.js rather than argued. 33 new tests (14 routing, 12 engine, 6 mirror, 8 pg) plus 4 cross-store cases; 21 mutations applied and killed, one of which survived first and exposed a real hole (the mid-cursor batch flush was never exercised, so that call site could lose its routing argument unnoticed).',
  },
  [MONEY_PATHS.SETTLEMENTS]: {
    // Routed, mirrored, reconciled and reversible — CI evidence at 3d416bc,
    // where settlementBonusCrossStore.integration.test.js ran green against a
    // real MongoDB + PostgreSQL for the first time. Still NOT cutover-eligible:
    // the ordering gate holds this behind BETS, which waits on ORDERS.
    implemented: true, dualWrite: true, reconciled: true, rollback: true,
    notes: 'Cycle settlement and payout. postgres/settlementPg.js EXISTS: cycle_settlements as a RUN — which cycle, which side won, how many bets settled so far, how much paid out. The Mongo path gets the hard part right (isSettled PENDING→PROCESSING deliberately re-admits a PROCESSING cycle so a recovery task can resume an interrupted payout, and money safety rests on per-bet idempotency), but it records nothing about what a pass ACTUALLY DID — a half-finished run cannot be told from a finished one except by re-deriving it from the bets. Two properties the flag on the Cycle cannot express: cycle_id is UNIQUE so one settlement per cycle is structural rather than guarded (a flag can be flipped back), and winning_side is written once and never updated, so a resumed pass settles the remaining bets against the side the FIRST pass recorded — otherwise a cycle whose result was corrected mid-settlement pays some bets on one result and the rest on another. Counters advance only when a transition actually happened, so they stay meaningful across a resume instead of inflating. findIncompleteSettlements is the strongest check: a COMPLETED run with bets still PENDING means a player\'s stake is locked with nothing coming to release it. BUILT AND WIRED, NOT CLAIMED. settlementPgAuthority routes gameEngine\'s two state moments: the claim is AWAITED (a run that failed to open must not go on to pay anybody) and the close is not (the money has already moved, so failing there would re-run a finished payout). dualWrite.mirrorCycleSettlement projects the run forward and reverseMirror.reverseMirrorCycleSettlement rolls it back — including VOIDED, which Mongo\'s enum cannot hold; writing it anyway is deliberate, because leaving a voided run at PROCESSING lets payoutRecoveryTask sweep it up and resurrect the payout. reconcile.reconcileCycleSettlements compares state AND payout, and the payout is the one that counts: Mongo re-derives its total from the stamped WON bets while Postgres accumulates it per settled bet, so agreement is evidence rather than a value checked against a copy of itself. 12 pg + 13 unit tests, three mutations verified. settlementBonusCrossStore.integration.test.js RAN GREEN in CI at 3d416bc, which is what these four flags rest on. NOT cutover-eligible regardless: the ordering gate holds this behind BETS, which waits on ORDERS.',
  },
  [MONEY_PATHS.BONUSES_AND_COMMISSIONS]: {
    // Routed, mirrored, reconciled and reversible — same CI evidence (3d416bc).
    implemented: true, dualWrite: true, reconciled: true, rollback: true,
    notes: 'Bonus engine and referral commission. postgres/bonusPg.js EXISTS: bonus_grants paid FROM the treasury pools that fund them (BONUS_POOL / REFERRAL_POOL / COMMISSION_POOL) rather than credited from nowhere. That is the property the domain is for — a bonus is a TRANSFER, not a mint. A credit from nowhere puts tokens on the user side with nothing on the other, so the closing invariant (User + Merchant + Treasury = Total Supply) stops holding and every downstream conservation check starts failing for a reason unrelated to the bug it was built to catch. Which pool funds which kind is DATA, so a new bonus type cannot quietly be paid from the wrong one. A COMMISSION lands in winnings (earned, withdrawable); a bonus lands in deposit (gifted, not) — a signup bonus that could be withdrawn immediately is a cash-out route, which is the entire reason the two pockets exist. Clawback is a second movement returning it to the pool, and the grant row SURVIVES marked, because "was this user ever given a signup bonus?" is what fraud review asks and deleting the row destroys the answer; it may drive the balance negative, since the money may already be spent and refusing to record a reversal that already happened is worse. The pool moves BEFORE the user credit, deliberately: taking a treasury lock while holding a wallet lock would invert the wallet-first order this codebase holds everywhere and deadlock, and the failure mode of this ordering (pool paid for a grant that does not exist) shows as treasury drift, where the other ordering breaks conservation outright. BUILT AND WIRED, NOT CLAIMED. bonusPgAuthority routes the giveaway and giftcode.routes returns the code to the user when the pool cannot fund it, rather than telling them they were paid. dualWrite.mirrorBonusGrant projects BonusRecord — the one collection every user-side giveaway already writes — WITHOUT paying the pool, because Mongo has already paid and paying again would double-spend it; ADMIN_CREDIT is deliberately unmapped, since a manual adjustment has no pool behind it and inventing one would make the treasury claim it financed something it did not. reverseMirror.reverseMirrorBonusGrant rolls a grant back and records a clawback as its own NEGATIVE record rather than editing the original. bonus_grants is deliberately absent from REVERSE_TABLES: a grant id has two shapes, so the generic one-column presence check would report half the table missing on healthy data. reconcile.reconcileBonusGrants compares per grant, not on a total — the right sum paid to the wrong users is exactly what a total hides — and its forward repair is an explicit UPDATE, because re-running an INSERT ... ON CONFLICT DO NOTHING mirror would report a repair that did not happen. 12 pg + 13 unit tests, three mutations verified. settlementBonusCrossStore.integration.test.js RAN GREEN in CI at 3d416bc, which is what these four flags rest on.',
  },
  [MONEY_PATHS.CASINO_SETTLEMENT]: {
    // Flipped on CI evidence at 9d11b79. gameProvider.routes.js calls
    // casinoPgAuthority and a refusal is surfaced to the provider — which in
    // this domain is the product, not a consistency nicety.
    implemented: true,
    dualWrite:   true,  // dualWrite.mirrorCasinoTransaction, hooked on GameTransaction
    reconciled:  true,  // reconcile.reconcileCasinoRounds (cross-store, per round on all three totals)
    rollback:    true,  // reverseMirror.reverseMirrorCasinoRound, live per callback
    notes: 'Casino provider callbacks (BET/WIN/ROLLBACK/REFUND). postgres/casinoPg.js EXISTS, and it is built to remove the defect the matrix recorded: a ROLLBACK or REFUND credit does not have to prove a matching prior debit. gameProvider.routes.js handles a rollback with refundOrder(userId, amount, roundId, \'depositBalance\') — no check that the round was ever bet on, and no bound on the amount — so a provider that is buggy, replayed or hostile can MINT REAL MONEY by rolling back a round that never had a bet, or by rolling back more than was staked. Here a reversal must name a round with debited_paise > 0, and refunded_paise <= debited_paise is a CHECK CONSTRAINT so the bound holds against a future code path that forgets to test it — the `if` gives a clean refusal, the constraint makes the rule a property of the DATA. Running totals move under the round\'s row lock inside the same transaction as the wallet movement, so two concurrent rollbacks cannot both read "nothing refunded yet" (tested with two distinct provider ids, where idempotency cannot help). The provider\'s own tx id is the idempotency gate, which matters more here than anywhere else because providers retry hard and duplicate callbacks are routine. postgres/casinoPgAuthority.js is the routed adapter and gameProvider.routes.js calls it; a REFUSAL IS SURFACED to the provider rather than retried against Mongo, which in this domain is the product rather than a consistency nicety — it is what stops the mint. The Mongo route does have the refund bound now, but it enforces it by summing GameTransaction documents AFTER reading them, outside any lock, so two concurrent rollbacks with DIFFERENT provider tx ids both read "nothing refunded yet" and both pass; the duplicate-txId check cannot help, because it stops one callback applying twice and says nothing about two distinct callbacks that should not both be honoured. dualWrite.mirrorCasinoTransaction is hooked on the GameTransaction model rather than called from the route, so a callback recorded by any future path still reaches Postgres, and it advances a round total ONLY when the transaction row is new — otherwise a redelivered webhook would inflate the totals while the row correctly refused to duplicate. reconcile.reconcileCasinoRounds compares per ROUND on all three totals rather than per transaction, because it is the totals the bound is enforced against, and it counts over-refunded Mongo rounds SEPARATELY in a counter no repair can clear — money already gone is not a record to rewrite. 18 tests: 11 routing, 7 reconcile against a real PostgreSQL including the CHECK constraint asserted directly. Remaining: CI evidence, then this flag.',
  },
});

/** Every capability flag that must be true before a path may carry authority. */
const REQUIRED_CAPABILITIES = Object.freeze(['implemented', 'dualWrite', 'reconciled', 'rollback']);

/**
 * TESTING — evidence that a path has been exercised, as opposed to written.
 *
 * Kept SEPARATE from CAPABILITIES on purpose. Capability answers "can this path
 * carry authority"; testing answers "has anyone proven it survives contact with
 * reality". A path can be fully implemented, mirrored, reconciled and
 * rollback-capable — cutover-eligible by every structural measure — and still
 * never have been run against a concurrent load or a database restart. Merging
 * the two would let a green cutover gate imply a certification nobody performed.
 *
 *   concurrencyTested       raced against itself on a real database: parallel
 *                           writers on one balance, retry storms on one key
 *   infrastructureTested    survived the infrastructure failing underneath it:
 *                           database restart mid-transaction, connection loss,
 *                           process kill, multi-instance contention
 *
 * `evidence` names the file or run that backs the claim. A `true` with no
 * evidence is a bug in this table.
 *
 * infrastructureTested is false for EVERY path, including the two that are
 * otherwise complete. That is not an oversight — it is the honest state. Those
 * drills need a running MongoDB, a multi-node deployment and a load balancer to
 * restart, none of which exist in the environment this code is developed in.
 * They are staging work, and until they run, nothing here is production
 * certified. See docs/PRODUCTION_CERTIFICATION_CHECKLIST.md.
 */
const TESTING = Object.freeze({
  [MONEY_PATHS.WALLET]: {
    concurrencyTested: true,
    infrastructureTested: false,
    evidence: 'backend/tests/postgres/walletPg.test.js — 200 racing debits on one balance, 200-copy retry storms, crash-recovery run. Infrastructure drills NOT RUN.',
  },
  [MONEY_PATHS.MERCHANT_WALLET]: {
    concurrencyTested: true,
    infrastructureTested: false,
    evidence: 'backend/tests/postgres/merchantWalletPg.test.js (200 racing reservations against a balance that fits 100) + merchantWalletPgAuthority.test.js (200 racing debits through the authority path, 200-copy retry storm on one key). Infrastructure drills NOT RUN.',
  },
  [MONEY_PATHS.LEDGER]: {
    concurrencyTested: true,
    infrastructureTested: false,
    evidence: 'backend/tests/postgres/ledgerPg.test.js — a 100-copy retry storm on one idempotency key, and an assertion that 100 concurrent writes leave pool.waitingCount at zero. Infrastructure drills NOT RUN.',
  },
  [MONEY_PATHS.ORDERS]: {
    concurrencyTested: true,
    infrastructureTested: false,
    evidence: 'backend/tests/postgres/orderPg.test.js — a 100-copy storm of the same callback (applied once), a racing complete-vs-dispute where exactly one wins, 60 concurrent completions with pool.waitingCount at zero and no deadlock, and an interleaved storm of completions and failures where every completion has its ledger entry and every failure has none. Infrastructure drills NOT RUN.',
  },
  [MONEY_PATHS.ADMIN_ISSUANCE]: {
    concurrencyTested: true,
    infrastructureTested: false,
    evidence: 'backend/tests/postgres/treasuryPg.test.js — 50 concurrent mints against a cap that fits 10 (exactly 10 commit), a 100-copy retry storm on one movement key, and 100 movements alternating direction between the same two accounts without deadlocking. Plus moneyConservation.test.js\'s closed-books scenario. Infrastructure drills NOT RUN.',
  },
  [MONEY_PATHS.CASINO_SETTLEMENT]: {
    concurrencyTested: true,
    infrastructureTested: false,
    evidence: 'backend/tests/postgres/casinoSettlementBonusPg.test.js — 50 racing copies of one provider callback apply exactly once, and two concurrent rollbacks with DISTINCT provider ids cannot both pass the refund bound (idempotency cannot help there; the round\'s row lock is what has to). Plus 40 mixed operations across three domains with pool.waitingCount at zero. Infrastructure drills NOT RUN.',
  },
  [MONEY_PATHS.SETTLEMENTS]: {
    concurrencyTested: true,
    infrastructureTested: false,
    evidence: 'backend/tests/postgres/casinoSettlementBonusPg.test.js — 10 passes completing one cycle at the same moment complete it exactly once, a resumed pass does not re-count bets an earlier pass settled, and a resumed pass cannot change the declared result. Infrastructure drills NOT RUN.',
  },
  [MONEY_PATHS.BONUSES_AND_COMMISSIONS]: {
    concurrencyTested: true,
    infrastructureTested: false,
    evidence: 'backend/tests/postgres/casinoSettlementBonusPg.test.js — 30 racing copies of one grant pay exactly once with the trial balance still closing to zero, and the mixed-domain pool test covers grants alongside casino callbacks. Infrastructure drills NOT RUN.',
  },
  [MONEY_PATHS.BETS]: {
    concurrencyTested: true,
    infrastructureTested: false,
    evidence: 'backend/tests/postgres/betPg.test.js — a 100-copy placement storm of one request (exactly one bet, one transition, one debit), 60 concurrent bets against a balance that fits 20 (exactly 20 commit, 40 refused, reconciliation clean), racing win-vs-lose where exactly one wins and the books match whichever did, 50 users placing at once with pool.waitingCount at zero and every client returned, and `max` concurrent placements completing — which they could not if one placement ever held two pooled connections. Infrastructure drills NOT RUN.',
  },
  [MONEY_PATHS.KYC]: {
    // The last domain to get one. KYC was the only path in the matrix still
    // reporting concurrencyTested: false.
    concurrencyTested: true,
    infrastructureTested: false,
    evidence: 'backend/tests/postgres/kycPg.test.js — a racing approve-vs-reject where exactly ONE wins and the stored reviewer and reason match whichever did (the Mongo path resolves that race by last-write-wins and records neither), a 100-copy storm of one approval applied exactly once, 60 users decided at once with pool.waitingCount at zero and every rejection still carrying its reason, and a 40-copy resubmission storm producing one new PENDING_APPROVAL rather than forty. Infrastructure drills NOT RUN.',
  },
  [MONEY_PATHS.MERCHANT_SETTLEMENT]: {
    concurrencyTested: true,
    // A connection killed mid-transition IS one row of the Phase 3 drill, and
    // it found a real defect (a dead client returned to the pool poisoning the
    // next caller). It is not the whole drill: no database restart under
    // sustained load, no multi-instance contention, no failover. One row is not
    // a certification.
    infrastructureTested: false,
    evidence: 'backend/tests/postgres/merchantSettlementPg.test.js — 200 concurrent reservations against inventory that fits 100, 200-copy retry storms on both open and transition, racing complete-vs-cancel (exactly one wins), an interleaved storm of every transition type, plus failure injection: a backend terminated mid-transition leaves state and money both untouched and the settlement still advanceable. merchantSettlementMirror.test.js adds the rollback leg: 100 racing completions hand the mirror EXACTLY ONE committed fact, 60 merchants settling at once leave pool.waitingCount at zero with every client returned, and `max` concurrent transitions complete — which they could not if one transition ever held two pooled connections. Full infrastructure drills NOT RUN.',
  },
});

/** The default for a path with no TESTING entry: nothing has been proven. */
const UNTESTED = Object.freeze({
  concurrencyTested: false,
  infrastructureTested: false,
  evidence: 'No concurrency or infrastructure testing. NOT VERIFIED.',
});

/** Everything that must hold before a path may be called production certified. */
const CERTIFICATION_CRITERIA = Object.freeze([
  ...REQUIRED_CAPABILITIES, 'concurrencyTested', 'infrastructureTested',
]);

/**
 * capabilityFor — the registry entry for a path, plus the derived eligibility
 * and the specific reasons it is not eligible. The `missing` list is what an
 * operator needs in order to know what work remains.
 */
export function capabilityFor(path) {
  const cap = CAPABILITIES[path];
  if (!cap) throw new Error(`Unknown money path '${path}'. Known paths: ${ALL_PATHS.join(', ')}`);
  const missing = REQUIRED_CAPABILITIES.filter((flag) => !cap[flag]);
  return { ...cap, missing, cutoverEligible: missing.length === 0 };
}

/** May this path carry Postgres authority at all? */
export function isCutoverEligible(path) {
  return capabilityFor(path).cutoverEligible;
}

/**
 * certificationFor — everything the go-live checklist asks about one path.
 *
 * `certified` is deliberately harder to earn than `cutoverEligible`: it also
 * requires the path to have been raced and to have survived its infrastructure
 * failing. `blockedBy` names exactly what is missing, so the checklist never
 * has to be maintained by hand.
 */
export function certificationFor(path) {
  const capability = capabilityFor(path);
  const testing = TESTING[path] ?? UNTESTED;
  const flags = { ...capability, ...testing };
  const blockedBy = CERTIFICATION_CRITERIA.filter((flag) => !flags[flag]);
  return {
    path,
    describes: PATH_SPEC[path].describes,
    ...capability,
    ...testing,
    blockedBy,
    certified: blockedBy.length === 0,
  };
}

/** The whole per-domain certification table, for the checklist document. */
export function certificationMatrix() {
  return ALL_PATHS.map(certificationFor);
}

/**
 * The single production-readiness verdict. Certified only when EVERY money path
 * is — a platform is not production ready in the parts nobody has tested.
 */
export function productionCertificationStatus() {
  const rows = certificationMatrix();
  const certified = rows.filter((r) => r.certified);
  return {
    status: certified.length === rows.length
      ? 'PRODUCTION_CERTIFIED'
      : 'NOT PRODUCTION CERTIFIED',
    ready: certified.length === rows.length,
    totalPaths: rows.length,
    certified: certified.map((r) => r.path),
    cutoverEligible: rows.filter((r) => r.cutoverEligible).map((r) => r.path),
    concurrencyTested: rows.filter((r) => r.concurrencyTested).map((r) => r.path),
    infrastructureTested: rows.filter((r) => r.infrastructureTested).map((r) => r.path),
  };
}

/**
 * Dependencies of `path` that are NOT yet authoritative in Postgres.
 *
 * Exported so the ordering rule stays directly testable. validateAuthorityConfig
 * checks capability first and stops there for an ineligible path — reporting
 * "ledger is out of order" alongside "ledger has no implementation" would be
 * noise — but that short-circuit would otherwise leave this rule uncovered
 * until a second path becomes eligible, which is exactly when a regression
 * would be most expensive.
 *
 * `seen` guards the mutual recursion with authorityFor(), which consults this
 * function to fail safe. PATH_SPEC is a DAG so a cycle cannot occur today; the
 * guard is here so that introducing one becomes a visible wrong answer rather
 * than a hung process on a money path.
 */
export function laggingDependencies(path, env = process.env, seen = new Set()) {
  if (!isKnownPath(path)) {
    throw new Error(`Unknown money path '${path}'. Known paths: ${ALL_PATHS.join(', ')}`);
  }
  if (seen.has(path)) return [];
  const walked = new Set(seen).add(path);
  return PATH_SPEC[path].dependsOn.filter((dep) => authorityFor(dep, env, walked) !== STORE.POSTGRES);
}

const PATH_SPEC = Object.freeze({
  [MONEY_PATHS.WALLET]: {
    env: 'MONEY_AUTHORITY_WALLET',
    order: 1,
    dependsOn: [],
    describes: 'user balances + WalletLedger (wallets, wallet_ledger)',
  },
  [MONEY_PATHS.LEDGER]: {
    env: 'MONEY_AUTHORITY_LEDGER',
    order: 3,
    // The accounting ledger is derived from completed money movements, so it
    // cannot be authoritative in Postgres while balances still are in Mongo.
    dependsOn: [MONEY_PATHS.WALLET],
    describes: 'double-entry accounting events + merchant wallet ledger',
  },
  [MONEY_PATHS.ORDERS]: {
    env: 'MONEY_AUTHORITY_ORDERS',
    order: 4,
    dependsOn: [MONEY_PATHS.WALLET, MONEY_PATHS.LEDGER],
    describes: 'payment orders + UTR registry',
  },
  [MONEY_PATHS.KYC]: {
    env: 'MONEY_AUTHORITY_KYC',
    order: 5,
    // Plan step 7: KYC cuts over LAST, after every money path is settled.
    dependsOn: [MONEY_PATHS.WALLET, MONEY_PATHS.LEDGER, MONEY_PATHS.ORDERS],
    describes: 'KYC submissions and status',
  },

  // ── Paths that move money but were never modelled ─────────────────────────
  // Declared with an env var and a dependency edge so the registry can report
  // them, the matrix shows the true size of the remaining work, and setting one
  // to `postgres` fails the boot instead of doing nothing. None is implemented,
  // so none can currently be flipped.
  //
  // NOTE on ordering: WALLET stays first. A proposal to resequence with the
  // user wallet LAST is defensible but inverts this graph, so it remains a
  // decision rather than a refactor — see docs/POSTGRES_FULL_AUTHORITY_PLAN.md.
  //
  // MERCHANT_WALLET moved from order 5 to order 2 on 2026-08-03, and its
  // dependency changed from LEDGER to WALLET. That edge was wrong as modelled:
  // a merchant movement writes its OWN ledger (merchant_wallet_entries) inside
  // its own transaction and never touches accounting_events, so nothing about
  // it required the double-entry ledger to move first.
  //
  // WALLET is the real dependency, and it is a transactional one. A deposit
  // confirmation debits the merchant and credits the user inside ONE Mongo
  // session (domains/payment/payment.routes.js, merchant.routes.js) — put those
  // two balances in different stores and that session no longer covers both, so
  // an abort between them leaves the merchant debited and the user uncredited.
  // The deterministic txId makes a RETRY safe, but nothing makes an unretried
  // failure safe, which is exactly the "one settlement, two sources of truth"
  // hazard this graph exists to prevent.
  //
  // The remaining coupling to LEDGER is a reporting one, not a transactional
  // one: until accounting_events moves too, a trial balance that includes
  // merchant tokens spans both stores. reconcile.js compares them account by
  // account, so it is visible rather than silent.
  [MONEY_PATHS.MERCHANT_WALLET]: {
    env: 'MONEY_AUTHORITY_MERCHANT_WALLET',
    order: 2,
    dependsOn: [MONEY_PATHS.WALLET],
    describes: 'merchant token balances + merchant wallet ledger',
  },
  [MONEY_PATHS.MERCHANT_SETTLEMENT]: {
    env: 'MONEY_AUTHORITY_MERCHANT_SETTLEMENT',
    order: 6,
    dependsOn: [MONEY_PATHS.MERCHANT_WALLET, MONEY_PATHS.ORDERS],
    describes: 'user↔merchant settlement of deposits and withdrawals',
  },
  [MONEY_PATHS.ADMIN_ISSUANCE]: {
    env: 'MONEY_AUTHORITY_ADMIN_ISSUANCE',
    order: 7,
    dependsOn: [MONEY_PATHS.MERCHANT_WALLET],
    describes: 'admin↔merchant token issuance and deduction',
  },
  [MONEY_PATHS.BETS]: {
    env: 'MONEY_AUTHORITY_BETS',
    order: 8,
    dependsOn: [MONEY_PATHS.WALLET, MONEY_PATHS.LEDGER],
    describes: 'bet lifecycle + stake reservation',
  },
  [MONEY_PATHS.SETTLEMENTS]: {
    env: 'MONEY_AUTHORITY_SETTLEMENTS',
    order: 9,
    dependsOn: [MONEY_PATHS.BETS, MONEY_PATHS.WALLET, MONEY_PATHS.LEDGER],
    describes: 'sports/cycle settlement and payout',
  },
  // Casino settles through the USER WALLET directly, not through the bets
  // path — gameProvider.routes.js calls walletAuthority, not the bet engine —
  // so its dependency is the wallet and the ledger, not BETS.
  [MONEY_PATHS.CASINO_SETTLEMENT]: {
    env: 'MONEY_AUTHORITY_CASINO_SETTLEMENT',
    order: 10,
    dependsOn: [MONEY_PATHS.WALLET, MONEY_PATHS.LEDGER],
    describes: 'casino provider callbacks (bet, win, rollback, refund, cancel)',
  },
  [MONEY_PATHS.BONUSES_AND_COMMISSIONS]: {
    env: 'MONEY_AUTHORITY_BONUSES',
    order: 11,
    dependsOn: [MONEY_PATHS.WALLET, MONEY_PATHS.LEDGER],
    describes: 'bonus engine + referral commission',
  },
});

export const ALL_PATHS = Object.freeze(
  Object.keys(PATH_SPEC).sort((a, b) => PATH_SPEC[a].order - PATH_SPEC[b].order)
);

function isKnownPath(path) {
  return Object.prototype.hasOwnProperty.call(PATH_SPEC, path);
}

/**
 * The store an operator has ASKED for on this path, before safety checks.
 * Anything other than an exact case-insensitive 'postgres' reads as Mongo —
 * a typo must never be interpreted as "move the source of truth for money".
 */
function requestedStore(path, env) {
  const raw = env[PATH_SPEC[path].env];
  return String(raw ?? '').trim().toLowerCase() === STORE.POSTGRES
    ? STORE.POSTGRES
    : STORE.MONGO;
}

/**
 * authorityFor — the store that is authoritative for `path` right now.
 *
 * Fails SAFE: if Postgres authority is requested but Postgres is not
 * configured, this returns MONGO. Returning POSTGRES there would send the app
 * looking for balances in a database it has no connection to.
 */
export function authorityFor(path, env = process.env, seen = new Set()) {
  if (!isKnownPath(path)) {
    throw new Error(`Unknown money path '${path}'. Known paths: ${ALL_PATHS.join(', ')}`);
  }
  if (requestedStore(path, env) !== STORE.POSTGRES) return STORE.MONGO;
  if (!pgConfigured()) return STORE.MONGO;
  // The capability gate. A path without a complete Postgres implementation can
  // never be authoritative, whatever the environment says — otherwise setting
  // the variable would move the *claim* without moving the *code*, and reads
  // would go to a store that does not own the data. validateAuthorityConfig
  // turns this into a boot failure rather than a silent downgrade, but the
  // runtime resolver has to fail safe on its own too: anything that calls
  // authorityFor() without having gone through boot validation (a script, a
  // test, a worker) still gets the truthful answer.
  if (!isCutoverEligible(path)) return STORE.MONGO;
  // The ordering gate, for the same reason. A path whose dependency still lives
  // in Mongo would split one settlement across two sources of truth, and
  // validateAuthorityConfig only catches that at boot — so a script, worker or
  // cron that never boots the app would happily act on the incoherent answer.
  // reconcile.js is exactly that case: it picks its REPAIR DIRECTION from this
  // resolver, and a wrong answer there overwrites good balances with stale ones.
  if (laggingDependencies(path, env, seen).length) return STORE.MONGO;
  return STORE.POSTGRES;
}

export function isPostgresAuthoritative(path, env = process.env) {
  return authorityFor(path, env) === STORE.POSTGRES;
}

/** True when at least one path has moved — i.e. the reverse mirror must run. */
export function anyPathOnPostgres(env = process.env) {
  return ALL_PATHS.some((p) => isPostgresAuthoritative(p, env));
}

/** The full matrix, for /health, boot logging and the admin cutover view. */
export function authorityMatrix(env = process.env) {
  return ALL_PATHS.map((path) => {
    const capability = capabilityFor(path);
    return {
      path,
      describes: PATH_SPEC[path].describes,
      requested: requestedStore(path, env),
      // `effective` is the ONLY field anything should act on. It already
      // accounts for the capability gate, so it can never say 'postgres' for a
      // path whose writes still go to MongoDB — which is what health endpoints
      // and the metrics gauge report.
      effective: authorityFor(path, env),
      implemented:     capability.implemented,
      dualWriteCapable: capability.dualWrite,
      reconciled:      capability.reconciled,
      rollbackCapable: capability.rollback,
      cutoverEligible: capability.cutoverEligible,
      missing:         capability.missing,
      notes:           capability.notes,
    };
  });
}

/**
 * POSTGRES_FULL_FINANCIAL_AUTHORITY — one honest answer to "is the migration
 * done?", for the certification report and any dashboard that asks.
 *
 * READY requires every declared money path to be BOTH eligible and actually
 * authoritative in Postgres. Anything less is NOT_READY with the specific
 * paths named, so the gap can never be hidden behind a configuration flag.
 */
export function fullFinancialAuthorityStatus(env = process.env) {
  const matrix = authorityMatrix(env);
  const notImplemented = matrix.filter((m) => !m.implemented).map((m) => m.path);
  const eligibleNotFlipped = matrix
    .filter((m) => m.cutoverEligible && m.effective !== STORE.POSTGRES)
    .map((m) => m.path);
  const onPostgres = matrix.filter((m) => m.effective === STORE.POSTGRES).map((m) => m.path);

  return {
    status: notImplemented.length === 0 && eligibleNotFlipped.length === 0
      ? 'POSTGRES_FULL_FINANCIAL_AUTHORITY = READY'
      : 'POSTGRES_FULL_FINANCIAL_AUTHORITY = NOT READY',
    ready: notImplemented.length === 0 && eligibleNotFlipped.length === 0,
    totalPaths: matrix.length,
    onPostgres,
    eligibleNotFlipped,
    notImplemented,
  };
}

/**
 * validateAuthorityConfig — refuse an incoherent cutover configuration.
 *
 * Two failures are possible and both are worth stopping a boot for, because
 * either one means money would be read from a store that does not own it:
 *
 *  1. A path requests Postgres while DATABASE_URL is unset. The request is
 *     silently downgraded to Mongo by authorityFor(), which is the safe
 *     behaviour, but shipping a deploy that *believes* it cut over when it did
 *     not is its own hazard — so it is reported.
 *  2. A path is on Postgres while one of its dependencies is still on Mongo
 *     (e.g. ledger cut over but wallet did not). A single settlement would then
 *     read balances from one store and write accounting to another, and no
 *     reconciliation could tell you which was right.
 *
 * Returns { ok, errors[], warnings[] } rather than throwing, so the caller
 * decides whether this is fatal (production boot) or a warning (a test).
 */
export function validateAuthorityConfig(env = process.env) {
  const errors = [];
  const warnings = [];

  for (const path of ALL_PATHS) {
    const requested = requestedStore(path, env);
    if (requested !== STORE.POSTGRES) continue;

    if (!pgConfigured()) {
      warnings.push(
        `${PATH_SPEC[path].env}=postgres but DATABASE_URL is unset — '${path}' stays on MongoDB. ` +
        `Set DATABASE_URL or remove the variable so the intent matches reality.`
      );
      continue;
    }

    // The capability gate, as a BOOT FAILURE rather than a silent downgrade.
    // This is the check whose absence let `MONEY_AUTHORITY_LEDGER=postgres` be
    // accepted while every ledger read and write still went to MongoDB — the
    // config, the boot log and the metrics gauge all claiming a cutover that
    // had not happened. Refusing to start is the only response that cannot be
    // mistaken for success.
    const capability = capabilityFor(path);
    if (!capability.cutoverEligible) {
      errors.push(
        `${PATH_SPEC[path].env}=postgres but '${path}' is NOT eligible for cutover — missing: ` +
        `${capability.missing.join(', ')}. ${capability.notes} ` +
        `Setting this variable would change what the system CLAIMS without changing where money is ` +
        `read or written. Build the missing pieces (see docs/POSTGRES_FULL_AUTHORITY_PLAN.md) or ` +
        `remove ${PATH_SPEC[path].env}.`
      );
      continue; // dependency check below is meaningless for a path that cannot flip
    }

    const laggingDeps = laggingDependencies(path, env);
    if (laggingDeps.length) {
      errors.push(
        `'${path}' is set to Postgres but ${laggingDeps.map((d) => `'${d}'`).join(', ')} ` +
        `${laggingDeps.length === 1 ? 'is' : 'are'} still on MongoDB. The plan flips paths in order ` +
        `(${ALL_PATHS.join(' → ')}); a settlement that spans both stores has no single source of truth. ` +
        `Cut over ${laggingDeps.map((d) => PATH_SPEC[d].env).join(' and ')} first, or revert ${PATH_SPEC[path].env}.`
      );
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

/**
 * Called once at boot. Logs the matrix when anything has moved, and returns the
 * validation result so server.js can refuse to start on an incoherent config.
 * Silent in the default all-Mongo case — the overwhelmingly common state should
 * not add noise to every boot.
 */
export function reportAuthorityAtBoot(env = process.env) {
  const result = validateAuthorityConfig(env);

  for (const w of result.warnings) console.warn(`⚠️  [money-authority] ${w}`);
  for (const e of result.errors)   console.error(`❌ [money-authority] ${e}`);

  if (anyPathOnPostgres(env)) {
    const moved = authorityMatrix(env).filter((r) => r.effective === STORE.POSTGRES);
    console.log(
      `💰 [money-authority] Postgres is the source of truth for: ${moved.map((r) => r.path).join(', ')}. ` +
      `Mongo is kept complete by the reverse mirror — rollback per postgres/DATA_ROLLBACK_PLAN.md Phase B.`
    );
  }

  return result;
}
