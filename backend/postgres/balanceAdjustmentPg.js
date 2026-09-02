// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * postgres/balanceAdjustmentPg.js — an admin moving a player's money by hand.
 *
 * The wallet ledger records that money MOVED. This records the DECISION behind
 * it: which admin, for which player, how much, off which pocket, and why. That
 * is what an audit of an adjustment actually asks about, and the ledger cannot
 * answer it.
 *
 * ── What this replaces, and the four things that were wrong with it ─────────
 *
 * 1. THE AUDIT ROW WAS NEVER WRITTEN. `BalanceAdjustment` was registered
 *    nowhere, so `.create()` raised MissingSchemaError, the route returned 500,
 *    and — because the row was written BEFORE the movement — no money moved
 *    either. The admin balance-adjust endpoint has never once succeeded.
 *
 * 2. THE DECISION READ THE WRONG NUMBER. `before` came from `user[field]` on
 *    the account document while the movement happened in `wallets`. The
 *    "insufficient balance" guard therefore compared a number nothing was going
 *    to debit. (CLAUDE.md trap 7. `audit-balance-reads.mjs` could not see this
 *    one: the field is a variable, not a literal.)
 *
 * 3. `field` WAS ACCEPTED AND IGNORED. `adminAdjustment` took a `field`
 *    argument and never passed it on — every credit went to winnings and every
 *    debit came out of deposit first. An admin debiting winnings moved deposit,
 *    and the audit row said "winningsBalance". An audit record that names the
 *    wrong pocket is worse than none: it looks authoritative and is false.
 *
 * 4. RUPEE FLOATS. The route did `before + (type==='CREDIT'?1:-1)*Number(amount)`
 *    in rupees, so an adjustment of ₹0.1 plus ₹0.2 is ₹0.30000000000000004 in
 *    the record. Paise, BIGINT, integers — like every other money column here.
 *
 * ── One transaction ─────────────────────────────────────────────────────────
 * The movement and its audit row commit together, under the same wallet row
 * lock. Either order without a transaction has a crash window, and the two
 * windows are not equally bad: a decision row with no money claims an
 * adjustment that never happened, which is exactly the false-authoritative
 * record the CHECK constraints exist to prevent. So neither — both or neither.
 *
 * `before` and `after` come from the balances the lock returned, never from a
 * pre-read. Under the lock they are the numbers the movement actually used.
 */
import {
  withWalletLock, applyMovementWithin, getBalancesPaise, FIELD_COLUMN,
} from './walletPg.js';
import { pgQuery } from './pgClient.js';
import { rupeesToPaise, paiseToRupees } from '../shared/money.js';

/**
 * Pockets an admin may adjust.
 *
 * Deliberately NOT every field in FIELD_COLUMN: `lockedBalance` and the two
 * lock-provenance counters are derived from money held against an open bet or
 * withdrawal, and hand-editing one desynchronises it from the thing holding it.
 * An admin who needs that changed needs the bet or the withdrawal resolved.
 */
export const ADJUSTABLE_FIELDS = Object.freeze([
  'depositBalance', 'winningsBalance', 'tokenBalance', 'reserveBalance',
]);

function assertAdjustable(field) {
  if (!ADJUSTABLE_FIELDS.includes(field)) {
    throw new Error(
      `Cannot adjust '${field}'. Adjustable: ${ADJUSTABLE_FIELDS.join(', ')}`
      + (FIELD_COLUMN[field] ? ' — locked balances follow the bet or withdrawal holding them.' : ''),
    );
  }
}

/**
 * Apply an adjustment.
 *
 * @returns {{ok:true, adjustment, balances}}                     applied
 *          {{ok:false, reason:'INSUFFICIENT', availableRupees}}  refused
 *          {{ok:true, idempotent:true, adjustment}}              already applied
 *
 * Refusal is a RETURN, not a throw: "this player does not have it" is an answer
 * the admin panel shows, not a server error.
 */
