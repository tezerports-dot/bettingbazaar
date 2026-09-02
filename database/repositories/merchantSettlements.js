// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * postgres/merchantSettlementPg.js — user↔merchant settlement, in PostgreSQL.
 *
 * Domain 2 of the full-authority migration. A settlement is the lifecycle of
 * one order's merchant-side value: committed, then either applied or given
 * back, with a correction path if it was applied wrongly.
 *
 * ── The defect this design exists to remove ─────────────────────────────────
 * The Mongo original keeps this state on the PaymentOrder and moves the money
 * AFTERWARDS. withdrawalHold.settleHold names the consequence in its own
 * comment: the order is flipped out of HELD first, and "if this throws, the
 * merchant is not credited and the next sweep cannot retry (the order has left
 * HELD)". The settlement is stranded — no automatic path forward, a human has
 * to find it.
 *
 * Here the state transition and the pocket movement are ONE transaction,
 * composed through merchantWalletPg.applyMovementWithin under a single merchant
 * lock. Either the settlement advanced and the tokens moved, or neither
 * happened and the retry finds it exactly where it was. There is no state in
 * which the books disagree with the state machine.
 *
 * ── The state machine ───────────────────────────────────────────────────────
 *
 *      open ──▶ RESERVED ──complete──▶ SETTLED ──reverse──▶ REVERSED
 *                   │
 *                   └────cancel──────▶ CANCELLED
 *
 * Every transition names the state it expects to find, and the guard is in the
 * UPDATE's WHERE clause. A caller that arrives with a stale idea of the state
 * matches no row and is refused — which is what makes out-of-order provider
 * callbacks safe rather than merely unlikely.
 *
 * ── What the pockets mean, per direction ────────────────────────────────────
 * The two directions are not symmetric, because the money flows opposite ways.
 *
 *   DEPOSIT — the merchant dispenses tokens to the user and takes fiat directly.
 *     reserve   available → reserved   inventory committed to this order
 *     complete  reserved  → (gone)     tokens dispensed; they leave the merchant
 *     cancel    reserved  → available  order died; inventory released
 *     reverse   (back)    → available  dispensed in error; returned
 *
 *   WITHDRAWAL — the merchant receives tokens from the user and sends fiat.
 *     reserve   (new)     → settlement owed to the merchant, NOT yet spendable
 *     complete  settlement → available the hold passed; now spendable
 *     cancel    settlement → (gone)    dispute upheld; never owed after all
 *     reverse   available  → (gone)    released in error; clawed back
 *
 * Reserving a WITHDRAWAL is the part the Mongo path cannot express. There, a
 * merchant's tokens simply do not exist during the hold window, so nothing
 * shows what the platform owes them. Here it is a real balance in a pocket that
 * cannot be spent, which is both more honest and what makes the reversal a
 * movement rather than an absence.
 *
 * ── Idempotency ─────────────────────────────────────────────────────────────
 * Two gates, and they answer different questions. `merchant_wallet_entries.tx_id`
 * UNIQUE stops the MONEY moving twice. `merchant_settlement_transitions.tx_id`
 * UNIQUE stops the STATE advancing twice. Both fire inside the transaction, so
 * a duplicate unwinds the whole thing rather than half of it.
 *
 * ── The rollback leg ────────────────────────────────────────────────────────
 * Every committed transition is mirrored back into Mongo, because this module
 * composes applyMovementWithin DIRECTLY rather than going through
 * merchantWalletPgAuthority — so it does not inherit that module's reverse
 * mirror, and without one of its own a settlement would move a merchant's
 * tokens in Postgres and leave `Merchant.tokenBalance` and the whole
 * MerchantWalletLedger untouched. Two things break at once if that happens:
 * falling back to Mongo silently loses the movement, and Mongo's idempotency
 * gate (`MerchantWalletLedger.findOne({ txId })`) no longer recognises it, so
 * the first retry after a fallback applies it a SECOND time.
 */
import { getPool, pgQuery, connectGuarded } from '../client.js';
import { POCKETS, applyMovementWithin } from './merchantWallets.core.js';
import { moneyOperations } from '../../backend/services/metrics.service.js';
import { MONEY_PATHS } from '../moneyPaths.js';

export const SETTLEMENT_STATES = Object.freeze({
  RESERVED:  'RESERVED',
  SETTLED:   'SETTLED',
  CANCELLED: 'CANCELLED',
  REVERSED:  'REVERSED',
});

export const DIRECTIONS = Object.freeze({
  DEPOSIT:    'DEPOSIT',
  WITHDRAWAL: 'WITHDRAWAL',
});

