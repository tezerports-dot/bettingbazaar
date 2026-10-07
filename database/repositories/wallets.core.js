// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * repositories/wallets.core.js — the mechanism every balance mutation runs on.
 *
 * Every balance read and every movement happens here. Money is integer paise
 * end to end, which is the schema's stated purpose: integer paise is the only
 * representation money has at rest. Rupees exist above this wall, for callers
 * and responses, and nowhere below it.
 *
 * ── The reference implementation that used to sit beside this ───────────────
 * `secureBetPlacement.js` demonstrated the serializable-with-outbox pattern on
 * a DIFFERENT table set (`user_wallets` NUMERIC / ISO-4217 currency,
 * `financial_ledger`, `operational_bet_outbox`) and on a string-decimal money
 * model rather than integer paise. It was never wired to anything, and its
 * tables never held the balances the dual-write mirror populates — so an
 * authoritative path built on it would have switched to an empty set of
 * balances at cutover.
 *
 * Deleted 2026-08-11 rather than left as a second, plausible-looking money
 * path for a reader to mistake for the real one. The pattern it showed is
 * worth knowing; the file was a trap. See docs/DEAD_CODE_AUDIT.md.
 *
 * ── Concurrency ─────────────────────────────────────────────────────────────
 * Every mutation runs in one transaction that:
 *   1. locks the wallet row (SELECT … FOR UPDATE), serialising concurrent
 *      movements for that user;
 *   2. applies the delta with a guard that refuses to leave a balance negative;
 *   3. appends the ledger row in the SAME transaction, so a balance can never
 *      move without its audit row — these were once two writes that a crash
 *      between could separate;
 *   4. when what the wallet HOLDS changes, posts the treasury movement that
 *      moves USER_FLOAT with it, against the counterparty the caller names —
 *      in the same transaction, because the database refuses to commit one
 *      without the other (schema.sql, "TOKEN CONSERVATION").
 *
 * ── Idempotency ─────────────────────────────────────────────────────────────
 * `tx_id` is UNIQUE on wallet_ledger. A replay of the same movement hits that
 * constraint, and the caller gets `{ idempotent: true }` with the balance the
 * original produced — the same contract walletAuthority exposes. This is the
 * hard-won lesson recorded in GOVERNANCE §20 (2026-07-10): the unique index
 * INSIDE the transaction is the idempotency gate, never a pre-read, because a
 * concurrent caller fits between a pre-read and the write it guards.
 */
import { getPool, pgQuery, connectGuarded } from '../client.js';
import { rupeesToPaise, paiseToRupees } from '../../backend/shared/money.js';
import { ACCOUNTS, postMovement, postHouseSettlement } from './treasury.js';

/** The balance name a caller uses → its paise column on `wallets`. */
export const FIELD_COLUMN = Object.freeze({
  depositBalance:  'deposit_paise',
  winningsBalance: 'winnings_paise',
  tokenBalance:    'token_paise',
  reserveBalance:  'reserve_paise',
  lockedBalance:   'locked_paise',
  // Lock provenance — how much of lockedBalance came from each pocket. These
  // are never the `field` of a ledger row; they move as extra legs alongside a
  // lockedBalance movement.
  lockedDepositAmount:  'locked_deposit_paise',
  lockedWinningsAmount: 'locked_winnings_paise',
});

export const BALANCE_FIELDS = Object.freeze(Object.keys(FIELD_COLUMN));

/**
 * The columns that hold TOKENS — what `bb_wallet_value_paise` adds up, and
 * what USER_FLOAT must move with. The provenance counters say where part of
 * `locked` came from; they are not tokens of their own.
 */
const VALUE_COLUMNS = Object.freeze(new Set([
  'deposit_paise', 'winnings_paise', 'token_paise', 'reserve_paise', 'locked_paise',
]));

function columnFor(field) {
  const column = FIELD_COLUMN[field];
  if (!column) {
    throw new Error(`Unknown balance field '${field}'. Known: ${BALANCE_FIELDS.join(', ')}`);
  }
  return column;
}

