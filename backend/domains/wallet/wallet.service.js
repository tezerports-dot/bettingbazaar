// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)


import mongoose from 'mongoose';
import crypto   from 'crypto';

// ── Helpers ───────────────────────────────────────────────────────────────────

function round2(n) { return Math.round((n || 0) * 100) / 100; }

export function sseBalancePush(userId, depositBalance, winningsBalance) {
  try {
    global.sseManager?.sendToUser?.(String(userId), 'balance_update', {
      depositBalance:  round2(depositBalance),
      winningsBalance: round2(winningsBalance),
      totalBalance:    round2(depositBalance + winningsBalance),
    });
  } catch (_) { /* SSE is best-effort — never block the transaction */ }
}

async function checkIdempotent(txId) {
  if (!txId) return false;
  const WalletLedger = mongoose.model('WalletLedger');
  return !!(await WalletLedger.findOne({ txId }).lean());
}

/**
 * Has ANY row for this movement already landed? Takes every key the movement
 * could have written, not just one of them.
 *
 * This exists because debitForBet's key depends on the SPLIT it chose:
 * `<base>_dep` when deposit covered part of it, `<base>_win` for the winnings
 * shortfall, and only the pockets it actually drew from get a row. Checking a
 * single suffix is therefore not a replay check — it asks "did the original
 * happen to draw from THIS pocket", which is a different question.
 *
 * Pass `session` to run it INSIDE the transaction. The unique txId index is the
 * durable gate for a key the replay re-writes; it cannot fire for a key the
 * replay does not write, so a replay that lands on a different pocket needs
 * this probe to stop it. See the hazard note on debitForBet.
 */
async function anyLedgerRowExists(txIds, session = null) {
  const candidates = txIds.filter(Boolean);
  if (!candidates.length) return false;
  const WalletLedger = mongoose.model('WalletLedger');
  const q = WalletLedger.findOne({ txId: { $in: candidates } }).select('_id');
  if (session) q.session(session);
  return !!(await q.lean());
}

/** Every ledger key a debitForBet movement with this base could produce. */
function debitBetTxIdCandidates(baseTid) {
  return [baseTid, `${baseTid}_dep`, `${baseTid}_win`];
}

// The DURABLE idempotency gate (F-2, 2026-07-10). checkIdempotent above is a
// fast-path read — two truly concurrent calls can both pass it. What actually
// prevents double money movement is the WalletLedger's UNIQUE txId index:
// the loser's transaction aborts on it (directly, or after MongoDB's
// transient write-conflict retry re-runs the callback against the winner's
// committed state) and must resolve as { idempotent } instead of erroring
// the caller (e.g. a settlement pass racing the payout recovery task).
function isDuplicateTxId(err) {
  return err?.code === 11000 || /duplicate key/i.test(err?.message || '');
}

// ── DEBIT (for bets only) ─────────────────────────────────────────────────────
/**
 * debitForBet — deduct `amount` from user wallet for a game bet.
 * Spend order: depositBalance first → winningsBalance covers shortfall.
 * depositBalance is NOT available for withdrawal — only for play.
 */
