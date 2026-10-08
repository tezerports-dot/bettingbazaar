// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * postgres/casinoPg.js — casino provider callbacks, in PostgreSQL.
 *
 * Domain 7. A provider posts BET / WIN / ROLLBACK / REFUND against a round, and
 * each one moves a real player balance.
 *
 * ── The defect this exists to remove ────────────────────────────────────────
 * Recorded in docs/FINANCIAL_DOMAIN_MATRIX.md:
 *
 *     A ROLLBACK or REFUND credit does not currently have to prove a matching
 *     prior debit.
 *
 * `gameProvider.routes.js` handled a rollback with a plain wallet credit
 * (`refundOrder(userId, amount, roundId, 'depositBalance')`, since deleted) —
 * no check that the round was ever bet on, and no bound on the amount. A
 * provider that is buggy, replayed, or hostile could therefore MINT REAL MONEY
 * by posting a rollback for a round that never had a bet, or a rollback larger
 * than the bet it reverses. Nothing in that path could tell such a callback
 * from a legitimate one.
 *
 * Here a refund is bounded by arithmetic the DATABASE enforces:
 *
 *   - the round must exist and must have been debited (`debited_paise > 0`);
 *   - `refunded_paise <= debited_paise` is a CHECK constraint, so the bound
 *     holds even against a code path that forgets to test it;
 *   - the running totals are updated under the round's row lock, inside the
 *     same transaction as the wallet movement, so two concurrent rollbacks
 *     cannot both read "nothing refunded yet".
 *
 * A CHECK rather than an `if` on purpose. The `if` is there too — it produces a
 * clean refusal instead of an exception — but the constraint is what makes the
 * rule true of the DATA rather than merely of this file, which is the only
 * version that survives the next caller.
 *
 * ── Idempotency ─────────────────────────────────────────────────────────────
 * `casino_transactions.tx_id` is the PROVIDER's id, UNIQUE, and the collision
 * happens inside the transaction. Providers retry aggressively and duplicate
 * callbacks are routine rather than exceptional, so this is the gate that
 * matters most in the domain.
 */
import { getPool, pgQuery, connectGuarded } from '../client.js';
import { applyMovementWithin, lockWalletWithin } from './wallets.core.js';
import { getSystemConfig } from './config.js';
import { moneyOperations } from '../../backend/services/metrics.service.js';
import { reserveBasisPoints, splitStakeMinor } from '../../backend/domains/risk/stakeFunding.js';
import { MONEY_PATHS } from '../moneyPaths.js';

export const CASINO_TX = Object.freeze({
  BET:      'BET',
  WIN:      'WIN',
  ROLLBACK: 'ROLLBACK',
  REFUND:   'REFUND',
});

/** Which running total each callback type advances on the round. */
const ROUND_COLUMN = Object.freeze({
  [CASINO_TX.BET]:      'debited_paise',
  [CASINO_TX.WIN]:      'credited_paise',
  [CASINO_TX.ROLLBACK]: 'refunded_paise',
  [CASINO_TX.REFUND]:   'refunded_paise',
});

const REVERSALS = Object.freeze([CASINO_TX.ROLLBACK, CASINO_TX.REFUND]);

/**
 * The pockets a casino stake draws on (owner, 2026-10-08: "Yes, like boards").
 *
 * A BET takes from the pockets a board bet takes from, by the board's own rule
 * — `splitStakeMinor`, the arithmetic `computeBetFundingPlan` applies to a
 * board stake: `SystemConfig.betReservePercent` of the stake from the reserve,
 * floored, as far as the reserve covers it; the rest from the deposit first
 * and then winnings. The split is decided from the wallet row this transaction
 * holds locked, so it is what moves (a split planned from an earlier read
 * would refuse a stake a concurrent one had made unfundable as planned, while
 * the pockets could still fund it). The round records each part
 * (`debited_<pocket>_paise`).
 *
 * Listed in the order a reversal returns them, each with its columns on
 * `casino_rounds` (`debited_<column>_paise`, `refunded_<column>_paise`). A
 * ROLLBACK or REFUND gives each part back to the pocket it came from, and a
 * PARTIAL one returns the reserve share first, then deposit, then winnings —
 * the order the rule draws them. A board refund has no partial case
 * (it returns every slice whole); here winnings come back LAST, so a rollback
 * never makes a deposit withdrawable, and no reversal returns more to a pocket
 * than the round took from it. `casino_rounds_split_refund_bound` and the
 * `casino_rounds_return_order` trigger hold the row to both.
 */
