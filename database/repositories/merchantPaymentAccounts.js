// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * A merchant account's payment accounts (owner, 2026-10-11 — Phase B of the
 * merchants-and-agents plan). The ONE writer of `merchant_payment_accounts`.
 *
 *   UPI_QR — the merchant's static UPI QR (its `pa` and `pn` kept, checked by
 *            `checkStaticUpiLink`), plus the bank account behind it. A buy is
 *            paid through a link built from it with the order's amount.
 *   BANK   — holder, account number, IFSC and bank name; a buy is paid by
 *            bank transfer into it.
 *
 * Each account is switched per direction (`accepts_deposits`: buys are paid
 * into it; `pays_withdrawals`: sells may be paid from it), ACTIVE or PAUSED,
 * and removed softly (an order names the account it was paid to or from). A
 * mobile anywhere on it is refused by the row (`bb_payment_account_shape`).
 *
 * Every write names the owner merchant in its WHERE, so an account id of
 * another merchant matches no row (trap 16).
 *
 * ── Which sizes go to which account (owner, 2026-10-20) ──────────────────────
 * Each account lists the order sizes it takes: `buy_sizes` (a buy of that size
 * is paid into it) and `sell_sizes` (a sell of that size is paid from it).
 * Routing gives an order only to an account listing its size, and a sell is
 * marked paid only from one. Every size the platform sends to merchant
 * accounts (`required`, from the route: `merchantSizes` ∩ `offeredSizes` per
 * direction) must be listed by at least one live account switched on for that
 * direction (ACTIVE or PAUSED; a pause is a moment, a removal is for good).
 * Every write that can change that answer asks it again after writing, in the
 * same transaction, under a lock on the merchant account's row (S6), and
 * unwinds with 409 SIZES_UNCOVERED naming what it left out (`coveredWrite`).
 */
import { randomBytes } from 'node:crypto';
import { pgQuery, withTransaction } from '../client.js';
import { checkStaticUpiLink } from '../../backend/domains/payment/cashLink.js';
import { ORDER_SIZES } from '../../backend/domains/merchant/denominations.js';

export const ACCOUNT_KINDS = Object.freeze({ UPI_QR: 'UPI_QR', BANK: 'BANK' });
export const ACCOUNT_STATUSES = Object.freeze({ ACTIVE: 'ACTIVE', PAUSED: 'PAUSED', REMOVED: 'REMOVED' });

const newAccountId = () => `mpa_${randomBytes(10).toString('hex')}`;
const bad = (message, code = 'INVALID_PAYMENT_ACCOUNT') => Object.assign(new Error(message), { status: 400, code });

export function toAccount(r) {
  if (!r) return null;
  return {
    accountId: r.account_id,
    merchantId: r.merchant_id,
    kind: r.kind,
    label: r.label,
    upiId: r.upi_pa ?? null,
    upiName: r.upi_pn ?? null,
    upiLink: r.upi_link ?? null,
    holderName: r.holder_name,
    accountNo: r.account_no,
    ifsc: r.ifsc,
    bankName: r.bank_name,
    acceptsDeposits: r.accepts_deposits === true,
    paysWithdrawals: r.pays_withdrawals === true,
    buySizes: (r.buy_sizes ?? []).map(Number),
    sellSizes: (r.sell_sizes ?? []).map(Number),
    status: r.status,
    lastUsedAt: r.last_used_at ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    removedAt: r.removed_at ?? null,
  };
}

const text = (v, name, max) => {
  const t = String(v ?? '').trim();
  if (!t) throw bad(`Enter the ${name}.`);
  if (t.length > max) throw bad(`The ${name} is too long (at most ${max} characters).`);
  return t;
};

/** The bank fields every account carries, normalised the way the row's CHECK reads them. */
function bankFields(input) {
  const accountNo = String(input.accountNo ?? '').replace(/[\s-]/g, '');
  if (!/^[0-9]{6,20}$/.test(accountNo)) throw bad('Enter the account number: 6 to 20 digits.');
  const ifsc = String(input.ifsc ?? '').replace(/\s/g, '').toUpperCase();
  if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifsc)) throw bad('Enter the IFSC: four letters, a zero, then six letters or digits.');
  return {
    holderName: text(input.holderName, 'account holder name', 100),
    accountNo, ifsc,
    bankName: text(input.bankName, 'bank name', 100),
  };
}

/**
 * A list of sizes as typed: whole sizes from `ORDER_SIZES`, each once,
 * ascending. Anything else is refused by name; absent is `fallback`.
 */
