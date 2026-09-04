// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * repositories/wallets.js — every balance mutation, in the vocabulary the
 * application speaks.
 *
 * `walletAuthority.service.js` is the single entry point every route and engine
 * calls to move money; this is what it calls. There is one implementation.
 *
 * ── The two contracts this file must not break ──────────────────────────────
 *
 * 1. RETURN SHAPES. Callers (settlement, payouts, admin routes) read fields
 *    like `winningsAfter` and `idempotent` off these results. Amounts crossing
 *    back out are RUPEES: paise stops at this wall, because rupees are what the
 *    routes serialise and the panels render. Inside, and at rest, money is
 *    integer paise in BIGINT and nothing else.
 *
 * 2. IDEMPOTENCY KEYS. Every txId is deterministic and derived from the thing
 *    it pays for (`wd_lock_<id>`, `dep_complete_<id>`, `<base>_dep`/`_win`, …),
 *    never generated per call. `wallet_ledger.tx_id` is UNIQUE, so the retry of
 *    a request that already moved money matches the existing row instead of
 *    moving it again. A random key would leave that constraint unable to fire —
 *    a gate that exists, is tested, and protects nothing.
 *
 * ── Why a movement is its own transaction ───────────────────────────────────
 * Each function here opens and commits its own transaction: the balance and its
 * ledger rows land together or not at all, under `SELECT … FOR UPDATE` on the
 * wallet row. A caller cannot enlist a movement in some larger unit of its own,
 * and does not need to — the deterministic txId means a retry after any outer
 * failure is a no-op rather than a double spend.
 */
import { paiseToRupees, rupeesToPaise } from '../../backend/shared/money.js';
import { pgQuery } from '../client.js';
import {
  applyMovementPaise, debitSpendOrderPaise, getBalancesPaise,
} from './wallets.core.js';

/** Every balance a caller might read, in rupees. */
export async function getBalances(userId) {
  const paise = await getBalancesPaise(userId);
  return Object.fromEntries(
    Object.entries(paise).map(([field, value]) => [field, paiseToRupees(value)]),
  );
}

const rupees = paiseToRupees;

/**
 * Credit one field. Covers creditWinnings / creditDeposit / creditReserve,
 * which differ only by field, reason and key format.
 */
async function credit({ userId, field, amount, txId, reason, refId, type = 'CREDIT' }) {
  const amountPaise = rupeesToPaise(amount);
  if (amountPaise <= 0) throw new Error(`Invalid credit amount: ${amount}`);

  const result = await applyMovementPaise({
    userId,
    legs: [{ field, deltaPaise: amountPaise }],
    ledger: [{ txId, field, amountPaise, type, reason, refId }],
  });
  if (result.idempotent) return { idempotent: true, txId };

  const after = rupees(result.balancesAfterPaise[field]);
  return {
    txId,
    before: rupees(result.balancesAfterPaise[field] - amountPaise),
    after,
    balances: mapRupees(result.balancesAfterPaise),
  };
}

function mapRupees(paise) {
  return Object.fromEntries(Object.entries(paise).map(([f, v]) => [f, rupees(v)]));
}

// ── Deposits, winnings, reserve ──────────────────────────────────────────────

/** wallet.service.creditDeposit — txId `dep_complete_<orderId>`. */
export async function creditDeposit(userId, amount, orderId) {
  const r = await credit({
    userId, field: 'depositBalance', amount,
    txId: `dep_complete_${orderId}`,
    reason: `P2P deposit confirmed ${orderId}`, refId: orderId,
  });
  return r.idempotent ? r : { depositBefore: r.before, depositAfter: r.after, txId: r.txId, balances: r.balances };
}

/** wallet.service.creditReserve — txId `reserve_credit_<orderId>`. */
export async function creditReserve(userId, amount, orderId) {
  const r = await credit({
    userId, field: 'reserveBalance', amount,
    txId: `reserve_credit_${orderId}`,
    reason: `Deposit reserve allocation ${orderId}`, refId: orderId,
  });
  return r.idempotent ? r : { reserveBefore: r.before, reserveAfter: r.after, txId: r.txId, balances: r.balances };
}

/** wallet.service.creditWinnings — caller supplies the txId. */
export async function creditWinnings(userId, amount, reason, refModel, refId, txId) {
  if (!txId) throw new Error('creditWinnings on Postgres requires a deterministic txId');
  const r = await credit({
    userId, field: 'winningsBalance', amount, txId,
    reason: reason || 'Bet win payout', refId,
  });
  if (r.idempotent) return r;
  return {
    before: r.before, after: r.after, winningsAfter: r.after,
    depositAfter: r.balances.depositBalance, txId: r.txId, balances: r.balances,
  };
}

