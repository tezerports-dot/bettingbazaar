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
import { getPool, pgQuery, connectGuarded, LOCK_CYCLE_SHARED_SQL } from './pgClient.js';
import { applyMovementWithin } from './walletPg.js';
import { moneyOperations } from '../services/metrics.service.js';
import { MONEY_PATHS } from './moneyAuthority.js';

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
    mongoId:     row.mongo_id,
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
 *                        mongo_id = the ObjectId DERIVED from that key
 *   mirrored from Mongo  bet_id = the Mongo `_id`, mongo_id = NULL
 *
 * Settlement reads its bets from MONGO in both cases — gameEngine's `Bet.find`
 * and its winner aggregation — so the id it holds is always the Mongo `_id`,
 * which matches `bet_id` for a mirrored bet and `mongo_id` for a placed one.
 * Settling by the Mongo id alone therefore found nothing for every bet the
 * routed placement path had created, and refused it as `not_found` with the
 * stake still locked. Verified against a real PostgreSQL before it was fixed;
 * `betSettlementPg.test.js` keeps it verified.
 *
 * One indexed lookup per settle. Both columns carry a UNIQUE index, and there
 * is no way to avoid it: Mongo does not store the Postgres key, so the
 * translation has to happen somewhere.
 */
export async function resolveBetId(idOrMongoId) {
  if (!idOrMongoId) return null;
  const key = String(idOrMongoId);
  const { rows } = await pgQuery(
    `SELECT bet_id FROM bets WHERE bet_id = $1 OR mongo_id = $1 LIMIT 1`,
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
 * Lock the user's wallet, then the bet row, in that order.
 *
 * Not arbitrary: every path that touches a bet also touches its user's
 * balances, so taking the wallet lock first everywhere means two concurrent
 * operations on the same user queue behind one lock instead of grabbing them in
 * opposite orders and deadlocking. This is the only place both are taken, which
 * is what makes that guarantee checkable.
 */
/** Slice amounts collapsed per wallet field, zero-filled. Paise. */
function sliceTotals(slices) {
  const out = { depositBalance: 0, winningsBalance: 0, reserveBalance: 0 };
  for (const s of slices || []) {
    if (Object.prototype.hasOwnProperty.call(out, s.field)) out[s.field] += s.amountPaise;
  }
  return out;
}

/**
 * The funding slices of a stored bet, read back from the row.
 *
 * The counterpart of `sliceTotals`, and the reason the split is stored here at
 * all: it lets a settlement pass work from the authoritative store instead of
 * from the Mongo mirror.
 *
 * Returns an EMPTY array for a row with no recorded provenance (a legacy row,
 * all zeros). That is not the same as "funded by nothing" and must not be
 * treated as such — `settle` refuses an empty slice set rather than defaulting
 * it, exactly as `slicesFromBet` does on the Mongo side, because guessing would
 * return a deposit-funded stake into `winningsBalance` and turn non-withdrawable
 * money withdrawable.
 */
export function slicesFromRow(row) {
  return [
    { field: 'depositBalance',  amountPaise: Number(row?.from_deposit_paise  ?? 0) },
    { field: 'winningsBalance', amountPaise: Number(row?.from_winnings_paise ?? 0) },
    { field: 'reserveBalance',  amountPaise: Number(row?.from_reserve_paise  ?? 0) },
  ].filter((s) => s.amountPaise > 0);
}

async function withBetLock(userId, betId, fn, cycleId = null) {
  const uid = String(userId);
  const bid = String(betId);
  const pool = await getPool();
  if (!pool) throw new Error('Postgres not configured (DATABASE_URL unset)');
  const client = await connectGuarded(pool);
  let failure = null;

  try {
    await client.query('BEGIN');
    // The per-cycle advisory lock FIRST, before any row lock, so it cannot form
    // a cycle in the lock graph with the wallet and bet locks below.
    //
    // SHARED, not exclusive: a bet must exclude the SETTLEMENT of its cycle,
    // never another bet. `openSettlement` takes the exclusive form of the same
    // lock, so it still waits for every in-flight bet and still blocks the ones
    // that arrive while it opens — but bets no longer queue behind each other,
    // which capped one cycle at ~420 bets/sec regardless of concurrency. See
    // LOCK_CYCLE_SHARED_SQL in pgClient.js for the measurements and for why it
    // is advisory rather than a row lock (there is no `cycles` table — the
    // cycle lives in MongoDB).
    if (cycleId != null) {
      await client.query(LOCK_CYCLE_SHARED_SQL, [String(cycleId)]);
    }
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
  betId, userId, cycleId, side, slices, mongoId = null, actor = null, reason = null,
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

    // ── The betting/settlement boundary, decided by the DATABASE ────────────
    // Until this check existed, nothing inside this transaction consulted the
    // cycle at all: the only thing standing between a stake and an already
    // settling cycle was the clock check in `bet.routes.js`, which runs BEFORE
    // this transaction opens and therefore cannot see a settlement that starts
    // while the stake is in flight. A bet could commit after the pools had been
    // read and the winner chosen — counted in the pools by nobody, paid by
    // nobody, and refunded by nobody.
    //
    // `cycle_settlements` is the boundary because it is the only per-cycle row
    // this schema has, and it is created exactly when settlement opens
    // (`cycle_id` is UNIQUE — one settlement per cycle, ever). The advisory
    // lock taken above is what makes reading it sound: without it the row could
    // be inserted between this SELECT and our COMMIT and neither side would
    // notice. With it, one of the two always sees the other's committed state.
    const settling = await ctx.client.query(
      `SELECT status FROM cycle_settlements WHERE cycle_id = $1`,
      [String(cycleId)],
    );
    if (settling.rows.length) {
      return {
        commit: false,
        value: { ok: false, reason: 'cycle_settling', status: settling.rows[0].status },
      };
    }

    // The funding split is stored WITH the bet, not only on the Mongo mirror.
    // `settle` refuses to return a stake without knowing which pockets funded
    // it, so a bet whose split lives elsewhere is un-settleable from here —
    // see the schema comment on these columns.
    const bySource = sliceTotals(slices);
    await ctx.client.query(
      `INSERT INTO bets (bet_id, mongo_id, user_id, cycle_id, side, stake_paise, status,
                         from_deposit_paise, from_winnings_paise, from_reserve_paise)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [ctx.bid, mongoId ? String(mongoId) : null, ctx.uid, String(cycleId), String(side), stakePaise, BET_STATUS.PENDING,
       bySource.depositBalance, bySource.winningsBalance, bySource.reserveBalance],
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
        bet: { betId: ctx.bid, mongoId, userId: ctx.uid, cycleId: String(cycleId), side: String(side), stakePaise, status: BET_STATUS.PENDING },
        balances: movement.balancesAfterPaise,
      },
    };
  }, cycleId);

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
 * Every bet still awaiting settlement on a cycle, from the store that owns them.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 * `gameEngine` enumerated the bets to settle with `Bet.find` / `Bet.aggregate`
 * — MongoDB — even while Postgres was authoritative for the write. The Mongo
 * copy is written by `betPgAuthority.placeBet` AFTER the Postgres transaction
 * commits, which is after the per-cycle advisory lock has already released. So
 * a bet could commit, the settlement could take the lock and enumerate, and the
 * mirror could land afterwards: a PENDING bet on a cycle whose settlement had
 * finished, never paid, never lost, never refunded, its stake locked.
 *
 * Reading the authoritative store removes the mirror from that decision
 * entirely. `bb_stalled_settlements` stays wired regardless — a detector for a
 * condition you believe you have fixed is how you find out you have not.
 *
 * `side` is optional so the caller can take the losing and winning halves
 * separately, which is the shape the settlement pass already has.
 */
export async function findPendingBetsForCycle(cycleId, { side = null, limit = 1000 } = {}) {
  const params = [String(cycleId), BET_STATUS.PENDING];
  let sideClause = '';
  if (side !== null) {
    params.push(String(side));
    sideClause = ` AND side = $${params.length}`;
  }
  params.push(Math.min(Math.max(parseInt(limit, 10) || 1000, 1), 5000));

  // Ordered by placement so a resumed pass settles in the same sequence a
  // first pass would have, and the `bets_cycle_idx` (cycle_id, status) index
  // serves the lookup.
  const { rows } = await pgQuery(
    `SELECT * FROM bets
      WHERE cycle_id = $1 AND status = $2${sideClause}
      ORDER BY placed_at ASC, id ASC
      LIMIT $${params.length}`,
    params, 'bets_pending_for_cycle',
  );
  return rows.map((r) => ({ ...rowToBet(r), slices: slicesFromRow(r) }));
}

/**
 * A cycle's payout totals, DERIVED from the settled bets themselves.
 *
 * The Postgres counterpart of the `Bet.aggregate` in `gameEngine`, and it keeps
 * that aggregate's most important property: the total is RECONSTRUCTED from
 * stamped rows, never accumulated in memory. A pass that resumes after a crash
 * only re-processes still-PENDING bets, so an accumulator would undercount by
 * everything the previous pass already paid — the table, by contrast, sees
 * every bet paid across every pass. Run it twice and it answers the same.
 *
 * It exists because that derivation was reading MongoDB even while Postgres
 * owned the bets, which put the cycle's recorded payout behind the mirror. The
 * reconstruction was right; the store was wrong.
 *
 * Paise in, paise out — the caller converts at its own boundary.
 */
export async function derivePayoutTotalsForCycle(cycleId) {
  const { rows } = await pgQuery(
    `SELECT COALESCE(SUM(payout_paise), 0)       AS paid,
            COALESCE(SUM(platform_fee_paise), 0) AS fees,
            COUNT(DISTINCT user_id)              AS winners,
            COUNT(*)                             AS bets
       FROM bets
      WHERE cycle_id = $1 AND status = $2`,
    [String(cycleId), BET_STATUS.WON], 'cycle_payout_totals',
  );
  const r = rows[0] || {};
  return {
    paidPaise: toPaise(r.paid),
    feesPaise: toPaise(r.fees),
    winners:   Number(r.winners || 0),
    bets:      Number(r.bets || 0),
  };
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
