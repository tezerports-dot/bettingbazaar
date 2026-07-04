// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
// Domain: Settlement (BBEPS Phase 003 section 3.3).
// Extracted from domains/game/gameEngine.js on 2026-07-03. Only the two genuinely
// self-contained pieces moved here -- the orchestrator (processPayoutsOptimized)
// stays in gameEngine.js because it also does socket emission, cache invalidation,
// and commission triggering. See backend/domains/settlement/README.md.
//
// NEITHER function uses MongoDB transactions/sessions. Correctness relies on
// idempotency keys (txId, win_<betId>) and status guards so payoutRecoveryTask()
// can safely re-run a stuck cycle without double-crediting.

import mongoose from 'mongoose';
import { User, Bet, Transaction } from '../../models/index.js';
import { creditWinnings } from '../wallet/walletAuthority.service.js';

export async function unlockLostBet(userId, amount, betId, fromDeposit, fromWinnings) {
    const WalletLedger = mongoose.model('WalletLedger');
    const txId = `unlock_lost_${betId}`;
    if (await WalletLedger.findOne({ txId }).lean()) return;
    await User.findByIdAndUpdate(userId, {
        $inc: {
            lockedBalance:        -amount,
            lockedDepositAmount:  -fromDeposit,
            lockedWinningsAmount: -fromWinnings,
        }
    });
    const user = await User.findById(userId).select('depositBalance winningsBalance').lean();
    await WalletLedger.create({
        userId, type: 'DEBIT', field: 'winningsBalance',
        amount: 0,
        balanceBefore: user?.winningsBalance || 0,
        balanceAfter:  user?.winningsBalance || 0,
        reason: `Lost bet unlock — cycle result`,
        refModel: 'Bet', refId: betId, txId,
    });
}

export async function executeSettlementBatch(userOps, txOps, betIds) {
    for (const op of userOps) {
        try {
            await creditWinnings(
                op.userId, op.payout,
                `Cycle win payout (2x)`, op.betIds[0],
                `win_${op.betIds[0]}`
            );
            await User.findByIdAndUpdate(op.userId, {
                $inc: {
                    lockedBalance:        -op.totalBetAmount,
                    lockedDepositAmount:  -op.totalLockedDeposit,
                    lockedWinningsAmount: -op.totalLockedWinnings,
                }
            });
        } catch (e) {
            console.error(`[Settlement] WalletAuthority payout error for user ${op.userId}:`, e.message);
            throw e;
        }
    }

    if (txOps.length > 0) {
        try {
            await Transaction.bulkWrite(txOps);
        } catch (e) {
            console.warn('[Settlement] Transaction log write failed (non-critical):', e.message);
        }
    }

    const allBetIds = userOps.flatMap(op => op.betIds);
    if (allBetIds.length > 0) {
        await Bet.updateMany(
            { _id: { $in: allBetIds }, status: { $ne: 'WON' } },
            [{ $set: { status: 'WON', payout: { $multiply: ['$amount', 2] } } }]
        );
    }
}