/** wallet.service.refundOrder — txId `refund_<orderId>`, field chosen by caller. */
export async function refundOrder(userId, amount, orderId, field = 'depositBalance') {
  const r = await credit({
    userId, field, amount,
    txId: `refund_${orderId}`,
    reason: `Refund for cancelled order ${orderId}`, refId: orderId,
  });
  return r.idempotent ? r : { before: r.before, after: r.after, txId: r.txId, balances: r.balances };
}

// ── Spending ────────────────────────────────────────────────────────────────

/**
 * wallet.service.debitForBet — deposit first, winnings covers the shortfall.
 * Rows are keyed `<base>_dep` / `<base>_win`, one per pocket the stake drew
 * from, so a partially funded bet is reconstructable from the ledger alone.
 */
export async function debitForBet(userId, amount, reason, refModel, refId, txId) {
  if (!txId) throw new Error('debitForBet on Postgres requires a deterministic txId');
  const amountPaise = rupeesToPaise(amount);
  if (amountPaise <= 0) throw new Error(`Invalid debit amount: ${amount}`);

  const result = await debitSpendOrderPaise({
    userId, amountPaise, txId, refId, type: 'DEBIT',
    pockets: [
      { field: 'depositBalance',  suffix: '_dep', reason },
      { field: 'winningsBalance', suffix: '_win', reason: `${reason} (winnings shortfall)` },
    ],
  });

  if (result.idempotent) return { idempotent: true, txId };
  if (!result.ok) {
    // Callers match on this message and failure mode — do not reword it.
    throw new Error(`Insufficient balance: have ₹${rupees(result.availablePaise ?? 0)}, need ₹${amount}`);
  }

  const after = result.balancesAfterPaise;
  const fromDeposit  = rupees(result.split.depositBalance  || 0);
  const fromWinnings = rupees(result.split.winningsBalance || 0);
  return {
    txId,
    depositBefore:  rupees(after.depositBalance)  + fromDeposit,
    winningsBefore: rupees(after.winningsBalance) + fromWinnings,
    depositAfter:   rupees(after.depositBalance),
    winningsAfter:  rupees(after.winningsBalance),
    fromDeposit, fromWinnings,
    balances: mapRupees(after),
  };
}

/**
 * wallet.service.debitWinningsForWithdrawal — winnings → locked, ONE ledger row
 * keyed `wd_<orderId>`. Only winnings are withdrawable; deposit is never touched.
 */
export async function debitWinningsForWithdrawal(userId, amount, orderId) {
  const amountPaise = rupeesToPaise(amount);
  if (amountPaise <= 0) throw new Error(`Invalid withdrawal amount: ${amount}`);
  const txId = `wd_${orderId}`;

  const result = await applyMovementPaise({
    userId,
    legs: [
      { field: 'winningsBalance', deltaPaise: -amountPaise },
      { field: 'lockedBalance',   deltaPaise:  amountPaise },
    ],
    ledger: [{
      txId, field: 'winningsBalance', amountPaise: -amountPaise, type: 'DEBIT',
      reason: `P2P withdrawal order ${orderId}`, refId: orderId,
    }],
  });

  if (result.idempotent) return { idempotent: true, txId };
  if (!result.ok) {
    // A refusal here is an EXPECTED answer, not a fault: the player asked for
    // more than they hold. The figures ride on the error so the caller can tell
    // them what is actually available without parsing the message — and so a
    // route can answer 400 rather than 500.
    const balances = await getBalancesPaise(userId);
    throw Object.assign(
      new Error(`Insufficient withdrawable balance: have ₹${rupees(balances.winningsBalance)}, need ₹${amount}. Only winnings are withdrawable.`),
      {
        status: 400,
        code: 'INSUFFICIENT_WITHDRAWABLE',
        availableWinnings: rupees(balances.winningsBalance),
        requested: amount,
      },
    );
  }

  const after = result.balancesAfterPaise;
  return {
    txId,
    winningsBefore: rupees(after.winningsBalance) + amount,
    winningsAfter:  rupees(after.winningsBalance),
    lockedAfter:    rupees(after.lockedBalance),
    balances: mapRupees(after),
  };
}

// ── Withdrawal lifecycle ────────────────────────────────────────────────────

