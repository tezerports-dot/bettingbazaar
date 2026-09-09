// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file.
/**
 * repositories/usdtDeposits.js — a deposit paid to the platform in USDT.
 *
 * ── What makes this different from every other deposit ─────────────────────
 * There is no merchant. The ₹10,000 INR ceiling is the largest amount a cash
 * machine dispenses and the largest a merchant is approved to serve; above it
 * the player pays the PLATFORM's BTCPay Server directly and the tokens are
 * MINTED — `TOKEN_SUPPLY → USER_FLOAT`, under the same supply cap as any other
 * mint. Nobody's float is drawn down because nobody else was party to it.
 *
 * ── The transition is the gate, exactly as it is for an order ──────────────
 * Every state change is a guarded UPDATE with the expected state in the WHERE
 * clause, in the same transaction as an append-only transition row whose
 * `tx_id` is UNIQUE. So a redelivered webhook — which BTCPay will send, on a
 * retry schedule, and which anyone who captures one signed body can replay
 * forever — either finds the row already moved or collides on the key. It never
 * advances the deposit twice, and it never credits twice.
 *
 * ── The amount is written at creation and never read from a callback ───────
 * `token_paise` is decided when the invoice is created, from the rate live at
 * that moment. The webhook says only THAT AN INVOICE SETTLED. Reading the
 * amount out of the callback body would let whoever can produce a valid
 * signature — including a replay of a real one, with a body they have — decide
 * how many tokens to mint. Trap 7, applied to an external system: the number
 * that gates a transfer is read from the row the write will lock.
 */
import { pgQuery, withTransaction } from '../client.js';

/** BIGINT arrives from node-postgres as a STRING. Cast at the boundary, once. */
const paise = (v) => (v === null || v === undefined ? 0 : Number(v));
const rupees = (v) => paise(v) / 100;

export const USDT_DEPOSIT_STATES = Object.freeze([
  'AWAITING_PAYMENT', 'PROCESSING', 'SETTLED', 'EXPIRED', 'INVALID',
]);

/**
 * Which moves are legal, as DATA rather than as a chain of ifs.
 *
 * PROCESSING is BTCPay saying a payment has been seen but not confirmed. It is
 * not money: the deposit may still expire or turn out invalid, so it credits
 * nothing and exists only so a player's screen can say "seen, waiting for
 * confirmations" instead of nothing.
 */
/**
 * The fields a `transition` may carry alongside the state, by name.
 *
 * Declared, and READ by the writer below rather than restated in it, for the
 * reason `SETTABLE` exists in `orders.record.js`: `check:settable` reads this
 * list and refuses any `set: { … }` in the backend that names something else.
 * Without it a typo here is a throw at runtime on a path that has already
 * committed a state change — the failure that has shipped three times.
 */
export const USDT_DEPOSIT_SETTABLE = Object.freeze({
  // When the player's WALLET actually moved. Not a state: SETTLED already says
  // the invoice was paid.
  creditedAt: 'credited_at',
  // Why it ended badly, in the operator's words.
  failureReason: 'failure_reason',
});

export const ALLOWED_FROM = Object.freeze({
  PROCESSING: ['AWAITING_PAYMENT'],
  SETTLED:    ['AWAITING_PAYMENT', 'PROCESSING'],
  EXPIRED:    ['AWAITING_PAYMENT', 'PROCESSING'],
  INVALID:    ['AWAITING_PAYMENT', 'PROCESSING'],
});