export async function debitForBet(userId, amount, reason, refModel, refId, txId, extSession) {
  amount = round2(amount);
  if (amount <= 0) throw new Error(`Invalid debit amount: ${amount}`);
  const tid = txId || `debit_${crypto.randomUUID()}`;

  const _baseTid = tid.replace(/_dep$/, '').replace(/_win$/, '');
  const _candidates = debitBetTxIdCandidates(_baseTid);

  // Fast path only — cheap enough to skip starting a transaction, but NOT the
  // guarantee. The probe inside run() is.
  if (await anyLedgerRowExists(_candidates)) return { idempotent: true, txId: _baseTid };

  const User         = mongoose.model('User');
  const WalletLedger = mongoose.model('WalletLedger');

  const run = async (session) => {
    // ── Replay gate (must stay INSIDE the transaction) ───────────────────────
    // The unique txId index catches a replay only when the replay writes a key
    // that ALREADY EXISTS. Here the key depends on the split, and the split is
    // recomputed from the balances as they are NOW — so a replay can legally
    // land on a different pocket and collide with nothing:
    //
    //   original: deposit 0, winnings 100, bet 50 → writes <base>_win only
    //   …a deposit lands…
    //   replay:   deposit 100, winnings 50, bet 50 → writes <base>_dep only
    //
    // No key repeats, the unique index never fires, the transaction commits,
    // and the user is charged twice for one bet. The pre-read did not catch it
    // either, because it only looked for `_dep` and the bare key.
    //
    // Probing every candidate key closes it: any one surviving row proves the
    // movement already ran, whichever pocket it drew from. Inside the
    // transaction this is durable against an attempt that has already
    // committed, and concurrent attempts still serialise on the User document
    // write conflict, after which withTransaction re-runs this callback and the
    // probe sees the winner's row.
    //
    // This is the same hazard postgres/walletPg.js documents on
    // debitSpendOrderPaise, which solves it with an under-lock probe.
    if (await anyLedgerRowExists(_candidates, session)) {
      return { idempotent: true, txId: _baseTid };
    }

    const user = await User.findById(userId).session(session);
    if (!user) throw new Error('User not found');

    const depBal = round2(user.depositBalance  || 0);
    const winBal = round2(user.winningsBalance || 0);
    const total  = round2(depBal + winBal);

    if (total < amount)
      throw new Error(`Insufficient balance: have ₹${total}, need ₹${amount}`);

    // Deposit first, winnings covers shortfall
    const fromDeposit  = round2(Math.min(depBal, amount));
    const fromWinnings = round2(amount - fromDeposit);
    const newDeposit   = round2(depBal  - fromDeposit);
    const newWinnings  = round2(winBal  - fromWinnings);

    await User.findByIdAndUpdate(userId,
      { $inc: { depositBalance: -fromDeposit, winningsBalance: -fromWinnings } },
      { session });

    const entries = [];
    if (fromDeposit > 0) {
      const [e] = await WalletLedger.create([{
        userId, type: 'DEBIT', field: 'depositBalance',
        amount: fromDeposit, balanceBefore: depBal, balanceAfter: newDeposit,
        reason, refModel, refId, txId: tid + '_dep',
      }], { session });
      entries.push(e._id);
    }
    if (fromWinnings > 0) {
      const [e] = await WalletLedger.create([{
        userId, type: 'DEBIT', field: 'winningsBalance',
        amount: fromWinnings, balanceBefore: winBal, balanceAfter: newWinnings,
        reason: `${reason} (winnings shortfall)`, refModel, refId, txId: tid + '_win',
      }], { session });
      entries.push(e._id);
    }

    sseBalancePush(userId, newDeposit, newWinnings);
    return { depositBefore: depBal, winningsBefore: winBal,
             depositAfter: newDeposit, winningsAfter: newWinnings,
             fromDeposit, fromWinnings, ledgerIds: entries, txId: tid };
  };

  if (extSession) return run(extSession);
  const session = await mongoose.startSession();
  try {
    let r; await session.withTransaction(async () => { r = await run(session); }); return r;
  } catch (err) {
    if (isDuplicateTxId(err)) return { idempotent: true, txId: tid }; // concurrent duplicate — see isDuplicateTxId
    throw err;
  } finally { await session.endSession(); }
}

// ── DEBIT WINNINGS ONLY (for withdrawals) ─────────────────────────────────────
/**
 * debitWinningsForWithdrawal — deduct from winningsBalance ONLY.
 * depositBalance is NEVER touched for withdrawals.
 */
export async function debitWinningsForWithdrawal(userId, amount, orderId, extSession) {
  amount = round2(amount);
  if (amount <= 0) throw new Error(`Invalid withdrawal amount: ${amount}`);
  const tid = `wd_${orderId}`;

  if (await checkIdempotent(tid)) return { idempotent: true, txId: tid };

  const User         = mongoose.model('User');
  const WalletLedger = mongoose.model('WalletLedger');

  const run = async (session) => {
    const user = await User.findById(userId).session(session);
    if (!user) throw new Error('User not found');

    const winBal = round2(user.winningsBalance || 0);
    if (winBal < amount)
      throw new Error(`Insufficient withdrawable balance: have ₹${winBal}, need ₹${amount}. Only winnings are withdrawable.`);

    const newWinnings = round2(winBal - amount);
    await User.findByIdAndUpdate(userId,
      { $inc: { winningsBalance: -amount, lockedBalance: amount } }, { session });

    await WalletLedger.create([{
      userId, type: 'DEBIT', field: 'winningsBalance',
      amount, balanceBefore: winBal, balanceAfter: newWinnings,
      reason: `P2P withdrawal order ${orderId}`,
      refModel: 'PaymentOrder', refId, txId: tid,
    }], { session });

    const newLocked = round2((user.lockedBalance || 0) + amount);
    sseBalancePush(userId, user.depositBalance || 0, newWinnings);
    return { winningsBefore: winBal, winningsAfter: newWinnings, lockedAfter: newLocked, txId: tid };
  };

  if (extSession) return run(extSession);
  const session = await mongoose.startSession();
  try {
    let r; await session.withTransaction(async () => { r = await run(session); }); return r;
  } catch (err) {
    if (isDuplicateTxId(err)) return { idempotent: true, txId: tid }; // concurrent duplicate — see isDuplicateTxId
    throw err;
  } finally { await session.endSession(); }
}

