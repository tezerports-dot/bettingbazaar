// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * repositories/promo.js — the GENERAL (promotional) balance, its turnover
 * requirements, and which profile a player is using (owner, 2026-10-08).
 *
 * The one writer of `wallets.promo_paise` credits and unlocks, `promo_grants`,
 * `promo_turnover` and `users.play_profile` (schema.sql, "THE GENERAL
 * (PROMOTIONAL) BALANCE").
 *
 *   Referral → bonus into GENERAL → 10× its amount in turnover required →
 *   play (wins stay in GENERAL and can be bet again) → requirement met →
 *   the bonus unlocks into withdrawable winnings → once nothing is
 *   outstanding, the promotional winnings unlock too.
 *
 * Every step runs under the player's wallet row lock, so turnover, grants and
 * the balance move together or not at all, and two stakes counted at once are
 * applied one after the other (§32 S6).
 */
import { pgQuery } from '../client.js';
import { withWalletLock, applyMovementWithin } from './wallets.core.js';
import { ACCOUNTS } from './treasury.js';

/** Turnover each promotional rupee asks for (owner, 2026-10-08: "Referral Bonus × 10"). */
export const PROMO_TURNOVER_MULTIPLIER = 10;

/** The two profiles; `users_play_profile_known` holds the same list. */
export const PLAY_PROFILES = Object.freeze(['VIP', 'GENERAL']);

const n = (v) => Number(v ?? 0);

/**
 * Pay a referral reward into the GENERAL balance and open its requirement, in
 * one transaction. Keyed by the earning: a replay moves nothing and opens
 * nothing (`promo_grants_once` and the ledger key agree).
 *
 * The tokens come out of the platform's holding (TOKEN_SUPPLY → USER_FLOAT),
 * exactly as the reward did when it was paid into winnings.
 */
export async function creditReferralBonus({ userId, amountPaise, earningId, reason = 'Referral bonus' }) {
  if (!Number.isInteger(amountPaise) || amountPaise <= 0) {
    throw Object.assign(new Error(`Invalid referral bonus: ${amountPaise}`), { status: 400 });
  }
  const txId = `ref_${earningId}`;
  return withWalletLock(userId, async (ctx) => {
    const moved = await applyMovementWithin(ctx, {
      legs: [{ field: 'promoBalance', deltaPaise: amountPaise }],
      ledger: [{ txId, field: 'promoBalance', amountPaise, type: 'CREDIT', reason, refId: earningId }],
      counterparty: {
        account: ACCOUNTS.TOKEN_SUPPLY, operation: 'PROMO_CREDITED',
        reason, refModel: 'ReferralEarning', refId: String(earningId),
      },
    });
    if (moved.idempotent) return { commit: false, value: { ok: true, idempotent: true, txId } };
    if (!moved.ok) return { commit: false, value: { ok: false, refused: moved.refused ?? 'refused', txId } };
    await ctx.client.query(
      `INSERT INTO promo_grants
         (grant_id, user_id, source, source_ref, amount_paise, required_turnover_paise)
       VALUES ($1, $2, 'REFERRAL', $3, $4, $5)`,
      [`ref_${earningId}`, ctx.uid, String(earningId), amountPaise, amountPaise * PROMO_TURNOVER_MULTIPLIER],
    );
    return { commit: true, value: { ok: true, idempotent: false, txId } };
  });
}

/**
 * Move `amountPaise` of the GENERAL balance into winnings, keyed `txId`.
 * Pocket to pocket: what the wallet holds is unchanged, so no counterparty.
 */
async function unlockWithin(ctx, amountPaise, txId, reason) {
  if (amountPaise <= 0) return 0;
  const moved = await applyMovementWithin(ctx, {
    legs: [
      { field: 'promoBalance', deltaPaise: -amountPaise },
      { field: 'winningsBalance', deltaPaise: amountPaise },
    ],
    ledger: [
      { txId: `${txId}_out`, field: 'promoBalance', amountPaise: -amountPaise, type: 'DEBIT', reason },
      { txId: `${txId}_in`, field: 'winningsBalance', amountPaise, type: 'CREDIT', reason },
    ],
  });
  if (!moved.ok) throw new Error(`promo unlock refused: ${moved.refused ?? 'insufficient'}`);
  return moved.idempotent ? 0 : amountPaise;
}

/**
 * Count one stake made with GENERAL money towards the player's requirements.
 *
 * `stakeRef` names the stake (a bet id); it is counted once, whatever retries.
 * The amount is applied to open grants oldest first. A grant it completes
 * unlocks up to its own amount from what the GENERAL balance holds; when no
 * grant is left open, the rest of the balance unlocks as well.
 *
 * @returns {{ counted: boolean, appliedPaise: number, unlockedPaise: number,
 *             completedGrants: string[] }}
 */
export async function recordTurnover({ userId, stakeRef, amountPaise }) {
  return withWalletLock(userId, async (ctx) => {
    const value = await recordTurnoverWithin(ctx, { stakeRef, amountPaise });
    return { commit: value.counted, value };
  });
}

/**
 * The same, inside a transaction that already holds the player's wallet row
 * lock (`ctx.client`, `ctx.uid`): a GENERAL bet's settlement counts its stake
 * here, so the settlement and the count commit together (bets.core.js).
 */
export async function recordTurnoverWithin(ctx, { stakeRef, amountPaise }) {
  if (!Number.isInteger(amountPaise) || amountPaise <= 0) {
    throw Object.assign(new Error(`Invalid turnover: ${amountPaise}`), { status: 400 });
  }
  const { client, uid } = ctx;
  const claimed = await client.query(
    `INSERT INTO promo_turnover (stake_ref, user_id, amount_paise, applied_paise)
     VALUES ($1, $2, $3, 0) ON CONFLICT (stake_ref) DO NOTHING RETURNING stake_ref`,
    [String(stakeRef), uid, amountPaise],
  );
  if (!claimed.rows.length) {
    return { counted: false, appliedPaise: 0, unlockedPaise: 0, completedGrants: [] };
  }

  const { rows: open } = await client.query(
    `SELECT grant_id, amount_paise, required_turnover_paise, turnover_paise
       FROM promo_grants WHERE user_id = $1 AND completed_at IS NULL
      ORDER BY created_at, grant_id FOR UPDATE`,
    [uid],
  );
  // What the GENERAL balance holds now, read under the lock this transaction
  // holds: the caller may already have moved it (a payout just credited).
  const { rows: [w] } = await client.query('SELECT promo_paise FROM wallets WHERE user_id = $1', [uid]);
  let promoHeld = n(w?.promo_paise);
  let left = amountPaise;
  let applied = 0;
  let unlocked = 0;
  const completedGrants = [];
  for (const g of open) {
    if (left === 0) break;
    const take = Math.min(left, n(g.required_turnover_paise) - n(g.turnover_paise));
    left -= take;
    applied += take;
    const done = n(g.turnover_paise) + take === n(g.required_turnover_paise);
    const release = done ? Math.min(n(g.amount_paise), promoHeld) : 0;
    await client.query(
      `UPDATE promo_grants
          SET turnover_paise = turnover_paise + $2,
              completed_at = CASE WHEN turnover_paise + $2 = required_turnover_paise THEN now() END,
              unlocked_paise = unlocked_paise + $3
        WHERE grant_id = $1 AND completed_at IS NULL`,
      [g.grant_id, take, release],
    );
    if (done) {
      completedGrants.push(g.grant_id);
      unlocked += await unlockWithin(ctx, release, `promo_unlock_${g.grant_id}`, 'Referral bonus unlocked');
      promoHeld -= release;
    }
  }
  await client.query(
    'UPDATE promo_turnover SET applied_paise = $2 WHERE stake_ref = $1',
    [String(stakeRef), applied],
  );

  unlocked += await unlockIfNothingOutstandingWithin(ctx, `promo_unlock_rest_${stakeRef}`);
  return { counted: true, appliedPaise: applied, unlockedPaise: unlocked, completedGrants };
}

/**
 * With no requirement open, nothing in the GENERAL balance is promotional any
 * more: it all unlocks into winnings, keyed `txId`. Called after every count
 * and every returned GENERAL stake, so money that lands in GENERAL after the
 * last requirement was met (a later win, a refunded stake) is never stranded.
 *
 * @returns {Promise<number>} paise unlocked
 */
export async function unlockIfNothingOutstandingWithin(ctx, txId) {
  const { client, uid } = ctx;
  const { rows: [state] } = await client.query(
    `SELECT w.promo_paise,
            EXISTS (SELECT 1 FROM promo_grants g WHERE g.user_id = w.user_id AND g.completed_at IS NULL) AS open
       FROM wallets w WHERE w.user_id = $1`,
    [uid],
  );
  if (!state || state.open || n(state.promo_paise) === 0) return 0;
  return unlockWithin(ctx, n(state.promo_paise), txId, 'Promotional winnings unlocked');
}

/** The profile a player is using (schema default: 'VIP'). */
export async function playProfileOf(userId) {
  const { rows } = await pgQuery(
    `SELECT play_profile FROM users WHERE user_id = $1`, [String(userId)], 'promo_profile_of',
  );
  return rows[0]?.play_profile ?? 'VIP';
}

/** Switch the profile a player is using. */
export async function setPlayProfile(userId, profile) {
  if (!PLAY_PROFILES.includes(profile)) {
    throw Object.assign(new Error(`Unknown profile '${profile}'. Known: ${PLAY_PROFILES.join(', ')}`), { status: 400 });
  }
  const { rows } = await pgQuery(
    `UPDATE users SET play_profile = $2 WHERE user_id = $1 AND account_type = 'PLAYER' RETURNING play_profile`,
    [String(userId), profile], 'promo_set_profile',
  );
  return rows[0] ? { ok: true, profile: rows[0].play_profile } : { ok: false };
}

/**
 * What the player's GENERAL profile shows: the profile in use, the balance,
 * and every grant with its progress (newest first).
 */
export async function promoSummary(userId) {
  const uid = String(userId);
  const [{ rows: [user] }, { rows: [wallet] }, { rows: [open] }, { rows: grants }] = await Promise.all([
    pgQuery('SELECT play_profile FROM users WHERE user_id = $1', [uid], 'promo_summary_profile'),
    pgQuery('SELECT promo_paise FROM wallets WHERE user_id = $1', [uid], 'promo_summary_balance'),
    pgQuery(
      `SELECT COALESCE(SUM(required_turnover_paise - turnover_paise), 0) AS outstanding
         FROM promo_grants WHERE user_id = $1 AND completed_at IS NULL`,
      [uid], 'promo_summary_outstanding',
    ),
    pgQuery(
      `SELECT grant_id, source, amount_paise, required_turnover_paise, turnover_paise,
              completed_at, unlocked_paise, created_at
         FROM promo_grants WHERE user_id = $1 ORDER BY created_at DESC, grant_id DESC LIMIT 200`,
      [uid], 'promo_summary_grants',
    ),
  ]);
  const shaped = grants.map((g) => ({
    grantId: g.grant_id,
    source: g.source,
    amountPaise: n(g.amount_paise),
    requiredTurnoverPaise: n(g.required_turnover_paise),
    turnoverPaise: n(g.turnover_paise),
    completedAt: g.completed_at,
    unlockedPaise: n(g.unlocked_paise),
    createdAt: g.created_at,
  }));
  return {
    profile: user?.play_profile ?? 'VIP', // schema default: 'VIP'
    promoBalancePaise: n(wallet?.promo_paise),
    outstandingTurnoverPaise: n(open?.outstanding),
    turnoverMultiplier: PROMO_TURNOVER_MULTIPLIER,
    grants: shaped,
  };
}