function sizesOf(value, name, fallback) {
  if (value === undefined || value === null) return fallback;
  if (!Array.isArray(value)) throw bad(`${name} is a list of order sizes.`, 'INVALID_ORDER_SIZES');
  const sizes = value.map(Number);
  const unknown = sizes.filter((n) => !ORDER_SIZES.includes(n));
  if (unknown.length) {
    throw bad(`${name}: ${unknown.join(', ')} is not an order size. The sizes are ${ORDER_SIZES.join(', ')}.`, 'INVALID_ORDER_SIZES');
  }
  return ORDER_SIZES.filter((n) => sizes.includes(n));
}

/** The sizes the platform sends to merchant accounts, per direction, as the route passes them. */
function requiredOf(required) {
  const pick = (k) => ORDER_SIZES.filter((n) => (required?.[k] ?? []).map(Number).includes(n));
  return { DEPOSIT: pick('DEPOSIT'), WITHDRAWAL: pick('WITHDRAWAL') };
}

/**
 * Which required sizes no live account of this merchant takes, per direction.
 * `q` is a client inside the writing transaction, or `pgQuery` for a read.
 */
async function uncoveredWith(q, merchantId, required) {
  const need = requiredOf(required);
  const { rows } = await q(
    `SELECT COALESCE(array_agg(DISTINCT b) FILTER (WHERE accepts_deposits AND b IS NOT NULL), '{}') AS buys,
            COALESCE(array_agg(DISTINCT s) FILTER (WHERE pays_withdrawals AND s IS NOT NULL), '{}') AS sells
       FROM merchant_payment_accounts a
       LEFT JOIN LATERAL unnest(a.buy_sizes) b ON TRUE
       LEFT JOIN LATERAL unnest(a.sell_sizes) s ON TRUE
      WHERE a.merchant_id = $1 AND a.status <> 'REMOVED'`,
    [String(merchantId)]);
  const buys = (rows[0]?.buys ?? []).map(Number);
  const sells = (rows[0]?.sells ?? []).map(Number);
  return {
    DEPOSIT: need.DEPOSIT.filter((n) => !buys.includes(n)),
    WITHDRAWAL: need.WITHDRAWAL.filter((n) => !sells.includes(n)),
  };
}

const rupees = (n) => `₹${Number(n).toLocaleString('en-IN')}`;

/** Thrown inside a write that would leave a size with no account: the write unwinds. */
export class SizesUncovered extends Error {
  constructor(uncovered) {
    const parts = [];
    if (uncovered.DEPOSIT.length) parts.push(`buys of ${uncovered.DEPOSIT.map(rupees).join(', ')}`);
    if (uncovered.WITHDRAWAL.length) parts.push(`sells of ${uncovered.WITHDRAWAL.map(rupees).join(', ')}`);
    super(`Every size must go to at least one of your accounts. Nothing would take ${parts.join(' or ')}: tick ${
      parts.length > 1 ? 'them' : 'it'} on an account that is switched on for that direction.`);
    this.status = 409;
    this.code = 'SIZES_UNCOVERED';
    this.uncovered = uncovered;
  }
}

/**
 * Run one write of a merchant's accounts under the lock on their merchant
 * account (one write at a time per merchant), then ask which required sizes no
 * account takes. The write unwinds with `SizesUncovered` when it left out a
 * size that was taken before it (a removal, a size unticked, a direction
 * switched off), or, with `strict`, when anything at all is left out (the
 * one-save "which size goes where", owner 2026-10-20). Adding an account only
 * ever adds, so the first of two accounts can be saved on its own.
 */
async function coveredWrite(merchantId, required, write, { strict = false } = {}) {
  return withTransaction(async (client) => {
    await client.query('SELECT 1 FROM teams WHERE owner_merchant_id = $1 FOR UPDATE', [String(merchantId)]);
    const q = (sql, params) => client.query(sql, params);
    const before = await uncoveredWith(q, merchantId, required);
    const out = await write(client);
    if (out?.ok) {
      const after = await uncoveredWith(q, merchantId, required);
      const lost = {
        DEPOSIT: after.DEPOSIT.filter((n) => strict || !before.DEPOSIT.includes(n)),
        WITHDRAWAL: after.WITHDRAWAL.filter((n) => strict || !before.WITHDRAWAL.includes(n)),
      };
      if (lost.DEPOSIT.length || lost.WITHDRAWAL.length) throw new SizesUncovered(lost);
    }
    return out;
  });
}