/**
 * Which pockets each transition moves, per direction. Kept as DATA rather than
 * branching inside each operation, because the asymmetry between the two
 * directions is the part most likely to be got wrong, and a table can be read
 * against the doc comment above in one glance.
 *
 * A leg of `null` means the value enters or leaves the platform's merchant
 * books entirely, which is correct for exactly the cases where it does: tokens
 * dispensed to a user are gone from the merchant, and tokens owed for a
 * withdrawal did not come out of any other merchant pocket.
 */
const POCKET_PLAN = Object.freeze({
  [DIRECTIONS.DEPOSIT]: {
    reserve:  (a) => ({ [POCKETS.AVAILABLE]: -a, [POCKETS.RESERVED]: a }),
    complete: (a) => ({ [POCKETS.RESERVED]: -a }),
    cancel:   (a) => ({ [POCKETS.RESERVED]: -a, [POCKETS.AVAILABLE]: a }),
    reverse:  (a) => ({ [POCKETS.AVAILABLE]: a }),
  },
  [DIRECTIONS.WITHDRAWAL]: {
    reserve:  (a) => ({ [POCKETS.SETTLEMENT]: a }),
    complete: (a) => ({ [POCKETS.SETTLEMENT]: -a, [POCKETS.AVAILABLE]: a }),
    cancel:   (a) => ({ [POCKETS.SETTLEMENT]: -a }),
    reverse:  (a) => ({ [POCKETS.AVAILABLE]: -a }),
  },
});

const toPaise = (v) => Number(v ?? 0);

/** Every exit from a transition is counted, so refusals and replays are visible. */
function count(operation, outcome) {
  moneyOperations.inc({
    path: MONEY_PATHS.MERCHANT_SETTLEMENT, store: 'postgres', operation, outcome,
  });
}

/**
 * Push a committed transition back into Mongo, and count the outcome.
 *
 * Runs ONLY while Postgres is authoritative for this path. On a
 * Mongo-authoritative path the forward mirror (dualWrite) owns the direction and
 * a reverse write would fight the real one — and it is also what keeps the
 * Postgres-only test suites, which have no Mongo connection at all, from
 * logging a mirror failure per assertion.
 *
 * Fire-and-forget by design: Postgres has already committed, so a Mongo failure
 * must not turn a settled transition into a thrown error. mirrorBack() logs,
 * counts and pages on a streak, and the reverse reconcile repairs the rest.
 */
function afterCommit(operation, result) {
  const outcome = !result?.ok ? (result?.reason ?? 'error')
    : result.idempotent ? 'idempotent' : 'applied';
  count(operation, outcome);

  if (!result?.ok || result.idempotent ) {
    return result;
  }
  const s = result.settlement;
  return result;
}

function rowToSettlement(row) {
  if (!row) return null;
  return {
    settlementId: row.settlement_id,
    merchantId:   row.merchant_id,
    orderId:      row.order_id,
    direction:    row.direction,
    amountPaise:  toPaise(row.amount_paise),
    state:        row.state,
    reason:       row.reason,
    createdAt:    row.created_at,
    updatedAt:    row.updated_at,
  };
}

/** The current settlement, or null. */
export async function getSettlement(settlementId) {
  const { rows } = await pgQuery(
    `SELECT * FROM merchant_settlements WHERE settlement_id = $1`,
    [String(settlementId)], 'merchant_settlement_read',
  );
  return rowToSettlement(rows[0]);
}

/** Its full transition history, oldest first. Append-only in the database. */
export async function getSettlementHistory(settlementId) {
  const { rows } = await pgQuery(
    `SELECT tx_id, from_state, to_state, actor, reason, created_at
       FROM merchant_settlement_transitions WHERE settlement_id = $1 ORDER BY id`,
    [String(settlementId)], 'merchant_settlement_history',
  );
  return rows.map((r) => ({
    txId: r.tx_id, from: r.from_state, to: r.to_state,
    actor: r.actor, reason: r.reason, at: r.created_at,
  }));
}

/**
 * Lock the merchant AND the settlement row, in that order.
 *
 * The order is not arbitrary. Every path that touches a settlement also touches
 * its merchant's pockets, so taking the merchant lock first everywhere means
 * two concurrent settlements for the same merchant queue behind one lock
 * instead of grabbing them in opposite orders and deadlocking. This is the only
 * place both locks are taken, which is what makes that guarantee checkable.
 */