/** walletAuthority.lockWithdrawal — winnings → locked, txId `wd_lock_<id>`. */
export async function lockWithdrawal(userId, amount, withdrawalId) {
  const amountPaise = rupeesToPaise(amount);
  const txId = `wd_lock_${withdrawalId}`;

  const result = await applyMovementPaise({
    userId,
    legs: [
      { field: 'winningsBalance', deltaPaise: -amountPaise },
      { field: 'lockedBalance',   deltaPaise:  amountPaise },
    ],
    ledger: [{
      txId, field: 'winningsBalance', amountPaise: -amountPaise, type: 'DEBIT',
      reason: `Withdrawal locked — request ${withdrawalId}`, refId: withdrawalId,
    }],
  });

  if (result.idempotent) return { idempotent: true, txId };
  if (!result.ok) {
    const balances = await getBalancesPaise(userId);
    throw new Error(`Insufficient withdrawable balance: have ₹${rupees(balances.winningsBalance)}, need ₹${amount}`);
  }

  const after = result.balancesAfterPaise;
  return {
    txId,
    winningsBefore: rupees(after.winningsBalance) + amount,
    winningsAfter:  rupees(after.winningsBalance),
    lockedAfter:    rupees(after.lockedBalance),
  };
}

/**
 * walletAuthority.releaseWithdrawal — approved: the locked money leaves the
 * platform. txId `wd_release_<id>`.
 *
 * The ledger row is labelled `lockedBalance`, which is the balance that
 * actually moved. Labelling it `winningsBalance` while reporting locked figures
 * — as this once did — makes the ledger describe a movement that did not happen
 * and corrupts a
 * rollback, so this path records the field it moved.
 */
export async function releaseWithdrawal(userId, amount, withdrawalId) {
  const amountPaise = rupeesToPaise(amount);
  const txId = `wd_release_${withdrawalId}`;

  const result = await applyMovementPaise({
    userId,
    legs: [{ field: 'lockedBalance', deltaPaise: -amountPaise }],
    ledger: [{
      txId, field: 'lockedBalance', amountPaise: -amountPaise, type: 'DEBIT',
      reason: `Withdrawal approved — request ${withdrawalId}`, refId: withdrawalId,
    }],
  });

  if (result.idempotent) return { idempotent: true, txId };
  if (!result.ok) {
    const balances = await getBalancesPaise(userId);
    throw new Error(`lockedBalance would go negative: current=${rupees(balances.lockedBalance)} debit=${amount}`);
  }

  const after = result.balancesAfterPaise;
  return { txId, lockedBefore: rupees(after.lockedBalance) + amount, lockedAfter: rupees(after.lockedBalance) };
}

/**
 * walletAuthority.refundWithdrawal — rejected: locked returns to winnings.
 * txId `refund_<id>`, preserved from the pre-2026-07-10 delegation so
 * historical idempotency continuity holds.
 */
export async function refundWithdrawal(userId, amount, withdrawalId) {
  const amountPaise = rupeesToPaise(amount);
  const txId = `refund_${withdrawalId}`;

  const result = await applyMovementPaise({
    userId,
    legs: [
      { field: 'winningsBalance', deltaPaise:  amountPaise },
      { field: 'lockedBalance',   deltaPaise: -amountPaise },
    ],
    ledger: [{
      txId, field: 'winningsBalance', amountPaise, type: 'CREDIT',
      reason: `Withdrawal rejected — request ${withdrawalId} refunded to winnings`,
      refId: withdrawalId,
    }],
  });

  if (result.idempotent) return { idempotent: true, txId };
  if (!result.ok) {
    const balances = await getBalancesPaise(userId);
    throw new Error(`lockedBalance would go negative on refund: current=${rupees(balances.lockedBalance)} refund=${amount}`);
  }

  const after = result.balancesAfterPaise;
  return {
    txId,
    winningsBefore: rupees(after.winningsBalance) - amount,
    winningsAfter:  rupees(after.winningsBalance),
    lockedAfter:    rupees(after.lockedBalance),
  };
}

// ── Bet stake lifecycle ─────────────────────────────────────────────────────

/**
 * walletAuthority.lockBetStake — bet placement: move the stake out of its
 * pockets into `locked`, recording which pocket each slice came from.
 *
 * ONE transaction covers the balance move, the lock-provenance counters and
 * every audit row. This used to be a guarded multi-field update followed by
 * fire-and-forget ledger writes, so a crash in between left a debited balance
 * with no
 * audit trail. Here that window does not exist.
 *
 * @param {Array<{field:string, suffix:string, amountPaise:number, reason:string}>} slices
 */
