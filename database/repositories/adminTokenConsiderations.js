// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * adminTokenConsiderations.js — the other side of an admin↔merchant token trade.
 *
 * The treasury says the tokens moved. It cannot say what they were moved FOR.
 * When an admin tops a merchant up, tokens leave the platform's holding and
 * rupees (or USDT) arrive somewhere the platform controls; when an admin takes
 * tokens back, rupees leave. Neither figure existed anywhere, so every
 * profit-and-loss reading of the admin↔merchant leg was missing its revenue
 * side entirely: the books balanced in tokens and said nothing about money.
 *
 * ── One row per movement, keyed by the movement ─────────────────────────────
 * `movement_id` is the primary key, so this inherits the token movement's
 * idempotency instead of inventing its own. A redelivered top-up collides here
 * for the same reason it collides in the treasury, and a genuinely second
 * top-up carries a different key and gets its own row. `ON CONFLICT DO NOTHING`
 * rather than an upsert: the figure is append-only (§19), and a retry that
 * silently restated an amount would be the one edit an audit cannot see.
 *
 * ── Two amounts, and this is trap 15 stated for a second table ──────────────
 * `fiatAmountMinor` is hundredths of the currency the platform actually
 * transacted — paise for INR, hundredths of a USDT for USDT. It is what a human
 * is shown and what reconciles against a bank line or a chain explorer, and it
 * must NEVER be summed across currencies: doing so reads 500 USDT as ₹500. Only
 * `inrEquivalentPaise` may be aggregated, and this module is the one place that
 * derives it, so no caller can compute it a second way (§5).
 *
 * ── The rate is frozen, for §25's reason ────────────────────────────────────
 * The admin's USDT price is editable. A P&L that re-valued settled trades at
 * today's rate would restate history every time an operator touched a config
 * screen. The rate that valued this trade is stored ON the row, and the CHECK
 * constraints refuse a USDT row that has none.
 */
import { pgQuery } from '../client.js';

/** What the platform did, from the platform's side. */
export const DIRECTIONS = Object.freeze({
  /** Tokens left the platform's holding; money came in. */
  RECEIVED: 'RECEIVED',
  /** Tokens came back to the platform's holding; money went out. */
  PAID: 'PAID',
});

/**
 * The currencies an admin↔merchant trade may settle in.
 *
 * Deliberately NOT `MERCHANT_CURRENCIES` from merchantCurrency.js, which is the
 * rail a merchant settles PLAYER orders on. A merchant on the USDT rail can
 * still pay the platform in rupees, and this is a different question.
 */
export const CONSIDERATION_CURRENCIES = Object.freeze(['INR', 'USDT']);

const toNum = (v) => Number(v ?? 0);

/**
 * This event valued in rupees.
 *
 * The ONE place the conversion happens. INR is the peg (`INR_TOKEN_RATE`) and
 * is its own equivalent; USDT is multiplied by the rate frozen on the row.
 *
 * Both sides are hundredths of their unit, which is why the arithmetic needs no
 * scaling factor: 500 USDT is 50,000 hundredths, at ₹90 that is 4,500,000
 * paise, which is ₹45,000. `Math.round` because the product of an integer and a
 * six-decimal rate is not an integer, and paise are integers (§30).
 */
export function valueInInrPaise({ currency, fiatAmountMinor, rateUsed }) {
  const minor = toNum(fiatAmountMinor);
  if (currency === 'INR') return Math.round(minor);
  const rate = Number(rateUsed);
  if (!Number.isFinite(rate) || rate <= 0) {
    throw new Error(
      `valueInInrPaise: a ${currency} consideration needs a positive rate, got ${rateUsed}`,
    );
  }
  return Math.round(minor * rate);
}

function mapRow(row) {
  if (!row) return null;
  return {
    movementId:         row.movement_id,
    merchantId:         row.merchant_id,
    direction:          row.direction,
    // BIGINT arrives as a string from node-postgres (trap 5). Cast here, at the
    // boundary, once — an uncast '900' compares wrong against every number.
    tokenAmountPaise:   toNum(row.token_amount_paise),
    currency:           row.currency,
    fiatAmountMinor:    toNum(row.fiat_amount_minor),
    inrEquivalentPaise: toNum(row.inr_equivalent_paise),
    rateUsed:           row.rate_used === null || row.rate_used === undefined
      ? null : Number(row.rate_used),
    recordedBy:         row.recorded_by,
    note:               row.note,
    createdAt:          row.created_at,
  };
}

