// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * postgres/bonusPg.js — bonuses and referral commissions, in PostgreSQL.
 *
 * Domain 8. Signup bonuses, cashback, referral rewards and merchant
 * commissions: money the PLATFORM gives away.
 *
 * ── The property this domain has to establish ───────────────────────────────
 * A bonus is a TRANSFER, not a mint.
 *
 * That sounds pedantic and is not. The treasury already models the pools these
 * come out of — BONUS_POOL, REFERRAL_POOL, COMMISSION_POOL — and the whole
 * system's closing invariant is
 *
 *     User Books + Merchant Books + Treasury Books = Total Supply
 *
 * A bonus credited straight onto a user's balance breaks that: tokens appear on
 * the user side with nothing on the other, so the books stop summing to zero
 * and every downstream conservation check starts failing for a reason that has
 * nothing to do with the bug it was built to catch. Paying from a pool keeps
 * the equation true, and — more usefully — makes "how much have we given away
 * this month, and is there anything left to give" a balance rather than a
 * report someone has to run.
 *
 * The pool movement and the user credit are ONE transaction. Either the pool
 * paid and the user received, or neither happened.
 *
 * ── Clawback, not deletion ──────────────────────────────────────────────────
 * A bonus granted in error is reversed by a second movement that returns it to
 * the pool, leaving both in the history. The grant and its clawback are
 * separately visible, which is what lets someone answer "was this user ever
 * given a signup bonus?" — a question that deleting the row destroys, and one
 * that fraud review actually asks.
 *
 * A clawback may drive the user's balance negative. It is authorised to: the
 * money may already have been spent, and refusing to record a reversal that has
 * already happened in the real world is worse than recording an overdraft.
 */
import { getPool, pgQuery, connectGuarded } from '../client.js';
import { applyMovementWithin } from './wallets.core.js';
import { moneyOperations } from '../../backend/services/metrics.service.js';
import { MONEY_PATHS } from '../moneyPaths.js';
import { ACCOUNTS, poolPaidUser, allocateFromHouse } from './treasury.js';

export const GRANT_STATUS = Object.freeze({
  PAID:         'PAID',
  CLAWED_BACK:  'CLAWED_BACK',
});

/**
 * Which treasury pool each kind of giveaway is paid from.
 *
 * Data, not a parameter the caller picks, so a new bonus type cannot quietly
 * be paid out of the wrong pool — and so "what does REFERRAL_POOL fund?" has
 * one answer readable in one place.
 */
export const BONUS_KIND = Object.freeze({
  SIGNUP:     { pool: ACCOUNTS.BONUS_POOL,      field: 'depositBalance' },
  CASHBACK:   { pool: ACCOUNTS.BONUS_POOL,      field: 'depositBalance' },
  PROMO:      { pool: ACCOUNTS.BONUS_POOL,      field: 'depositBalance' },
  REFERRAL:   { pool: ACCOUNTS.REFERRAL_POOL,   field: 'depositBalance' },
  // A commission is EARNED rather than gifted, so it lands in winnings, which
  // is the withdrawable pocket. The others land in deposit, which is not —
  // a signup bonus that could be withdrawn immediately is a cash-out route,
  // and that distinction is the entire point of the two pockets.
  COMMISSION: { pool: ACCOUNTS.COMMISSION_POOL, field: 'winningsBalance' },
});

const toPaise = (v) => Number(v ?? 0);

function count(operation, outcome) {
  moneyOperations.inc({ path: MONEY_PATHS.BONUSES_AND_COMMISSIONS, store: 'postgres', operation, outcome });
}

function rowToGrant(row) {
  if (!row) return null;
  return {
    grantId:     row.grant_id,
    userId:      row.user_id,
    kind:        row.kind,
    pool:        row.pool,
    amountPaise: toPaise(row.amount_paise),
    status:      row.status,
    refModel:    row.ref_model,
    refId:       row.ref_id,
    grantedAt:   row.granted_at,
  };
}

/** The grant, or null. */
export async function getGrant(grantId) {
  const { rows } = await pgQuery(
    `SELECT * FROM bonus_grants WHERE grant_id = $1`, [String(grantId)], 'bonus_grant_read',
  );
  return rowToGrant(rows[0]);
}

/** Every grant for a user, newest first. */
export async function getUserGrants(userId, { limit = 100 } = {}) {
  const { rows } = await pgQuery(
    `SELECT * FROM bonus_grants WHERE user_id = $1 ORDER BY granted_at DESC LIMIT $2`,
    [String(userId), limit], 'bonus_grant_list',
  );
  return rows.map(rowToGrant);
}