/**
 * The sizes, per direction, the platform sends to merchant accounts and
 * which of them none of this merchant's accounts takes (display, for the
 * Payment accounts screen; the writes ask again for themselves).
 */
export async function sizeCoverage(merchantId, required) {
  const need = requiredOf(required);
  const uncovered = await uncoveredWith((sql, params) => pgQuery(sql, params, 'merchant_payment_account_coverage'),
    merchantId, required);
  return { required: need, uncovered };
}

/**
 * Add an account. `upiLink` (UPI_QR only) is what the merchant's scanner read
 * from their static QR. Answers { ok: true, account } or a 400 thrown with the
 * reason; a mobile on the account, or a UPI ID already live on another account,
 * is answered by the caller from the database's refusal.
 */
export async function addAccount(merchantId, input = {}, { required = null } = {}) {
  const kind = String(input.kind ?? '');
  if (!ACCOUNT_KINDS[kind]) throw bad('Choose the kind of account: UPI_QR or BANK.');
  const label = text(input.label, 'account label', 60);
  const bank = bankFields(input);
  const upi = kind === ACCOUNT_KINDS.UPI_QR ? checkStaticUpiLink(input.upiLink) : null;
  // Sizes not given: every size the platform sends to merchant accounts now.
  const need = requiredOf(required);
  const buySizes = sizesOf(input.buySizes, 'Buy sizes', need.DEPOSIT);
  const sellSizes = sizesOf(input.sellSizes, 'Sell sizes', need.WITHDRAWAL);
  return coveredWrite(merchantId, required, async (client) => {
    const { rows } = await client.query(
      `INSERT INTO merchant_payment_accounts
         (account_id, merchant_id, kind, label, upi_link, upi_pa, upi_pn,
          holder_name, account_no, ifsc, bank_name, accepts_deposits, pays_withdrawals, buy_sizes, sell_sizes)
       SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::int[], $15::int[]
        WHERE EXISTS (SELECT 1 FROM teams WHERE owner_merchant_id = $2)
       RETURNING *`,
      [newAccountId(), String(merchantId), kind, label, upi?.link ?? null, upi?.pa ?? null, upi?.pn ?? null,
        bank.holderName, bank.accountNo, bank.ifsc, bank.bankName,
        input.acceptsDeposits !== false, input.paysWithdrawals !== false, buySizes, sellSizes]);
    return rows[0] ? { ok: true, account: toAccount(rows[0]) } : { ok: false, reason: 'not_direct' };
  });
}

/**
 * Edit an account's label, bank fields, UPI QR (UPI_QR only), direction
 * switches or ACTIVE/PAUSED. The kind never changes. A removed account is not
 * edited (the WHERE).
 */
export async function updateAccount(merchantId, accountId, patch = {}, { required = null } = {}) {
  const current = await getAccount(merchantId, accountId);
  if (!current || current.status === ACCOUNT_STATUSES.REMOVED) return { ok: false, reason: 'not_found' };
  const merged = { ...current, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) };
  const label = text(merged.label, 'account label', 60);
  const bank = bankFields(merged);
  let upi = null;
  if (current.kind === ACCOUNT_KINDS.UPI_QR) {
    upi = patch.upiLink !== undefined ? checkStaticUpiLink(patch.upiLink)
      : { link: current.upiLink, pa: current.upiId, pn: current.upiName };
  } else if (patch.upiLink !== undefined) {
    throw bad('A bank account has no UPI QR. Add a UPI_QR account instead.');
  }
  let status = current.status;
  if (patch.status !== undefined) {
    if (![ACCOUNT_STATUSES.ACTIVE, ACCOUNT_STATUSES.PAUSED].includes(patch.status)) {
      throw bad('An account is ACTIVE or PAUSED. Remove it with DELETE.');
    }
    status = patch.status;
  }
  for (const k of ['acceptsDeposits', 'paysWithdrawals']) {
    if (patch[k] !== undefined && typeof patch[k] !== 'boolean') throw bad(`${k} must be true or false.`);
  }
  const buySizes = sizesOf(patch.buySizes, 'Buy sizes', current.buySizes);
  const sellSizes = sizesOf(patch.sellSizes, 'Sell sizes', current.sellSizes);
  return coveredWrite(merchantId, required, async (client) => {
    const { rows } = await client.query(
      `UPDATE merchant_payment_accounts
          SET label = $3, holder_name = $4, account_no = $5, ifsc = $6, bank_name = $7,
              upi_link = $8, upi_pa = $9, upi_pn = $10,
              accepts_deposits = $11, pays_withdrawals = $12, status = $13,
              buy_sizes = $14::int[], sell_sizes = $15::int[], updated_at = now()
        WHERE account_id = $1 AND merchant_id = $2 AND status <> 'REMOVED'
        RETURNING *`,
      [String(accountId), String(merchantId), label, bank.holderName, bank.accountNo, bank.ifsc, bank.bankName,
        upi?.link ?? null, upi?.pa ?? null, upi?.pn ?? null,
        merged.acceptsDeposits === true, merged.paysWithdrawals === true, status, buySizes, sellSizes]);
    return rows[0] ? { ok: true, account: toAccount(rows[0]) } : { ok: false, reason: 'not_found' };
  });
}