export async function applyAdjustment({
  adjustmentId, userId, adminId, type, field, amountRupees, reason,
}) {
  if (!adjustmentId) throw new Error('applyAdjustment requires an adjustmentId (idempotency key)');
  if (!userId) throw new Error('applyAdjustment requires a userId');
  if (!adminId) throw new Error('applyAdjustment requires an adminId');
  if (type !== 'CREDIT' && type !== 'DEBIT') throw new Error(`type must be CREDIT or DEBIT, got ${type}`);
  assertAdjustable(field);
  if (!String(reason ?? '').trim()) throw new Error('An adjustment requires a reason');

  const amountPaise = rupeesToPaise(amountRupees);
  if (!Number.isInteger(amountPaise) || amountPaise <= 0) {
    throw new Error(`Invalid adjustment amount: ${amountRupees}`);
  }

  const uidStr = String(userId);
  const adminStr = String(adminId);
  const idStr = String(adjustmentId);
  const txId = `admin_${idStr}`;
  const fullReason = `[Admin:${adminStr}] ${String(reason).trim()}`;

  // A retry of the same adjustment is a retry, not a second adjustment. Checked
  // before the lock so the common replay costs nothing; the PRIMARY KEY below
  // is what actually enforces it, because a check outside the transaction is a
  // hopeful pre-read.
  const prior = await getAdjustment(idStr);
  if (prior) return { ok: true, idempotent: true, adjustment: prior };

  const delta = type === 'CREDIT' ? amountPaise : -amountPaise;

  const outcome = await withWalletLock(uidStr, async (ctx) => {
    const beforePaise = ctx.balances[field];

    // NO PRE-CHECK HERE, deliberately. An earlier draft compared
    // `beforePaise < amountPaise` before attempting the movement, and the
    // mutation harness reported that check SURVIVING every deletion: the
    // movement's own guard refuses a negative balance under the same lock and
    // returns the same refusal, so the comparison was a second owner of a
    // decision that already had one. The database is the owner. (§ "Derive, do
    // not duplicate".)
    const moved = await applyMovementWithin(ctx, {
      legs: [{ field, deltaPaise: delta }],
      ledger: [{
        txId, field, amountPaise: delta, type,
        reason: fullReason, refId: idStr,
      }],
    });
    // Refused: the pocket does not hold it. `beforePaise` is the locked read, so
    // the number reported back is the one the refusal was made against.
    if (!moved.ok) {
      return {
        commit: false,
        value: { ok: false, reason: 'INSUFFICIENT', availableRupees: paiseToRupees(beforePaise) },
      };
    }
    // The ledger key already existed: the money moved on an earlier attempt
    // whose audit row did not land. THAT UNIQUE VIOLATION ABORTED THIS
    // TRANSACTION — Postgres refuses every further statement on the connection
    // until it unwinds — so the recovery cannot be written here. Unwind, and
    // finish it outside the lock. (`withWalletLock`'s own doc comment records
    // this; the first draft of this function ignored it and every replay threw
    // "current transaction is aborted".)
    if (moved.idempotent) return { commit: false, value: { ok: true, ledgerReplayed: true } };
    const afterPaise = moved.balancesAfterPaise[field];

    const { rows } = await ctx.client.query(
      `INSERT INTO balance_adjustments
         (adjustment_id, user_id, admin_id, tx_type, field,
          amount_paise, before_paise, after_paise, reason)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING adjustment_id, user_id, admin_id, tx_type, field,
                 amount_paise, before_paise, after_paise, reason, created_at`,
      [idStr, uidStr, adminStr, type, field,
        amountPaise, beforePaise, beforePaise + delta, String(reason).trim()],
    );

    return {
      commit: true,
      value: {
        ok: true,
        adjustment: toAdjustment(rows[0]),
        txId,
        beforeRupees: paiseToRupees(beforePaise),
        afterRupees: paiseToRupees(afterPaise),
        balances: moved.balancesAfterPaise
          ? Object.fromEntries(Object.entries(moved.balancesAfterPaise)
            .map(([f, v]) => [f, paiseToRupees(v)]))
          : null,
      },
    };
  });

  // ── The recovery, outside the aborted transaction ────────────────────────
  // The money moved on an earlier attempt and this attempt's audit row never
  // landed. Reconstruct the row from the balance the movement actually left,
  // rather than from the caller's arguments: `before` is what `after` was
  // before this delta, and both are read after the fact because the locked
  // pre-read is gone with the transaction that held it.
  if (outcome.ledgerReplayed) {
    const balances = await getBalancesPaise(uidStr);
    const afterPaise = balances[field];
    const { rows } = await pgQuery(
      `INSERT INTO balance_adjustments
         (adjustment_id, user_id, admin_id, tx_type, field,
          amount_paise, before_paise, after_paise, reason)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (adjustment_id) DO NOTHING
       RETURNING ${COLUMNS}`,
      [idStr, uidStr, adminStr, type, field,
        amountPaise, afterPaise - delta, afterPaise, String(reason).trim()],
      'adjustment_recover',
    );
    return {
      ok: true, idempotent: true,
      adjustment: rows[0] ? toAdjustment(rows[0]) : await getAdjustment(idStr),
      txId,
      beforeRupees: paiseToRupees(afterPaise - delta),
      afterRupees: paiseToRupees(afterPaise),
      balances: Object.fromEntries(Object.entries(balances).map(([f, v]) => [f, paiseToRupees(v)])),
    };
  }

  return outcome;
}

