// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * playerBet.service.js — placing a player's real bet: every check, the stake
 * and the bet in one transaction, then the broadcast (owner, 2026-10-22).
 *
 * The ONE admission for a player's bet. `POST /api/bet/place` (the player's
 * tap) and the auto bets (`cycleGenerator.runPlayerAutoBets`, autoBets.js)
 * both come through `placePlayerBet`, so an auto bet is refused for exactly
 * what a tapped bet is refused for: the board rules, the round's status and
 * clock, the board's switch and stake bounds (`assessBet`), the profile and
 * the funding split (S3). The checks and their wording moved here unchanged
 * from bet.routes.js.
 *
 * Answers one of
 *   { kind: 'refused', status, body }     nothing moved; `body` is the HTTP answer
 *   { kind: 'replay',  bet }              this key already placed a bet; nothing moved
 *   { kind: 'placed',  bet, balances, cycle }   the stake moved in this call
 * and `announcePlacedBet` sends what follows a placed bet (balance, pools,
 * staff). It runs after the commit and never throws (§21).
 */
import { db } from '#db';
import { getBalances } from '../wallet/walletAuthority.service.js';
import * as betAuthority from '#db/repositories/bets.js';
import { assessBet, computeBetFundingPlan, computeMaxStake } from '../risk/riskValidation.service.js';
import { MARKET_SIDES } from '../trading/tradingModels.js';
import { boardOf } from './cycleTypes.js';
import { computeRealPools } from './cyclePool.service.js';
import { cycleSnapshotPublisher } from './cycleSnapshotPublisher.js';
import { poolsHidden } from './cyclePublicView.js';
import { getSystemConfig } from '#db/repositories/config.js';
import { emitToStaff } from '../notification/staffEventAreas.js';

const refuse = (status, body) => ({ kind: 'refused', status, body });

/**
 * Place a player's bet. `betId` is the caller's idempotency key (the route's
 * `bet_<userId>_<Idempotency-Key>`, an auto bet's `autoBetId`); a second call
 * with it places nothing. `autoPlanId` marks a bet the plan placed.
 */