async function withSettlementLock(merchantId, settlementId, fn) {
  const mid = String(merchantId);
  const sid = String(settlementId);
  const pool = await getPool();
  if (!pool) throw new Error('Postgres not configured (DATABASE_URL unset)');
  const client = await connectGuarded(pool);
  let failure = null;

  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO merchant_wallets (merchant_id) VALUES ($1) ON CONFLICT (merchant_id) DO NOTHING`,
      [mid],
    );
    const wallet = await client.query(
      `SELECT available_paise, reserved_paise, settlement_paise
         FROM merchant_wallets WHERE merchant_id = $1 FOR UPDATE`, [mid],
    );
    const settlement = await client.query(
      `SELECT * FROM merchant_settlements WHERE settlement_id = $1 FOR UPDATE`, [sid],
    );

    const balances = {
      available:  toPaise(wallet.rows[0]?.available_paise),
      reserved:   toPaise(wallet.rows[0]?.reserved_paise),
      settlement: toPaise(wallet.rows[0]?.settlement_paise),
    };
    balances.liability = balances.reserved + balances.settlement;

    const { commit, value } = await fn({
      client, mid, sid, balances,
      settlement: rowToSettlement(settlement.rows[0]),
    });
    await client.query(commit ? 'COMMIT' : 'ROLLBACK');
    return value;
  } catch (error) {
    failure = error;
    try { await client.query('ROLLBACK'); } catch { /* already unwound */ }
    throw error;
  } finally {
    // Destroy rather than return a client whose backend may have gone away
    // mid-transaction — see withMerchantLock for what a plain release() does to
    // the next caller.
    client.release(failure ?? undefined);
  }
}

/**
 * Record the transition. Returns false on a UNIQUE tx_id collision — the
 * idempotency gate firing, not an error.
 */
async function recordTransition(client, sid, { txId, from, to, actor, reason }) {
  try {
    await client.query(
      `INSERT INTO merchant_settlement_transitions
         (tx_id, settlement_id, from_state, to_state, actor, reason)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [txId, sid, from ?? null, to, actor ?? null, reason ?? null],
    );
    return true;
  } catch (error) {
    if (error.code === '23505') return false;
    throw error;
  }
}

/**
 * openSettlement — create a settlement and commit the merchant's side of it.
 *
 * `settlementId` is the caller's deterministic key (`ms_<orderId>`), so a
 * retried request opens the same settlement rather than a second one for the
 * same order. Re-opening an existing settlement is idempotent whatever state it
 * has reached — a duplicate open must never re-reserve tokens against a
 * settlement that has already been paid out.
 */
export async function openSettlement({
  settlementId, merchantId, orderId, direction, amountPaise,
  actor = null, reason = null, correlationId = null,
}) {
  requireDirection(direction);
  requirePositive(amountPaise, 'openSettlement');
  if (!settlementId) throw new Error('openSettlement requires a settlementId');

  const result = await withSettlementLock(merchantId, settlementId, async (ctx) => {
    if (ctx.settlement) {
      return { commit: false, value: { ok: true, idempotent: true, settlement: ctx.settlement, balances: ctx.balances } };
    }

    const { rows } = await ctx.client.query(
      `INSERT INTO merchant_settlements
         (settlement_id, merchant_id, order_id, direction, amount_paise, state, reason)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING updated_at`,
      [ctx.sid, ctx.mid, String(orderId), direction, amountPaise, SETTLEMENT_STATES.RESERVED, reason],
    );

    return applyTransition(ctx, {
      transition: 'reserve',
      direction,
      amountPaise,
      from: null,
      to: SETTLEMENT_STATES.RESERVED,
      updatedAt: rows[0]?.updated_at,
      txId: `${ctx.sid}_reserve`,
      operation: `SETTLEMENT_RESERVE_${direction}`,
      actor, reason, orderId, correlationId,
    });
  });
  return afterCommit('SETTLEMENT_OPEN', result);
}

/** RESERVED → SETTLED. The value is applied: dispensed, or made spendable. */
export const completeSettlement = (args) =>
  advance(args, {
    transition: 'complete',
    expect: SETTLEMENT_STATES.RESERVED,
    to: SETTLEMENT_STATES.SETTLED,
    suffix: 'complete',
    operation: 'SETTLEMENT_COMPLETE',
  });

/** RESERVED → CANCELLED. The settlement never happens; the reservation unwinds. */
export const cancelSettlement = (args) =>
  advance(args, {
    transition: 'cancel',
    expect: SETTLEMENT_STATES.RESERVED,
    to: SETTLEMENT_STATES.CANCELLED,
    suffix: 'cancel',
    operation: 'SETTLEMENT_CANCEL',
  });

