// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * postgres/betPgAuthority.js — bet placement, behind the resolver.
 *
 * `bet.routes.js` places a bet in TWO steps today: `lockBetStake` moves the
 * stake, then `Bet.create` writes the document. This module is the other
 * implementation, where those are ONE transaction (betPg.placeBet), and which
 * one runs is decided per call by `isPostgresAuthoritative(MONEY_PATHS.BETS)`.
 *
 * ── Why the two-step version is not merely untidy ───────────────────────────
 * Between the stake lock and the bet insert there is a window in which the
 * user's money is locked against a bet that does not exist. Nothing sweeps
 * that: the stake is attributed to a bet id that was never written, so no
 * settlement will ever release it and no reconciliation can attribute it. The
 * user's balance is simply short until a human finds it.
 *
 * The Postgres path closes the window by construction — the bet row, the stake
 * movement and the ledger rows commit together or not at all.
 *
 * ── The key, and what is honestly still open ────────────────────────────────
 * `betPg.placeBet` is idempotent on `betId`, so a redelivered request debits
 * nothing further. That guarantee is only as good as the id: the route
 * currently mints `bet_<userId>_<randomUUID()>` per request, so a retry
 * arrives with a DIFFERENT id and is a genuinely new bet.
 *
 * So this module takes the id from the caller, and `bet.routes.js` prefers a
 * client-supplied `Idempotency-Key`. Where no client sends one, the random
 * fallback remains and a retry is still a second bet.
 *
 * That fallback is NOT the same mistake as the one removed from
 * `/merchants/:id/fund`. There, a generated key sat behind a UNIQUE constraint
 * and made the code look guarded while the gate could never fire. Here the
 * generated id is genuinely new, the gate genuinely fires for the id it is
 * given, and the residual exposure is the documented one: two deliveries are
 * two bets. Enforcing the header outright would break any client that does not
 * send it, and bet placement is the highest-traffic endpoint in the system — so
 * that is an operator's decision to make once they know every client, not one
 * to take by surprise in a migration commit.
 */
import { createHash } from 'crypto';
import mongoose from 'mongoose';
import { rupeesToPaise, paiseToRupees } from '../shared/money.js';
import { isPostgresAuthoritative, MONEY_PATHS } from './moneyAuthority.js';
import {
  placeBet as placeBetPg, BET_STATUS, winBet, loseBet, voidBet, refundBet,
} from './betPg.js';
import { reverseMirrorBet, reverseMirrorBetRow } from './reverseMirror.js';

/** Is Postgres the source of truth for the bet lifecycle? */
export const onPostgres = () => isPostgresAuthoritative(MONEY_PATHS.BETS);

/**
 * A stable Mongo ObjectId for an idempotency key.
 *
 * Mongo types `Bet._id` as an ObjectId, so it cannot hold `bet_<userId>_<key>`
 * directly — assigning one is a CastError. Generating a fresh ObjectId per
 * attempt would be worse than that error: a replayed request would find the
 * Postgres bet already there (correct) and create a SECOND Mongo document
 * behind it (not), which is exactly the duplication `bet_id` exists to prevent.
 *
 * So it is DERIVED. The first 24 hex characters of a SHA-256 of the key give a
 * valid ObjectId that is identical for every delivery of the same request, and
 * different for different ones. It is an identifier, not a secret — nothing
 * depends on it being unpredictable, only on it being stable.
 *
 * The ObjectId's usual embedded timestamp is meaningless here, so anything
 * reading creation time must use `timestamp`, which is set explicitly.
 */
export function mongoIdFor(betId) {
  return createHash('sha256').update(String(betId)).digest('hex').slice(0, 24);
}

/**
 * The Mongo `Bet` fields that carry the funding split, by wallet field.
 *
 * A refund has to return the stake to the pockets it came from, so both stores
 * must agree on which pocket funded what. Mapping this in one place means the
 * mirror and the settlement path cannot drift into two different ideas of it.
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

/** The Mongo document's columns → wallet-field slices, for settling. */
export function slicesFromBet(bet) {
  return Object.entries(BET_SOURCE_FIELD)
    .map(([walletField, betField]) => ({
      field: walletField,
      amountPaise: rupeesToPaise(Number(bet?.[betField]) || 0),
    }))
    .filter((s) => s.amountPaise > 0);
}