export function toUsdtDeposit(r) {
  if (!r) return null;
  return {
    depositId: r.deposit_id,
    userId: r.user_id,
    invoiceId: r.invoice_id,
    tokenAmount: rupees(r.token_paise),
    depositAllocation: rupees(r.deposit_allocation_paise),
    reserveAllocation: rupees(r.reserve_allocation_paise),
    usdtAmount: r.usdt_amount === null ? null : Number(r.usdt_amount),
    usdtRateInr: r.usdt_rate_inr === null ? null : Number(r.usdt_rate_inr),
    state: r.state,
    status: r.state,
    checkoutLink: r.checkout_link,
    expiresAt: r.expires_at,
    settledAt: r.settled_at,
    creditedAt: r.credited_at,
    failureReason: r.failure_reason,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/**
 * Open a deposit in AWAITING_PAYMENT, before the invoice exists.
 *
 * The row is written FIRST and the invoice id attached after BTCPay answers.
 * The other order — call the API, then write — loses the deposit entirely if
 * the process dies between them: an invoice exists, a player can pay it, and
 * nothing on this side knows the invoice was ever ours. This way the failure is
 * a row with no invoice id, which is a deposit that never started.
 */
export async function openDeposit({
  depositId, userId, tokenPaise, depositAllocationPaise, reserveAllocationPaise,
  usdtAmount, usdtRateInr, expiresAt = null,
}) {
  const { rows } = await pgQuery(
    `INSERT INTO usdt_deposits
       (deposit_id, user_id, token_paise, deposit_allocation_paise, reserve_allocation_paise,
        usdt_amount, usdt_rate_inr, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING *`,
    [String(depositId), String(userId), tokenPaise, depositAllocationPaise, reserveAllocationPaise,
     usdtAmount, usdtRateInr, expiresAt],
    'usdt_deposit_open',
  );
  return toUsdtDeposit(rows[0]);
}

/**
 * Attach BTCPay's invoice to a deposit that does not have one yet.
 *
 * Guarded on `invoice_id IS NULL` so a second call cannot repoint a deposit at
 * a different invoice — which would mean one payment settling a row that was
 * quoted for another.
 */
export async function attachInvoice({ depositId, invoiceId, checkoutLink = null, expiresAt = null }) {
  const { rows } = await pgQuery(
    `UPDATE usdt_deposits
        SET invoice_id = $2,
            checkout_link = COALESCE($3, checkout_link),
            expires_at = COALESCE($4, expires_at),
            updated_at = now()
      WHERE deposit_id = $1 AND invoice_id IS NULL
      RETURNING *`,
    [String(depositId), String(invoiceId), checkoutLink, expiresAt],
    'usdt_deposit_attach_invoice',
  );
  return rows[0] ? toUsdtDeposit(rows[0]) : null;
}

export async function getDeposit(depositId) {
  const { rows } = await pgQuery(
    `SELECT * FROM usdt_deposits WHERE deposit_id = $1`,
    [String(depositId)], 'usdt_deposit_get',
  );
  return toUsdtDeposit(rows[0]);
}

export async function getDepositByInvoice(invoiceId) {
  const { rows } = await pgQuery(
    `SELECT * FROM usdt_deposits WHERE invoice_id = $1`,
    [String(invoiceId)], 'usdt_deposit_by_invoice',
  );
  return toUsdtDeposit(rows[0]);
}

export async function listForUser(userId, { limit = 20 } = {}) {
  const { rows } = await pgQuery(
    `SELECT * FROM usdt_deposits WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [String(userId), Math.min(Math.max(Number(limit) || 20, 1), 100)],
    'usdt_deposit_list_user',
  );
  return rows.map(toUsdtDeposit);
}

/**
 * Move a deposit to `toState`, or refuse and say why.
 *
 * The guarded UPDATE and the transition row are ONE transaction. Two webhook
 * deliveries racing the same settle: one matches the row and writes the
 * transition, the other finds no row in an allowed state and is told
 * `already_there`. Neither can credit twice, because neither reaches the
 * credit unless it won here.
 *
 * `txId` is the idempotency key and defaults to `<deposit>:<state>` — one
 * settle per deposit, whatever redelivers.
 */
export async function transition(depositId, toState, {
  txId = null, actor = null, reason = null, deliveryId = null,
  ledgerKey = null, set = {},
} = {}) {
  const allowed = ALLOWED_FROM[toState];
  if (!allowed) throw new Error(`usdtDeposits.transition: unknown target state '${toState}'`);

  // Refuse a field name this writer does not know, LOUDLY and BEFORE anything
  // is written — the opposite of the order lifecycle, where the equivalent
  // throw lands after the state has already committed. A silently dropped
  // field is worse still: the caller wanted it recorded.
  for (const key of Object.keys(set)) {
    if (!(key in USDT_DEPOSIT_SETTABLE)) {
      throw new Error(
        `usdtDeposits.transition: '${key}' is not settable. One of: ${Object.keys(USDT_DEPOSIT_SETTABLE).join(', ')}`,
      );
    }
  }

  return withTransaction(async (client) => {
    const current = await client.query(
      `SELECT state FROM usdt_deposits WHERE deposit_id = $1 FOR UPDATE`,
      [String(depositId)],
    );
    if (!current.rows.length) return { ok: false, reason: 'not_found' };
    const from = current.rows[0].state;
    if (from === toState) return { ok: false, reason: 'already_there', state: from };
    if (!allowed.includes(from)) return { ok: false, reason: 'illegal_transition', state: from };

    // The fields that justify the new state, written in the same statement as
    // the state itself. The order lifecycle writes them second and pays for it
    // — a failure there leaves an order in a state without the facts behind it.
    // There is no such split here: one UPDATE, one row, both or neither.
    const moved = await client.query(
      `UPDATE usdt_deposits
          SET state = $2,
              settled_at = CASE WHEN $2 = 'SETTLED' THEN COALESCE(settled_at, now()) ELSE settled_at END,
              credited_at = COALESCE($3::timestamptz, credited_at),
              failure_reason = COALESCE($4, failure_reason),
              updated_at = now()
        WHERE deposit_id = $1 AND state = $5
        RETURNING *`,
      [String(depositId), toState, set.creditedAt ?? null, set.failureReason ?? null, from],
    );
    if (!moved.rows.length) return { ok: false, reason: 'raced', state: from };

    try {
      await client.query(
        `INSERT INTO usdt_deposit_transitions
           (tx_id, deposit_id, from_state, to_state, actor, reason, delivery_id, ledger_key)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [txId || `${depositId}:${toState}`, String(depositId), from, toState,
         actor, reason, deliveryId, ledgerKey],
      );
    } catch (error) {
      // UNIQUE tx_id — the gate firing INSIDE the transaction, so the state
      // change unwinds with it rather than landing without its audit row.
      if (error.code === '23505') return { ok: false, reason: 'duplicate', state: from };
      throw error;
    }

    return { ok: true, from, deposit: toUsdtDeposit(moved.rows[0]) };
  });
}

