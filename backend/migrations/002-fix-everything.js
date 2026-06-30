// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * MIGRATION STATUS: APPLIED — do not re-run.
 * H-08 / GOVERNANCE: applied migrations must be deleted after all environments confirm.
 * This file is kept only for audit trail. Delete it once confirmed in production.
 */
/**
 * Migration 002 — Fix Everything
 *
 * Fixes ALL stuck/corrupt data across the entire database.
 * Safe to re-run — every step checks before acting.
 *
 * Run ONCE after deploying code:
 *   cd backend && node migrations/002-fix-everything.js
 */
// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

if (!process.env.MONGODB_URI) { console.error('❌ MONGODB_URI not set'); process.exit(1); }

const log  = (m) => console.log(m);
const sep  = () => console.log('─'.repeat(60));

async function run() {
  await mongoose.connect(process.env.MONGODB_URI, { dbName: 'bettingbazaar' });
  log('✅ Connected\n');

  const Users     = mongoose.connection.collection('users');
  const Merchants = mongoose.connection.collection('merchants');
  const Orders    = mongoose.connection.collection('p2porders');
  const Bets      = mongoose.connection.collection('bets');
  const Cycles    = mongoose.connection.collection('cycles');
  const Txns      = mongoose.connection.collection('transactions');
  const Chats     = mongoose.connection.collection('chatmessages');

  const now = new Date();
  const TWO_HOURS_AGO = new Date(now - 2 * 60 * 60 * 1000);

  const c = { approval:0, password:0, merchantStatus:0, isOnline:0, tokenBalance:0, limits:0,
              orderId:0, requeued:0, refunds:0, paidDeposits:0, paidWithdrawals:0,
              orphanedBets:0, orphanedLocks:0 };

  // ── Load reference data ────────────────────────────────────────────────────
  const allMerchants = await Merchants.find({}).toArray();
  const mUserIds     = allMerchants.map(m => m.userId).filter(Boolean);
  const mUsers       = await Users.find({ _id: { $in: mUserIds } }).toArray();
  const userById     = Object.fromEntries(mUsers.map(u => [u._id.toString(), u]));
  const mByUserId    = Object.fromEntries(allMerchants.map(m => [m.userId?.toString(), m]));
  const mIdSet       = new Set(allMerchants.map(m => m._id.toString()));

  // ══════════════════════════════════════════════════════════════════════════
  // PART 1 — MERCHANT DATA MODEL
  // ══════════════════════════════════════════════════════════════════════════
  log('PART 1 — Merchant data model');  sep();

  for (const m of allMerchants) {
    const u = userById[m.userId?.toString()];
    const updates = {};

    // 1a. merchantApprovalStatus
    if (!m.merchantApprovalStatus && u?.merchantApprovalStatus)
      Object.assign(updates, { merchantApprovalStatus: u.merchantApprovalStatus,
        merchantApprovedBy: u.merchantApprovedBy||null, merchantApprovedAt: u.merchantApprovedAt||null,
        merchantRejectionReason: u.merchantRejectionReason||null }) && c.approval++;

    // 1b. password
    if (!m.password && !m.passwordHash && u?.passwordHash)
      Object.assign(updates, { password: u.passwordHash, passwordHash: u.passwordHash }) && c.password++;

    // 1c. status PENDING → ACTIVE for approved merchants
    const approval = updates.merchantApprovalStatus || m.merchantApprovalStatus || u?.merchantApprovalStatus;
    if (m.status === 'PENDING' && approval === 'APPROVED')
      Object.assign(updates, { status: 'ACTIVE', merchantApprovalStatus: 'APPROVED' }) && c.merchantStatus++;

    // 1d. isOnline
    if (!m.isOnline && u?.isOnline)
      Object.assign(updates, { isOnline: true }) && c.isOnline++;

    // 1e. tokenBalance
    if (!(m.tokenBalance > 0)) {
      const bal = (u?.depositBalance||0) + (u?.walletBalance||0);
      if (bal > 0) { updates.tokenBalance = bal; c.tokenBalance++; log(`  💰 ${m.name}: ₹${bal}`); }
    }

    // 1f. order limits
    if (!m.minOrder && u?.merchantLimits) {
      updates.minOrder = u.merchantLimits.minOrder || 500;
      updates.maxOrder = u.merchantLimits.perTransactionLimit || 50000;
      c.limits++;
    }

    if (Object.keys(updates).length)
      await Merchants.updateOne({ _id: m._id }, { $set: updates });
  }
  log(`  merchantApprovalStatus: ${c.approval}  password: ${c.password}  status: ${c.merchantStatus}`);
  log(`  isOnline: ${c.isOnline}  tokenBalance: ${c.tokenBalance}  limits: ${c.limits}`);

  // ══════════════════════════════════════════════════════════════════════════
  
  // ══════════════════════════════════════════════════════════════════════════
  log('\nPART 2 — P2P orders');  sep();

  const activeOrders = await Orders.find({
    status: { $in: ['PENDING_QUEUE','ASSIGNED','PROCESSING','PAID'] }
  }).toArray();

  log(`  Found ${activeOrders.length} active orders`);

  for (const o of activeOrders) {
    const mid = o.merchantId?.toString();
    let correctMerchantId = null;

    // 2a. Fix merchantId (User._id → Merchant._id)
    if (mid && !mIdSet.has(mid)) {
      const mDoc = mByUserId[mid];
      if (mDoc) {
        await Orders.updateOne({ _id: o._id }, { $set: { merchantId: mDoc._id } });
        correctMerchantId = mDoc._id;
        c.orderId++;
      }
    } else {
      correctMerchantId = o.merchantId;
    }

    // 2b. PENDING_QUEUE: clear stale wrong merchantId
    if (o.status === 'PENDING_QUEUE' && mid && !mIdSet.has(mid))
      await Orders.updateOne({ _id: o._id }, { $set: { merchantId: null } });

    // 2c. ASSIGNED/PROCESSING: check if expired or too old
    if (['ASSIGNED','PROCESSING'].includes(o.status)) {
      const expired = (o.expiresAt && new Date(o.expiresAt) < now) ||
                      (!o.expiresAt && new Date(o.createdAt) < TWO_HOURS_AGO);
      if (!expired) continue; // still live — merchantId fix is enough

      log(`  ⚠️  Order ${o.orderId||o._id} (${o.type} ${o.status}) expired → requeueing`);

      // Refund withdrawal balance
      if (o.type === 'WITHDRAWAL' && (o.tokenAmount||0) > 0) {
        await Users.updateOne({ _id: o.userId }, { $inc: { winningsBalance: o.tokenAmount } });
        await Txns.insertOne({
          _id: new mongoose.Types.ObjectId(), userId: o.userId, type: 'ADMIN_ADJUSTMENT',
          amount: o.tokenAmount, balanceType: 'WINNINGS', status: 'SUCCESS',
          referenceId: o._id.toString(),
          description: `Auto-refund: withdrawal ${o.orderId} was stuck in ${o.status} — returned to queue`,
          timestamp: now,
        });
        log(`    💰 Refunded ₹${o.tokenAmount} to user ${o.userId}`);
        c.refunds++;
      }

      await Orders.updateOne({ _id: o._id }, {
        $set: { status: 'PENDING_QUEUE', merchantId: null, assignedAt: null,
                assignedBy: null, expiresAt: null, updatedAt: now }
      });

      await Chats.insertOne({
        _id: new mongoose.Types.ObjectId(), orderId: o._id, senderId: o.userId,
        senderType: 'SYSTEM', isSystem: true, timestamp: now,
        message: o.type === 'WITHDRAWAL'
          ? `⚙️ System: Your withdrawal of ₹${o.fiatAmount} could not be processed. Your balance has been returned and the order is back in queue.`
          : `⚙️ System: Your deposit order was not processed in time. It's back in queue and will be assigned shortly.`,
      });
      c.requeued++;
    }

    // 2d. PAID DEPOSIT stuck — user paid merchant but depositBalance not credited
    if (o.status === 'PAID' && o.type === 'DEPOSIT') {
      // Check if there's already a DEPOSIT transaction for this order
      const existing = await Txns.findOne({ type: 'DEPOSIT', referenceId: o._id.toString() });
      if (!existing) {
        log(`  💳 PAID DEPOSIT ${o.orderId||o._id} — crediting depositBalance ₹${o.tokenAmount}`);
        await Users.updateOne({ _id: o.userId }, { $inc: { depositBalance: o.tokenAmount } });
        await Txns.insertOne({
          _id: new mongoose.Types.ObjectId(), userId: o.userId, type: 'DEPOSIT',
          amount: o.tokenAmount, balanceType: 'DEPOSIT', status: 'SUCCESS',
          referenceId: o._id.toString(),
          description: `Recovery: deposit ${o.orderId} was stuck in PAID — balance credited`,
          timestamp: now,
        });
        // Deduct from merchant tokenBalance (they already paid)
        if (correctMerchantId)
          await Merchants.updateOne({ _id: correctMerchantId }, { $inc: { tokenBalance: -o.tokenAmount } });
        // Advance to COMPLETED
        await Orders.updateOne({ _id: o._id }, { $set: { status: 'COMPLETED', completedAt: now, updatedAt: now } });
        c.paidDeposits++;
      }
    }

    // 2e. PAID WITHDRAWAL stuck — merchant paid user but tokenBalance not returned
    if (o.status === 'PAID' && o.type === 'WITHDRAWAL') {
      const existing = await Txns.findOne({ type: 'ADMIN_ADJUSTMENT', referenceId: o._id.toString(), description: /tokenBalance.*recovery/i });
      if (!existing && correctMerchantId) {
        log(`  🏦 PAID WITHDRAWAL ${o.orderId||o._id} — crediting merchant tokenBalance ₹${o.tokenAmount}`);
        await Merchants.updateOne({ _id: correctMerchantId }, { $inc: { tokenBalance: o.tokenAmount } });
        await Orders.updateOne({ _id: o._id }, { $set: { status: 'COMPLETED', completedAt: now, updatedAt: now } });
        c.paidWithdrawals++;
      }
    }
  }

  log(`  merchantId fixed: ${c.orderId}  requeued: ${c.requeued}  refunds: ${c.refunds}`);
  log(`  paid deposits resolved: ${c.paidDeposits}  paid withdrawals resolved: ${c.paidWithdrawals}`);

  // ══════════════════════════════════════════════════════════════════════════
  // PART 3 — BETS: stuck PENDING on settled cycles
  // ══════════════════════════════════════════════════════════════════════════
  log('\nPART 3 — Bets stuck PENDING on settled cycles');  sep();

  const settledCycles = await Cycles.find({
    isSettled: 'COMPLETED', winner: { $in: ['DELHI','BOMBAY'] }
  }).toArray();

  for (const cycle of settledCycles) {
    const stuckBets = await Bets.find({
      cycleId: cycle.cycleId, status: 'PENDING', isPhantom: { $ne: true }
    }).toArray();

    if (stuckBets.length === 0) continue;
    log(`  Cycle ${cycle.cycleId} (winner: ${cycle.winner}) has ${stuckBets.length} stuck bets`);

    for (const bet of stuckBets) {
      if (bet.side === cycle.winner) {
        // Won — credit 2x payout to winningsBalance and unlock
        const payout = bet.amount * 2;
        await Users.updateOne({ _id: bet.userId }, {
          $inc: {
            winningsBalance:     payout,
            lockedBalance:       -bet.amount,
            lockedDepositAmount: -(bet.fromDepositBalance||0),
            lockedWinningsAmount:-(bet.fromWinningsBalance||0),
          }
        });
        await Bets.updateOne({ _id: bet._id }, { $set: { status: 'WON', payout, settledAt: now } });
        // Audit transaction
        const txExists = await Txns.findOne({ type: 'BET_WIN', referenceId: bet._id.toString() });
        if (!txExists) await Txns.insertOne({
          _id: new mongoose.Types.ObjectId(), userId: bet.userId, type: 'BET_WIN',
          amount: payout, balanceType: 'WINNINGS', status: 'SUCCESS',
          referenceId: bet._id.toString(),
          description: `Recovery payout: cycle ${cycle.cycleId} winner ${cycle.winner} — 2x ₹${bet.amount}`,
          timestamp: now,
        });
        log(`    ✅ WON  bet ${bet._id}: payout ₹${payout} → user ${bet.userId}`);
      } else {
        // Lost — just unlock
        await Users.updateOne({ _id: bet.userId }, {
          $inc: {
            lockedBalance:       -bet.amount,
            lockedDepositAmount: -(bet.fromDepositBalance||0),
            lockedWinningsAmount:-(bet.fromWinningsBalance||0),
          }
        });
        await Bets.updateOne({ _id: bet._id }, { $set: { status: 'LOST', settledAt: now } });
        log(`    ❌ LOST bet ${bet._id}: unlocked ₹${bet.amount} for user ${bet.userId}`);
      }
      c.orphanedBets++;
    }
  }
  log(`  Orphaned bets resolved: ${c.orphanedBets}`);

  // ══════════════════════════════════════════════════════════════════════════
  // PART 4 — ORPHANED LOCKED BALANCES
  // Users with lockedBalance > sum of their actual PENDING bets.
  // These are leftover locks from bets that were settled or deleted without
  // properly decrementing lockedBalance.
  // ══════════════════════════════════════════════════════════════════════════
  log('\nPART 4 — Orphaned lockedBalance');  sep();

  const usersWithLocks = await Users.find({ lockedBalance: { $gt: 0 } }).toArray();
  log(`  Found ${usersWithLocks.length} users with lockedBalance > 0`);

  for (const user of usersWithLocks) {
    // Sum of all PENDING bets for this user
    const pendingAgg = await Bets.aggregate([
      { $match: { userId: user._id, status: 'PENDING', isPhantom: { $ne: true } } },
      { $group: { _id: null, total: { $sum: '$amount' } } }
    ]).toArray();
    const actualLocked = pendingAgg[0]?.total || 0;
    const diff = (user.lockedBalance || 0) - actualLocked;

    if (diff > 0.01) {
      log(`  User ${user._id}: lockedBalance=₹${user.lockedBalance} actual=₹${actualLocked} → releasing ₹${diff.toFixed(2)}`);

      // Determine what proportion was deposit vs winnings (best effort using lockedDepositAmount)
      const lockedDeposit  = Math.min(user.lockedDepositAmount  || 0, diff);
      const lockedWinnings = Math.max(diff - lockedDeposit, 0);

      await Users.updateOne({ _id: user._id }, {
        $inc: {
          depositBalance:      lockedDeposit,   // return deposit portion
          winningsBalance:     lockedWinnings,  // return winnings portion
          lockedBalance:       -diff,
          lockedDepositAmount: -lockedDeposit,
          lockedWinningsAmount:-lockedWinnings,
        }
      });
      await Txns.insertOne({
        _id: new mongoose.Types.ObjectId(), userId: user._id, type: 'ADMIN_ADJUSTMENT',
        amount: diff, balanceType: 'BOTH', status: 'SUCCESS',
        description: `Recovery: lockedBalance=₹${user.lockedBalance} but only ₹${actualLocked} in pending bets. Released ₹${diff.toFixed(2)}.`,
        timestamp: now,
      });
      c.orphanedLocks++;
    }
  }
  log(`  Orphaned locks fixed: ${c.orphanedLocks}`);

  // ══════════════════════════════════════════════════════════════════════════
  // SUMMARY
  // ══════════════════════════════════════════════════════════════════════════
  sep();
  log('✅ MIGRATION 002 COMPLETE\n');
  log('PART 1 — Merchant model:');
  log(`  Approval status copied: ${c.approval} | Password copied: ${c.password} | Status fixed: ${c.merchantStatus}`);
  log(`  isOnline synced: ${c.isOnline} | tokenBalance synced: ${c.tokenBalance} | Limits copied: ${c.limits}`);
  log('PART 2 — P2P orders:');
  log(`  merchantId fixed: ${c.orderId} | Requeued: ${c.requeued} | Withdrawal refunds: ${c.refunds}`);
  log(`  Paid deposits resolved: ${c.paidDeposits} | Paid withdrawals resolved: ${c.paidWithdrawals}`);
  log('PART 3 — Stuck bets:');
  log(`  Orphaned bets resolved: ${c.orphanedBets}`);
  log('PART 4 — Locked balances:');
  log(`  Orphaned locks fixed: ${c.orphanedLocks}`);
  log('');
  log('Redeploy: backend → admin-panel → merchant-panel on Railway.');
  sep();

  await mongoose.disconnect();
}

run().catch(e => { console.error('❌ Migration failed:', e); process.exit(1); });