/**
 * Say, in one save, which sizes go to which account (owner, 2026-10-20):
 * `assignments` is `[{ accountId, buySizes, sellSizes }]`, each a live account
 * of this merchant. All of it lands or none: the save is refused 409
 * SIZES_UNCOVERED if any required size is left with no account, and 404 if an
 * account is not this merchant's live one.
 */
export async function setAccountSizes(merchantId, assignments, { required = null } = {}) {
  if (!Array.isArray(assignments) || assignments.length === 0) {
    throw bad('Send each account with the sizes it takes.', 'INVALID_ORDER_SIZES');
  }
  const parsed = assignments.map((a) => ({
    accountId: String(a?.accountId ?? ''),
    buySizes: sizesOf(a?.buySizes ?? [], 'Buy sizes', []),
    sellSizes: sizesOf(a?.sellSizes ?? [], 'Sell sizes', []),
  }));
  if (new Set(parsed.map((a) => a.accountId)).size !== parsed.length) {
    throw bad('Each account is listed once.', 'INVALID_ORDER_SIZES');
  }
  return coveredWrite(merchantId, required, async (client) => {
    const accounts = [];
    for (const a of parsed) {
      const { rows } = await client.query(
        `UPDATE merchant_payment_accounts SET buy_sizes = $3::int[], sell_sizes = $4::int[], updated_at = now()
          WHERE account_id = $1 AND merchant_id = $2 AND status <> 'REMOVED'
          RETURNING *`,
        [a.accountId, String(merchantId), a.buySizes, a.sellSizes]);
      if (!rows[0]) return { ok: false, reason: 'not_found', accountId: a.accountId };
      accounts.push(toAccount(rows[0]));
    }
    return { ok: true, accounts };
  }, { strict: true });
}

/**
 * Remove an account, for good. Its assignments to sub-members go with it in
 * the same statement; the orders that name it keep naming it.
 */
export async function removeAccount(merchantId, accountId, { required = null } = {}) {
  return coveredWrite(merchantId, required, async (client) => {
    const { rows } = await client.query(
      `WITH gone AS (
         UPDATE merchant_payment_accounts
            SET status = 'REMOVED', removed_at = now(), updated_at = now()
          WHERE account_id = $1 AND merchant_id = $2 AND status <> 'REMOVED'
          RETURNING account_id)
       , unassigned AS (
         DELETE FROM merchant_staff_accounts WHERE account_id IN (SELECT account_id FROM gone))
       SELECT account_id FROM gone`,
      [String(accountId), String(merchantId)]);
    return rows[0] ? { ok: true } : { ok: false, reason: 'not_found' };
  });
}

export async function getAccount(merchantId, accountId) {
  const { rows } = await pgQuery(
    'SELECT * FROM merchant_payment_accounts WHERE account_id = $1 AND merchant_id = $2',
    [String(accountId), String(merchantId)], 'merchant_payment_account_get');
  return toAccount(rows[0]);
}

/** A merchant's accounts; removed ones only when asked for. */
export async function listAccounts(merchantId, { includeRemoved = false } = {}) {
  const { rows } = await pgQuery(
    `SELECT * FROM merchant_payment_accounts
      WHERE merchant_id = $1 AND ($2 OR status <> 'REMOVED')
      ORDER BY created_at`,
    [String(merchantId), Boolean(includeRemoved)], 'merchant_payment_account_list');
  return rows.map(toAccount);
}

/**
 * The account a merchant-account BUY of `sizeTokens` would be paid into: an
 * ACTIVE account of this merchant that accepts deposits and takes that size,
 * the least recently used first (never used first). A READ — the assignment
 * takes it with `takeDepositAccountWithin`, which asks again under the
 * account's lock. Null when there is none.
 */