export async function lockBetStake(userId, { amountPaise, txId, refId, slices }) {
  const provenance = {
    depositBalance:  'lockedDepositAmount',
    winningsBalance: 'lockedWinningsAmount',
  };

  const result = await applyMovementPaise({
    userId,
    legs: [
      { field: 'lockedBalance', deltaPaise: amountPaise },
      ...slices.flatMap((s) => [
        { field: s.field, deltaPaise: -s.amountPaise },
        // The reserve slice has no provenance counter: reserve is platform
        // money, not the player's, so there is no split to unwind later.
        ...(provenance[s.field] ? [{ field: provenance[s.field], deltaPaise: s.amountPaise }] : []),
      ]),
    ],
    ledger: slices.map((s) => ({
      txId: `${txId}${s.suffix}`, field: s.field, amountPaise: -s.amountPaise,
      type: 'DEBIT', reason: s.reason, refId,
    })),
  });

  if (result.idempotent) return { ok: true, idempotent: true, txId };
  if (!result.ok) return { ok: false, insufficient: true, txId };
  return { ok: true, idempotent: false, txId, balances: mapRupees(result.balancesAfterPaise) };
}

/**
 * walletAuthority.unlockBetStake — the exact reverse, for the compensating path
 * when the cycle closes between the debit and the pool commit. Atomic for the
 * same reason: a partial restore is worse than no bet.
 */
export async function unlockBetStake(userId, { amountPaise, txId, refId, slices }) {
  const provenance = {
    depositBalance:  'lockedDepositAmount',
    winningsBalance: 'lockedWinningsAmount',
  };

  const result = await applyMovementPaise({
    userId,
    legs: [
      { field: 'lockedBalance', deltaPaise: -amountPaise },
      ...slices.flatMap((s) => [
        { field: s.field, deltaPaise: s.amountPaise },
        ...(provenance[s.field]
          ? [{ field: provenance[s.field], deltaPaise: -s.amountPaise, allowNegative: true }]
          : []),
      ]),
    ],
    ledger: slices.map((s) => ({
      txId: `${txId}${s.suffix}`, field: s.field, amountPaise: s.amountPaise,
      type: 'CREDIT', reason: s.reason, refId,
    })),
  });

  if (result.idempotent) return { ok: true, idempotent: true, txId };
  if (!result.ok) return { ok: false, insufficient: true, txId };
  return { ok: true, idempotent: false, txId, balances: mapRupees(result.balancesAfterPaise) };
}

/**
 * walletAuthority.releaseLockedStake — settlement releases a bet's locked
 * stake, and the lock-provenance counters unwind with it.
 *
 * The provenance legs are allowed to go negative, deliberately: a stale split
 * must not be able to strand a settled stake in `locked` forever, which is the
 * worse failure of the two.
 */
export async function releaseLockedStake(userId, { amount, fromDeposit = 0, fromWinnings = 0, txId, reason }) {
  if (!txId) throw new Error('releaseLockedStake requires a deterministic txId');
  if (!(amount > 0)) throw new Error(`releaseLockedStake: invalid amount ${amount}`);
  const amountPaise = rupeesToPaise(amount);

  const result = await applyMovementPaise({
    userId,
    legs: [
      { field: 'lockedBalance',        deltaPaise: -amountPaise },
      { field: 'lockedDepositAmount',  deltaPaise: -rupeesToPaise(fromDeposit  || 0), allowNegative: true },
      { field: 'lockedWinningsAmount', deltaPaise: -rupeesToPaise(fromWinnings || 0), allowNegative: true },
    ],
    ledger: [{
      txId, field: 'lockedBalance', amountPaise: -amountPaise, type: 'DEBIT',
      reason: reason || 'Bet stake unlock — cycle settlement',
    }],
  });

  if (result.idempotent) return { idempotent: true, txId };
  if (!result.ok) {
    const balances = await getBalancesPaise(userId);
    throw new Error(`lockedBalance would go negative: current=${rupees(balances.lockedBalance)} debit=${amount}`);
  }

  const after = result.balancesAfterPaise;
  return { txId, lockedBefore: rupees(after.lockedBalance) + amount, lockedAfter: rupees(after.lockedBalance) };
}

// ── Reads ───────────────────────────────────────────────────────────────────

/**
 * walletAuthority.getUserLedger — the same paginated history, read from
 * wallet_ledger and reshaped into the WalletLedger doc the panels render.
 */
