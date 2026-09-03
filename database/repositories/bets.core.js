// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * postgres/betPg.js — the bet lifecycle, in PostgreSQL.
 *
 * Domain 5, and the one everything downstream waits on: `settlements` is built
 * out of bets, and casino settlement rides the same wallet primitives.
 *
 * ── The two defects this exists to remove ───────────────────────────────────
 * Both are recorded in docs/MONGO_MONEY_AUDIT.md, and a straight port would
 * reproduce them in a better database.
 *
 * M-2 — NO IDEMPOTENCY KEY ON THE BALANCE MOVE. `_mongoBetStake` is a bare
 * `$inc`; call it twice with the same `txId` and the stake is debited twice.
 * The current call site hides it — `bet.routes.js` builds
 * `bet_<userId>_<randomUUID()>` fresh per request — but that is not
 * idempotency, it is a NEW BET on every retry. A user whose connection dropped
 * and retried has two bets and two debits, which is a worse outcome than either
 * a refusal or a no-op. Here `bet_id` is UNIQUE and the collision happens
 * INSIDE the transaction, so a replay unwinds the whole thing.
 *
 * M-4 — THE LEDGER IS WRITTEN OUTSIDE THE TRANSACTION, best-effort, so money
 * can move unaudited. That is worse than it first sounds: the ledger is exactly
 * what reconciliation and the trial balance are computed from, so a failed
 * ledger write erases its own symptom. Here the bet row, the stake movement and
 * its ledger rows are ONE transaction under a single wallet lock, composed
 * through walletPg.applyMovementWithin.
 *
 * ── The state machine ───────────────────────────────────────────────────────
 *
 *      place ──▶ PENDING ──win────▶ WON
 *                   │
 *                   ├────lose───▶ LOST
 *                   ├────void───▶ VOID       (cycle cancelled; stake returned)
 *                   └────refund─▶ REFUNDED   (bet withdrawn; stake returned)
 *
 * Every transition names the state it expects, and the guard is in the UPDATE's
 * WHERE clause. A settlement arriving twice, or arriving after a void, matches
 * no row and is refused — which is what makes a re-run of the settlement sweep
 * safe rather than merely unlikely.
 *
 * ── Where the money is at each point ────────────────────────────────────────
 *   place     stake → locked          the user's stake is committed, not spent
 *   win       locked → (gone)         stake consumed; payout credited separately
 *   lose      locked → (gone)         stake consumed by the house
 *   void      locked → back to source returned to the pocket it came from
 *   refund    locked → back to source same, by the user's own request
 *
 * The source pockets are carried on the bet as `slices`, because a stake can be
 * funded from deposit and winnings at once and a return must go back to the
 * pockets it actually came from. Returning it all to one would silently convert
 * non-withdrawable deposit into withdrawable winnings.
 */
import { getPool, pgQuery, connectGuarded } from '../client.js';
import { applyMovementWithin } from './wallets.core.js';
import { moneyOperations } from '../../backend/services/metrics.service.js';
import { MONEY_PATHS } from '../moneyPaths.js';
import { paiseToRupees } from '../../backend/shared/money.js';

export const BET_STATUS = Object.freeze({
  PENDING:  'PENDING',
  WON:      'WON',
  LOST:     'LOST',
  VOID:     'VOID',
  REFUNDED: 'REFUNDED',
});

/**
 * Which prior state each transition demands, and whether the stake goes back.
 * Data rather than branches, because "does this return the stake?" is the
 * question most likely to be got wrong and a table can be read in one glance.
 */
const TRANSITIONS = Object.freeze({
  win:    { expect: BET_STATUS.PENDING, to: BET_STATUS.WON,      returnsStake: false },
  lose:   { expect: BET_STATUS.PENDING, to: BET_STATUS.LOST,     returnsStake: false },
  void:   { expect: BET_STATUS.PENDING, to: BET_STATUS.VOID,     returnsStake: true },
  refund: { expect: BET_STATUS.PENDING, to: BET_STATUS.REFUNDED, returnsStake: true },
});

/** Lock provenance counters, by the pocket they track. Reserve has none. */
const LOCK_PROVENANCE = Object.freeze({
  depositBalance:  'lockedDepositAmount',
  winningsBalance: 'lockedWinningsAmount',
});

