// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file.
/**
 * repositories/casino.js — the vocabulary layer over the casino round machinery.
 *
 * `casino.core.js` holds the mechanism: the round lock, the reversal bound, the
 * idempotency gate and the wallet movement, all in one transaction. This file
 * is the shape the provider webhook calls it in — it normalises the supplier's
 * word for a money move and answers with the balance to send back.
 *
 * ── The refusal IS the product ──────────────────────────────────────────────
 * A reversal must prove the debit it reverses. A provider that is buggy,
 * replayed, or hostile can otherwise CREDIT REAL MONEY by rolling back a round
 * that never had a bet, or by rolling back more than was staked — and the
 * duplicate-txId gate does not help, because it stops the SAME callback
 * applying twice and says nothing about a DIFFERENT callback that should never
 * have been honoured.
 *
 * Two concurrent rollbacks carrying different provider ids are the case that
 * makes summing-then-comparing wrong: both reads see "nothing refunded yet" and
 * both pass. The totals therefore move under the round's row lock inside the
 * same transaction as the wallet movement, and `refunded_paise <= debited_paise`
 * is a CHECK CONSTRAINT — so the bound holds against a future code path that
 * forgets to test it.
 *
 * A refusal is returned to the caller to be surfaced to the provider. There is
 * nowhere for it to fall back to, and there should not be.
 */
import { rupeesToPaise } from '../../backend/shared/money.js';
import { CASINO_TX, recordCallback, getRound } from './casino.core.js';
import { getBalancesRupees } from './wallets.core.js';

/** The provider's vocabulary, normalised. Anything else is not a money move. */
export function normaliseType(raw) {
  const t = String(raw || '').toUpperCase().replace('DEBIT', 'BET').replace('CREDIT', 'WIN');
  return CASINO_TX[t] ? t : null;
}

/** What the provider is told, and what the audit row records. */
export async function spendableBalance(userId) {
  const w = await getBalancesRupees(String(userId));
  return (w?.depositBalance || 0) + (w?.winningsBalance || 0);
}

/**
 * Apply one provider callback. This is the whole decision.
 *
 *   { ok: true,  idempotent, round, balanceRupees }
 *   { ok: false, reason: 'unknown_type' | 'no_prior_debit' | 'refund_exceeds_debit'
 *                      | 'insufficient' | 'inconsistent_idempotency' }
 *
 * An amount that is not a positive number is refused here rather than reaching
 * the mechanism: `rupeesToPaise` on junk yields NaN, and NaN paise passed to a
 * `BIGINT` column is a 500 to a provider that will retry it forever.
 */
export async function applyProviderCallback({
  txId, roundId, userId, type, amountRupees, providerKey = null, gameId = null, reason = null,
}) {
  const normalised = normaliseType(type);
  if (!normalised) return { ok: false, reason: 'unknown_type', type };

  const amountPaise = rupeesToPaise(Number(amountRupees) || 0);
  if (!Number.isInteger(amountPaise) || amountPaise <= 0) {
    return { ok: false, reason: 'invalid_amount', amountRupees };
  }

  const result = await recordCallback({
    txId, roundId, userId: String(userId), type: normalised,
    amountPaise, providerKey, gameId, reason,
  });

  if (!result.ok) return result;

  return {
    ok: true,
    idempotent: Boolean(result.idempotent),
    round: result.round ?? await getRound(roundId),
    // Read AFTER the movement committed and its client was released — the
    // provider reconciles against this figure, so it must be the balance the
    // wallet actually holds rather than the one this function expected.
    balanceRupees: await spendableBalance(userId),
  };
}