/** pg returns BIGINT as a string; every balance crosses this boundary as paise. */
function toPaise(value) {
  return Number(value ?? 0);
}

/**
 * getBalancesPaise — every balance for a user, in integer paise.
 * Returns zeros for a user with no wallet row yet — a user who has never
 * transacted has no row, and that is not an error.
 */
export async function getBalancesPaise(userId) {
  const { rows } = await pgQuery(
    `SELECT ${BALANCE_FIELDS.map((f) => FIELD_COLUMN[f]).join(', ')}
       FROM wallets WHERE user_id = $1`,
    [String(userId)],
    'wallet_read',
  );
  const row = rows[0] || {};
  return Object.fromEntries(
    BALANCE_FIELDS.map((field) => [field, toPaise(row[FIELD_COLUMN[field]])]),
  );
}

/** The same balances in rupees, which is what routes serialise. */
export async function getBalancesRupees(userId) {
  const paise = await getBalancesPaise(userId);
  return Object.fromEntries(
    Object.entries(paise).map(([field, value]) => [field, paiseToRupees(value)]),
  );
}


// ── Transaction plumbing ─────────────────────────────────────────────────────

const BALANCE_COLUMNS = BALANCE_FIELDS.map((f) => FIELD_COLUMN[f]).join(', ');

function rowToBalances(row = {}) {
  return Object.fromEntries(BALANCE_FIELDS.map((f) => [f, toPaise(row[FIELD_COLUMN[f]])]));
}

/**
 * withWalletLock — open a transaction, materialise the user's wallet row, take
 * the row lock, and hand the callback the client plus the balances AS OF that
 * lock.
 *
 * The lock is this user's mutex. While it is held no other movement for them
 * can read or write, so a decision made inside the callback — an existence
 * probe, a spend-order split across two pockets — is DURABLE rather than a
 * hopeful pre-read that a concurrent writer can invalidate. That is the
 * property a guarded conditional update can only approximate with a retry.
 *
 * The callback returns `{ commit, value }`; `commit:false` rolls back and still
 * returns `value`, which is the shape "this was refused, and here is why"
 * needs. Note that once a statement inside the transaction has errored,
 * Postgres refuses further work on that connection until it unwinds — so any
 * follow-up read (e.g. fetching what an earlier replay produced) must happen
 * OUTSIDE this helper, after it has returned.
 */
export async function withWalletLock(userId, fn) {
  const uid = String(userId);
  const pool = await getPool();
  if (!pool) throw new Error('Postgres not configured (DATABASE_URL unset)');
  // connectGuarded, not pool.connect: an unguarded checked-out client turns a
  // Postgres restart mid-transaction into an unhandled 'error' event and a hard
  // process crash. See pgClient.connectGuarded.
  const client = await connectGuarded(pool);
  let failure = null;

  try {
    await client.query('BEGIN');
    const { commit, value } = await fn(await lockWalletWithin(client, uid));

    await client.query(commit ? 'COMMIT' : 'ROLLBACK');
    return value;
  } catch (error) {
    failure = error;
    try { await client.query('ROLLBACK'); } catch { /* already unwound */ }
    throw error;
  } finally {
    // Passing the error DESTROYS the client instead of returning it to the
    // pool. It matters when the backend went away mid-transaction — a Postgres
    // restart, a failover, an admin pg_terminate_backend: the socket is dead
    // but a plain release() puts it back in rotation and the NEXT caller
    // inherits "terminating connection due to administrator command" on a query
    // of its own, two statements later, in unrelated code.
    //
    // The merchant modules were fixed when a settlement test killed a backend
    // mid-transition and the failure surfaced somewhere else entirely. This is
    // the same bug on the HOTTEST money path, which had simply never been
    // subjected to that drill.
    client.release(failure ?? undefined);
  }
}