const STAKE_POCKETS = Object.freeze([
  Object.freeze({ field: 'reserveBalance',  column: 'reserve' }),
  Object.freeze({ field: 'depositBalance',  column: 'deposit' }),
  Object.freeze({ field: 'winningsBalance', column: 'winnings' }),
]);

/**
 * A casino WIN pays into winnings, the withdrawable pocket — as a board win
 * does (`bets.core` WON credits `winningsBalance`; owner, 2026-10-07: "a
 * player wins a casino game, it should go to their winnings balance"). It is
 * not a return of the stake, so it moves no part of it.
 */
const WIN_POCKET = 'winningsBalance';

const toPaise = (v) => Number(v ?? 0);

function count(operation, outcome) {
  moneyOperations.inc({ path: MONEY_PATHS.CASINO_SETTLEMENT, store: 'postgres', operation, outcome });
}

function rowToRound(row) {
  if (!row) return null;
  return {
    roundId:       row.round_id,
    userId:        row.user_id,
    providerKey:   row.provider_key,
    gameId:        row.game_id,
    debitedPaise:  toPaise(row.debited_paise),
    creditedPaise: toPaise(row.credited_paise),
    refundedPaise: toPaise(row.refunded_paise),
    // Which pockets the stake came from, and how much of each has gone back.
    debitedByPocket:  byPocket(row, 'debited'),
    refundedByPocket: byPocket(row, 'refunded'),
  };
}

function byPocket(row, total) {
  return Object.fromEntries(STAKE_POCKETS.map((p) => [p.field, toPaise(row[`${total}_${p.column}_paise`])]));
}

/**
 * The parts a BET takes, split by the board rule from the LOCKED balances, or
 * null when deposit and winnings cannot cover the main part.
 */
function stakeParts(balances, amountPaise, reserveBp) {
  const split = splitStakeMinor({
    amountMinor: amountPaise, reserveBp,
    depositMinor: balances.depositBalance,
    winningsMinor: balances.winningsBalance,
    reserveMinor: balances.reserveBalance,
  });
  if (!split) return null;
  const taken = {
    reserveBalance: split.fromReserveMinor,
    depositBalance: split.fromDepositMinor,
    winningsBalance: split.fromWinningsMinor,
  };
  return STAKE_POCKETS.map((p) => ({ ...p, amountPaise: taken[p.field] })).filter((p) => p.amountPaise > 0);
}

/**
 * The parts a reversal of `amountPaise` returns: what is still out in each
 * pocket, in STAKE_POCKETS order — the reserve share, then deposit, then
 * winnings. Null when the parts still out cannot make up the amount, which the
 * round's own bound refuses first; a round whose split was never recorded
 * reaches here, and is refused rather than guessed at.
 */
function returnParts(round, amountPaise) {
  let left = amountPaise;
  const parts = [];
  for (const p of STAKE_POCKETS) {
    const out = Math.max(0, round.debitedByPocket[p.field] - round.refundedByPocket[p.field]);
    const back = Math.min(left, out);
    if (back > 0) parts.push({ ...p, amountPaise: back });
    left -= back;
  }
  return left === 0 ? parts : null;
}

/**
 * The provider a callback with no provider key is recorded under. One place, so
 * the writer and every reader agree on it.
 */
const NO_PROVIDER = 'unknown';

/**
 * A round is ONE PLAYER's stake on ONE PROVIDER's round id — never the round id
 * alone. A crash round or a live table is one round id shared by everybody at
 * it, and two providers can number rounds the same way; keyed on the id alone,
 * every player after the first was refused, and before that refusal their
 * totals merged. So every reader names all three, and the player is REQUIRED:
 * a default would read some other player's stake on the same table.
 */
function roundKey(roundId, { userId, providerKey } = {}) {
  if (userId === undefined || userId === null || userId === '') {
    throw new Error('A casino round is one player\'s stake: pass the userId it belongs to');
  }
  return [String(providerKey ?? NO_PROVIDER), String(userId), String(roundId)];
}

/** One player's stake on one provider round, with its running totals, or null. */
export async function getRound(roundId, who) {
  const { rows } = await pgQuery(
    `SELECT * FROM casino_rounds WHERE provider_key = $1 AND user_id = $2 AND round_id = $3`,
    roundKey(roundId, who), 'casino_round_read',
  );
  return rowToRound(rows[0]);
}

