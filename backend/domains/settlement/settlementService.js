// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
// Domain: Settlement (BBEPS Phase 003 section 3.3).
import mongoose from 'mongoose';
import { User, Bet, Transaction } from '../../models/index.js';
import { creditWinnings } from '../wallet/walletAuthority.service.js';

export async function unlockLostBet(userId, amount, betId, fromDeposit, fromWinnings) {
    const WalletLedger = mongoose.model('WalletLedger');
    const txId = `unlock_lost_${betId}`;
    if (await WalletLedger.findOne({ txId }).lean()) return;
    await User.findByIdAndUpdate(userId, {
        $inc: { lockedBalance: -amount, lockedDepositAmount: -fromDeposit, lockedWinningsAmount: -fromWinnings }
    });
    const user = await User.findById(userId).select('depositBalance winningsBalance').lean();
    await WalletLedger.create({
        userId, type: 'DEBIT', field: 'winningsBalance', amount: 0,
        balanceBefore: user?.winningsBalance || 0, balanceAfter: user?.winningsBalance || 0,
        reason: `Lost bet unlock — cycle result`, refModel: 'Bet', refId: betId, txId,
    });
}

export async function executeSettlementBatch(userOps, txOps) {
    for (const op of userOps) {
        try {
            // Phase A (2026-07-10): op.payout is NET — gross 2x minus the
            // winnings platform fee, computed per bet by the Risk Platform
            // (riskValidation.computeWinningsPayout) in gameEngine.js.
            const reason = op.feePercent > 0
                ? `Cycle win payout (2x minus ${op.feePercent}% platform fee)`
                : `Cycle win payout (2x)`;
            await creditWinnings(op.userId, op.payout, reason, op.betIds[0], `win_${op.betIds[0]}`);
            await User.findByIdAndUpdate(op.userId, {
                $inc: { lockedBalance: -op.totalBetAmount, lockedDepositAmount: -op.totalLockedDeposit, lockedWinningsAmount: -op.totalLockedWinnings }
            });
        } catch (e) {
            console.error(`[Settlement] WalletAuthority payout error for user ${op.userId}:`, e.message);
            throw e;
        }
    }
    if (txOps.length > 0) {
        try { await Transaction.bulkWrite(txOps); }
        catch (e) { console.warn('[Settlement] Transaction log write failed (non-critical):', e.message); }
    }
    // Stamp each winning bet with its exact NET payout and retained fee
    // (idempotent: status guard skips bets a recovery re-run already stamped).
    const stampOps = userOps.flatMap(op => (op.betStamps || []).map(s => ({
        updateOne: {
            filter: { _id: s.betId, status: { $ne: 'WON' } },
            update: { $set: { status: 'WON', payout: s.payout, platformFee: s.platformFee, settledAt: new Date() } },
        }
    })));
    if (stampOps.length > 0) {
        await Bet.bulkWrite(stampOps);
    }
}
