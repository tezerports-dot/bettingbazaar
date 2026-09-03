// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)


import express from 'express';
import { db } from '#db';
import { creditWinnings, lockBetStake, unlockBetStake, getBalances } from '../wallet/walletAuthority.service.js'; // HIGH-03: atomicBet removed (never called; inline atomic pattern used instead)
import { authenticate, requireApprovedKyc } from '../identity/auth.middleware.js';
import { betLimiter } from '../../middleware/security.js';
// Betting is for members of the official Telegram channel. The gate serves a
// cache kept current by chat_member events, so this costs a lookup, not a
// Telegram round-trip — see middleware/requireChannelMembership.js for the
// bounded-window policy when Telegram is unreachable.
import { requireChannelMembership } from '../../middleware/requireChannelMembership.js';
import { requireIdempotencyKey, IdempotencyKeyError } from '../../middleware/idempotencyKey.js';
import * as betAuthority from '#db/repositories/bets.js';
// Risk Platform (Phase 010): the single validation authority for bets.
// Phase A (2026-07-10): computeBetFundingPlan owns the stake-split arithmetic.
import { assessBet, computeBetFundingPlan, computeMaxStake } from '../risk/riskValidation.service.js';
// Shared trading vocabulary (Phase 011) — one source for sides/statuses.
import { MARKET_SIDES } from '../trading/tradingModels.js';
// Cycle-type vocabulary: which betLimits key belongs to which type.
import { CYCLE_TYPES, DEFAULT_CYCLE_PHASES, isCycleType, limitsKeyFor, phasesFor } from './cycleTypes.js';
// Phase offsets, for the clock-based betting cutoff below. Same single
// declaration the generator and the admin phase view read.
// Derived cycle pools (FLAGS.DERIVED_CYCLE_POOLS, default off) — see
// cyclePool.service.js for why the running total is the scaling ceiling.
import { computeRealPools } from './cyclePool.service.js';
// Real/phantom pools reveal the minority-side winner — the public bet broadcast
// must carry totals only. assertPublicCycleSafe throws if one slips in.
import { assertPublicCycleSafe } from './cyclePublicView.js';
// Coalesces per-bet pool changes into one snapshot/sec/cycle instead of a
// per-bet fan-out to every connected client (cycleSnapshotPublisher.js).
import { cycleSnapshotPublisher } from './cycleSnapshotPublisher.js';
// Pages the operator when a bet's stake cannot be conclusively refunded or
// released — the one outcome no automated path can resolve on its own.
import { sendAlert } from '../../services/alerting.service.js';
import { getSystemConfig } from '#db/repositories/config.js';

const router = express.Router();