export async function leastUsedDepositAccount(merchantId, sizeTokens) {
  const { rows } = await pgQuery(
    `SELECT * FROM merchant_payment_accounts
      WHERE merchant_id = $1 AND status = 'ACTIVE' AND accepts_deposits AND $2::int = ANY (buy_sizes)
      ORDER BY last_used_at ASC NULLS FIRST, created_at, account_id
      LIMIT 1`,
    [String(merchantId), Number(sizeTokens)], 'merchant_payment_account_least_used');
  return toAccount(rows[0]);
}

/**
 * Take that account for a buy, INSIDE the assigning transaction: still this
 * merchant's, still ACTIVE, still accepting deposits, still taking the size —
 * asked in the UPDATE's WHERE under its row lock (trap 18) — and stamped used,
 * so the next buy goes to the next account. Null when it no longer qualifies;
 * the caller refuses the candidate and the move unwinds.
 */
export async function takeDepositAccountWithin(client, merchantId, accountId, sizeTokens) {
  const { rows } = await client.query(
    `UPDATE merchant_payment_accounts SET last_used_at = clock_timestamp()
      WHERE account_id = $1 AND merchant_id = $2 AND status = 'ACTIVE' AND accepts_deposits
        AND $3::int = ANY (buy_sizes)
      RETURNING *`,
    [String(accountId), String(merchantId), Number(sizeTokens)]);
  return toAccount(rows[0]);
}

/**
 * Whether an account may pay this merchant's withdrawal of `sizeTokens` now:
 * this merchant's, ACTIVE, paying withdrawals, taking that size, and — when a
 * sub-member acts — one assigned to them for WITHDRAWAL (`allowedAccountIds`;
 * null for the owner). A READ, asked before the payout reference is claimed so
 * a wrong account costs nothing; `stampPaidFromWithin` asks it again where it
 * counts.
 */
export async function mayPayFrom(merchantId, accountId, { allowedAccountIds = null, sizeTokens } = {}) {
  if (!accountId) return false;
  if (allowedAccountIds && !allowedAccountIds.includes(String(accountId))) return false;
  const { rows } = await pgQuery(
    `SELECT 1 FROM merchant_payment_accounts
      WHERE account_id = $1 AND merchant_id = $2 AND status = 'ACTIVE' AND pays_withdrawals
        AND $3::int = ANY (sell_sizes)`,
    [String(accountId), String(merchantId), Number(sizeTokens)], 'merchant_payment_account_may_pay');
  return rows.length > 0;
}

/** Thrown inside the Paid transition when the account may not pay it: the move unwinds. */
export class PaidFromRefused extends Error {
  constructor() {
    super('Choose an active account of yours that pays withdrawals of this size (and, for a sub-member, one assigned to you).');
    this.status = 409;
    this.code = 'PAID_FROM_ACCOUNT_REFUSED';
  }
}

/**
 * Name the account a merchant-account SELL was paid from, INSIDE the Paid
 * transition (owner, 2026-10-11). The one writer of
 * `order_states.paid_from_account_id`. Every condition is in the UPDATE's
 * WHERE, under the order's lock (trap 18): the order is a withdrawal of this
 * account's merchant with none named yet, the account is ACTIVE, pays
 * withdrawals and takes the order's size, and a sub-member names only an
 * account assigned to them.
 * Throws `PaidFromRefused` otherwise, so the order does not reach PAID.
 */
export async function stampPaidFromWithin(client, { orderId, accountId, allowedAccountIds = null }) {
  const { rows } = await client.query(
    `UPDATE order_states o SET paid_from_account_id = $2
      WHERE o.order_id = $1 AND o.order_type = 'WITHDRAWAL' AND o.paid_from_account_id IS NULL
        AND EXISTS (SELECT 1 FROM merchant_payment_accounts a
                     WHERE a.account_id = $2 AND a.merchant_id = o.merchant_id
                       AND a.status = 'ACTIVE' AND a.pays_withdrawals
                       AND (o.token_amount_paise / 100)::int = ANY (a.sell_sizes))
        AND ($3::text[] IS NULL OR $2 = ANY ($3::text[]))
      RETURNING o.order_id`,
    [String(orderId), String(accountId ?? ''), allowedAccountIds ? [...allowedAccountIds] : null]);
  if (!rows[0]) throw new PaidFromRefused();
}
