// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
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
 * wallet row — except the `…Within` ones. Those are the player's half of a
 * TEAM POOL movement (a buy paid, a sell settled or reversed): the pool, the
 * wallet and the treasury movement between them are one fact, and the
 * database refuses to commit any of them alone (owner, 2026-10-07), so they
 * run inside `teamPools.js`'s transaction, after its order and pool locks.
 */
import { paiseToRupees, rupeesToPaise } from '../../backend/shared/money.js';
import { pgQuery } from '../client.js';
import {
  applyMovementPaise, applyMovementWithin, getBalancesPaise, withWalletLock,
} from './wallets.core.js';
import { ACCOUNTS } from './treasury.js';

/** Every balance a caller might read, in rupees. */
export async function getBalances(userId) {
  const paise = await getBalancesPaise(userId);
  return Object.fromEntries(
    Object.entries(paise).map(([field, value]) => [field, paiseToRupees(value)]),
  );
}

const rupees = paiseToRupees;

function mapRupees(paise) {
  return Object.fromEntries(Object.entries(paise).map(([f, v]) => [f, rupees(v)]));
}

// ── Deposits, winnings, reserve ──────────────────────────────────────────────

/**
 * How much of a completed buy lands in each pocket. ONE rule, in one place,
 * because three routes once had three and one of them created tokens.
 *
 * The player receives exactly the order's token amount. It is split between
 * `depositBalance` (usable for betting) and `reserveBalance` by the allocation
 * the active DepositPolicy locked onto the order at creation, when that
 * allocation is present and adds up; otherwise the whole amount goes to
 * deposit, which neither creates nor destroys a token. The allocation is
 * legitimately 0 twice over — a 100% reserve policy makes the deposit share 0,
 * and an order with no split reads 0/0 — so a zero is a value, never "absent"
 * (an `||` here once credited the whole amount to deposit AND to reserve).
 * A partial split is not a split to fall back from: it would leave the
 * difference unaccounted for, so it is refused by the row too
 * (`order_states_allocation_closes`).
 *
 * Paise, read from the order row the spend has LOCKED (§9).
 *
 * @returns {{depositPaise:number, reservePaise:number, split:boolean}}
 *   `depositPaise + reservePaise === amountPaise` always.
 */
export function buyCreditSplit({ amountPaise, depositAllocationPaise, reserveAllocationPaise }) {
  const total = Number(amountPaise) || 0;
  const deposit = Number(depositAllocationPaise);
  const reserve = Number(reserveAllocationPaise);
  const usable = Number.isInteger(deposit) && Number.isInteger(reserve)
    && deposit >= 0 && reserve >= 0
    && deposit + reserve === total;
  if (!usable) return { depositPaise: total, reservePaise: 0, split: false };
  return { depositPaise: deposit, reservePaise: reserve, split: true };
}

/**
 * A completed BUY reaching the player, INSIDE the transaction that takes the
 * tokens out of the team's pool (`teamPools.spendForBuy`): the pool, the
 * player's wallet and the TEAM_FLOAT → USER_FLOAT movement commit together or
 * not at all. Split by `buyCreditSplit`; keys `dep_complete_<orderId>` and
 * `reserve_credit_<orderId>`, so a replay collides on the first and moves
 * nothing.
 *
 * `ctx` is `lockWalletWithin`'s: the caller holds the order and pool locks and
 * takes the wallet's next, in that order (see `lockWalletWithin`).
 */
export async function creditBuyWithin(ctx, { orderId, amountPaise, depositAllocationPaise, reserveAllocationPaise }) {
  const split = buyCreditSplit({ amountPaise, depositAllocationPaise, reserveAllocationPaise });
  const slices = [
    { field: 'depositBalance', amountPaise: split.depositPaise, txId: `dep_complete_${orderId}`, reason: `P2P deposit confirmed ${orderId}` },
    { field: 'reserveBalance', amountPaise: split.reservePaise, txId: `reserve_credit_${orderId}`, reason: `Deposit reserve allocation ${orderId}` },
  ].filter((s) => s.amountPaise > 0);
  if (!slices.length) throw new Error(`creditBuyWithin: order ${orderId} credits nothing`);
  const moved = await applyMovementWithin(ctx, {
    legs: slices.map((s) => ({ field: s.field, deltaPaise: s.amountPaise })),
    ledger: slices.map((s) => ({
      txId: s.txId, field: s.field, amountPaise: s.amountPaise, type: 'CREDIT', reason: s.reason, refId: orderId,
    })),
    // TEAM_FLOAT → USER_FLOAT is the pool spend's own movement (`team_buy_<id>`).
    counterparty: { postedByCaller: true },
  });
  return { ...moved, split };
}

/**
 * wallet.service.creditWinnings — caller supplies the txId.
 *
 * Winnings no game paid: a referral reward is the one production caller. The
 * platform pays it out of its own holding, TOKEN_SUPPLY → USER_FLOAT, in the
 * same transaction (owner, 2026-10-07). A game's payout is not this: it is
 * the bet's or the round's own settlement, against the house.
 */
