// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * postgres/casinoPg.js — casino provider callbacks, in PostgreSQL.
 *
 * Domain 7. A provider posts BET / WIN / ROLLBACK / REFUND against a round, and
 * each one moves a real player balance.
 *
 * ── The defect this exists to remove ────────────────────────────────────────
 * Recorded in docs/FINANCIAL_DOMAIN_MATRIX.md and MONGO_MONEY_AUDIT.md:
 *
 *     A ROLLBACK or REFUND credit does not currently have to prove a matching
 *     prior debit.
 *
 * `gameProvider.routes.js` handles a rollback with
 * `refundOrder(userId, amount, roundId, 'depositBalance')` — no check that the
 * round was ever bet on, and no bound on the amount. A provider that is buggy,
 * replayed, or hostile can therefore MINT REAL MONEY by posting a rollback for
 * a round that never had a bet, or a rollback larger than the bet it reverses.
 * Nothing in that path can tell such a callback from a legitimate one.
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
import { applyMovementWithin } from './wallets.core.js';
import { moneyOperations } from '../../backend/services/metrics.service.js';
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
  };
}

/** The round and its running totals, or null. */
export async function getRound(roundId) {
  const { rows } = await pgQuery(
    `SELECT * FROM casino_rounds WHERE round_id = $1`, [String(roundId)], 'casino_round_read',
  );
  return rowToRound(rows[0]);
}

/** Every callback recorded against a round, oldest first. Append-only. */
export async function getRoundTransactions(roundId) {
  const { rows } = await pgQuery(
    `SELECT tx_id, tx_type, amount_paise, created_at FROM casino_transactions
      WHERE round_id = $1 ORDER BY id`,
    [String(roundId)], 'casino_round_history',
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
async function withRoundLock(userId, roundId, fn) {
  const uid = String(userId);
  const rid = String(roundId);
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
    const round = await client.query(
      `SELECT * FROM casino_rounds WHERE round_id = $1 FOR UPDATE`, [rid],
    );

    const { commit, value } = await fn({ client, uid, rid, round: rowToRound(round.rows[0]) });
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
 * @returns one of
 *   { ok: true,  idempotent: false, round, balances }
 *   { ok: true,  idempotent: true,  round }              duplicate callback
 *   { ok: false, reason: 'insufficient' }                player cannot cover a BET
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

  const result = await withRoundLock(userId, roundId, async (ctx) => {
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
         VALUES ($1,$2,$3,$4) ON CONFLICT (round_id) DO NOTHING`,
        [ctx.rid, ctx.uid, providerKey ?? 'unknown', gameId],
      );
    }

    // The idempotency gate, inside the transaction. Providers retry hard, so a
    // duplicate here is routine rather than exceptional.
    try {
      await ctx.client.query(
        `INSERT INTO casino_transactions (tx_id, round_id, user_id, tx_type, amount_paise)
         VALUES ($1,$2,$3,$4,$5)`,
        [String(txId), ctx.rid, ctx.uid, type, amountPaise],
      );
    } catch (error) {
      if (error.code !== '23505') throw error;
      return { commit: false, value: { ok: true, idempotent: true, round: ctx.round } };
    }

    // Advance the round's running total. The `refunded_paise <= debited_paise`
    // CHECK fires here if the guard above were ever removed or bypassed — the
    // constraint is what makes the bound a property of the DATA rather than of
    // this function.
    const column = ROUND_COLUMN[type];
    const { rows: [updated] } = await ctx.client.query(
      `UPDATE casino_rounds SET ${column} = ${column} + $2, updated_at = now()
        WHERE round_id = $1 RETURNING *`,
      [ctx.rid, amountPaise],
    );

    const debiting = type === CASINO_TX.BET;
    const movement = await applyMovementWithin(ctx, {
      // A BET takes from deposit; everything else gives back. The Mongo path
      // refunds into `depositBalance` too, so the two stores agree on which
      // pocket a reversal lands in.
      legs: [{ field: 'depositBalance', deltaPaise: debiting ? 0 - amountPaise : amountPaise }],
      ledger: [{
        txId: `casino_${txId}`,
        field: debiting ? 'depositBalance' : (type === CASINO_TX.WIN ? 'winningsBalance' : 'depositBalance'),
        amountPaise: debiting ? 0 - amountPaise : amountPaise,
        type: debiting ? 'DEBIT' : 'CREDIT',
        reason: reason || `Casino ${type} round ${ctx.rid}`,
        refId: ctx.rid,
      }],
    });

    if (movement.idempotent) {
      // The callback row was new but the ledger row was not — both keyed on the
      // same provider id inside one transaction, so this should be impossible.
      // Corruption, not something to commit quietly.
      return { commit: false, value: { ok: false, reason: 'inconsistent_idempotency', txId } };
    }
    if (!movement.ok) {
      return { commit: false, value: { ok: false, reason: 'insufficient' } };
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
    `SELECT round_id, user_id, debited_paise, refunded_paise
       FROM casino_rounds WHERE refunded_paise > debited_paise LIMIT 500`,
    [], 'casino_over_refunded',
  );
  return rows.map((r) => ({
    roundId: r.round_id, userId: r.user_id,
    debitedPaise: toPaise(r.debited_paise), refundedPaise: toPaise(r.refunded_paise),
    excessPaise: toPaise(r.refunded_paise) - toPaise(r.debited_paise),
  }));
}

/** Do a round's recorded callbacks explain its running totals? */
export async function reconcileRound(roundId) {
  const [{ rows: sums }, round] = await Promise.all([
    pgQuery(
      `SELECT tx_type, COALESCE(SUM(amount_paise), 0) AS total
         FROM casino_transactions WHERE round_id = $1 GROUP BY tx_type`,
      [String(roundId)], 'casino_round_reconcile',
    ),
    getRound(roundId),
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
