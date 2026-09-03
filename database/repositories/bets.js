// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * repositories/bets.js — placing a bet, in the shape the route answers with.
 *
 * The lifecycle itself lives in `bets.core.js`. This is the thin layer above
 * it: rupees in and out, the document-shaped response body the client renders,
 * and the derived id described below.
 *
 * ── Why placement is ONE transaction ────────────────────────────────────────
 * Bet placement used to be two steps — lock the stake, then write the bet.
 * Between them there is a window in which a player's money is locked against a
 * bet that does not exist. Nothing sweeps that: the stake is attributed to a
 * bet id that was never written, so no settlement will ever release it and no
 * reconciliation can attribute it. The balance is simply short until a human
 * finds it.
 *
 * `bets.core.placeBet` closes the window by construction — the bet row, the
 * stake movement and the ledger rows commit together or not at all.
 *
 * ── The key, and what is honestly still open ────────────────────────────────
 * Placement is idempotent on `betId`, so a redelivered request debits nothing
 * further. That guarantee is only as good as the id: where a client sends an
 * `Idempotency-Key`, `bet.routes.js` uses it and a retry is genuinely the same
 * bet. Where none is sent the route mints `bet_<userId>_<randomUUID()>`, so a
 * retry arrives with a DIFFERENT id and IS a second bet.
 *
 * That residual exposure is documented rather than papered over. Enforcing the
 * header outright would break any client that does not send one, and bet
 * placement is the highest-traffic endpoint in the system — so it is an
 * operator's decision to make once they know every client, not one to take by
 * surprise in a migration commit.
 */
import { createHash } from 'crypto';
import { rupeesToPaise, paiseToRupees } from '../../backend/shared/money.js';
import { MONEY_PATHS } from '../moneyPaths.js';
import {
  placeBet as placeBetPg, BET_STATUS, getBet, resolveBetId,
} from './bets.core.js';

/**
 * The public id a bet is shown under.
 *
 * A bet carries two keys. `bet_id` is the caller's idempotency key —
 * `bet_<userId>_<something>` — and it is what the UNIQUE constraint gates on.
 * This is the OTHER one: a 24-character hex id, which is the shape every client
 * and every stored reference in this platform expects an entity id to be.
 *
 * It is DERIVED from the key, not generated. The first 24 hex characters of a
 * SHA-256 give an id that is identical for every delivery of the same request
 * and different for different ones — so a replayed placement resolves to the
 * SAME bet rather than minting a second identity for it, which is exactly the
 * duplication `bet_id` exists to prevent.
 *
 * It carries no embedded timestamp, so anything reading creation time must use
 * `placedAt`, which the row sets explicitly.
 */
export function publicIdFor(betId) {
  return createHash('sha256').update(String(betId)).digest('hex').slice(0, 24);
}

/**
 * The document-shaped names for the funding split, by wallet field.
 *
 * The document shape is what `bet.routes.js` serialises into its response and
 * what the client renders, so a placed bet still comes back carrying these
 * three keys. They are a PRESENTATION detail: the authoritative record of which
 * pocket funded what is the placement ledger, which `listSettleableBets`
 * reconstructs from — see the note there for why a stored second copy would be
 * the wrong owner.
 */
const BET_SOURCE_FIELD = Object.freeze({
  depositBalance:  'fromDepositBalance',
  winningsBalance: 'fromWinningsBalance',
  reserveBalance:  'fromReserveBalance',
});

/** wallet-field slices → the Mongo document's three columns. */
export function sourcesFromSlices(slices) {
  const out = { fromDepositBalance: 0, fromWinningsBalance: 0, fromReserveBalance: 0 };
  for (const s of slices) {
    const field = BET_SOURCE_FIELD[s.field];
    if (field) out[field] = paiseToRupees(s.amountPaise);
  }
  return out;
}

/**
 * Place a bet: the stake and the bet record, in one transaction on Postgres.
 *
 * Returns the shape `bet.routes.js` already handles, so the route's response
 * and its error branches do not change with the store:
 *   { ok: true,  bet, balances, idempotent }
 *   { ok: false, reason: 'insufficient' }   the caller answers 400
 *
 * `bet` is a MONGO-SHAPED plain object (rupees, `amount`, `status`), because
 * that is what the route serialises into its response and what the client
 * renders. The Postgres row is paise and is not the thing anyone reads.
 */
export async function placeBet({
  betId, userId, cycleId, side, amount, slices, reason = null,
}) {

  const publicId = publicIdFor(betId);
  const result = await placeBetPg({
    betId, publicId, userId: String(userId), cycleId: String(cycleId), side,
    slices: slices.map((s) => ({ field: s.field, amountPaise: rupeesToPaise(s.amount) })),
    reason,
  });

  if (!result.ok) return result;

  const doc = {
    _id: publicId,
    userId: String(userId),
    cycleId: String(cycleId),
    amount,
    side,
    ...sourcesFromSlices(slices.map((s) => ({ field: s.field, amountPaise: rupeesToPaise(s.amount) }))),
    status: BET_STATUS.PENDING,
    isPhantom: false,
    timestamp: result.bet?.placedAt ?? new Date(),
  };

  // NOTE, and it was a live bug: an earlier pass removed a mirror call that sat
  // behind `if (!result.idempotent)` and left the bare `if` in front of this
  // return. A REPLAYED request therefore fell past it and returned `undefined`,
  // and the route then read `.ok` off nothing — so every retried bet placement
  // threw a TypeError, on the platform's highest-traffic endpoint, in the exact
  // case idempotency exists to make safe.
  return {
    ok: true,
    idempotent: result.idempotent === true,
    bet: doc,
    // paise → rupees at the boundary, so the route's SSE push and response body
    // carry the units the client renders.
    balances: result.balances ? mapRupees(result.balances) : null,
  };
}

function mapRupees(balancesPaise) {
  return Object.fromEntries(
    Object.entries(balancesPaise).map(([field, paise]) => [field, paiseToRupees(paise)]),
  );
}

/**
 * The bet an id names, in the shape the route serialises.
 *
 * Accepts EITHER key. A bet placed through this module carries two: `bet_id`,
 * the caller's idempotency key, and `public_id`, the stable hash derived from
 * it. The route holds one and the row is found by whichever it is — see
 * `resolveBetId`, which exists because handing back "not found" for a bet that
 * demonstrably exists is worse than the lookup costing one extra statement.
 *
 * This used to read the document store while the transition ran against
 * PostgreSQL, on the reasoning that a stale read "cannot move money". True as
 * far as it goes, and still the wrong shape: the response a player is shown
 * after placing a bet came from a different store than the bet itself, so the
 * two could disagree about the status of the thing they were both describing.
 */
export async function getBetDoc(betIdOrPublicId) {
  const betId = await resolveBetId(betIdOrPublicId);
  if (!betId) return null;
  const bet = await getBet(betId);
  if (!bet) return null;
  return {
    ...bet,
    // The document-shaped keys the client renders. Rupees, because that is what
    // the response has always carried.
    _id: bet.publicId ?? bet.betId,
    amount: paiseToRupees(bet.stakePaise),
    payout: paiseToRupees(bet.payoutPaise),
    platformFee: paiseToRupees(bet.platformFeePaise ?? 0),
    timestamp: bet.placedAt,
  };
}