/**
 * Take one player's wallet lock INSIDE a transaction somebody else opened —
 * the pool movement that pays a buy or settles a sell, which must move the
 * pool, the wallet and the treasury in one commit. Returns the context
 * `applyMovementWithin` takes.
 *
 * Lock order, everywhere: the order row, then the team pool, then the wallet,
 * then the bet or round, then the treasury accounts (alphabetically). A path
 * that took them in another order could deadlock against this one.
 */
export async function lockWalletWithin(client, userId) {
  const uid = String(userId);
  // Materialise the wallet row so FOR UPDATE has something to lock. A
  // first-ever movement and a concurrent one race here; ON CONFLICT makes the
  // loser a no-op rather than an error.
  await client.query(
    `INSERT INTO wallets (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`, [uid],
  );
  const locked = await client.query(
    `SELECT ${BALANCE_COLUMNS} FROM wallets WHERE user_id = $1 FOR UPDATE`, [uid],
  );
  return { client, uid, balances: rowToBalances(locked.rows[0]) };
}

/** Normalise legs to one signed delta per column, carrying the negative guard. */
function mergeLegs(legs) {
  const merged = new Map(); // column → { delta }
  for (const leg of legs) {
    if (!Number.isInteger(leg.deltaPaise)) {
      throw new TypeError(`leg '${leg.field}': deltaPaise must be an integer number of paise, got ${leg.deltaPaise}`);
    }
    const column = columnFor(leg.field);
    const prior = merged.get(column) || { delta: 0 };
    merged.set(column, { delta: prior.delta + leg.deltaPaise });
  }
  return merged;
}

/** How many tokens the movement adds to (or takes from) what the wallet holds. */
function valueDelta(merged) {
  let delta = 0;
  for (const [column, { delta: d }] of merged) if (VALUE_COLUMNS.has(column)) delta += d;
  return delta;
}

/**
 * The other side of a movement that changes what a wallet HOLDS (owner,
 * 2026-10-07: no token is used or counted twice).
 *
 * Moving tokens between a player's own pockets — a stake into `locked`, a
 * withdrawal's winnings into `locked`, a stake returned — leaves what they hold
 * unchanged and needs none. Anything else came from somewhere or went
 * somewhere, and USER_FLOAT moves with it IN THIS TRANSACTION, or the database
 * refuses the commit (`bb_conservation_user_float`). The caller names where:
 *
 *   { account, operation, … }   a treasury account pays or takes it — the
 *                               platform's holding (TOKEN_SUPPLY) for a
 *                               referral reward or an admin adjustment, a pool
 *                               account for a bonus
 *   { house: true, operation, … }  a game's result: `postHouseSettlement`
 *   { postedByCaller: true }    the caller posts the USER_FLOAT leg itself, in
 *                               the same transaction — a team pool paying a
 *                               buy, or taking a sell (`teamPools.js`)
 *
 * The movement's id is its first ledger key, so the treasury half replays with
 * the wallet half and never without it.
 */
function requireCounterparty(counterparty, delta) {
  if (delta === 0) return;
  if (!counterparty) {
    throw new Error(
      `a movement that changes what a wallet holds (by ${delta} paise) needs a counterparty: `
      + 'where the tokens came from or went (wallets.core.applyMovementWithin)',
    );
  }
  if (counterparty.postedByCaller || counterparty.house) return;
  if (!Object.values(ACCOUNTS).includes(counterparty.account) || counterparty.account === ACCOUNTS.USER_FLOAT) {
    throw new Error(`counterparty account '${counterparty.account}' is not a treasury account a wallet can move against`);
  }
}