// ── CREDIT winnings ───────────────────────────────────────────────────────────
/**
 * creditWinnings — credit `amount` to winningsBalance.
 * Used for: bet wins, referral commission, check-in, gift code bonuses.
 */
export async function creditWinnings(userId, amount, reason, refModel, refId, txId, extSession) {
  amount = round2(amount);
  if (amount <= 0) throw new Error(`Invalid credit amount: ${amount}`);
  const tid = txId || `credit_${crypto.randomUUID()}`;

  if (await checkIdempotent(tid)) return { idempotent: true, txId: tid };

  const User         = mongoose.model('User');
  const WalletLedger = mongoose.model('WalletLedger');

  const run = async (session) => {
    const user    = await User.findById(userId).session(session);
    if (!user) throw new Error('User not found');
    const before  = round2(user.winningsBalance || 0);
    const after   = round2(before + amount);

    await User.findByIdAndUpdate(userId,
      { $inc: { winningsBalance: amount } }, { session });

    const [e] = await WalletLedger.create([{
      userId, type: 'CREDIT', field: 'winningsBalance',
      amount, balanceBefore: before, balanceAfter: after,
      reason, refModel, refId, txId: tid,
    }], { session });

    sseBalancePush(userId, user.depositBalance || 0, after);
    return { before, after, winningsAfter: after,
             depositAfter: user.depositBalance || 0, ledgerId: e._id, txId: tid };
  };

  if (extSession) return run(extSession);
  const session = await mongoose.startSession();
  try {
    let r; await session.withTransaction(async () => { r = await run(session); }); return r;
  } catch (err) {
    if (isDuplicateTxId(err)) return { idempotent: true, txId: tid }; // concurrent duplicate — see isDuplicateTxId
    throw err;
  } finally { await session.endSession(); }
}



export async function creditDeposit(userId, amount, orderId, extSession) {
  amount = round2(amount);
  if (amount <= 0) throw new Error(`Invalid deposit amount: ${amount}`);
  const tid = `dep_complete_${orderId}`;

  if (await checkIdempotent(tid)) return { idempotent: true, txId: tid };

  const User         = mongoose.model('User');
  const WalletLedger = mongoose.model('WalletLedger');

  const run = async (session) => {
    const user   = await User.findById(userId).session(session);
    if (!user) throw new Error('User not found');
    const before = round2(user.depositBalance || 0);
    const after  = round2(before + amount);

    await User.findByIdAndUpdate(userId,
      { $inc: { depositBalance: amount } }, { session });

    await WalletLedger.create([{
      userId, type: 'CREDIT', field: 'depositBalance',
      amount, balanceBefore: before, balanceAfter: after,
      reason: `P2P deposit confirmed ${orderId}`,
      refModel: 'PaymentOrder', refId, txId: tid,
    }], { session });

    sseBalancePush(userId, after, user.winningsBalance || 0);
    return { depositBefore: before, depositAfter: after, txId: tid };
  };

  if (extSession) return run(extSession);
  const session = await mongoose.startSession();
  try {
    let r; await session.withTransaction(async () => { r = await run(session); }); return r;
  } catch (err) {
    if (isDuplicateTxId(err)) return { idempotent: true, txId: tid }; // concurrent duplicate — see isDuplicateTxId
    throw err;
  } finally { await session.endSession(); }
}

/**
 * creditReserve — credit the deposit's reserve-allocation share to
 * reserveBalance. Mirrors creditDeposit exactly (idempotent via txId, writes
 * a WalletLedger entry). Added 2026-07-09 (audit) so reserve credits stop
 * being raw $inc writes with no audit trail (docs/governance/04-GOVERNANCE.md §7).
 */