/**
 * Settle ONE bet, with Postgres deciding when it owns the path.
 *
 * The other half of the domain. Placement has routed through `placeBet` for a
 * while; settlement still wrote `Bet.status` directly in two places, which left
 * half the lifecycle authoritative in one store and half in the other — the
 * split docs/ORDERS_ROUTING_DESIGN.md exists to prevent.
 *
 * ── Why per bet is not a regression ─────────────────────────────────────────
 * The Mongo path ALREADY settles per bet: gameEngine loops
 * `await unlockLostBet(...)` over the losing side, and settlementService loops
 * `creditWinnings` + `releaseLockedStake` per winner. The bulk `updateMany` /
 * `bulkWrite` that follows is only the status stamp on top of work that is
 * already N-at-a-time.
 *
 * So routing replaces *N wallet operations plus a bulk stamp* with *N
 * transactions that do both atomically*. Same order of work, and the state and
 * the money now commit together instead of the status being stamped after the
 * money moved. docs/BETS_SETTLEMENT_ROUTING.md carries the correction — an
 * earlier draft of this reasoning had it wrong.
 *
 * ── The funding slices are required, not defaulted ──────────────────────────
 * `betPg.settle` refuses to settle without them, and this passes them through
 * rather than inventing a default. Returning a deposit-funded stake into
 * `winningsBalance` would silently convert non-withdrawable money into
 * withdrawable, which is a cash-out route rather than a rounding error. A bet
 * whose slices do not add up is REFUSED and reported, so the settlement pass
 * leaves it for a human instead of guessing.
 */
export async function settleBetOnPostgres({ bet, outcome, payoutRupees = 0, reason = null }) {
  if (!onPostgres()) return { handled: false };

  const spec = { WON: winBet, LOST: loseBet, VOID: voidBet, REFUNDED: refundBet }[outcome];
  if (!spec) return { handled: true, ok: false, reason: 'unknown_outcome', outcome };

  const betId = String(bet._id ?? bet.betId);
  const slices = slicesFromBet(bet);
  // Legacy bets carry 0/0/0 provenance, from before the split was recorded.
  // Refusing is deliberate: `settle` would throw on the mismatch anyway, and a
  // caller that silently skipped would report a clean settlement pass over bets
  // whose stakes are still locked.
  if (!slices.length) {
    return { handled: true, ok: false, reason: 'no_funding_slices', betId };
  }

  const result = await spec({
    betId,
    userId: String(bet.userId),
    slices,
    payoutPaise: rupeesToPaise(Number(payoutRupees) || 0),
    actor: 'settlement',
    reason,
  });

  if (!result.ok) return { handled: true, ...result, betId };

  // Mongo follows. AWAITED — the settlement pass reads bet status back to decide
  // what still needs paying, and the recovery task sweeps on it.
  if (!result.idempotent && result.bet) {
    await reverseMirrorBetRow({
      bet_id: betId, mongo_id: betId,
      user_id: String(bet.userId), cycle_id: bet.cycleId, side: bet.side,
      stake_paise: rupeesToPaise(Number(bet.amount) || 0),
      payout_paise: rupeesToPaise(Number(payoutRupees) || 0),
      status: result.bet.status,
      settled_at: result.bet.settledAt ?? new Date(),
      placed_at: bet.timestamp,
    });
  }

  return { handled: true, ok: true, idempotent: Boolean(result.idempotent), betId };
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
  if (!onPostgres()) throw new Error('placeBet: called while MongoDB is authoritative for bets');

  const mongoId = mongoIdFor(betId);
  const result = await placeBetPg({
    betId, mongoId, userId: String(userId), cycleId: String(cycleId), side,
    slices: slices.map((s) => ({ field: s.field, amountPaise: rupeesToPaise(s.amount) })),
    reason,
  });

  if (!result.ok) return result;

  const doc = {
    _id: mongoId,
    userId: String(userId),
    cycleId: String(cycleId),
    amount,
    side,
    ...sourcesFromSlices(slices.map((s) => ({ field: s.field, amountPaise: rupeesToPaise(s.amount) }))),
    status: BET_STATUS.PENDING,
    isPhantom: false,
    timestamp: result.bet?.placedAt ?? new Date(),
  };

  // Mirror AFTER the commit. Awaited so the bet is readable in Mongo by the
  // time the route answers — every read path (history, settlement sweep,
  // analytics) still queries Mongo, and returning a bet the client cannot then
  // fetch would be a visible regression rather than an internal one.
  //
  // Cannot throw: mirrorBack() logs, counts and pages internally. Postgres has
  // already committed and owns the decision either way.
  if (!result.idempotent) await reverseMirrorBet(doc);

  return {
    ok: true,
    idempotent: result.idempotent === true,
    bet: doc,
    // paise → rupees at the boundary, matching what lockBetStake returns on the
    // Mongo path so the route's SSE push and response body are unchanged.
    balances: result.balances ? mapRupees(result.balances) : null,
  };
}

function mapRupees(balancesPaise) {
  return Object.fromEntries(
    Object.entries(balancesPaise).map(([field, paise]) => [field, paiseToRupees(paise)]),
  );
}

/**
 * The Mongo `Bet` document for an id, whichever store owns the lifecycle.
 *
 * Reads still come from Mongo even under Postgres authority, exactly as they do
 * for the merchant wallet: the live mirror keeps the document current, and the
 * authoritative decision is the transition itself, which refuses
 * transactionally. A stale read can show an old status; it cannot move money.
 */
export function getBetDoc(betIdOrMongoId) {
  return mongoose.model('Bet').findById(betIdOrMongoId).lean();
}