/** Every callback recorded against one player's round, oldest first. Append-only. */
export async function getRoundTransactions(roundId, who) {
  const { rows } = await pgQuery(
    `SELECT tx_id, tx_type, amount_paise, created_at FROM casino_transactions
      WHERE provider_key = $1 AND user_id = $2 AND round_id = $3 ORDER BY id`,
    roundKey(roundId, who), 'casino_round_history',
  );
  return rows.map((r) => ({
    txId: r.tx_id, type: r.tx_type, amountPaise: toPaise(r.amount_paise), at: r.created_at,
  }));
}

/**
 * Lock the player's wallet, then the round.
 *
 * Wallet first, everywhere — the same fixed order betPg and merchantSettlementPg
 * use, and for the same reason: every callback touches a balance, so two
 * concurrent callbacks for one player queue behind one lock rather than taking
 * two locks in opposite orders and deadlocking.
 */
async function withRoundLock(userId, roundId, providerKey, fn) {
  const uid = String(userId);
  const rid = String(roundId);
  const provider = String(providerKey ?? NO_PROVIDER);
  const pool = await getPool();
  if (!pool) throw new Error('Postgres not configured (DATABASE_URL unset)');
  const client = await connectGuarded(pool);
  let failure = null;

  try {
    await client.query('BEGIN');
    // The balances AS OF the lock: a BET's split is decided from these, and
    // no other movement for this player can land before it is written.
    const { balances } = await lockWalletWithin(client, uid);
    // THIS player's stake on THIS provider's round — the whole key. Another
    // player's stake on the same table is a different row, and so is the same
    // round id at another provider.
    const round = await client.query(
      `SELECT * FROM casino_rounds
        WHERE provider_key = $1 AND user_id = $2 AND round_id = $3 FOR UPDATE`, [provider, uid, rid],
    );

    const { commit, value } = await fn({ client, uid, rid, provider, balances, round: rowToRound(round.rows[0]) });
    await client.query(commit ? 'COMMIT' : 'ROLLBACK');
    return value;
  } catch (error) {
    failure = error;
    try { await client.query('ROLLBACK'); } catch { /* already unwound */ }
    throw error;
  } finally {
    client.release(failure ?? undefined);
  }
}

/**
 * Record one provider callback and move the player's balance, in one
 * transaction.
 *
 * @param {object} args
 * @param {string} args.txId    the PROVIDER's transaction id — the idempotency gate
 * @param {string} args.roundId
 * @param {string} args.userId
 * @param {string} args.type    BET | WIN | ROLLBACK | REFUND
 * @param {number} args.amountPaise
 *
 * A BET's stake is split across the pockets by the board rule (STAKE_POCKETS);
 * a reversal returns each part to its own pocket; a WIN pays into winnings.
 *
 * @returns one of
 *   { ok: true,  idempotent: false, round, balances }
 *   { ok: true,  idempotent: true,  round }              duplicate callback
 *   { ok: false, reason: 'insufficient' }                the pockets cannot cover a BET
 *   { ok: false, reason: 'no_prior_debit' }              rollback with nothing to reverse
 *   { ok: false, reason: 'refund_exceeds_debit', … }     rollback larger than the bet
 */