export async function creditReserve(userId, amount, orderId, extSession) {
  amount = round2(amount);
  if (amount <= 0) throw new Error(`Invalid reserve amount: ${amount}`);
  const tid = `reserve_credit_${orderId}`;

  if (await checkIdempotent(tid)) return { idempotent: true, txId: tid };

  const User         = mongoose.model('User');
  const WalletLedger = mongoose.model('WalletLedger');

  const run = async (session) => {
    const user   = await User.findById(userId).session(session);
    if (!user) throw new Error('User not found');
    const before = round2(user.reserveBalance || 0);
    const after  = round2(before + amount);

    await User.findByIdAndUpdate(userId,
      { $inc: { reserveBalance: amount } }, { session });

    await WalletLedger.create([{
      userId, type: 'CREDIT', field: 'reserveBalance',
      amount, balanceBefore: before, balanceAfter: after,
      reason: `Deposit reserve allocation ${orderId}`,
      refModel: 'PaymentOrder', refId, txId: tid,
    }], { session });

    return { reserveBefore: before, reserveAfter: after, txId: tid };
  };

  if (extSession) return run(extSession);
  const session = await mongoose.startSession();
  try {
    let r; await session.withTransaction(async () => { r = await run(session); }); return r;
  } catch (err) {
    if (isDuplicateTxId(err)) return { idempotent: true, txId: tid }; // concurrent duplicate — see isDuplicateTxId
    throw err;
  } finally { await session.endSession(); }
}

// ── REFUND (cancelled order) ──────────────────────────────────────────────────
/**
 * refundOrder — refund a locked amount back.
 * Deposit refunds → depositBalance. Withdrawal refunds → winningsBalance.
 */
export async function refundOrder(userId, amount, orderId, field = 'depositBalance', extSession) {
  amount = round2(amount);
  const tid = `refund_${orderId}`;
  // M-8: `refId` is an ObjectId on the WalletLedger schema, but this function is
  // also called with a PROVIDER-SUPPLIED round id — gameProvider.routes passes
  // `body.roundId || body.round_id || body.gameRound || txId`, which is an
  // arbitrary string. Casting that threw inside the transaction, so the whole
  // refund aborted: EVERY casino ROLLBACK/REFUND has returned 500 since it
  // shipped. No money was lost (the transaction unwound the balance change
  // with it), but no refund ever succeeded either.
  //
  // The id is not lost by dropping it here — it is already in `txId`
  // (`refund_<orderId>`, which is also the idempotency key) and in the reason
  // text. Only the typed foreign-key column, which cannot hold it, is skipped.
  const refId = mongoose.Types.ObjectId.isValid(orderId) ? orderId : null;
  if (await checkIdempotent(tid)) return { idempotent: true, txId: tid };

  const User         = mongoose.model('User');
  const WalletLedger = mongoose.model('WalletLedger');

  const run = async (session) => {
    const user   = await User.findById(userId).session(session);
    if (!user) throw new Error('User not found');
    const before = round2(user[field] || 0);
    const after  = round2(before + amount);

    await User.findByIdAndUpdate(userId,
      { $inc: { [field]: amount } }, { session });

    await WalletLedger.create([{
      userId, type: 'CREDIT', field,
      amount, balanceBefore: before, balanceAfter: after,
      reason: `Refund for cancelled order ${orderId}`,
      refModel: 'PaymentOrder', refId, txId: tid,
    }], { session });

    const updated = await User.findById(userId).session(session).lean();
    sseBalancePush(userId, updated.depositBalance || 0, updated.winningsBalance || 0);
    return { before, after, txId: tid };
  };

  if (extSession) return run(extSession);
  const session = await mongoose.startSession();
  try {
    let r; await session.withTransaction(async () => { r = await run(session); }); return r;
  } catch (err) {
    if (isDuplicateTxId(err)) return { idempotent: true, txId: tid }; // concurrent duplicate — see isDuplicateTxId
    throw err;
  } finally { await session.endSession(); }
}

// ── ADMIN ADJUSTMENT ──────────────────────────────────────────────────────────
export async function adminAdjust(userId, type, field, amount, reason, adjustmentId) {
  const tid = `admin_${adjustmentId}`;
  if (type === 'CREDIT') {
    return creditWinnings(userId, amount, reason, 'AdminAdjustment', adjustmentId, tid);
  } else {
    // Admin debit: treat as bet debit (deposit first, winnings shortfall)
    return debitForBet(userId, amount, reason, 'AdminAdjustment', adjustmentId, tid);
  }
}

// ── LEDGER QUERY ──────────────────────────────────────────────────────────────
export async function getUserLedger(userId, page = 1, limit = 30) {
  const WalletLedger = mongoose.model('WalletLedger');
  const skip = (page - 1) * limit;
  const [entries, total] = await Promise.all([
    WalletLedger.find({ userId }).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    WalletLedger.countDocuments({ userId }),
  ]);
  return { entries, total, pages: Math.ceil(total / limit) };
}