/**
 * SETTLED → REVERSED. A correction after the fact.
 *
 * Distinct from cancel, and deliberately so: cancel unwinds something that was
 * never applied, reversal undoes something that was. They post different
 * entries and reach different pockets, and collapsing them would make the
 * ledger unable to tell "this order died" from "we got this wrong".
 *
 * A reversal may drive `available` negative — the tokens may already have been
 * spent — which is why it is the one transition that carries the authorisation
 * to do so. The alternative is refusing to record a correction that has already
 * happened in the real world, which is worse.
 */
export const reverseSettlement = (args) =>
  advance(args, {
    transition: 'reverse',
    expect: SETTLEMENT_STATES.SETTLED,
    to: SETTLEMENT_STATES.REVERSED,
    suffix: 'reverse',
    operation: 'SETTLEMENT_REVERSE',
    allowNegativeAvailable: true,
  });

/**
 * The shared body of every post-open transition.
 *
 * Returns one of four outcomes, and callers need all four distinguished:
 *   { ok: true,  idempotent: false }  this call advanced it
 *   { ok: true,  idempotent: true  }  someone already did; nothing moved
 *   { ok: false, reason: 'not_found' }
 *   { ok: false, reason: 'invalid_transition', state } arrived out of order
 * Collapsing "already done" into "invalid" is the classic way a retry-safe API
 * stops being retry-safe: the caller sees a failure and compensates for
 * something that actually succeeded.
 */
async function advance(
  { settlementId, merchantId, actor = null, reason = null, correlationId = null },
  spec,
) {
  if (!settlementId) throw new Error(`${spec.transition}Settlement requires a settlementId`);

  const result = await withSettlementLock(merchantId, settlementId, async (ctx) => {
    const s = ctx.settlement;
    if (!s) return { commit: false, value: { ok: false, reason: 'not_found' } };
    if (s.state === spec.to) {
      return { commit: false, value: { ok: true, idempotent: true, settlement: s, balances: ctx.balances } };
    }
    if (s.state !== spec.expect) {
      return {
        commit: false,
        value: { ok: false, reason: 'invalid_transition', state: s.state, expected: spec.expect },
      };
    }

    // The guard is in the WHERE clause, not in the check above: between reading
    // the row and writing it another transaction could have moved it, and only
    // the database can settle that race. The read gives a good error message;
    // the WHERE gives correctness.
    const moved = await ctx.client.query(
      `UPDATE merchant_settlements SET state = $2, updated_at = now()
        WHERE settlement_id = $1 AND state = $3
        RETURNING updated_at`,
      [ctx.sid, spec.to, spec.expect],
    );
    if (!moved.rowCount) {
      return { commit: false, value: { ok: false, reason: 'invalid_transition', state: s.state, expected: spec.expect } };
    }

    return applyTransition(ctx, {
      transition: spec.transition,
      direction: s.direction,
      amountPaise: s.amountPaise,
      from: spec.expect,
      to: spec.to,
      updatedAt: moved.rows[0].updated_at,
      txId: `${ctx.sid}_${spec.suffix}`,
      operation: `${spec.operation}_${s.direction}`,
      allowNegativeAvailable: spec.allowNegativeAvailable ?? false,
      actor, reason, orderId: s.orderId, correlationId,
    });
  });
  return afterCommit(spec.operation, result);
}

/**
 * Write the transition row and move the pockets, in the caller's transaction.
 *
 * Both gates are checked here and BOTH unwind the whole transaction when they
 * fire. That is the property the composition exists for: a duplicate cannot
 * leave the state advanced with the money unmoved, or the money moved with the
 * state behind.
 */