export async function placePlayerBet({ userId, cycleId, side, amount, betId, autoPlanId = null }) {
  const betTxBase = betId;

  // Fast replay gate: this exact request already produced a bet. Answer with it
  // and touch NOTHING.
  const priorBet = await db.bets.getBet(betTxBase);
  if (priorBet) return { kind: 'replay', bet: priorBet };

  if (!MARKET_SIDES.includes(side)) {
    return refuse(400, { success: false, code: 'INVALID_SIDE', message: 'Invalid side — must be DELHI or BOMBAY' });
  }

  // ── The player has read how the boards work ──────────────────────────────
  // Owner, 2026-10-08: players are told how a round is won and that the
  // pools include phantom bets, and accept it, before they stake anything
  // (`domains/markets/boardRules.js`, the admin's current version). After the replay gate, so a retry of
  // a bet placed under an older acceptance still answers with that bet.
  if (!(await db.boardRules.acceptsCurrent(userId))) {
    return refuse(409, {
      success: false, code: 'BOARD_RULES_NOT_ACCEPTED',
      message: 'Please read and accept the board rules before you bet.',
    });
  }

  // ── Cycle check ──────────────────────────────────────────────────────────
  // Read BEFORE the limits, because the limits belong to the cycle.
  const cycle = await db.markets.getCycle(cycleId);

  if (!cycle) {
    return refuse(404, { success: false, code: 'CYCLE_NOT_FOUND', message: 'Cycle not found' });
  }

  if (!['OPEN', 'MERGED'].includes(cycle.status)) {
    return refuse(400, {
      success: false, code: 'BETTING_CLOSED',
      message: `Betting closed. Cycle status: ${cycle.status}`
    });
  }

  // ── The stake limits are the CYCLE'S BOARD'S ─────────────────────────────
  // Keyed on `cycle.type`, never on the `type` the client sent. They used to
  // be read from the request body, so a full-day bet (floor ₹100) went
  // through at ₹10 by claiming to be a 30-minute bet, and a 30-minute bet
  // reached the full-day ceiling by claiming the opposite (R6, 2026-09-30).
  // The body's `type` is now only echoed back in the response.
  //
  // A board switched off takes no new bet; its open round still settles.
  const config = await getSystemConfig();
  const board  = await boardOf(cycle.type);
  if (!board?.enabled) {
    return refuse(409, {
      success: false,
      message: 'This board is switched off. Pick another board.',
      code: 'BOARD_SWITCHED_OFF',
    });
  }
  const minBet = board.minBet;
  const maxBet = board.maxBet;

  // ── Risk Platform gate (Phase 010) — the single validation authority ────
  // positive/whole/multiples-of-10, min/max, and the config-gated
  // opposite-side restriction.
  try {
    await assessBet({ userId, cycleId, side, amount, min: minBet, max: maxBet });
  } catch (riskErr) {
    return refuse(riskErr.status || 400, { success: false, message: riskErr.message, code: riskErr.code });
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
  // The clock does not slip, so the clock is the gate: the board's own
  // close offset, read above with its stake limits.
  if (Date.now() >= cycle.endTime - (board.phases.closeBeforeEndSec * 1000)) {
    return refuse(400, {
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
  const [user, balances, profile] = await Promise.all([
    db.users.getUser(userId),
    getBalances(String(userId)),
    db.promo.playProfileOf(userId),
  ]);

  if (!user) {
    return refuse(404, { success: false, message: 'User not found' });
  }

  // ── VIP and GENERAL never share a cycle (owner, 2026-10-08) ─────────────
  // A player bets only on their own profile's cycles. The stake's pockets
  // are held to the cycle's audience again in the writer (`bets.core`), so
  // this is the answer a player can act on, not the only guard.
  if (cycle.audience !== profile) {
    return refuse(409, {
      success: false, code: 'WRONG_PROFILE_FOR_CYCLE',
      message: profile === 'GENERAL'
        ? 'You are playing with your General balance. Switch to VIP ID to bet on this board.'
        : 'This board is for General balance players. Switch to General to bet on it.',
    });
  }

  const availableDeposit  = balances.depositBalance  || 0;
  const availableWinnings = balances.winningsBalance || 0;
  const availableReserve  = balances.reserveBalance  || 0;
  const totalAvailable    = availableDeposit + availableWinnings + availableReserve;

  // ── A GENERAL bet is staked from the GENERAL balance alone ──────────────
  // No reserve split and no other pocket: the bonus and what it has won are
  // the whole of what a GENERAL player plays with.
  let stakeSlices;
  if (profile === 'GENERAL') {
    const availableGeneral = balances.promoBalance || 0;
    if (amount > availableGeneral) {
      return refuse(400, {
        success: false, code: 'STAKE_EXCEEDS_FUNDABLE',
        message: `You can bet up to ₹${availableGeneral} from your General balance right now.`,
        balance: { general: availableGeneral, maxStake: availableGeneral },
      });
    }
    stakeSlices = [{
      field: 'promoBalance', suffix: '_gen', amount,
      reason: `BET_PLACED General balance — ₹${amount} on ${side}`,
    }];
  } else {
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
      return refuse(400, {
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
      return refuse(planErr.status || 400, {
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
    // The bet's identity (betTxBase) was established at the top of
    // the handler from the REQUIRED Idempotency-Key. It is the txId of every
    // slice's ledger row and the Bet row's _id, so on both stores the unique
    // index — not a convention — is what makes a redelivery idempotent.
    stakeSlices = [
      { field: 'depositBalance',  suffix: '_dep', amount: fromDeposit,
        reason: `BET_PLACED deposit portion — ₹${amount} on ${side}` },
      { field: 'winningsBalance', suffix: '_win', amount: fromWinnings,
        reason: `BET_PLACED winnings portion — ₹${amount} on ${side}` },
      { field: 'reserveBalance',  suffix: '_res', amount: fromReserve,
        reason: `BET_PLACED reserve portion (${plan.reservePercentApplied}%) — ₹${amount} on ${side}` },
    ].filter((s) => s.amount > 0);
  }

  // ── Stake + bet record ─────────────────────────────────────────────────
  // These were once two operations: lock the stake, then insert the bet.
  // Between them the user's money is locked against a bet that does not
  // exist, and nothing sweeps that — the stake is attributed to a bet id
  // never written, so no settlement releases it and nothing can attribute
  // it. The balance is simply short until a human finds it.
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
    autoPlanId,
  });
  const stakeLock = { ok: placed.ok, balances: placed.balances };
  const pgBet = placed.ok ? placed.bet : null;
  const moneyMoved = placed.ok && placed.idempotent !== true;

  if (!stakeLock.ok && placed.reason === 'wrong_balance_for_cycle') {
    // The writer holds the stake to the cycle's audience. Reached only if the
    // profile changed between the check above and the write.
    return refuse(409, {
      success: false, code: 'WRONG_PROFILE_FOR_CYCLE',
      message: 'Your profile changed while this bet was being placed. Please try again.',
    });
  }
  if (!stakeLock.ok && placed.reason === 'cycle_closed') {
    // Betting closed between the check above and the write. Nothing moved.
    return refuse(400, {
      success: false,
      message: 'Betting closed for this cycle. Your balance was not touched.',
      code: 'BETTING_CLOSED',
    });
  }
  if (!stakeLock.ok) {
    // Concurrent request won the race — our pre-computed split is now stale.
    return refuse(400, {
      success: false, code: 'INSUFFICIENT_BALANCE',
      message: 'Insufficient balance. Please try again.',
      balance: { deposit: availableDeposit, winnings: availableWinnings, reserve: availableReserve, total: totalAvailable }
    });
  }

  // Already written inside the stake's transaction, under `bet_id` UNIQUE —
  // so a delivery that raced past the fast gate collides INSIDE the
  // transaction rather than creating a second bet.
  const bet = await betAuthority.getBetDoc(pgBet._id);

  // Every delivery except the one that moved the money is a replay: the bet
  // exists once, the money moved at most once, and the pool / broadcast must
  // run at most once.
  if (!moneyMoved) return { kind: 'replay', bet };
  return { kind: 'placed', bet, balances: stakeLock.balances, cycle };
}

/**
 * What follows a placed bet, after its commit: the player's balance down
 * their stream, the public pool total (coalesced) and the split to staff.
 * Never throws: the bet is placed whatever happens here (§21).
 */
export async function announcePlacedBet({ userId, cycleId, cycle, side, amount, balances }) {
  try {
    const updatedUser = balances;

    // SSE: push updated balance to user's personal channel (Finding 3)
    try {
      global.sseManager?.sendToUser?.(String(userId), 'balance_update', {
        depositBalance:  updatedUser.depositBalance  || 0,
        winningsBalance: updatedUser.winningsBalance || 0,
        reserveBalance:  updatedUser.reserveBalance  || 0,
        promoBalance:    updatedUser.promoBalance    || 0,
        totalBalance:    (updatedUser.depositBalance || 0) + (updatedUser.winningsBalance || 0),
      });
    } catch (_) { /* SSE failure never blocks the bet response */ }

    // ── The round, for the broadcast ─────────────────────────────────────────
    // Whether the round still takes bets was asked INSIDE the transaction that
    // wrote this one (`bets.core.placeBet`, share-locked against every status
    // change), so a bet that got this far is in the round and is counted when
    // the winner is chosen. This read only supplies the house figures the
    // public total adds to the real pools.
    //
    // It replaced a re-check here, after the commit, that asked the status but
    // not the clock and refunded a bet whose round had closed meanwhile: a bet
    // committed after `completeCycle` read the pools was accepted, settled, and
    // never counted when the smaller side was chosen.
    const cycleNow = await db.markets.getCycle(cycleId);

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
    const phantomD = cycleNow?.phantomDelhi || 0;
    const phantomB = cycleNow?.phantomBombay || 0;
    const updatedCycle = {
      realDelhi: realD,
      realBombay: realB,
      phantomDelhi: phantomD,
      phantomBombay: phantomB,
      totalDelhi: realD + phantomD,
      totalBombay: realB + phantomB,
    };
    // Named in THIS scope, because the broadcast below reads them as bare
    // identifiers. It used to, without this line: `totalDelhi`, `totalBombay`
    // and `realNow` existed only in the PHANTOM handler further down, and this
    // block was written against that shape. Every real bet therefore threw
    // `ReferenceError: totalDelhi is not defined` — AFTER the stake had been
    // locked and committed.
    //
    // §21 exactly: a write that follows a commit and is allowed to fail. The
    // money moved, the handler's catch answered "Failed to place bet", and the
    // player watched ₹100 leave their balance while being told nothing had
    // happened. The bet was real and settled normally; only the person who
    // placed it did not know.
    const { totalDelhi, totalBombay } = updatedCycle;

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
        poolsHidden: poolsHidden(cycleNow),
      });

      // ADMINS get the full real/phantom breakdown, per bet, on admin-room only
      // (few admins — per-bet detail here is cheap and useful).
      emitToStaff(global.io, 'admin_bet_placed', {
        cycleId,
        side,
        amount,
        cycleType:        cycle.type,
        newRealDelhi:     realD,
        newRealBombay:    realB,
        newPhantomDelhi:  updatedCycle.phantomDelhi,
        newPhantomBombay: updatedCycle.phantomBombay,
        newTotalDelhi:    totalDelhi,
        newTotalBombay:   totalBombay,
      });
    }

  } catch (error) {
    console.error(`❌ Announcing bet on ${cycleId}:`, error.message);
  }
}