/**
 * Platform-wide wallet movement, a page at a time, with the player's name.
 *
 * ── Three things the endpoint above this was doing wrong ───────────────────
 *   • It read a `transactions` collection that stopped receiving writes when
 *     the money moved to PostgreSQL. The admin transaction list showed only
 *     pre-migration history and nothing since.
 *   • It ran the page and the count as two statements, so the total could
 *     describe a different instant than the rows.
 *   • It called `.populate('userId', …)` to attach a username. On a plain row
 *     that is a TypeError; the join does it here, in the same statement, so
 *     one page is one round trip rather than one plus a lookup per row.
 *
 * `field` filters by pocket (depositBalance, winningsBalance…) and `txType` by
 * direction (CREDIT / DEBIT), which is the vocabulary the ledger actually uses.
 */
export async function platformLedger({ field = null, txType = null, page = 1, limit = 50 } = {}) {
  const where = []; const params = [];
  if (field)  { params.push(String(field));  where.push(`l.field = $${params.length}`); }
  if (txType) { params.push(String(txType)); where.push(`l.tx_type = $${params.length}`); }

  const size = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const wanted = Math.max(Number(page) || 1, 1);
  params.push(size, (wanted - 1) * size);

  const { rows } = await pgQuery(
    `SELECT l.tx_id, l.user_id, l.field, l.amount_paise, l.balance_before_paise,
            l.balance_after_paise, l.tx_type, l.description, l.ref_id, l.created_at,
            u.username, u.mobile,
            COUNT(*) OVER () AS total_matching
       FROM wallet_ledger l
       LEFT JOIN users u ON u.user_id = l.user_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY l.created_at DESC, l.id DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params, 'wallet_ledger_platform',
  );

  const total = rows.length ? Number(rows[0].total_matching) : 0;
  return {
    total, page: wanted, limit: size,
    pages: Math.max(Math.ceil(total / size), 1),
    entries: rows.map((r) => {
      const amount = Number(r.amount_paise);
      const balanceAfter = Number(r.balance_after_paise);
      return {
        txId: r.tx_id,
        userId: r.user_id,
        // A LEFT JOIN so a ledger row survives a user row that is gone. The
        // money moved; losing its record because the account was deleted would
        // put a hole in the one trail reconciliation is computed from.
        user: r.username ? { userId: r.user_id, username: r.username, mobile: r.mobile } : null,
        type: r.tx_type, field: r.field,
        amount: rupees(amount),
        balanceBefore: rupees(
          r.balance_before_paise != null
            ? Number(r.balance_before_paise)
            : (r.tx_type === 'DEBIT' ? balanceAfter + amount : balanceAfter - amount),
        ),
        balanceAfter: rupees(balanceAfter),
        reason: r.description, refId: r.ref_id, createdAt: r.created_at,
      };
    }),
  };
}

export async function getUserLedger(userId, page = 1, limit = 30) {
  const uid = String(userId);
  const offset = (Math.max(1, page) - 1) * limit;

  const [{ rows }, { rows: [count] }] = await Promise.all([
    pgQuery(
      `SELECT tx_id, field, amount_paise, balance_before_paise, balance_after_paise,
              tx_type, description, ref_id, created_at
         FROM wallet_ledger WHERE user_id = $1
        ORDER BY created_at DESC, id DESC LIMIT $2 OFFSET $3`,
      [uid, limit, offset], 'wallet_ledger_page',
    ),
    pgQuery(`SELECT COUNT(*)::int AS n FROM wallet_ledger WHERE user_id = $1`, [uid], 'wallet_ledger_count'),
  ]);

  const total = count?.n ?? 0;
  return {
    total,
    pages: Math.ceil(total / limit),
    entries: rows.map((r) => {
      const amount = Number(r.amount_paise);
      const balanceAfter = Number(r.balance_after_paise);
      return {
        txId: r.tx_id,
        userId: uid,
        type: r.tx_type,
        field: r.field,
        amount: rupees(amount),
        // Derived in paise for rows predating balance_before_paise, so the
        // arithmetic stays exact.
        balanceBefore: rupees(
          r.balance_before_paise != null
            ? Number(r.balance_before_paise)
            : (r.tx_type === 'DEBIT' ? balanceAfter + amount : balanceAfter - amount),
        ),
        balanceAfter: rupees(balanceAfter),
        reason: r.description,
        refId: r.ref_id,
        createdAt: r.created_at,
      };
    }),
  };
}