function toAdjustment(r) {
  return {
    adjustmentId: r.adjustment_id,
    _id: r.adjustment_id,
    userId: r.user_id,
    adminId: r.admin_id,
    type: r.tx_type,
    field: r.field,
    // Rupees on the way out, because that is what the panel renders and what
    // the admin typed. Paise is what was stored and compared.
    amount: paiseToRupees(Number(r.amount_paise)),
    beforeBalance: paiseToRupees(Number(r.before_paise)),
    afterBalance: paiseToRupees(Number(r.after_paise)),
    amountPaise: Number(r.amount_paise),
    beforePaise: Number(r.before_paise),
    afterPaise: Number(r.after_paise),
    reason: r.reason,
    createdAt: r.created_at,
  };
}

const COLUMNS = `adjustment_id, user_id, admin_id, tx_type, field,
                 amount_paise, before_paise, after_paise, reason, created_at`;

export async function getAdjustment(adjustmentId) {
  const { rows } = await pgQuery(
    `SELECT ${COLUMNS} FROM balance_adjustments WHERE adjustment_id = $1`,
    [String(adjustmentId)], 'adjustment_get',
  );
  return rows[0] ? toAdjustment(rows[0]) : null;
}

/**
 * The adjustment history, newest first.
 *
 * Offset paging, because this is what the panel's page control sends and the
 * list is small and admin-only. The keyset argument that applies to player
 * ledgers does not bite here: rows arrive at human speed.
 */
export async function listAdjustments({ userId = null, adminId = null, page = 1, limit = 30 } = {}) {
  const size = Math.min(Math.max(Number(limit) || 30, 1), 200);
  const skip = Math.max(0, (Math.max(Number(page) || 1, 1) - 1) * size);

  const where = [];
  const params = [];
  if (userId) { params.push(String(userId)); where.push(`user_id = $${params.length}`); }
  if (adminId) { params.push(String(adminId)); where.push(`admin_id = $${params.length}`); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const { rows } = await pgQuery(
    `SELECT ${COLUMNS}, COUNT(*) OVER () AS total_count
       FROM balance_adjustments ${clause}
      ORDER BY created_at DESC, adjustment_id DESC
      LIMIT ${size} OFFSET ${skip}`,
    params, 'adjustment_list',
  );

  return {
    // COUNT(*) OVER () rather than a second query: two statements outside a
    // transaction can disagree, and a total that contradicts the page it
    // labels is how a paginator grows a phantom last page.
    total: rows[0] ? Number(rows[0].total_count) : 0,
    adjustments: rows.map(toAdjustment),
  };
}