const toPaise = (v) => Number(v ?? 0);

function count(operation, outcome) {
  moneyOperations.inc({ path: MONEY_PATHS.BETS, store: 'postgres', operation, outcome });
}

function rowToBet(row) {
  if (!row) return null;
  return {
    betId:       row.bet_id,
    publicId:     row.public_id,
    userId:      row.user_id,
    cycleId:     row.cycle_id,
    side:        row.side,
    stakePaise:  toPaise(row.stake_paise),
    payoutPaise: toPaise(row.payout_paise),
    platformFeePaise: toPaise(row.platform_fee_paise),
    status:      row.status,
    placedAt:    row.placed_at,
    settledAt:   row.settled_at,
    updatedAt:   row.updated_at,
  };
}

/** The current bet, or null. */
export async function getBet(betId) {
  const { rows } = await pgQuery(
    `SELECT * FROM bets WHERE bet_id = $1`, [String(betId)], 'bet_read',
  );
  return rowToBet(rows[0]);
}

/**
 * The canonical `bet_id` for a key that may be either one — or null.
 *
 * A bet has TWO identities and which one you hold depends on where it was born:
 *
 *   placed on Postgres   bet_id = the idempotency key (`bet_<user>_<key>`)
 *                        public_id = the ObjectId DERIVED from that key
 *   mirrored from Mongo  bet_id = the Mongo `_id`, public_id = NULL
 *
 * Settlement reads its bets from MONGO in both cases — gameEngine's `Bet.find`
 * and its winner aggregation — so the id it holds is always the Mongo `_id`,
 * which matches `bet_id` for a mirrored bet and `public_id` for a placed one.
 * Settling by the Mongo id alone therefore found nothing for every bet the
 * routed placement path had created, and refused it as `not_found` with the
 * stake still locked. Verified against a real PostgreSQL before it was fixed;
 * `betSettlementPg.test.js` keeps it verified.
 *
 * One indexed lookup per settle. Both columns carry a UNIQUE index, and there
 * is no way to avoid it: Mongo does not store the Postgres key, so the
 * translation has to happen somewhere.
 */
export async function resolveBetId(idOrPublicId) {
  if (!idOrPublicId) return null;
  const key = String(idOrPublicId);
  const { rows } = await pgQuery(
    `SELECT bet_id FROM bets WHERE bet_id = $1 OR public_id = $1 LIMIT 1`,
    [key], 'bet_resolve_id',
  );
  return rows[0]?.bet_id ?? null;
}

/** Its transition history, oldest first. Append-only in the database. */
export async function getBetHistory(betId) {
  const { rows } = await pgQuery(
    `SELECT tx_id, from_status, to_status, actor, reason, created_at
       FROM bet_transitions WHERE bet_id = $1 ORDER BY id`,
    [String(betId)], 'bet_history',
  );
  return rows.map((r) => ({
    txId: r.tx_id, from: r.from_status, to: r.to_status,
    actor: r.actor, reason: r.reason, at: r.created_at,
  }));
}

/**
 * A player's bets, newest first.
 *
 * ── Phantom bets are excluded by default ────────────────────────────────────
 * A phantom bet is house liquidity placed under a managed account; it is not
 * something a player did and must never appear in their history. Including
 * them by accident would show a player wagers they never made — so the
 * exclusion is the DEFAULT and a caller has to ask for them by name.
 *
 * Keyset pagination on `(placed_at, id)`: a bet placed while a player scrolls
 * shifts every later row under OFFSET, and the page after it silently skips
 * one of their own bets.
 */