// ─────────────────────────────────────────────────────────────────────────────
// idempotentBetResponse — the success body for a bet that ALREADY exists, i.e. a
// redelivered POST /place. It carries the original bet and the user's CURRENT
// balances, so a client that retried (its own 500/network retry, a double-tap, a
// proxy replay) gets the same "placed" answer it would have gotten the first
// time — and never a second bet, a second debit, a doubled pool or a duplicate
// Transaction row. Balances are read live because what the client needs is "what
// is my balance now", not the balance captured at first placement.
// ─────────────────────────────────────────────────────────────────────────────
async function idempotentBetResponse(bet, userId, type) {
  let balance = null;
  try {
    const b = await getBalances(userId);
    balance = {
      deposit:  b.depositBalance,
      winnings: b.winningsBalance,
      reserve:  b.reserveBalance || 0,
      locked:   b.lockedBalance,
      total:    (b.depositBalance || 0) + (b.winningsBalance || 0),
    };
  } catch { /* the balance echo is a convenience; its absence never fails a replay */ }
  return {
    success: true,
    message: 'Bet already placed',
    idempotent: true,
    bet: {
      id:       bet._id,
      cycleId:  bet.cycleId,
      side:     bet.side,
      amount:   bet.amount,
      status:   bet.status || 'PENDING',
      type,
      placedAt: bet.timestamp,
    },
    balance,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/bet/place
// Places a real bet. Deducts from winnings first, then deposits.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/place', authenticate, requireApprovedKyc, requireChannelMembership({ action: 'place a bet' }), betLimiter, async (req, res) => {
  // NOTE: No session opened here — the critical balance step is a single atomic
  // findOneAndUpdate (see FIX B). Remaining writes (Bet, Cycle pool, Transaction)
  // are idempotent/append-only and do not need a multi-document transaction.

  try {
    const { cycleId, side, amount: rawAmount, type } = req.body;
    const amount = Number(rawAmount);
    const userId = req.user.userId;

    // ── Server-enforced idempotency (M-2) ────────────────────────────────────
    // The bet's identity comes from the caller's Idempotency-Key, REQUIRED here.
    // The server cannot invent one: a fresh id per delivery is not idempotency,
    // it is a second bet — and this is the endpoint where a retry (the client's
    // own 500/network retry, a double-tap, a proxy replay) must never place two.
    // `bet_<userId>_<key>` is the stake movement's txId and, via a stable derived
    // ObjectId, the Bet row's _id on BOTH stores, so the gate is the unique index
    // rather than a convention. See middleware/idempotencyKey.js.
    let clientKey;
    try {
      clientKey = requireIdempotencyKey(req);
    } catch (keyErr) {
      if (keyErr instanceof IdempotencyKeyError) {
        return res.status(keyErr.status || 400).json({ success: false, message: keyErr.message });
      }
      throw keyErr;
    }
    const betTxBase  = `bet_${userId}_${clientKey}`;
    const betPublicId = betAuthority.publicIdFor(betTxBase);

    // Fast replay gate: this exact request already produced a bet. Answer with it
    // and touch NOTHING — no stake move, no pool change, no second Transaction
    // row, no double broadcast. This resolves the common (sequential) retry before
    // any work, on both stores, with one primary-key lookup.
    const priorBet = await db.bets.getBet(betTxBase);
    if (priorBet) {
      return res.json(await idempotentBetResponse(priorBet, userId, type));
    }

    // ── FIX A: DB-driven limits ──────────────────────────────────────────────
    // Old: const minBet = type === 'FULL_DAY' ? 100 : 10;  ← always hardcoded
    // New: read betLimits from SystemConfig.betLimits; fall back to safe defaults.
    // The limits key comes from the type registry rather than an isFullDay
    // ternary. Under the ternary a type that was neither silently inherited the
    // 30-minute bounds — which happens to be right for the 1-minute block and
    // would have been wrong, invisibly, for the next type added.
    const config    = await getSystemConfig();
    const isFullDay = type === CYCLE_TYPES.FULL_DAY;
    const limitsKey = isCycleType(type) ? limitsKeyFor(type) : 'thirtyMin';
    const minBet    = config?.betLimits?.[limitsKey]?.min ?? (isFullDay ? 100  : 10);
    const maxBet    = config?.betLimits?.[limitsKey]?.max ?? (isFullDay ? 500000 : 100000);

    if (!MARKET_SIDES.includes(side)) {
      return res.status(400).json({ success: false, message: 'Invalid side — must be DELHI or BOMBAY' });
    }

    // ── Risk Platform gate (Phase 010) — the single validation authority ────
    // positive/whole/multiples-of-10, min/max, and the config-gated
    // opposite-side restriction. Replaces the inline checks this route
    // previously ran itself.
    try {
      await assessBet({ userId, cycleId, side, amount, min: minBet, max: maxBet });
    } catch (riskErr) {
      return res.status(riskErr.status || 400).json({ success: false, message: riskErr.message, code: riskErr.code });
    }

    // ── Cycle check ──────────────────────────────────────────────────────────
    const cycle = await db.markets.getCycle(cycleId);

    if (!cycle) {
      return res.status(404).json({ success: false, message: 'Cycle not found' });
    }

    if (!['OPEN', 'MERGED'].includes(cycle.status)) {
      return res.status(400).json({
        success: false,
        message: `Betting closed. Cycle status: ${cycle.status}`
      });
    }

    // ── Time backstop: betting closes on the CLOCK, not on a flag ────────────
    //
    // The status check above used to be the only thing standing between a
    // player and a late bet, and `status` is flipped to CLOSED by the cycle
    // generator's 1-second tick. A tick that runs late — the generator shares
    // its event loop with settlement — leaves the cycle reading OPEN past the
    // moment betting was supposed to stop, and this route would take the bet.
    //
    // On a 30-minute block that slack is ~20 seconds wide (close at T−30s,
    // declare at T−10s) and never mattered. On the 1-minute block it is TWO
    // seconds (close T−5s, declare T−3s), and the generator deliberately
    // tolerates a missed CLOSED transition by completing a still-OPEN cycle
    // directly — which means bets were accepted until T−3s rather than T−5s
    // whenever a tick slipped.
    //
    // That window sits AFTER the phantom equalizer has run (T−9s), so a stake
    // landing in it moves the real minority side — the side that wins — after
    // the house has finished balancing. It is not a guaranteed win (the public
    // payload carries combined pools only, never the real/phantom split, so
    // the minority side is not visible), but "the outcome is influenced by
    // whoever benefits from a slow tick" is not a property a real-money board
    // should have.
    //
    // The clock does not slip, so the clock is the gate. `config` is already
    // loaded above for the stake limits, so this costs no extra read. An
    // unrecognised type keeps the status-only behaviour rather than being
    // rejected outright — it cannot be created through the model's enum, and
    // failing closed on the money path over an impossible value is worse.
    const phases = isCycleType(cycle.type)
      ? (phasesFor(cycle.type, config?.cyclePhases) || phasesFor(cycle.type, DEFAULT_CYCLE_PHASES))
      : null;
    if (phases && Date.now() >= cycle.endTime - (phases.closeBeforeEndSec * 1000)) {
      return res.status(400).json({
        success: false,
        message: 'Betting closed for this cycle',
        code: 'BETTING_CLOSED',
      });
    }

    // ── The balances come from the WALLET ────────────────────────────────────
    // This is a MONEY DECISION: it decides whether a stake can be funded, and
    // the funding plan below executes against `wallets`. Reading it anywhere
    // else is trap 7 — and reading it off the account is worse than stale,
    // because that table has no balance columns at all: every figure comes
    // back undefined, the `|| 0` makes it a confident zero, and no player can
    // place any bet.
    const [user, balances] = await Promise.all([
      db.users.getUser(userId),
      getBalances(String(userId)),
    ]);

    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const availableDeposit  = balances.depositBalance  || 0;
    const availableWinnings = balances.winningsBalance || 0;
    const availableReserve  = balances.reserveBalance  || 0;
    const totalAvailable    = availableDeposit + availableWinnings + availableReserve;

    const reservePercent = config?.betReservePercent ?? 1; // schema default: 1

    // ── The affordability check, against the TRUE ceiling ────────────────────
    // This used to compare the stake to deposit + winnings + reserve, which is
    // not what the wallet can fund: only `reservePercent` of a stake may come
    // from the reserve, and the rest must come from deposit + winnings. So a
    // player with ₹100 + ₹100 + ₹800 was refused a ₹500 bet by the funding plan
    // below with the message "Insufficient balance. Available: ₹1000" — told
    // they had the money while being refused it.
    //
    // computeMaxStake applies the same expression the funding plan does, so the
    // number in this message is exactly the number that would succeed.
    const { maxStake } = computeMaxStake({
      reservePercent, availableDeposit, availableWinnings, availableReserve,
    });

    if (amount > maxStake) {
      // Integer paise: `totalAvailable` is a sum of stored floats, so subtracting
      // the exact maxStake from it directly yields 793.8199999999999.
      const reserveLocked = (Math.round(totalAvailable * 100) - Math.round(maxStake * 100)) / 100;
      return res.status(400).json({
        success: false,
        code: 'STAKE_EXCEEDS_FUNDABLE',
        message: reserveLocked > 0
          ? `You can bet up to ₹${maxStake} right now. ₹${reserveLocked} of your reserve `
            + `can only be used ${reservePercent}% at a time, so add to your deposit to bet more.`
          : `You can bet up to ₹${maxStake} right now.`,
        balance: {
          deposit: availableDeposit, winnings: availableWinnings,
          reserve: availableReserve, total: totalAvailable,
          // How much of the reserve this wallet cannot reach yet. The client
          // shows it so the gap between "I hold ₹9" and "I may bet ₹7.21" is
          // explained rather than left as an apparently arbitrary limit.
          maxStake, reservePercent, reserveLocked,
        },
      });
    }

    // ── Bet funding split (Phase A, 2026-07-10) ──────────────────────────────
    // Admin-editable reserve % (Business Policy owns the number; Risk owns the
    // arithmetic). Replaces the hardcoded 0.97/0.03 Math.round pair, which
    // wasn't configurable, rounded 9.7/0.3 to 10/0, and could over-deduct
    // (₹50 → 49+2 = ₹51). Paise-exact: parts always conserve the stake.
    // Fallbacks preserved: reserve short → main; deposit short → winnings.
    let plan;
    try {
      plan = computeBetFundingPlan({
        amount, reservePercent,
        availableDeposit, availableWinnings, availableReserve,
      });
    } catch (planErr) {
      return res.status(planErr.status || 400).json({
        success: false,
        message: planErr.message,
        balance: { deposit: availableDeposit, winnings: availableWinnings, reserve: availableReserve, total: totalAvailable }
      });
    }
    const { fromDeposit, fromWinnings, fromReserve } = plan;

    // ── Stake lock (§7: walletAuthority is the sole balance writer) ─────────
    // This used to be a raw three-field `findOneAndUpdate` plus a
    // fire-and-forget ledger write, right here in the route. That made
    // balances have two writers, one of which the money-authority switch
    // could not reach — so flipping the wallet path to Postgres would have
    // split the source of truth mid-bet. The authority now owns it, and picks
    // the store per postgres/moneyAuthority.js.
    // ── The stake, split across pockets ─────────────────────────────────────
    // The bet's identity (betTxBase / betPublicId) was established at the top of
    // the handler from the REQUIRED Idempotency-Key. It is the txId of every
    // slice's ledger row and the Bet row's _id, so on both stores the unique
    // index — not a convention — is what makes a redelivery idempotent.
    const stakeSlices = [
      { field: 'depositBalance',  suffix: '_dep', amount: fromDeposit,
        reason: `BET_PLACED deposit portion — ₹${amount} on ${side}` },
      { field: 'winningsBalance', suffix: '_win', amount: fromWinnings,
        reason: `BET_PLACED winnings portion — ₹${amount} on ${side}` },
      { field: 'reserveBalance',  suffix: '_res', amount: fromReserve,
        reason: `BET_PLACED reserve portion (${plan.reservePercentApplied}%) — ₹${amount} on ${side}` },
    ].filter((s) => s.amount > 0);

    // ── Stake + bet record ─────────────────────────────────────────────────
    // On MONGO these are two operations: lock the stake, then insert the bet.
    // Between them the user's money is locked against a bet that does not
    // exist, and nothing sweeps that — the stake is attributed to a bet id
    // never written, so no settlement releases it and no reconciliation can
    // attribute it. The balance is simply short until a human finds it.
    //
    // The stake movement and the bet row are ONE transaction (`placeBet`), so
    // the window cannot open at all.
    //
    // This used to be `if (betsOnPostgres) { … } else { … }` — and
    // `betsOnPostgres` was deleted with the rest of the store resolver, so the
    // condition threw a ReferenceError on EVERY bet placed. The path is the
    // hottest one on the platform.
    //
    // `moneyMoved` IS the idempotency decision: true only for the single
    // delivery that actually debited. `placeBet` is idempotent on the key, so
    // every other delivery reports idempotent and moved nothing — and must not
    // run the pool increment, the transaction row or the broadcast. The
    // invariant is "the delivery that moved the money owns the side-effects".
    const placed = await betAuthority.placeBet({
      betId: betTxBase, userId, cycleId, side, amount,
      slices: stakeSlices,
      reason: `BET_PLACED — ₹${amount} on ${side}`,
    });
    const stakeLock = { ok: placed.ok, balances: placed.balances };
    const pgBet = placed.ok ? placed.bet : null;
    const moneyMoved = placed.ok && placed.idempotent !== true;

    if (!stakeLock.ok) {
      // Concurrent request won the race — our pre-computed split is now stale.
      return res.status(400).json({
        success: false,
        message: 'Insufficient balance. Please try again.',
        balance: { deposit: availableDeposit, winnings: availableWinnings, reserve: availableReserve, total: totalAvailable }
      });
    }

    // ── The bet record ───────────────────────────────────────────────────────
    // Already written inside the stake's transaction, under `bet_id` UNIQUE —
    // so a delivery that raced past the fast gate collides INSIDE the
    // transaction rather than creating a second bet. There is no separate
    // insert here to get wrong.
    const bet = await betAuthority.getBetDoc(pgBet._id);

    // Every delivery except the one that moved the money is a replay: the bet
    // exists once, the money moved at most once, and the pool / Transaction /
    // broadcast must run at most once. Return the existing bet and stop.
    if (!moneyMoved) {
      return res.json(await idempotentBetResponse(bet, userId, type));
    }

    const updatedUser = stakeLock.balances;

    // SSE: push updated balance to user's personal channel (Finding 3)
    try {
      global.sseManager?.sendToUser?.(String(userId), 'balance_update', {
        depositBalance:  updatedUser.depositBalance  || 0,
        winningsBalance: updatedUser.winningsBalance || 0,
        reserveBalance:  updatedUser.reserveBalance  || 0,
        totalBalance:    (updatedUser.depositBalance || 0) + (updatedUser.winningsBalance || 0),
      });
    } catch (_) { /* SSE failure never blocks the bet response */ }

    // ── Commit the bet against the cycle ─────────────────────────────────────
    // Two shapes, chosen by FLAGS.DERIVED_CYCLE_POOLS.
    //
    // STORED (default): one atomic `findOneAndUpdate` both increments the pool
    // and proves the cycle was still open (FIX-8a) — the increment IS the
    // TOCTOU guard. Correct, but it makes every concurrent bet queue on this
    // one document, which is the scaling ceiling in LATENCY.md.
    //
    // DERIVED: the pool is recomputed from the bets, so there is nothing to
    // increment — and any write to the Cycle document would reintroduce exactly
    // the contention this removes, including a no-op `$set`. The guard is
    // therefore a READ (reads do not contend), which reopens the TOCTOU window
    // the write had closed. It is closed again on the far side: the bet is
    // already inserted, so we re-read the status and, if the cycle closed
    // underneath us, take the same compensating path below.
    //
    // The compensation is safe against a settlement that ran in that window
    // because the delete is conditional on the bet still being PENDING — if
    // settlement already relabelled it WON/LOST, our delete matches nothing and
    // we must not refund. See the conditional `claimed` delete below.
    // The cycle must still be taking bets. A READ, not an increment: the pool
    // totals are derived from the bets and nothing on this path writes them —
    // a bet that also UPDATEd the cycle row would block against every other bet
    // doing the same, which is a 40P01 deadlock on the hottest path here.
    const cycleStillOpen = await db.markets.getAcceptingCycle(cycleId);
    if (!cycleStillOpen) {
      // Cycle closed between the pre-check and the commit — restore the stake
      // through the same authority that took it, so the compensating CREDIT
      // rows and the balance move stay together (CRIT-03).
      //
      // Claim the bet BEFORE refunding, and only refund if the claim succeeded.
      // Settlement selects on `status: 'PENDING'`, so it can legitimately have
      // picked this row up in the window we are compensating for. If it did,
      // it has already paid or consumed the stake — deleting and refunding on
      // top of that pays the user twice. Conditioning the delete on PENDING
      // makes the two paths race for the same row and lets exactly one win.
      //
      // This ordering also fixes the same latent double-refund on the default
      // stored-pool path, where the delete was unconditional.
      //
      // The claim has THREE outcomes, and collapsing the last two loses money.
      // A `.catch(() => null)` here would make a thrown query indistinguishable
      // from "no document matched", sending a transient database error down the
      // settlement-owns-it branch — which deliberately does not refund. The
      // stake would stay locked against a bet nobody settles, and the user would
      // be told it settled, so they would not even report it. Reconciliation
      // cannot recover it either: both stores agree the debit happened.
      let claimed;
      try {
        // `status = 'PENDING'` is in the DELETE's WHERE clause, so the database
        // settles who owns this bet rather than a read either side could pass.
        ({ claimed } = await db.bets.claimPendingBetForRefund(bet.betId ?? bet._id));
      } catch (claimErr) {
        // Ownership genuinely unknown. Refunding risks paying twice; not
        // refunding risks locking the stake. Do neither silently — page the
        // operator with the identifiers needed to resolve it by hand, and tell
        // the user the truth rather than a comforting guess.
        console.error(`Bet ${bet.betId ?? bet._id} compensation unresolved:`, claimErr.message);
        sendAlert('bet-compensation-unresolved',
          'Could not determine bet ownership while refunding a closed-cycle bet', {
            betId: String(bet.betId ?? bet._id), userId: String(userId), cycleId, amount,
            error: claimErr.message,
          }).catch(() => { /* alerting must never mask the original failure */ });
        return res.status(500).json({
          success: false,
          message: 'Betting closed and we could not confirm your bet. Support has been notified and your balance will be reconciled — please do not retry.',
        });
      }

      if (claimed) {
        await unlockBetStake(userId, {
          amount, txId: `refund_bet_${bet.betId ?? bet._id}`, refId: String(bet.betId ?? bet._id),
          slices: stakeSlices.map((s) => ({
            ...s,
            reason: `Bet refund — cycle closed during placement (${s.field.replace('Balance', '')} portion)`,
          })),
        }).catch(() => { /* restore failure is alerted by reconciliation, never blocks the response */ });
        return res.status(400).json({
          success: false,
          message: 'Betting window just closed. Your balance has been fully restored.'
        });
      }

      // Settlement won the race and owns this bet now. Do not touch the money.
      return res.status(400).json({
        success: false,
        message: 'Betting window just closed while your bet was being placed. It was included in the cycle that just settled — check My Bets for the result.'
      });
    }

    // ── No separate transaction row ─────────────────────────────────────────
    // A second audit record of the same fact used to be written here, with its
    // own before/after balances taken from figures read BEFORE the stake moved
    // — so a concurrent bet made them describe a position that never existed.
    // `placeBet` writes the ledger rows inside the same transaction as the
    // stake movement, which is the record, and the only one that cannot
    // disagree with the money.

    // ── Pool figures for the broadcast ───────────────────────────────────────
    // Summed from the bets, INCLUDING the one just placed. The read above was
    // taken before this stake existed, so reusing it would broadcast a total
    // that trails by exactly this bet — the bettor's own stake missing from the
    // pool they are looking at.
    //
    // There is no memo and no refresh interval. Both existed because each
    // recompute was a WRITE to the cycle document and a burst of bets became a
    // burst of contending writes. A sum over an indexed column writes nothing.
    const pools = await computeRealPools(cycleId).catch(() => null);
    const realD = pools ? pools.realDelhi : 0;
    const realB = pools ? pools.realBombay : 0;
    const phantomD = cycleStillOpen.phantomDelhi || 0;
    const phantomB = cycleStillOpen.phantomBombay || 0;
    const updatedCycle = {
      realDelhi: realD,
      realBombay: realB,
      phantomDelhi: phantomD,
      phantomBombay: phantomB,
      totalDelhi: realD + phantomD,
      totalBombay: realB + phantomB,
    };

    {
      // PUBLIC pool update — coalesced. Instead of fanning a `bet_placed` out to
      // every connected client on every bet (~500–800/sec × all users), hand the
      // post-$inc totals to the snapshot publisher, which emits at most one
      // update per cycle per second. Totals only; the publisher re-guards with
      // assertPublicCycleSafe so no real/phantom field can ever leak.
      cycleSnapshotPublisher.recordBet(cycleId, {
        cycleType:  cycle.type,
        totalDelhi,
        totalBombay,
      });

      // ADMINS get the full real/phantom breakdown, per bet, on admin-room only
      // (few admins — per-bet detail here is cheap and useful).
      global.io?.to('admin-room').emit('admin_bet_placed', {
        cycleId,
        side,
        amount,
        cycleType:        cycle.type,
        newRealDelhi:     realNow.realDelhi,
        newRealBombay:    realNow.realBombay,
        newPhantomDelhi:  updatedCycle.phantomDelhi,
        newPhantomBombay: updatedCycle.phantomBombay,
        newTotalDelhi:    totalDelhi,
        newTotalBombay:   totalBombay,
      });
    }

    res.json({
      success: true,
      message: 'Bet placed successfully',
      bet: {
        id:       bet._id,
        cycleId,
        side,
        amount,
        status:   'PENDING',   // BettingCard filters userBets by status === 'PENDING' for "You: ₹X" badge
        type,
        placedAt: bet.timestamp
      },
      balance: {
        deposit:  updatedUser.depositBalance,
        winnings: updatedUser.winningsBalance,
        reserve:  updatedUser.reserveBalance  || 0,
        locked:   updatedUser.lockedBalance,
        total:    updatedUser.depositBalance + updatedUser.winningsBalance,
      }
    });

  } catch (error) {
    console.error('❌ Place bet error:', error);
    res.status(500).json({ success: false, message: 'Failed to place bet' });
  }
});
// ─────────────────────────────────────────────────────────────────────────────
// POST /api/bet/phantom
// Places a phantom (ghost) bet. Only for users with phantomAccess assigned by admin.
// Phantom bets:
//   - Do NOT deduct from user balance (they are synthetic)
//   - Are flagged isPhantom: true
//   - Only affect phantomDelhi / phantomBombay pool counters
//   - Always LOSE at settlement (GameEngine skips isPhantom:true rows)
//   - Are only visible to admin room via admin_bet_placed event
//   - Pool totals shown to regular users include phantom (combined) but hide the split
// ─────────────────────────────────────────────────────────────────────────────
router.post('/phantom', authenticate, async (req, res) => {
  try {
    const { cycleId, side, amount } = req.body;
    const userId = req.user.userId;

    // ── Auth: only phantom agents may call this ────────────────────────────
    const agent = await db.users.getUser(userId);
    if (!agent || !agent.phantomAccess || agent.phantomAccess === 'NONE') {
      return res.status(403).json({ success: false, message: 'Phantom access not granted' });
    }

    const cycle = await db.markets.getCycle(cycleId);
    if (!cycle) return res.status(404).json({ success: false, message: 'Cycle not found' });

    // Verify the agent has access to this cycle type.
    const access = agent.phantomAccess;
    if (access !== 'BOTH' && access !== cycle.type) {
      return res.status(403).json({
        success: false,
        message: `Your phantom access is for ${access} cycles only`,
      });
    }

    if (!amount || amount < 1) {
      return res.status(400).json({ success: false, message: 'Invalid amount' });
    }
    if (!MARKET_SIDES.includes(side)) {
      return res.status(400).json({ success: false, message: 'Invalid side' });
    }

    // ── The bet row and the phantom pool, in ONE transaction ────────────────
    // They were two writes with the status checks in front of them, so a cycle
    // closing in between left a phantom bet the pools did not include —
    // invisible in the total a player sees, and still there at settlement. The
    // status and the phantom-closed flag are now re-checked under the cycle's
    // row lock, so an admin closing phantom betting cannot be raced by an
    // agent's last bet.
    const placed = await db.markets.placePhantomBet({
      betId: `phantom_${cycleId}_${userId}_${Date.now()}`,
      userId, cycleId, side, amountRupees: amount, cycleType: cycle.type,
    });

    if (!placed.ok) {
      const message = {
        CYCLE_NOT_FOUND: 'Cycle not found',
        CYCLE_CLOSED: `Betting closed. Cycle status: ${placed.status}`,
        PHANTOM_CLOSED: 'Phantom betting is closed for this cycle',
      }[placed.reason] || 'That phantom bet was refused.';
      return res.status(placed.reason === 'CYCLE_NOT_FOUND' ? 404 : 400)
        .json({ success: false, message });
    }
    if (placed.idempotent) {
      return res.json({ success: true, message: 'Phantom bet already recorded' });
    }

    const updatedCycle = placed.cycle;

    // ── The pools the broadcast carries ───────────────────────────────────
    // Phantom pools stay STORED: `equalizePhantomPools` OVERWRITES them with
    // max(delhi, bombay) rather than adding, so no sum over rows reproduces
    // them, and they come from a handful of admin agents rather than the
    // contention path. The REAL pools are summed from the bets — a phantom bet
    // moves neither, but the public number is the total, so both are needed.
    const realNow = await db.markets.realPools(cycleId).catch(() => ({ realDelhi: 0, realBombay: 0 }));
    const totalDelhi = realNow.realDelhi + (updatedCycle.phantomDelhi || 0);
    const totalBombay = realNow.realBombay + (updatedCycle.phantomBombay || 0);

    {
      // PUBLIC pool update — coalesced (same path as a real bet). A phantom bet
      // only moves the phantom pool, but the PUBLIC number is the total, so the
      // publisher carries the updated total exactly as it does for a real bet.
      cycleSnapshotPublisher.recordBet(cycleId, {
        cycleType:  cycle.type,
        totalDelhi,
        totalBombay,
      });

      // ADMINS see the phantom breakdown per bet on admin-room only.
      global.io?.to('admin-room').emit('admin_bet_placed', {
        cycleId,
        side,
        amount,
        isPhantom:        true,
        cycleType:        cycle.type,
        newRealDelhi:     realNow.realDelhi,
        newRealBombay:    realNow.realBombay,
        newPhantomDelhi:  updatedCycle.phantomDelhi,
        newPhantomBombay: updatedCycle.phantomBombay,
        newTotalDelhi:    totalDelhi,
        newTotalBombay:   totalBombay,
      });
    }

    res.json({
      success: true,
      message: 'Phantom bet placed',
      bet: { cycleId, side, amount, isPhantom: true }
    });

  } catch (error) {
    console.error('❌ Phantom bet error:', error);
    res.status(500).json({ success: false, message: 'Failed to place phantom bet' });
  }
});

export default router;