async function postCounterparty(client, counterparty, delta, movementId) {
  if (delta === 0 || counterparty.postedByCaller) return { ok: true };
  const { account, house, operation, actor = null, reason = null, refModel = null, refId = null } = counterparty;
  if (!operation) throw new Error('a counterparty names its operation');
  const meta = { client, movementId, operation, actor, reason, refModel, refId: refId ?? null };
  const moved = house
    ? await postHouseSettlement({ ...meta, userDeltaPaise: delta })
    : await postMovement({ ...meta, legs: { [ACCOUNTS.USER_FLOAT]: delta, [account]: 0 - delta } });
  if (!moved.ok) return { ok: false, refused: moved.reason };
  // The wallet half was new and the treasury half was not: the two share one
  // key, so this is a movement posted outside this function. Never pay twice.
  if (moved.idempotent) return { ok: false, refused: 'treasury_already_posted' };
  return { ok: true };
}

/**
 * Apply merged legs to the locked row. The negative guard lives in the UPDATE's
 * WHERE clause, so a debit that would overdraw simply matches no row — it
 * cannot be lost to a race between a read and a write. Returns the post-state,
 * or null when a guard refused. There is no override: `wallets_pockets_nonneg`
 * holds the same rule for every writer, so a negative pocket cannot be written
 * at all — this guard only turns the refusal into an answer instead of an error.
 */
async function moveBalances(client, uid, merged) {
  const params = [uid];
  const sets = [];
  const guards = [];
  for (const [column, { delta }] of merged) {
    params.push(delta);
    const placeholder = `$${params.length}`;
    sets.push(`${column} = ${column} + ${placeholder}`);
    if (delta < 0) guards.push(`AND ${column} + ${placeholder} >= 0`);
  }
  const { rows } = await client.query(
    `UPDATE wallets SET ${sets.join(', ')}, updated_at = now()
      WHERE user_id = $1 ${guards.join(' ')}
      RETURNING ${BALANCE_COLUMNS}`,
    params,
  );
  return rows.length ? rowToBalances(rows[0]) : null;
}

/**
 * Append the audit rows in the SAME transaction as the balance move: a balance
 * can never shift without its ledger row. Returns false on a UNIQUE tx_id
 * collision — that is not an error, it is the idempotency gate firing, and the
 * caller unwinds the whole movement.
 *
 * ── Sign convention ─────────────────────────────────────────────────────────
 * Callers pass `amountPaise` SIGNED because that is what a balance leg means,
 * but the row STORES a positive magnitude with the direction in `tx_type`.
 * That is not a style choice: every sum-based check — the trial balance, the
 * conservation triggers — adds `amount_paise` and reads the direction from the
 * type. A stored −500 would be counted twice in the same direction and make
 * those checks disagree with the balances they are computed from.
 */
