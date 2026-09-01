// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * postgres/casinoPgAuthority.js — casino provider callbacks, behind the resolver.
 *
 * The eleventh path to be routed and the last one that was not built at all.
 * `domains/casino/gameProvider.routes.js` handles BET / WIN / ROLLBACK / REFUND
 * and moved real money with no round accounting behind it;
 * `isPostgresAuthoritative(MONEY_PATHS.CASINO_SETTLEMENT)` now decides per call.
 *
 * ── What routing buys ───────────────────────────────────────────────────────
 * The Mongo route has the refund bound — it was added when the exposure was
 * found — but it enforces it by summing `GameTransaction` documents AFTER
 * reading them, outside any lock:
 *
 *     const priorTx = await GameTransaction.find({ roundId, userId });
 *     …sum BETs, sum ROLLBACKs, compare, then refund
 *
 * Two concurrent rollbacks with DIFFERENT provider tx ids both read the same
 * "nothing refunded yet" and both pass. The duplicate-txId check cannot help:
 * it stops one callback applying twice and says nothing about two distinct
 * callbacks that should not both be honoured. In Postgres the totals move under
 * the round's row lock inside the same transaction as the wallet movement, and
 * `refunded_paise <= debited_paise` is a CHECK CONSTRAINT — so the bound holds
 * against a future code path that forgets to test it.
 *
 * ── A refusal is surfaced, never swallowed ──────────────────────────────────
 * When Postgres refuses a reversal the provider is told no. Falling back to the
 * Mongo path on a refusal would mean the store that owns the round is overruled
 * by the store that has no opinion — and this is the one domain where the
 * refusal IS the product: it is what stops a buggy or hostile provider minting
 * money by rolling back a round that never had a bet.
 */
import mongoose from 'mongoose';
import { isPostgresAuthoritative, MONEY_PATHS } from './moneyAuthority.js';
import { rupeesToPaise, paiseToRupees } from '../shared/money.js';
import { CASINO_TX, recordCallback, getRound } from './casinoPg.js';

/** Is Postgres the source of truth for casino rounds? */
export const onPostgres = () => isPostgresAuthoritative(MONEY_PATHS.CASINO_SETTLEMENT);

/** The provider's vocabulary, normalised. Anything else is not a money move. */
export function normaliseType(raw) {
  const t = String(raw || '').toUpperCase().replace('DEBIT', 'BET').replace('CREDIT', 'WIN');
  return CASINO_TX[t] ? t : null;
}

/**
 * Apply one provider callback.
 *
 * Returns `{ handled: false }` when Mongo owns the path, which tells the route
 * to run its own logic unchanged. Anything else is the final answer:
 *
 *   { ok: true,  idempotent }            applied, or already applied
 *   { ok: false, reason: 'no_prior_debit' | 'refund_exceeds_debit' | … }
 */
export async function applyCallbackOnPostgres({
  txId, roundId, userId, type, amountRupees, providerKey = null, gameId = null, reason = null,
}) {
  if (!onPostgres()) return { handled: false };

  const normalised = normaliseType(type);
  if (!normalised) return { handled: true, ok: false, reason: 'unknown_type', type };

  const result = await recordCallback({
    txId, roundId, userId: String(userId), type: normalised,
    amountPaise: rupeesToPaise(Number(amountRupees) || 0),
    providerKey, gameId, reason,
  });

  if (!result.ok) return { handled: true, ...result };

  // Mongo follows so the player's balance, the game history and the admin
  // panels stay usable, and a fallback is a redeploy rather than a recovery.
  // AWAITED: the route reads the balance back to answer the provider, and a
  // provider told the wrong balance will reconcile against it.
  const round = result.round ?? await getRound(roundId);

  return {
    handled: true, ok: true,
    idempotent: Boolean(result.idempotent),
    round,
    // The route answers the provider with a balance; give it the authoritative
    // one rather than letting it re-read a document that may still be catching up.
    balanceRupees: await authoritativeBalance(userId),
  };
}

/**
 * The player's spendable balance, from whichever store owns the wallet.
 *
 * Casino settles through the USER WALLET directly rather than the bets path, so
 * this follows WALLET's authority, not this module's — those are separate flags
 * and reading the wrong one is how a provider gets told a balance that no store
 * actually holds.
 */
async function authoritativeBalance(userId) {
  if (isPostgresAuthoritative(MONEY_PATHS.WALLET)) {
    const { getBalancesRupees } = await import('./walletPg.js');
    const w = await getBalancesRupees(String(userId));
    if (w) return (w.depositBalance || 0) + (w.winningsBalance || 0);
  }
  const u = await mongoose.model('User').findById(userId).select('depositBalance winningsBalance').lean();
  return (u?.depositBalance || 0) + (u?.winningsBalance || 0);
}