/**
 * Record what the platform got, or gave, for one token movement.
 *
 * Returns `{ consideration, idempotent }`. `idempotent` is true when this
 * movement already had a row — the caller redelivered a request — and the row
 * that comes back is the one already stored, never the one just offered.
 *
 * ── Validation happens HERE and before the caller moves any tokens ──────────
 * This insert runs AFTER the token movement has committed, which is §21's
 * shape: anything that can throw here throws with the tokens already moved and
 * the money record missing — precisely the gap this table exists to close. So
 * every input is checked by `assertRecordable` FIRST, at the top of the
 * handler, before a single token moves. By the time the insert runs, every
 * CHECK on the table is already known to hold and `ON CONFLICT DO NOTHING`
 * covers the only remaining failure.
 */
export async function recordConsideration({
  movementId, merchantId, direction, tokenAmountPaise,
  currency, fiatAmountMinor, rateUsed = null, recordedBy, note = null,
}) {
  assertRecordable({
    movementId, merchantId, direction, tokenAmountPaise,
    currency, fiatAmountMinor, rateUsed, recordedBy,
  });
  const inrEquivalentPaise = valueInInrPaise({ currency, fiatAmountMinor, rateUsed });

  const { rows } = await pgQuery(
    `INSERT INTO admin_token_considerations
       (movement_id, merchant_id, direction, token_amount_paise,
        currency, fiat_amount_minor, inr_equivalent_paise, rate_used, recorded_by, note)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (movement_id) DO NOTHING
     RETURNING *`,
    [
      String(movementId), String(merchantId), direction, Math.round(toNum(tokenAmountPaise)),
      currency, Math.round(toNum(fiatAmountMinor)), inrEquivalentPaise,
      currency === 'INR' ? null : Number(rateUsed), String(recordedBy),
      note === null || note === undefined ? null : String(note),
    ],
    'admin_consideration_record',
  );

  if (rows.length) return { consideration: mapRow(rows[0]), idempotent: false };
  return { consideration: await considerationFor(movementId), idempotent: true };
}

/**
 * Everything the table refuses, checked before any token moves.
 *
 * Exported because the route calls it at the TOP of the handler — see the note
 * on `recordConsideration`. A refusal carries `status: 400` so `respondError`
 * routes it as the caller's mistake and the operator reads the field and the
 * bound rather than "the server broke" (§21).
 */
export function assertRecordable({
  movementId, merchantId, direction, tokenAmountPaise,
  currency, fiatAmountMinor, rateUsed, recordedBy,
}) {
  const refuse = (message) => {
    const err = new Error(message);
    err.status = 400;
    throw err;
  };
  if (!movementId) refuse('A token consideration needs the movement it belongs to.');
  if (!merchantId) refuse('A token consideration needs a merchant.');
  if (!recordedBy) refuse('A token consideration needs the admin who recorded it.');
  if (!Object.values(DIRECTIONS).includes(direction)) {
    refuse(`direction must be one of ${Object.values(DIRECTIONS).join(', ')} — got '${direction}'.`);
  }
  if (!CONSIDERATION_CURRENCIES.includes(currency)) {
    refuse(`Settlement currency must be one of ${CONSIDERATION_CURRENCIES.join(', ')} — got '${currency}'.`);
  }
  if (direction === DIRECTIONS.PAID && currency !== 'INR') {
    refuse('The platform pays merchants back in INR. A payout cannot be recorded in USDT.');
  }
  const tokens = toNum(tokenAmountPaise);
  if (!Number.isFinite(tokens) || tokens <= 0) {
    refuse(`Token amount must be positive — got ${tokenAmountPaise}.`);
  }
  const minor = Number(fiatAmountMinor);
  // Zero is allowed and is not the same as absent — an admin correcting their
  // own mis-keyed top-up moved tokens for no money, and 0 says so. `null` and
  // `''` are not 0 and are refused, or the row would be missing for two
  // different reasons and the P&L could not tell them apart.
  if (fiatAmountMinor === null || fiatAmountMinor === undefined || fiatAmountMinor === '') {
    refuse('Record what the platform received or paid for these tokens. Enter 0 if no money changed hands.');
  }
  if (!Number.isFinite(minor) || minor < 0 || !Number.isInteger(minor)) {
    refuse(`The settlement amount must be a whole number of hundredths, zero or more — got ${fiatAmountMinor}.`);
  }
  if (currency === 'USDT') {
    const rate = Number(rateUsed);
    if (!Number.isFinite(rate) || rate <= 0) {
      refuse('A USDT settlement cannot be valued without an INR rate. Set the admin USDT buy rate in System Settings, or record the amount in INR.');
    }
  }
}