async function appendLedgerRows(client, uid, rows, after) {
  try {
    for (const row of rows) {
      const balanceAfter = after[row.field];
      const magnitude = Math.abs(row.amountPaise);
      const direction = row.type || (row.amountPaise < 0 ? 'DEBIT' : 'CREDIT');
      const balanceBefore = direction === 'DEBIT'
        ? balanceAfter + magnitude
        : balanceAfter - magnitude;
      await client.query(
        `INSERT INTO wallet_ledger
           (tx_id, user_id, field, amount_paise, balance_before_paise, balance_after_paise, tx_type, description, ref_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          row.txId, uid, row.field, magnitude, balanceBefore, balanceAfter,
          direction, row.reason ?? null, row.refId ? String(row.refId) : null,
        ],
      );
    }
    return true;
  } catch (error) {
    if (error.code === '23505') return false; // unique_violation on tx_id
    throw error;
  }
}

function validateLedgerRows(ledger) {
  for (const row of ledger) {
    if (!row.txId) throw new Error('every ledger row needs a txId (idempotency key)');
    columnFor(row.field);
    if (!Number.isInteger(row.amountPaise)) {
      throw new TypeError(`ledger row '${row.txId}': amountPaise must be an integer, got ${row.amountPaise}`);
    }
  }
}

/**
 * What the ORIGINAL movement produced, looked up after a replay was refused. A
 * replay must answer the same thing the first call did, however many unrelated
 * movements have landed since — so this reads the ledger, not today's balance.
 */
async function replayedBalances(txIds) {
  const { rows } = await pgQuery(
    `SELECT tx_id, balance_after_paise FROM wallet_ledger WHERE tx_id = ANY($1)`,
    [txIds], 'wallet_replay',
  );
  return Object.fromEntries(rows.map((r) => [r.tx_id, toPaise(r.balance_after_paise)]));
}

// ── The mutation API ─────────────────────────────────────────────────────────

/**
 * applyMovementPaise — THE general mutation: move N balance fields and append M
 * ledger rows, atomically, under one row lock.
 *
 * Why N legs and M rows rather than a series of single-field calls: a movement
 * like "lock a withdrawal" touches winnings and locked together and is ONE
 * ledger row. Composing it from two independent single-field transactions would
 * open a window where the money is in neither pocket, and would write twice the
 * ledger rows the movement actually made.
 *
 * ── Why ledger rows are caller-supplied ────────────────────────────────────
 * The caller passes the EXACT txId strings (`wd_lock_<id>`,
 * `bet_<u>_<c>_<b>_dep`, …), because the key must be derived from the thing
 * being paid for rather than generated here. A key generated per call is
 * `random()`: the UNIQUE constraint behind it can never fire, so a retry moves
 * the money a second time while the code reads as protected — a gate that
 * exists, is tested, and protects nothing. Generating keys here would be
 * exactly that.
 *
 * @param {object} args
 * @param {string} args.userId
 * @param {Array<{field:string, deltaPaise:number}>} args.legs
 * @param {Array<{txId:string, field:string, amountPaise:number, type?:string,
 *                reason?:string, refId?:string}>} args.ledger
 *   A ledger row's `field` must be a field the movement actually touched: the
 *   reverse mirror reads it to know which balance the row describes.
 * @param {string[]} [args.excludes] ledger keys of the movement's RIVALS — the
 *   other answer to the same question. If any of them exists for this user the
 *   movement is refused (`excluded`), under the same lock as the replay probe.
 * @param {object} [args.counterparty] where tokens the wallet gains came from,
 *   or tokens it loses went — required when the movement changes what the
 *   wallet holds (`postCounterparty`).
 *
 * @returns {Promise<{ok, idempotent, insufficient?, excluded?, refused?, balancesAfterPaise, replayedLedger?}>}
 */
export async function applyMovementPaise({ userId, legs, ledger, excludes = [], counterparty = null }) {
  if (!Array.isArray(legs) || !legs.length) {
    throw new Error('applyMovementPaise requires at least one balance leg');
  }
  if (!Array.isArray(ledger) || !ledger.length) {
    throw new Error('applyMovementPaise requires at least one ledger row — a balance must never move unaudited');
  }
  validateLedgerRows(ledger);
  const merged = mergeLegs(legs);

  const outcome = await withWalletLock(userId, async (ctx) => {
    const value = await applyMovementWithin(ctx, { merged, ledger, excludes, counterparty });
    return { commit: value.ok && !value.idempotent, value };
  });

  // The replay lookup has to happen out here: inside the transaction the
  // connection is still poisoned by the constraint violation that got us here.
  if (outcome.idempotent) {
    outcome.replayedLedger = await replayedBalances(ledger.map((r) => r.txId));
  }
  return outcome;
}

/**
 * The movement itself, executed inside a lock someone else opened.
 *
 * Split out from applyMovementPaise so a caller that must do MORE than move a
 * balance — write a bet row and its stake debit, in the same transaction or not
 * at all — can compose with it instead of opening a second one. betPg is that
 * caller, and the composition is the entire point of the domain: writing the
 * bet, moving the balance and appending the ledger as three separate operations
 * is defect M-4 — money moves unaudited when the ledger write fails, and the
 * ledger is what every check is computed from, so the failure erases its own
 * symptom.
 *
 * Does NOT commit or roll back. The lock holder decides that, because only it
 * knows whether the rest of the transaction succeeded.
 *
 * `merged` is pre-normalised leg output from mergeLegs(); callers outside this
 * module should pass `legs` and let it normalise.
 *
 * A movement that changes what the wallet HOLDS posts its USER_FLOAT leg here,
 * after the ledger rows and in the same transaction, against `counterparty`
 * (see `postCounterparty`); a treasury refusal comes back as `refused` and the
 * lock holder must roll back.
 */
export async function applyMovementWithin({ client, uid }, { legs, merged, ledger, excludes = [], counterparty = null }) {
  if (!merged) {
    if (!Array.isArray(legs) || !legs.length) {
      throw new Error('applyMovementWithin requires at least one balance leg');
    }
    if (!Array.isArray(ledger) || !ledger.length) {
      throw new Error('applyMovementWithin requires at least one ledger row — a balance must never move unaudited');
    }
    validateLedgerRows(ledger);
  }
  const columns = merged ?? mergeLegs(legs);
  const delta = valueDelta(columns);
  requireCounterparty(counterparty, delta);

  // ── THE REPLAY PROBE COMES FIRST ─────────────────────────────────────────
  // Moving the balances first and letting the ledger's UNIQUE detect the replay
  // only works when the replayed movement would still PASS the balance guard.
  // When it would not, the guard refuses before the collision is ever reached
  // and the caller cannot tell "already done" from "cannot afford" — so a
  // redelivered callback throws instead of being a no-op.
  //
  // That was real: replaying a withdrawal refund tried `locked -= X` against a
  // `locked` the first refund had already emptied, was refused for going
  // negative, and the caller raised an error on an operation that had in fact
  // succeeded. Every movement that RETURNS value to a pocket has this shape.
  //
  // The probe is exact rather than a fast path because the wallet row is
  // already locked here: no concurrent movement for this user can land between
  // the probe and the write. An equivalent read taken outside the lock would be
  // a guess.
  const keys = ledger.map((r) => r.txId);
  const { rows: replayed } = await client.query(
    `SELECT 1 FROM wallet_ledger WHERE user_id = $1 AND tx_id = ANY($2) LIMIT 1`,
    [uid, keys],
  );
  if (replayed.length) {
    return { ok: true, idempotent: true, balancesAfterPaise: null };
  }

  // ── A RIVAL MOVEMENT, ALREADY MADE ──────────────────────────────────────
  // Some movements are two answers to ONE question: a withdrawal's locked
  // stake is either CONSUMED (it went to the team) or RETURNED (refunded to
  // the player), never both. Each has its own key, so neither key's UNIQUE can
  // see the other, and the balance guard cannot either while the lock holds
  // somebody else's stake as well. Asked here, under the wallet lock, so the
  // answer cannot change before the write.
  if (excludes.length) {
    const { rows: rival } = await client.query(
      `SELECT tx_id FROM wallet_ledger WHERE user_id = $1 AND tx_id = ANY($2) LIMIT 1`,
      [uid, excludes],
    );
    if (rival.length) {
      return { ok: false, excluded: rival[0].tx_id, idempotent: false, balancesAfterPaise: null };
    }
  }

  const after = await moveBalances(client, uid, columns);
  if (!after) {
    return { ok: false, insufficient: true, idempotent: false, balancesAfterPaise: null };
  }
  // Still checked: the probe closes the window this transaction can see, and
  // the UNIQUE closes the one it cannot — a movement committed by another
  // transaction between our lock being taken and this insert.
  if (!await appendLedgerRows(client, uid, ledger, after)) {
    return { ok: true, idempotent: true, balancesAfterPaise: null };
  }
  const other = await postCounterparty(client, counterparty, delta, keys[0]);
  if (!other.ok) return { ok: false, refused: other.refused, idempotent: false, balancesAfterPaise: null };
  return { ok: true, idempotent: false, balancesAfterPaise: after };
}

/**
 * applyDeltaPaise — move one balance field by a signed paise amount.
 *
 * @param {object}  args
 * @param {string}  args.userId
 * @param {string}  args.field       one of BALANCE_FIELDS
 * @param {number}  args.deltaPaise  signed; negative debits
 * @param {string}  args.txId        idempotency key (required — a money movement
 *                                   without one cannot be safely retried)
 * @param {string}  [args.type]      ledger tx_type
 * @param {string}  [args.reason]
 * @param {string}  [args.refId]
 * @param {object}  args.counterparty where the tokens come from or go
 *                                   (`postCounterparty`); a pocket's change is
 *                                   always somebody else's
 *
 * @returns {Promise<{ok, idempotent, balanceAfterPaise, insufficient?, refused?}>}
 *   ok:false + insufficient:true when the guard refused the debit — the caller
 *   decides how to surface it — a refused debit is not an exception.
 */
export async function applyDeltaPaise({
  userId, field, deltaPaise, txId,
  type = null, reason = null, refId = null, counterparty = null,
}) {
  if (!txId) throw new Error('applyDeltaPaise requires a txId (idempotency key)');
  if (!Number.isInteger(deltaPaise)) {
    throw new TypeError(`deltaPaise must be an integer number of paise, got ${deltaPaise}`);
  }
  const result = await applyMovementPaise({
    userId,
    legs: [{ field, deltaPaise }],
    ledger: [{ txId, field, amountPaise: deltaPaise, type, reason, refId }],
    counterparty,
  });
  return {
    ok: result.ok,
    idempotent: result.idempotent,
    ...(result.insufficient ? { insufficient: true } : {}),
    ...(result.refused ? { refused: result.refused } : {}),
    balanceAfterPaise: result.balancesAfterPaise
      ? result.balancesAfterPaise[field]
      : (result.replayedLedger?.[txId] ?? null),
  };
}

/** Rupee-denominated convenience over applyDeltaPaise, for callers above the wall. */
export async function applyDeltaRupees({ userId, field, deltaRupees, ...rest }) {
  return applyDeltaPaise({ userId, field, deltaPaise: rupeesToPaise(deltaRupees), ...rest });
}

/**
 * transferPaise — move value between two fields of the SAME user atomically
 * (locking a withdrawal, releasing a stake). Both legs and both ledger rows
 * commit together or not at all, so there is no window in which the value is
 * in neither pocket.
 *
 * Ledger rows are keyed `${txId}:from` / `${txId}:to` so the pair replays as a
 * unit under one caller-supplied idempotency key. Callers that must reproduce
 * a specific ledger shape — one row for a two-pocket move — should use
 * applyMovementPaise directly and supply the exact txIds instead.
 */
export async function transferPaise({
  userId, fromField, toField, amountPaise, txId,
  type = null, reason = null, refId = null,
}) {
  if (!txId) throw new Error('transferPaise requires a txId (idempotency key)');
  if (!Number.isInteger(amountPaise) || amountPaise <= 0) {
    throw new TypeError(`amountPaise must be a positive integer, got ${amountPaise}`);
  }
  if (fromField === toField) throw new Error('transferPaise needs two different fields');

  const result = await applyMovementPaise({
    userId,
    legs: [
      { field: fromField, deltaPaise: -amountPaise },
      { field: toField,   deltaPaise:  amountPaise },
    ],
    ledger: [
      { txId: `${txId}:from`, field: fromField, amountPaise: -amountPaise, type, reason, refId },
      { txId: `${txId}:to`,   field: toField,   amountPaise:  amountPaise, type, reason, refId },
    ],
  });

  if (!result.ok) return { ok: false, insufficient: true, idempotent: false };
  if (result.idempotent) return { ok: true, idempotent: true };
  return {
    ok: true, idempotent: false,
    fromAfterPaise: result.balancesAfterPaise[fromField],
    toAfterPaise:   result.balancesAfterPaise[toField],
  };
}