/**
 * Stamp the moment the player's wallet actually received the tokens.
 *
 * Not a state — SETTLED already says the invoice was paid. This says the money
 * moved, and the gap between the two is the crash window: a deposit SETTLED
 * with `credited_at` null is a player who paid and has not been credited,
 * which is a row an operator can find. Without it that failure is invisible.
 *
 * Guarded on `credited_at IS NULL` so a replay cannot move the timestamp
 * forward and make an old repair look recent.
 */
export async function markCredited(depositId) {
  const { rows } = await pgQuery(
    `UPDATE usdt_deposits
        SET credited_at = now(), updated_at = now()
      WHERE deposit_id = $1 AND credited_at IS NULL
      RETURNING *`,
    [String(depositId)], 'usdt_deposit_mark_credited',
  );
  return rows[0] ? toUsdtDeposit(rows[0]) : null;
}

/**
 * Deposits that settled and were never credited — the crash window, as a query.
 *
 * The player has paid. Nothing here fixes it automatically, because a mint that
 * was refused by the supply cap needs a person to decide; this is how they are
 * found rather than discovered by the player complaining.
 */
export async function findUncredited({ limit = 100 } = {}) {
  const { rows } = await pgQuery(
    `SELECT * FROM usdt_deposits
      WHERE state = 'SETTLED' AND credited_at IS NULL
      ORDER BY settled_at ASC LIMIT $1`,
    [Math.min(Math.max(Number(limit) || 100, 1), 500)],
    'usdt_deposit_find_uncredited',
  );
  return rows.map(toUsdtDeposit);
}

/**
 * Deposits whose invoice window has passed and that nobody paid.
 *
 * Nothing is refunded and nothing is owed: the player never sent USDT, so an
 * expired invoice is the absence of a transaction. It exists so a stale row
 * does not sit AWAITING_PAYMENT forever and so the player's screen stops
 * offering a checkout link that BTCPay will refuse.
 */
export async function findExpiredDeposits({ limit = 100 } = {}) {
  const { rows } = await pgQuery(
    `SELECT * FROM usdt_deposits
      WHERE state IN ('AWAITING_PAYMENT', 'PROCESSING')
        AND expires_at IS NOT NULL AND expires_at <= now()
      ORDER BY expires_at ASC LIMIT $1`,
    [Math.min(Math.max(Number(limit) || 100, 1), 500)],
    'usdt_deposit_find_expired',
  );
  return rows.map(toUsdtDeposit);
}

/** How many deposits this player has that are still waiting to be paid. */
export async function countOpenForUser(userId) {
  const { rows } = await pgQuery(
    `SELECT count(*)::int AS n FROM usdt_deposits
      WHERE user_id = $1 AND state IN ('AWAITING_PAYMENT', 'PROCESSING')`,
    [String(userId)], 'usdt_deposit_count_open',
  );
  return rows[0]?.n ?? 0;
}

/** Every deposit, newest first — the admin's view of the USDT rail. */
export async function listAll({ state = null, limit = 100 } = {}) {
  const { rows } = await pgQuery(
    `SELECT * FROM usdt_deposits
      WHERE ($1::text IS NULL OR state = $1)
      ORDER BY created_at DESC LIMIT $2`,
    [state, Math.min(Math.max(Number(limit) || 100, 1), 500)],
    'usdt_deposit_list_all',
  );
  return rows.map(toUsdtDeposit);
}