async function applyTransition(ctx, {
  transition, direction, amountPaise, from, to, txId, operation, updatedAt,
  actor, reason, orderId, correlationId, allowNegativeAvailable = false,
}) {
  if (!await recordTransition(ctx.client, ctx.sid, { txId, from, to, actor, reason })) {
    return { commit: false, value: { ok: true, idempotent: true, balances: ctx.balances } };
  }

  const legs = POCKET_PLAN[direction][transition](amountPaise);
  const movement = await applyMovementWithin(ctx, {
    txId, operation, legs, actor,
    reason: reason || `${operation} ${ctx.sid}`,
    refModel: 'PaymentOrder', refId: orderId, correlationId,
    allowNegativeAvailable,
  });

  if (movement.idempotent) {
    // The transition row was new but the movement was not. That combination
    // should be impossible — both are keyed on the same txId inside the same
    // transaction — so treat it as corruption rather than quietly committing a
    // state change whose money never moved.
    return {
      commit: false,
      value: { ok: false, reason: 'inconsistent_idempotency', txId },
    };
  }
  if (!movement.ok) {
    return {
      commit: false,
      value: { ok: false, reason: 'insufficient', balances: ctx.balances, legs },
    };
  }

  // The whole settlement as it now stands, including the orderId and the
  // timestamp the transition itself wrote. The mirror needs both — it addresses
  // the PaymentOrder by id, and stamps `completedAt` from the moment Postgres
  // decided rather than the moment Mongo caught up — and reading them back off
  // ctx.settlement would give the values from BEFORE the transition (or, on an
  // open, no values at all, since there was no row to read).
  const settlement = {
    ...(ctx.settlement ?? {}),
    settlementId: ctx.sid, merchantId: ctx.mid, orderId: String(orderId),
    direction, amountPaise, state: to, updatedAt: updatedAt ?? new Date(),
  };
  return {
    commit: true,
    value: {
      ok: true, idempotent: false, settlement,
      balances: movement.balances, entries: movement.entries, txId,
    },
  };
}

function requireDirection(direction) {
  if (!DIRECTIONS[direction]) {
    throw new Error(`Unknown settlement direction '${direction}'. Known: ${Object.keys(DIRECTIONS).join(', ')}`);
  }
}

function requirePositive(amountPaise, fn) {
  if (!Number.isInteger(amountPaise) || amountPaise <= 0) {
    throw new TypeError(`${fn}: amountPaise must be a positive integer, got ${amountPaise}`);
  }
}

/**
 * Do the settlements explain the merchant's committed pockets?
 *
 * `reserved` should equal the outstanding DEPOSIT reservations and `settlement`
 * the outstanding WITHDRAWAL ones. Anything else means a pocket moved without a
 * settlement behind it, or a settlement's state and its money disagree — which
 * the transaction structure above is designed to make impossible, so a non-zero
 * result is evidence that something outside it wrote.
 */
export async function reconcileSettlements(merchantId) {
  const [{ rows: outstanding }, { rows: wallet }] = await Promise.all([
    pgQuery(
      `SELECT direction, COALESCE(SUM(amount_paise), 0) AS total
         FROM merchant_settlements
        WHERE merchant_id = $1 AND state = $2
        GROUP BY direction`,
      [String(merchantId), SETTLEMENT_STATES.RESERVED], 'merchant_settlement_reconcile',
    ),
    pgQuery(
      `SELECT reserved_paise, settlement_paise FROM merchant_wallets WHERE merchant_id = $1`,
      [String(merchantId)], 'merchant_settlement_reconcile_wallet',
    ),
  ]);

  const byDirection = { DEPOSIT: 0, WITHDRAWAL: 0 };
  for (const r of outstanding) byDirection[r.direction] = toPaise(r.total);

  const pockets = {
    reserved:   toPaise(wallet[0]?.reserved_paise),
    settlement: toPaise(wallet[0]?.settlement_paise),
  };
  const drift = {
    reserved:   pockets.reserved   - byDirection.DEPOSIT,
    settlement: pockets.settlement - byDirection.WITHDRAWAL,
  };

  return {
    ok: drift.reserved === 0 && drift.settlement === 0,
    pockets, outstanding: byDirection, drift,
  };
}

/** Every merchant whose committed pockets are not explained by its settlements. */
export async function findUnexplainedSettlementPockets() {
  const { rows } = await pgQuery(
    `SELECT w.merchant_id,
            w.reserved_paise,
            w.settlement_paise,
            COALESCE(SUM(s.amount_paise) FILTER (WHERE s.direction = 'DEPOSIT'), 0)    AS deposit_reserved,
            COALESCE(SUM(s.amount_paise) FILTER (WHERE s.direction = 'WITHDRAWAL'), 0) AS withdrawal_reserved
       FROM merchant_wallets w
       LEFT JOIN merchant_settlements s
         ON s.merchant_id = w.merchant_id AND s.state = 'RESERVED'
      GROUP BY w.merchant_id, w.reserved_paise, w.settlement_paise`,
    [], 'merchant_settlement_reconcile_all',
  );

  return rows
    .map((r) => ({
      merchantId: String(r.merchant_id),
      reservedDrift:   toPaise(r.reserved_paise)   - toPaise(r.deposit_reserved),
      settlementDrift: toPaise(r.settlement_paise) - toPaise(r.withdrawal_reserved),
    }))
    .filter((r) => r.reservedDrift !== 0 || r.settlementDrift !== 0);
}