export async function recordCallback({
  txId, roundId, userId, type, amountPaise,
  providerKey = null, gameId = null, reason = null,
}) {
  if (!txId) throw new Error('recordCallback requires a txId (the provider\'s id)');
  if (!ROUND_COLUMN[type]) {
    throw new Error(`Unknown casino callback type '${type}'. Known: ${Object.keys(ROUND_COLUMN).join(', ')}`);
  }
  if (!Number.isInteger(amountPaise) || amountPaise <= 0) {
    throw new TypeError(`recordCallback: amountPaise must be a positive integer, got ${amountPaise}`);
  }
  // The board's reserve share, from the one config field a board bet reads
  // (the spec fills its default). Read before the lock: it is policy, not a
  // balance, and the wallet lock is not held across a config fetch.
  const reserveBp = type === CASINO_TX.BET
    ? reserveBasisPoints((await getSystemConfig()).betReservePercent)
    : null;

  const result = await withRoundLock(userId, roundId, providerKey, async (ctx) => {
    // ── Whose round this is, is the KEY — not a check ───────────────────────
    // `ctx.round` is this player's own stake on this provider's round, or
    // null. A WIN or ROLLBACK naming player B on a table where only A staked
    // therefore finds no stake of B's and is refused below, and B's BET opens
    // B's own row instead of advancing A's. That replaces two refusals
    // (`round_not_this_player`, `round_not_this_provider`) which also refused
    // every LEGITIMATE second player on a shared crash or live-table round.

    // ── A WIN pays only on a stake that is still standing ───────────────────
    // Owner, 2026-10-01: winnings are only given where the player placed a bet
    // on that round. A board payout is already the WON transition of a bet
    // row; this is the same rule for casino, crash and sports. A bet rolled
    // back in full is a bet that did not stand. Checked BEFORE the round is
    // materialised, like the reversal rule below, so a refused WIN leaves no
    // round behind. The amount is not bounded: a win may be many times the
    // stake. `casino_rounds_win_needs_bet` states the rule in the data too.
    if (type === CASINO_TX.WIN) {
      if (!ctx.round || ctx.round.debitedPaise <= ctx.round.refundedPaise) {
        return { commit: false, value: { ok: false, reason: 'no_prior_bet', roundId: ctx.rid } };
      }
    }

    // ── The rule the domain exists for ──────────────────────────────────────
    // A reversal must prove the debit it reverses. Checked BEFORE the round is
    // materialised, so a rollback for a round that never existed cannot bring
    // one into being as a side effect of being refused.
    if (REVERSALS.includes(type)) {
      if (!ctx.round || ctx.round.debitedPaise <= 0) {
        return { commit: false, value: { ok: false, reason: 'no_prior_debit', roundId: ctx.rid } };
      }
      const wouldRefund = ctx.round.refundedPaise + amountPaise;
      if (wouldRefund > ctx.round.debitedPaise) {
        return {
          commit: false,
          value: {
            ok: false, reason: 'refund_exceeds_debit',
            debitedPaise: ctx.round.debitedPaise,
            refundedPaise: ctx.round.refundedPaise,
            requestedPaise: amountPaise,
          },
        };
      }
    }

    if (!ctx.round) {
      await ctx.client.query(
        `INSERT INTO casino_rounds (round_id, user_id, provider_key, game_id)
         VALUES ($1,$2,$3,$4) ON CONFLICT (provider_key, user_id, round_id) DO NOTHING`,
        [ctx.rid, ctx.uid, ctx.provider, gameId],
      );
    }

    // The idempotency gate, inside the transaction. Providers retry hard, so a
    // duplicate here is routine rather than exceptional.
    try {
      await ctx.client.query(
        `INSERT INTO casino_transactions (tx_id, round_id, user_id, provider_key, tx_type, amount_paise)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [String(txId), ctx.rid, ctx.uid, ctx.provider, type, amountPaise],
      );
    } catch (error) {
      if (error.code !== '23505') throw error;
      return { commit: false, value: { ok: true, idempotent: true, round: ctx.round } };
    }

    // ── Which pockets move, and by how much ─────────────────────────────────
    // After the idempotency gate on purpose (§32 S34): a redelivered BET whose
    // stake the pockets could no longer fund is "already done", not
    // "cannot afford". A BET is split from the balances the lock holds; a
    // reversal returns what is still out of each pocket, winnings last; a WIN
    // pays into winnings and touches no part of the stake.
    const debiting = type === CASINO_TX.BET;
    const parts = debiting ? stakeParts(ctx.balances, amountPaise, reserveBp)
      : type === CASINO_TX.WIN ? [{ field: WIN_POCKET, amountPaise }]
        : returnParts(ctx.round, amountPaise);
    if (!parts) {
      return {
        commit: false,
        value: { ok: false, reason: debiting ? 'insufficient' : 'stake_split_unknown', roundId: ctx.rid },
      };
    }

    // Advance the round's running total and, for a stake or its return, each
    // pocket's part. The round's CHECKs fire here whatever reached this UPDATE
    // — `refunded_paise <= debited_paise`, the parts adding up to the totals,
    // no pocket getting back more than it gave — and the return-order trigger
    // with them: the constraints make the bounds a property of the DATA rather
    // than of this function.
    const column = ROUND_COLUMN[type];
    const stakeMoved = type === CASINO_TX.WIN ? [] : parts;
    const sets = [`${column} = ${column} + $4`, ...stakeMoved.map((p, i) => {
      const part = `${debiting ? 'debited' : 'refunded'}_${p.column}_paise`;
      return `${part} = ${part} + $${5 + i}`;
    })];
    const { rows: [updated] } = await ctx.client.query(
      `UPDATE casino_rounds SET ${sets.join(', ')}, updated_at = now()
        WHERE provider_key = $1 AND user_id = $2 AND round_id = $3 RETURNING *`,
      [ctx.provider, ctx.uid, ctx.rid, amountPaise, ...stakeMoved.map((p) => p.amountPaise)],
    );

    const note = reason || `Casino ${type} round ${ctx.rid}`;
    const movement = await applyMovementWithin(ctx, {
      legs: parts.map((p) => ({ field: p.field, deltaPaise: debiting ? 0 - p.amountPaise : p.amountPaise })),
      // One ledger row per pocket that moved, each naming that pocket — what
      // the player's History shows. The first is keyed `casino_<provider id>`,
      // the movement's key, whichever pocket it is; each further part
      // `casino:<pocket>:<provider id>`. The two shapes differ before the
      // provider's id begins, so no provider id can spell another callback's
      // part key, and a replay always carries the first key.
      ledger: parts.map((p, i) => ({
        txId: i === 0 ? `casino_${txId}` : `casino:${p.field}:${txId}`,
        field: p.field,
        amountPaise: debiting ? 0 - p.amountPaise : p.amountPaise,
        type: debiting ? 'DEBIT' : 'CREDIT',
        reason: note,
        refId: ctx.rid,
      })),
      // The house is the other side, in this transaction: a BET's stake joins
      // HOUSE_RESERVE; a WIN or a reversal comes out of it, and past what it
      // holds from the platform's own (`treasury.postHouseSettlement`).
      counterparty: {
        house: true, operation: `CASINO_${type}`, reason: note,
        refModel: 'CasinoRound', refId: ctx.rid,
      },
    });

    if (movement.idempotent) {
      // The callback row was new but the ledger row was not — both keyed on the
      // same provider id inside one transaction, so this should be impossible.
      // Corruption, not something to commit quietly.
      return { commit: false, value: { ok: false, reason: 'inconsistent_idempotency', txId } };
    }
    if (!movement.ok) {
      return { commit: false, value: { ok: false, reason: movement.refused ?? 'insufficient' } };
    }

    return {
      commit: true,
      value: {
        ok: true, idempotent: false,
        round: rowToRound(updated),
        balances: movement.balancesAfterPaise,
      },
    };
  });

  count(`CASINO_${type}`, !result.ok ? (result.reason ?? 'error') : result.idempotent ? 'idempotent' : 'applied');
  return result;
}

// ── Reconciliation ───────────────────────────────────────────────────────────

/**
 * Rounds that gave back more than they took.
 *
 * The CHECK constraint makes this impossible to reach through `recordCallback`,
 * so a non-empty result is evidence that something wrote outside this module —
 * which is exactly what it is for. A check that can only ever return empty is
 * still worth running; it is the one that would catch a future path added
 * without the guard.
 */
export async function findOverRefundedRounds() {
  const { rows } = await pgQuery(
    `SELECT round_id, user_id, provider_key, debited_paise, refunded_paise
       FROM casino_rounds WHERE refunded_paise > debited_paise LIMIT 500`,
    [], 'casino_over_refunded',
  );
  return rows.map((r) => ({
    roundId: r.round_id, userId: r.user_id, providerKey: r.provider_key,
    debitedPaise: toPaise(r.debited_paise), refundedPaise: toPaise(r.refunded_paise),
    excessPaise: toPaise(r.refunded_paise) - toPaise(r.debited_paise),
  }));
}

/** Do one player's recorded callbacks on a round explain its running totals? */
export async function reconcileRound(roundId, who) {
  const [{ rows: sums }, round] = await Promise.all([
    pgQuery(
      `SELECT tx_type, COALESCE(SUM(amount_paise), 0) AS total
         FROM casino_transactions
        WHERE provider_key = $1 AND user_id = $2 AND round_id = $3 GROUP BY tx_type`,
      roundKey(roundId, who), 'casino_round_reconcile',
    ),
    getRound(roundId, who),
  ]);
  if (!round) return { ok: false, reason: 'not_found' };

  const byType = Object.fromEntries(sums.map((r) => [r.tx_type, toPaise(r.total)]));
  const fromTx = {
    debitedPaise:  byType[CASINO_TX.BET] ?? 0,
    creditedPaise: byType[CASINO_TX.WIN] ?? 0,
    refundedPaise: (byType[CASINO_TX.ROLLBACK] ?? 0) + (byType[CASINO_TX.REFUND] ?? 0),
  };

  const drift = {
    debitedPaise:  round.debitedPaise  - fromTx.debitedPaise,
    creditedPaise: round.creditedPaise - fromTx.creditedPaise,
    refundedPaise: round.refundedPaise - fromTx.refundedPaise,
  };
  return {
    ok: Object.values(drift).every((d) => d === 0),
    round, fromTx, drift,
  };
}