export async function creditWinnings(userId, amount, reason, refModel, refId, txId) {
  if (!txId) throw new Error('creditWinnings on Postgres requires a deterministic txId');
  const amountPaise = rupeesToPaise(amount);
  if (amountPaise <= 0) throw new Error(`Invalid credit amount: ${amount}`);
  const field = 'winningsBalance';
  const description = reason || 'Winnings credited';

  const result = await applyMovementPaise({
    userId,
    legs: [{ field, deltaPaise: amountPaise }],
    ledger: [{ txId, field, amountPaise, type: 'CREDIT', reason: description, refId }],
    counterparty: {
      account: ACCOUNTS.TOKEN_SUPPLY, operation: 'WINNINGS_CREDITED',
      reason: description, refModel: refModel ?? null, refId: refId ?? null,
    },
  });
  if (result.idempotent) return { idempotent: true, txId };
  if (!result.ok) throw new Error(`creditWinnings refused: ${result.refused ?? 'insufficient'}`);

  const after = rupees(result.balancesAfterPaise[field]);
  return {
    before: rupees(result.balancesAfterPaise[field] - amountPaise), after, winningsAfter: after,
    depositAfter: rupees(result.balancesAfterPaise.depositBalance), txId,
    balances: mapRupees(result.balancesAfterPaise),
  };
}

// ── Spending ────────────────────────────────────────────────────────────────


/**
 * wallet.service.debitWinningsForWithdrawal — winnings → locked, ONE ledger row
 * keyed `wd_<orderId>`. Only winnings are withdrawable; deposit is never touched.
 *
 * ── `within`: the order the lock is FOR, committed with it ──────────────────
 * A lock with no order behind it is money nothing will ever release — no
 * expiry sweep, cancel or refund can find it, because they all start from the
 * order. So the caller passes the order's INSERT (`prepareOrderRecord`) and it
 * runs here, on this connection, under this row lock, after the movement. If
 * the INSERT is refused the whole transaction unwinds and the winnings never
 * left; if it lands, the lock and its order exist together.
 *
 * Without `within` it is the bare movement, for the suites that stage a locked
 * balance to test release and refund against.
 */
export async function debitWinningsForWithdrawal(userId, amount, orderId, { within = null } = {}) {
  const amountPaise = rupeesToPaise(amount);
  if (amountPaise <= 0) throw new Error(`Invalid withdrawal amount: ${amount}`);
  const txId = `wd_${orderId}`;

  const result = await withWalletLock(userId, async (ctx) => {
    const moved = await applyMovementWithin(ctx, {
      legs: [
        { field: 'winningsBalance', deltaPaise: -amountPaise },
        { field: 'lockedBalance',   deltaPaise:  amountPaise },
      ],
      ledger: [{
        txId, field: 'winningsBalance', amountPaise: -amountPaise, type: 'DEBIT',
        reason: `P2P withdrawal order ${orderId}`, refId: orderId,
      }],
    });
    // Refused, or already done: nothing further may be written. A replay that
    // collided on the ledger key has also aborted this transaction, so it must
    // unwind before anything else runs on the connection.
    if (!moved.ok || moved.idempotent) return { commit: false, value: moved };
    const record = within ? await within(ctx.client) : null;
    return { commit: true, value: { ...moved, record } };
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
    // What `within` wrote — the order — when there was one.
    ...(within ? { record: result.record } : {}),
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
 * A settled SELL consuming the player's locked stake, INSIDE the transaction
 * that puts the tokens in the team's pool (`teamPools.creditSellToPool`): the
 * stake, the pool and the USER_FLOAT → TEAM_FLOAT movement commit together, so
 * there is no moment at which the tokens are in both places, or in neither.
 * Key `wd_release_<id>`.
 *
 * The ledger row is labelled `lockedBalance`, which is the balance that
 * actually moved. Labelling it `winningsBalance` while reporting locked figures
 * — as this once did — makes the ledger describe a movement that did not happen
 * and corrupts a rollback, so this path records the field it moved.
 *
 * A stake already RETURNED to the player (`refund_<id>`) cannot also be
 * consumed: what is left in `locked` belongs to other orders (`excluded`).
 */
export async function consumeWithdrawalStakeWithin(ctx, { orderId, amountPaise }) {
  return applyMovementWithin(ctx, {
    legs: [{ field: 'lockedBalance', deltaPaise: -amountPaise }],
    ledger: [{
      txId: `wd_release_${orderId}`, field: 'lockedBalance', amountPaise: -amountPaise, type: 'DEBIT',
      reason: `Withdrawal approved — request ${orderId}`, refId: orderId,
    }],
    excludes: [`refund_${orderId}`],
    // USER_FLOAT → TEAM_FLOAT is the pool credit's own movement (`team_sell_<id>`).
    counterparty: { postedByCaller: true },
  });
}

/**
 * A settled SELL refunded after all: its consumed stake comes back to the
 * player as winnings, INSIDE the transaction that takes the tokens back out of
 * the pool or has the platform cover them (`teamPools.reverseSellFromPool`).
 * Key `dispute_wd_refund_<id>`.
 */
export async function returnSettledStakeWithin(ctx, { orderId, amountPaise }) {
  return applyMovementWithin(ctx, {
    legs: [{ field: 'winningsBalance', deltaPaise: amountPaise }],
    ledger: [{
      txId: `dispute_wd_refund_${orderId}`, field: 'winningsBalance', amountPaise, type: 'CREDIT',
      reason: `Dispute resolved — withdrawal refunded after settlement: ${orderId}`, refId: orderId,
    }],
    // TEAM_FLOAT (or TOKEN_SUPPLY) → USER_FLOAT is the reversal's own movement.
    counterparty: { postedByCaller: true },
  });
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
    // A stake already CONSUMED has left `locked`; what is there now belongs to
    // other orders, and returning it would pay this refund out of theirs.
    excludes: [`wd_release_${withdrawalId}`],
  });

  if (result.idempotent) return { idempotent: true, txId };
  if (result.excluded) {
    throw Object.assign(new Error(`Withdrawal ${withdrawalId} was already settled; its stake is no longer locked`), { status: 409 });
  }
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
    balances: mapRupees(after),
  };
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