export async function listUserBets(userId, {
  cycleId = null, status = null, includePhantom = false,
  limit = 50, cursor = null,
} = {}) {
  const where = ['user_id = $1'];
  const params = [String(userId)];
  const add = (sql, value) => { params.push(value); where.push(sql.replace('$?', `$${params.length}`)); };

  if (!includePhantom) where.push('NOT is_phantom');
  if (cycleId) add('cycle_id = $?', String(cycleId));
  if (status) add('status = $?', String(status));
  if (cursor?.placedAt && cursor?.id !== undefined) {
    params.push(cursor.placedAt, Number(cursor.id));
    where.push(`(placed_at, id) < ($${params.length - 1}, $${params.length})`);
  }

  const size = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const { rows } = await pgQuery(
    `SELECT id, bet_id, user_id, cycle_id, cycle_type, side, stake_paise,
            payout_paise, platform_fee_paise, status, placed_at, settled_at,
            COUNT(*) OVER () AS total_count
       FROM bets WHERE ${where.join(' AND ')}
      ORDER BY placed_at DESC, id DESC
      LIMIT ${size + 1}`,
    params, 'bet_list_user',
  );

  const hasMore = rows.length > size;
  const page = rows.slice(0, size);
  const last = page[page.length - 1];
  return {
    bets: page.map((r) => ({
      id: r.bet_id, betId: r.bet_id, userId: r.user_id,
      cycleId: r.cycle_id, cycleType: r.cycle_type, side: r.side,
      amount: paiseToRupees(Number(r.stake_paise)),
      payout: paiseToRupees(Number(r.payout_paise)),
      platformFee: paiseToRupees(Number(r.platform_fee_paise)),
      status: r.status,
      timestamp: r.placed_at, placedAt: r.placed_at, settledAt: r.settled_at,
    })),
    total: rows[0] ? Number(rows[0].total_count) : 0,
    nextCursor: hasMore && last ? { placedAt: last.placed_at, id: Number(last.id) } : null,
  };
}

/**
 * Lock the user's wallet, then the bet row, in that order.
 *
 * Not arbitrary: every path that touches a bet also touches its user's
 * balances, so taking the wallet lock first everywhere means two concurrent
 * operations on the same user queue behind one lock instead of grabbing them in
 * opposite orders and deadlocking. This is the only place both are taken, which
 * is what makes that guarantee checkable.
 */
async function withBetLock(userId, betId, fn) {
  const uid = String(userId);
  const bid = String(betId);
  const pool = await getPool();
  if (!pool) throw new Error('Postgres not configured (DATABASE_URL unset)');
  const client = await connectGuarded(pool);
  let failure = null;

  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO wallets (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`, [uid],
    );
    await client.query(`SELECT 1 FROM wallets WHERE user_id = $1 FOR UPDATE`, [uid]);
    const bet = await client.query(`SELECT * FROM bets WHERE bet_id = $1 FOR UPDATE`, [bid]);

    const { commit, value } = await fn({ client, uid, bid, bet: rowToBet(bet.rows[0]) });
    await client.query(commit ? 'COMMIT' : 'ROLLBACK');
    return value;
  } catch (error) {
    failure = error;
    try { await client.query('ROLLBACK'); } catch { /* already unwound */ }
    throw error;
  } finally {
    // Destroy rather than return a client whose backend may have gone away
    // mid-transaction — see walletPg.withWalletLock.
    client.release(failure ?? undefined);
  }
}

/** Record the transition. False on a UNIQUE tx_id collision — the gate firing. */
async function recordTransition(client, bid, { txId, from, to, actor, reason }) {
  try {
    await client.query(
      `INSERT INTO bet_transitions (tx_id, bet_id, from_status, to_status, actor, reason)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [txId, bid, from ?? null, to, actor ?? null, reason ?? null],
    );
    return true;
  } catch (error) {
    if (error.code === '23505') return false;
    throw error;
  }
}

/**
 * The wallet legs for moving a stake into or out of `lockedBalance`.
 *
 * `sign` is -1 when locking (the source pockets go down) and +1 when returning.
 * The provenance counters move WITH the lock, so `lockedDepositAmount` always
 * says how much of the locked total came from deposit — which is what a return
 * needs in order to put it back where it belongs.
 */
function stakeLegs(slices, locking) {
  const sign = locking ? -1 : 1;
  return [
    { field: 'lockedBalance', deltaPaise: locking ? sumSlices(slices) : 0 - sumSlices(slices) },
    ...slices.flatMap((s) => [
      { field: s.field, deltaPaise: sign * s.amountPaise },
      ...(LOCK_PROVENANCE[s.field]
        ? [{ field: LOCK_PROVENANCE[s.field], deltaPaise: (locking ? 1 : -1) * s.amountPaise }]
        : []),
    ]),
  ];
}

