// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
// Domain: Settlement (BBEPS Phase 003 section 3.3).
// F-2 (2026-07-10): ALL balance writes here go through walletAuthority (§7)
// — the raw lockedBalance `$inc`s this file used to run are gone. Unlocks
// are idempotent per deterministic txId, which is what makes overlapping
// settlement passes (engine tick + recovery task, or two nodes) safe.
import { Bet, Transaction } from '../../models/index.js';
import { creditWinnings, releaseLockedStake } from '../wallet/walletAuthority.service.js';

export async function unlockLostBet(userId, amount, betId, fromDeposit, fromWinnings) {
    // txId format predates F-2 — kept identical so historical ledger entries
    // still block re-unlocks of already-settled bets.
    return releaseLockedStake(String(userId), {
        amount,
        fromDeposit:  fromDeposit  || 0,
        fromWinnings: fromWinnings || 0,
        txId: `unlock_lost_${betId}`,
        reason: 'Lost bet unlock — cycle result',
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
            await releaseLockedStake(op.userId, {
                amount:       op.totalBetAmount,
                fromDeposit:  op.totalLockedDeposit,
                fromWinnings: op.totalLockedWinnings,
                txId: `unlock_win_${op.betIds[0]}`,
                reason: 'Won bet stake unlock — cycle settlement',
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