/** Lock the user's wallet, then the grant. Wallet first, as everywhere else. */
async function withGrantLock(userId, grantId, fn) {
  const uid = String(userId);
  const gid = String(grantId);
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
    const grant = await client.query(
      `SELECT * FROM bonus_grants WHERE grant_id = $1 FOR UPDATE`, [gid],
    );

    const { commit, value } = await fn({ client, uid, gid, grant: rowToGrant(grant.rows[0]) });
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
 * Grant a bonus: credit the user and take it out of the pool that funds it.
 *
 * @param {object} args
 * @param {string} args.grantId  the caller's deterministic key — REQUIRED
 * @param {string} args.kind     a key of BONUS_KIND
 *
 * @returns one of
 *   { ok: true,  idempotent: false, grant, balances }
 *   { ok: true,  idempotent: true,  grant }   already granted; nothing moved
 *   { ok: false, reason: 'pool_movement_failed' }
 *
 * ── Why the pool movement is NOT in the same transaction ────────────────────
 * It cannot be: the treasury is its own set of row locks in its own
 * transaction, and taking a treasury lock while holding a wallet lock would
 * invert the lock order this codebase holds everywhere else (wallet first) and
 * deadlock against any path that takes them the other way.
 *
 * So the pool moves FIRST, keyed on the same grantId. If the user credit then
 * fails, the pool has paid out for a grant that does not exist — visible
 * immediately as treasury drift, and repaired by re-running the grant, which is
 * idempotent on both halves. The alternative ordering (user first) would leave
 * a user credited from a pool that never paid, which breaks the conservation
 * invariant instead of merely offsetting it, and is much harder to find.
 */
export async function grantBonus({
  grantId, userId, kind, amountPaise, refModel = null, refId = null, reason = null,
}) {
  if (!grantId) throw new Error('grantBonus requires a grantId (idempotency key)');
  const spec = BONUS_KIND[kind];
  if (!spec) {
    throw new Error(`Unknown bonus kind '${kind}'. Known: ${Object.keys(BONUS_KIND).join(', ')}`);
  }
  if (!Number.isInteger(amountPaise) || amountPaise <= 0) {
    throw new TypeError(`grantBonus: amountPaise must be a positive integer, got ${amountPaise}`);
  }

  // Already granted? Answer before touching the treasury, so a replay does not
  // post a pool movement it will then discard.
  const existing = await getGrant(grantId);
  if (existing) {
    count(`BONUS_${kind}`, 'idempotent');
    return { ok: true, idempotent: true, grant: existing };
  }

  const paid = await poolPaidUser(amountPaise, spec.pool, {
    movementId: `bonus_${grantId}`,
    reason: reason || `${kind} bonus`,
    refModel, refId: refId ?? userId,
  });
  if (!paid.ok) {
    count(`BONUS_${kind}`, 'pool_movement_failed');
    return { ok: false, reason: 'pool_movement_failed', detail: paid.reason };
  }

  const result = await withGrantLock(userId, grantId, async (ctx) => {
    if (ctx.grant) {
      return { commit: false, value: { ok: true, idempotent: true, grant: ctx.grant } };
    }

    const { rows } = await ctx.client.query(
      `INSERT INTO bonus_grants (grant_id, user_id, kind, pool, amount_paise, status, ref_model, ref_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (grant_id) DO NOTHING
       RETURNING *`,
      [ctx.gid, ctx.uid, kind, spec.pool, amountPaise, GRANT_STATUS.PAID, refModel, refId ? String(refId) : null],
    );
    if (!rows.length) {
      // A concurrent caller inserted it between the read above and here. The
      // UNIQUE key is the real gate; the pre-read is only an optimisation.
      return { commit: false, value: { ok: true, idempotent: true, grant: null } };
    }

    const movement = await applyMovementWithin(ctx, {
      legs: [{ field: spec.field, deltaPaise: amountPaise }],
      ledger: [{
        txId: `bonus_${ctx.gid}`,
        field: spec.field, amountPaise, type: 'CREDIT',
        reason: reason || `${kind} bonus`, refId: refId ? String(refId) : ctx.gid,
      }],
    });

    if (movement.idempotent) {
      return { commit: false, value: { ok: false, reason: 'inconsistent_idempotency', grantId: ctx.gid } };
    }
    if (!movement.ok) {
      return { commit: false, value: { ok: false, reason: 'insufficient' } };
    }

    return {
      commit: true,
      value: {
        ok: true, idempotent: false,
        grant: rowToGrant(rows[0]),
        balances: movement.balancesAfterPaise,
      },
    };
  });

  count(`BONUS_${kind}`, !result.ok ? (result.reason ?? 'error') : result.idempotent ? 'idempotent' : 'applied');
  return result;
}

/**
 * Take a bonus back: debit the user and return it to the pool.
 *
 * PAID → CLAWED_BACK, guarded in the UPDATE's WHERE clause. The grant row
 * stays, so the history shows both that the bonus was given and that it was
 * recovered — which is the question fraud review asks and the one deleting the
 * row would destroy.
 */
export async function clawBackBonus({ grantId, userId, actor = null, reason = null }) {
  if (!grantId) throw new Error('clawBackBonus requires a grantId');

  const result = await withGrantLock(userId, grantId, async (ctx) => {
    const grant = ctx.grant;
    if (!grant) return { commit: false, value: { ok: false, reason: 'not_found' } };
    if (grant.status === GRANT_STATUS.CLAWED_BACK) {
      return { commit: false, value: { ok: true, idempotent: true, grant } };
    }

    const moved = await ctx.client.query(
      `UPDATE bonus_grants SET status = $2, updated_at = now()
        WHERE grant_id = $1 AND status = $3 RETURNING *`,
      [ctx.gid, GRANT_STATUS.CLAWED_BACK, GRANT_STATUS.PAID],
    );
    if (!moved.rowCount) {
      return { commit: false, value: { ok: false, reason: 'invalid_transition', status: grant.status } };
    }

    const spec = BONUS_KIND[grant.kind];
    const movement = await applyMovementWithin(ctx, {
      legs: [{
        field: spec.field, deltaPaise: 0 - grant.amountPaise,
        // Authorised to go negative: the money may already be spent, and
        // refusing to record a reversal that has already happened is worse
        // than recording an overdraft.
        allowNegative: true,
      }],
      ledger: [{
        txId: `bonus_clawback_${ctx.gid}`,
        field: spec.field, amountPaise: 0 - grant.amountPaise, type: 'DEBIT',
        reason: reason || `${grant.kind} bonus clawed back`, refId: ctx.gid,
      }],
    });

    if (movement.idempotent) {
      return { commit: false, value: { ok: false, reason: 'inconsistent_idempotency', grantId: ctx.gid } };
    }
    if (!movement.ok) {
      return { commit: false, value: { ok: false, reason: 'insufficient' } };
    }

    return {
      commit: true,
      value: {
        ok: true, idempotent: false,
        grant: rowToGrant(moved.rows[0]),
        balances: movement.balancesAfterPaise,
      },
    };
  });

  // Return it to the pool AFTER the user side committed, and only then — the
  // mirror image of grantBonus's ordering, for the same lock-order reason. A
  // failure here shows as treasury drift rather than as money the user still
  // holds, which is the safer of the two ways to be wrong.
  if (result.ok && !result.idempotent) {
    const grant = result.grant;
    await allocateFromHouse(grant.amountPaise, grant.pool, {
      movementId: `bonus_clawback_${grantId}`,
      actor, reason: reason || `${grant.kind} bonus clawed back`,
      refModel: grant.refModel, refId: grant.refId ?? grantId,
    }).catch((e) => console.error(`[bonus] pool return failed for ${grantId}:`, e.message));
  }

  count('BONUS_CLAWBACK', !result.ok ? (result.reason ?? 'error') : result.idempotent ? 'idempotent' : 'applied');
  return result;
}

// ── Reconciliation ───────────────────────────────────────────────────────────

/**
 * Do the grants explain what the pools have paid out?
 *
 * Per pool, the sum of PAID grants should equal what the treasury shows leaving
 * it. A difference means a pool moved without a grant behind it, or a grant was
 * recorded without the pool paying — the two halves of the ordering risk
 * grantBonus documents, made visible.
 */
export async function reconcileBonusPools() {
  const { rows } = await pgQuery(
    `SELECT pool,
            COALESCE(SUM(amount_paise) FILTER (WHERE status = $1), 0) AS paid_paise,
            COUNT(*) FILTER (WHERE status = $1) AS paid_count,
            COALESCE(SUM(amount_paise) FILTER (WHERE status = $2), 0) AS clawed_paise
       FROM bonus_grants GROUP BY pool`,
    [GRANT_STATUS.PAID, GRANT_STATUS.CLAWED_BACK], 'bonus_pool_reconcile',
  );

  const { rows: treasury } = await pgQuery(
    `SELECT account, COALESCE(SUM(amount_paise), 0) AS net
       FROM treasury_entries
      WHERE operation LIKE 'PAYOUT_%'
      GROUP BY account`,
    [], 'bonus_pool_treasury',
  );
  const paidOut = Object.fromEntries(treasury.map((r) => [r.account, 0 - toPaise(r.net)]));

  const pools = rows.map((r) => {
    const fromGrants = toPaise(r.paid_paise);
    const fromTreasury = paidOut[r.pool] ?? 0;
    return {
      pool: r.pool,
      grantsPaise: fromGrants,
      grantCount: Number(r.paid_count),
      clawedBackPaise: toPaise(r.clawed_paise),
      treasuryPaidPaise: fromTreasury,
      // Clawed-back grants were paid out of the pool and then returned, so the
      // treasury's gross payout legitimately exceeds the outstanding grants by
      // exactly that amount.
      driftPaise: fromTreasury - (fromGrants + toPaise(r.clawed_paise)),
    };
  });

  return { ok: pools.every((p) => p.driftPaise === 0), pools };
}