const sumSlices = (slices) => slices.reduce((s, x) => s + x.amountPaise, 0);

/**
 * placeBet — create the bet AND commit the stake, in one transaction.
 *
 * `betId` is the caller's deterministic key. It must be derived from stable
 * request identity, NOT generated per attempt: a fresh id on every retry is not
 * idempotency, it is a new bet, and that is precisely the current behaviour
 * this replaces. See middleware/idempotencyKey.js for where callers get one.
 *
 * @returns one of
 *   { ok: true,  idempotent: false, bet, balances }  placed by this call
 *   { ok: true,  idempotent: true,  bet }            already placed; nothing moved
 *   { ok: false, reason: 'insufficient' }            the guard refused the debit
 */
export async function placeBet({
  betId, userId, cycleId, side, slices, publicId = null, actor = null, reason = null,
}) {
  if (!betId) throw new Error('placeBet requires a betId (idempotency key)');
  if (!Array.isArray(slices) || !slices.length) {
    throw new Error('placeBet requires at least one funding slice');
  }
  for (const s of slices) {
    if (!Number.isInteger(s.amountPaise) || s.amountPaise <= 0) {
      throw new TypeError(`slice '${s.field}': amountPaise must be a positive integer, got ${s.amountPaise}`);
    }
  }
  const stakePaise = sumSlices(slices);

  const result = await withBetLock(userId, betId, async (ctx) => {
    // The bet already exists: a redelivered request, not a second bet. Report
    // it as already-done rather than as a failure — collapsing those two is the
    // classic way a retry-safe API stops being retry-safe, because the caller
    // compensates for something that actually succeeded.
    if (ctx.bet) {
      return { commit: false, value: { ok: true, idempotent: true, bet: ctx.bet } };
    }

    await ctx.client.query(
      `INSERT INTO bets (bet_id, public_id, user_id, cycle_id, side, stake_paise, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [ctx.bid, publicId ? String(publicId) : null, ctx.uid, String(cycleId), String(side), stakePaise, BET_STATUS.PENDING],
    );

    if (!await recordTransition(ctx.client, ctx.bid, {
      txId: `${ctx.bid}_place`, from: null, to: BET_STATUS.PENDING, actor, reason,
    })) {
      return { commit: false, value: { ok: true, idempotent: true, bet: null } };
    }

    // The stake, in the SAME transaction. This is the M-4 fix: the Mongo path
    // moves the balance and then writes the ledger, so a ledger failure leaves
    // money moved with nothing recording it.
    const movement = await applyMovementWithin(ctx, {
      legs: stakeLegs(slices, true),
      ledger: slices.map((s) => ({
        txId: `${ctx.bid}_stake_${s.field}`,
        field: s.field,
        amountPaise: 0 - s.amountPaise,
        type: 'DEBIT',
        reason: reason || `Bet ${ctx.bid} stake`,
        refId: ctx.bid,
      })),
    });

    if (movement.idempotent) {
      // The bet row was new but the movement was not. Both are keyed on the
      // same bet id inside one transaction, so that combination should be
      // impossible — treat it as corruption rather than quietly committing a
      // bet whose stake never moved.
      return { commit: false, value: { ok: false, reason: 'inconsistent_idempotency', betId: ctx.bid } };
    }
    if (!movement.ok) {
      return { commit: false, value: { ok: false, reason: 'insufficient' } };
    }

    return {
      commit: true,
      value: {
        ok: true, idempotent: false,
        bet: { betId: ctx.bid, publicId, userId: ctx.uid, cycleId: String(cycleId), side: String(side), stakePaise, status: BET_STATUS.PENDING },
        balances: movement.balancesAfterPaise,
      },
    };
  });

  count('BET_PLACE', !result.ok ? (result.reason ?? 'error') : result.idempotent ? 'idempotent' : 'applied');
  return result;
}

/**
 * The shared body of every settlement transition.
 *
 * A losing bet and a winning bet both consume the locked stake; the difference
 * is the payout, which is credited as its own movement so the ledger says
 * "stake consumed" and "winnings paid" separately rather than netting them into
 * one number nobody can audit.
 */
async function settle(
  { betId, userId, slices, payoutPaise = 0, platformFeePaise = 0, actor = null, reason = null },
  spec,
) {
  if (!betId) throw new Error(`${spec.name}Bet requires a betId`);
  if (!Number.isInteger(payoutPaise) || payoutPaise < 0) {
    throw new TypeError(`${spec.name}Bet: payoutPaise must be a non-negative integer, got ${payoutPaise}`);
  }
  // The fee is RETAINED, not paid, so it moves no money here — it is recorded
  // because the settlement decided it, and `Cycle.totalPlatformFees` is summed
  // from it. Validated exactly like the payout so a float rupee value cannot
  // reach the column and be silently truncated.
  if (!Number.isInteger(platformFeePaise) || platformFeePaise < 0) {
    throw new TypeError(`${spec.name}Bet: platformFeePaise must be a non-negative integer, got ${platformFeePaise}`);
  }

  const result = await withBetLock(userId, betId, async (ctx) => {
    const bet = ctx.bet;
    if (!bet) return { commit: false, value: { ok: false, reason: 'not_found' } };
    if (bet.status === spec.to) {
      return { commit: false, value: { ok: true, idempotent: true, bet } };
    }
    if (bet.status !== spec.expect) {
      return {
        commit: false,
        value: { ok: false, reason: 'invalid_transition', status: bet.status, expected: spec.expect },
      };
    }

    // The guard is in the WHERE clause, not in the check above: between reading
    // the row and writing it another transaction could have moved it, and only
    // the database can settle that race. The read gives a good error message;
    // the WHERE gives correctness.
    const moved = await ctx.client.query(
      `UPDATE bets SET status = $2, payout_paise = $3, platform_fee_paise = $5,
                       settled_at = now(), updated_at = now()
        WHERE bet_id = $1 AND status = $4
        RETURNING updated_at`,
      [ctx.bid, spec.to, payoutPaise, spec.expect, platformFeePaise],
    );
    if (!moved.rowCount) {
      return { commit: false, value: { ok: false, reason: 'invalid_transition', status: bet.status, expected: spec.expect } };
    }

    if (!await recordTransition(ctx.client, ctx.bid, {
      txId: `${ctx.bid}_${spec.name}`, from: spec.expect, to: spec.to, actor, reason,
    })) {
      return { commit: false, value: { ok: true, idempotent: true, bet } };
    }

    // The stake leaves `lockedBalance` either way. Where it goes is the whole
    // difference between the transitions: back to the pockets it came from, or
    // consumed.
    const stakeSlices = requireSlices(slices, bet);
    const legs = spec.returnsStake
      ? stakeLegs(stakeSlices, false)
      : consumeLegs(stakeSlices);

    const ledger = spec.returnsStake
      ? stakeSlices.map((s) => ({
          txId: `${ctx.bid}_${spec.name}_${s.field}`,
          field: s.field, amountPaise: s.amountPaise, type: 'CREDIT',
          reason: reason || `Bet ${ctx.bid} ${spec.to.toLowerCase()} — stake returned`,
          refId: ctx.bid,
        }))
      : [{
          txId: `${ctx.bid}_${spec.name}`,
          field: 'lockedBalance', amountPaise: 0 - bet.stakePaise, type: 'DEBIT',
          reason: reason || `Bet ${ctx.bid} ${spec.to.toLowerCase()} — stake consumed`,
          refId: ctx.bid,
        }];

    // A winning payout is a SEPARATE credit with its own ledger row, so the
    // books distinguish "the stake was consumed" from "the house paid out".
    // Netting them would make a won bet look like a smaller loss.
    if (payoutPaise > 0) {
      legs.push({ field: 'winningsBalance', deltaPaise: payoutPaise });
      ledger.push({
        txId: `${ctx.bid}_payout`,
        field: 'winningsBalance', amountPaise: payoutPaise, type: 'CREDIT',
        reason: reason || `Bet ${ctx.bid} payout`, refId: ctx.bid,
      });
    }

    const movement = await applyMovementWithin(ctx, { legs, ledger });
    if (movement.idempotent) {
      return { commit: false, value: { ok: false, reason: 'inconsistent_idempotency', betId: ctx.bid } };
    }
    if (!movement.ok) {
      return { commit: false, value: { ok: false, reason: 'insufficient', legs } };
    }

    return {
      commit: true,
      value: {
        ok: true, idempotent: false,
        bet: { ...bet, status: spec.to, payoutPaise, platformFeePaise, updatedAt: moved.rows[0].updated_at },
        balances: movement.balancesAfterPaise,
      },
    };
  });

  count(`BET_${spec.name.toUpperCase()}`, !result.ok ? (result.reason ?? 'error') : result.idempotent ? 'idempotent' : 'applied');
  return result;
}

/**
 * A return has to go back to the pockets the stake CAME from, so the caller
 * supplies them. Refusing rather than defaulting to one pocket is deliberate:
 * returning a deposit-funded stake into `winningsBalance` would silently
 * convert non-withdrawable money into withdrawable money, which is a
 * cash-out route, not a rounding error.
 */
function requireSlices(slices, bet) {
  if (!Array.isArray(slices) || !slices.length) {
    throw new Error(
      `bet ${bet.betId}: settling requires the funding slices, so a returned stake `
      + 'goes back to the pockets it came from rather than all into one',
    );
  }
  const total = sumSlices(slices);
  if (total !== bet.stakePaise) {
    throw new Error(
      `bet ${bet.betId}: slices total ${total} paise but the stake is ${bet.stakePaise}`,
    );
  }
  return slices;
}

/** Consume the locked stake: it leaves `lockedBalance` and the provenance counters. */
function consumeLegs(slices) {
  return [
    { field: 'lockedBalance', deltaPaise: 0 - sumSlices(slices) },
    ...slices.flatMap((s) => (LOCK_PROVENANCE[s.field]
      ? [{ field: LOCK_PROVENANCE[s.field], deltaPaise: 0 - s.amountPaise }]
      : [])),
  ];
}

/** PENDING → WON. The stake is consumed and the payout credited. */
export const winBet = (args) => settle(args, { name: 'win', ...TRANSITIONS.win });

/** PENDING → LOST. The stake is consumed by the house. */
export const loseBet = (args) => settle(args, { name: 'lose', ...TRANSITIONS.lose });

/** PENDING → VOID. The cycle was cancelled; the stake goes back. */
export const voidBet = (args) => settle(args, { name: 'void', ...TRANSITIONS.void });

/** PENDING → REFUNDED. The bet was withdrawn; the stake goes back. */
export const refundBet = (args) => settle(args, { name: 'refund', ...TRANSITIONS.refund });

// ── Reconciliation ───────────────────────────────────────────────────────────

/**
 * Does every PENDING bet have locked balance behind it?
 *
 * The sum of outstanding stakes should equal the user's `lockedBalance` minus
 * anything locked for a withdrawal. This reports the bet side alone, so a
 * caller can subtract what it knows about the other.
 */
/**
 * Claim a bet for compensation: delete it, but ONLY while it is still PENDING.
 *
 * The bet-placement route uses this when the cycle closes underneath a bet it
 * has already taken money for. Settlement may have reached the same bet first,
 * in which case it owns it and the stake must NOT be refunded — the player was
 * included in the round and will be paid or not on its result.
 *
 * `status = 'PENDING'` is in the WHERE clause, so the race is settled by the
 * database. THREE outcomes, and collapsing the last two loses money:
 *
 *   { claimed: true }   this call owns it; refund the stake
 *   { claimed: false }  settlement owns it; touch nothing
 *   a THROW              ownership unknown — the caller must page a human
 *                        rather than guess, because refunding risks paying
 *                        twice and not refunding risks locking the stake
 *
 * That last case is why this does not swallow its own errors. A `.catch(=> null)`
 * would make a transient database failure indistinguishable from "settlement
 * won", sending it down the branch that deliberately does not refund — and
 * reconciliation could not recover it, because the ledger legitimately shows
 * the debit.
 */
/**
 * A cycle's outstanding bets, with the pockets each stake came from.
 *
 * ── Why the slices come from the LEDGER ────────────────────────────────────
 * The `bets` row records the stake total, not which pockets it was taken from.
 * The provenance lives where the money moved: `place` writes one DEBIT per
 * source pocket keyed `<betId>_stake_<field>`, so those rows ARE the record of
 * the split — and reconstructing from them cannot disagree with what actually
 * happened, which a second copy stored on the bet could.
 *
 * That matters because a returned stake must go back to the pocket it came out
 * of. Crediting a deposit-funded stake into `winningsBalance` silently converts
 * non-withdrawable money into withdrawable, which is a cash-out route rather
 * than a rounding error.
 *
 * ── Why the settlement engine needs this at all ────────────────────────────
 * The engine used to enumerate the bets to settle from the document store and
 * then execute the transitions here — a money decision read from one store and
 * carried out in another, which is the one thing the single-store rule forbids
 * outright. The rows it settles and the rows it reads are now the same rows.
 *
 * Phantom bets are excluded. They are created with no balance deduction and no
 * provenance, so there is no stake to consume and `settle` would refuse them.
 */
export async function listSettleableBets(cycleId, { side = null, limit = 1000, after = 0 } = {}) {
  const params = [String(cycleId), Number(after) || 0];
  let sideClause = '';
  if (side === 'WINNING' || side === 'LOSING') {
    // The winning side is the cycle's own `winner`, read in the statement, so a
    // pass cannot settle against a result that changed after it started.
    sideClause = side === 'WINNING'
      ? 'AND b.side = (SELECT winner FROM cycles WHERE cycle_id = $1)'
      : 'AND b.side <> (SELECT winner FROM cycles WHERE cycle_id = $1)';
  }

  const { rows } = await pgQuery(
    `SELECT b.id, b.bet_id, b.public_id, b.user_id, b.side, b.stake_paise,
            COALESCE(
              (SELECT jsonb_agg(jsonb_build_object(
                        'field', l.field, 'amountPaise', ABS(l.amount_paise)))
                 FROM wallet_ledger l
                WHERE l.ref_id = b.bet_id
                  AND l.tx_id LIKE b.bet_id || '_stake_%'
                  AND l.tx_type = 'DEBIT'),
              '[]'::jsonb) AS slices
       FROM bets b
      WHERE b.cycle_id = $1 AND b.status = 'PENDING' AND NOT b.is_phantom
        AND b.id > $2
        ${sideClause}
      ORDER BY b.id
      LIMIT ${Math.min(Math.max(Number(limit) || 1000, 1), 5000)}`,
    params, 'bets_list_settleable',
  );

  return rows.map((r) => ({
    id: Number(r.id),
    betId: r.bet_id,
    publicId: r.public_id,
    userId: r.user_id,
    side: r.side,
    stakePaise: Number(r.stake_paise),
    // An empty array here is a bet whose stake movement was never recorded.
    // Passed through as-is rather than defaulted: `settle` refuses it and the
    // engine reports it, which is what leaves it for a human instead of
    // guessing at a split and returning the money to the wrong pocket.
    slices: (r.slices ?? []).map((s) => ({ field: s.field, amountPaise: Number(s.amountPaise) })),
  }));
}

/**
 * What a cycle actually paid, reconstructed from its settled bets.
 *
 * ── Trap 6, in the one place it costs money ────────────────────────────────
 * The settlement pass must NOT report its own in-memory accumulators. An
 * accumulator counts what THIS pass did; a pass resumed after a crash only
 * re-processes the bets still PENDING, so its accumulator undercounts every bet
 * an earlier pass already paid — and the cycle's recorded payout, which is what
 * the platform's profit is computed from, is then permanently wrong while the
 * money itself is correct. There is no way to tell afterwards which number
 * lied.
 *
 * Summed from the rows, this is right whether the cycle settled in one pass or
 * five.
 */
export async function cyclePayoutTotals(cycleId) {
  const { rows } = await pgQuery(
    `SELECT COALESCE(SUM(payout_paise), 0)       AS paid,
            COALESCE(SUM(platform_fee_paise), 0) AS fees,
            COUNT(DISTINCT user_id) FILTER (WHERE status = 'WON')::int AS winners,
            COUNT(*) FILTER (WHERE status = 'WON')::int     AS won_bets,
            COUNT(*) FILTER (WHERE status = 'LOST')::int    AS lost_bets,
            COUNT(*) FILTER (WHERE status = 'PENDING')::int AS still_pending
       FROM bets
      WHERE cycle_id = $1 AND NOT is_phantom`,
    [String(cycleId)], 'bets_cycle_payout_totals',
  );
  const r = rows[0];
  return {
    paidOutPaise: Number(r.paid),
    platformFeesPaise: Number(r.fees),
    winners: Number(r.winners),
    wonBets: Number(r.won_bets),
    lostBets: Number(r.lost_bets),
    // A settled cycle with bets still PENDING is a stake locked with nothing
    // coming to release it. The pass reports this rather than discovering it
    // months later through a support ticket.
    stillPending: Number(r.still_pending),
  };
}

/**
 * Stamp a cycle's phantom bets LOST.
 *
 * Phantom bets never win and never move money: they are created with no balance
 * deduction, so there is no stake to consume and nothing for `settle` to settle
 * against. This is bookkeeping — one UPDATE, so the displayed history does not
 * leave synthetic bets sitting at PENDING forever.
 */
export async function closePhantomBets(cycleId) {
  const { rowCount } = await pgQuery(
    `UPDATE bets SET status = 'LOST', settled_at = now(), updated_at = now()
      WHERE cycle_id = $1 AND is_phantom AND status = 'PENDING'`,
    [String(cycleId)], 'bets_close_phantom',
  );
  return rowCount;
}

export async function claimPendingBetForRefund(betId) {
  const { rows } = await pgQuery(
    `DELETE FROM bets WHERE bet_id = $1 AND status = 'PENDING' RETURNING *`,
    [String(betId)], 'bet_claim_for_refund',
  );
  return { claimed: rows.length > 0, bet: rows[0] ? rowToBet(rows[0]) : null };
}

export async function reconcileUserStakes(userId) {
  const [{ rows: pending }, { rows: wallet }] = await Promise.all([
    pgQuery(
      `SELECT COALESCE(SUM(stake_paise), 0) AS total FROM bets
        WHERE user_id = $1 AND status = $2`,
      [String(userId), BET_STATUS.PENDING], 'bet_reconcile',
    ),
    pgQuery(
      `SELECT locked_paise FROM wallets WHERE user_id = $1`,
      [String(userId)], 'bet_reconcile_wallet',
    ),
  ]);

  const stakedPaise = toPaise(pending[0]?.total);
  const lockedPaise = toPaise(wallet[0]?.locked_paise);
  return {
    ok: lockedPaise >= stakedPaise,
    stakedPaise,
    lockedPaise,
    // Positive means locked money this domain cannot explain — a withdrawal
    // hold, or a leak. Negative would mean bets outstanding with nothing locked
    // behind them, which the transaction structure makes impossible; a
    // non-zero negative is evidence something wrote outside this module.
    unexplainedPaise: lockedPaise - stakedPaise,
  };
}

/** Every settled bet whose stake never left `lockedBalance`. */
/**
 * Does this player already hold a live bet on the OTHER side of this cycle?
 *
 * The wash-bet guard: betting both sides of the same cycle guarantees a return
 * regardless of the outcome, which is not betting.
 *
 * A read, deliberately — it decides whether to REFUSE a bet, and the refusal is
 * a policy the operator can switch off. It is not the money gate: the stake
 * movement is, one call later, under the wallet's row lock.
 */
export async function hasOppositeSideBet({ userId, cycleId, side }) {
  const { rows } = await pgQuery(
    `SELECT 1 FROM bets
      WHERE user_id = $1 AND cycle_id = $2 AND side <> $3 AND status = 'PENDING'
      LIMIT 1`,
    [String(userId), String(cycleId), String(side)], 'bet_opposite_side',
  );
  return rows.length > 0;
}

export async function findBetsMissingStakeMovement() {
  const { rows } = await pgQuery(
    `SELECT b.bet_id, b.user_id, b.status
       FROM bets b
      WHERE b.status <> $1
        AND NOT EXISTS (
          SELECT 1 FROM wallet_ledger l
           WHERE l.ref_id = b.bet_id AND l.tx_id LIKE b.bet_id || '\\_%'
        )
      LIMIT 500`,
    [BET_STATUS.PENDING], 'bet_missing_movement',
  );
  return rows.map((r) => ({ betId: r.bet_id, userId: r.user_id, status: r.status }));
}