/** The consideration recorded against one movement, or null. */
export async function considerationFor(movementId) {
  const { rows } = await pgQuery(
    `SELECT * FROM admin_token_considerations WHERE movement_id = $1`,
    [String(movementId)], 'admin_consideration_get',
  );
  return mapRow(rows[0]);
}

/** Every consideration recorded against one merchant, newest first. */
export async function listForMerchant(merchantId, { limit = 100 } = {}) {
  const { rows } = await pgQuery(
    `SELECT * FROM admin_token_considerations
      WHERE merchant_id = $1
      ORDER BY created_at DESC, movement_id DESC
      LIMIT $2`,
    [String(merchantId), Math.min(Math.max(Number(limit) || 100, 1), 500)],
    'admin_consideration_list',
  );
  return rows.map(mapRow);
}

/**
 * What the platform has taken in and paid out on one merchant's token trades.
 *
 * Aggregated on `inr_equivalent_paise` and never on `fiat_amount_minor` — trap
 * 15, and the reason this table stores both. The currency breakdown comes back
 * beside it so a screen can still say "and 5,000 USDT of that" without anything
 * summing two currencies into one number.
 */
export async function merchantConsiderationTotals(merchantId) {
  const { rows } = await pgQuery(
    `SELECT direction,
            currency,
            COUNT(*)::int                       AS movements,
            SUM(inr_equivalent_paise)::BIGINT   AS inr_paise,
            SUM(fiat_amount_minor)::BIGINT      AS minor,
            SUM(token_amount_paise)::BIGINT     AS token_paise
       FROM admin_token_considerations
      WHERE merchant_id = $1
      GROUP BY direction, currency`,
    [String(merchantId)], 'admin_consideration_totals',
  );
  return foldTotals(rows);
}

/** The same figures across every merchant — the platform's own token-trade P&L. */
export async function platformConsiderationTotals({ since = null } = {}) {
  const { rows } = await pgQuery(
    `SELECT direction,
            currency,
            COUNT(*)::int                       AS movements,
            SUM(inr_equivalent_paise)::BIGINT   AS inr_paise,
            SUM(fiat_amount_minor)::BIGINT      AS minor,
            SUM(token_amount_paise)::BIGINT     AS token_paise
       FROM admin_token_considerations
      WHERE ($1::timestamptz IS NULL OR created_at >= $1)
      GROUP BY direction, currency`,
    [since], 'admin_consideration_platform_totals',
  );
  return foldTotals(rows);
}

/**
 * Shared by both aggregates so the two cannot phrase the same answer
 * differently (§5). `byCurrency` keeps the raw figures apart by currency
 * because that is the only form in which they mean anything.
 */
function foldTotals(rows) {
  const out = {
    receivedInrPaise: 0,
    paidInrPaise:     0,
    netInrPaise:      0,
    tokensSoldPaise:  0,
    tokensBoughtBackPaise: 0,
    movements:        0,
    byCurrency:       {},
  };
  for (const r of rows) {
    const inr    = toNum(r.inr_paise);
    const minor  = toNum(r.minor);
    const tokens = toNum(r.token_paise);
    out.movements += toNum(r.movements);
    if (r.direction === DIRECTIONS.RECEIVED) {
      out.receivedInrPaise += inr;
      out.tokensSoldPaise  += tokens;
    } else {
      out.paidInrPaise          += inr;
      out.tokensBoughtBackPaise += tokens;
    }
    const slot = out.byCurrency[r.currency] ??= { receivedMinor: 0, paidMinor: 0, movements: 0 };
    slot.movements += toNum(r.movements);
    if (r.direction === DIRECTIONS.RECEIVED) slot.receivedMinor += minor;
    else slot.paidMinor += minor;
  }
  out.netInrPaise = out.receivedInrPaise - out.paidInrPaise;
  return out;
}
