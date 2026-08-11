// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
// Domain: Settlement (BBEPS Phase 003 section 3.3).
// F-2 (2026-07-10): ALL balance writes here go through walletAuthority (§7)
// — the raw lockedBalance `$inc`s this file used to run are gone. Unlocks
// are idempotent per deterministic txId, which is what makes overlapping
// settlement passes (engine tick + recovery task, or two nodes) safe.
import { Bet, Transaction } from '../../models/index.js';
import { creditWinnings, releaseLockedStake } from '../wallet/walletAuthority.service.js';
import { onPostgres as betsOnPostgres, settleBetOnPostgres } from '../../postgres/betPgAuthority.js';

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

/**
 * Pay and stamp one batch of winners.
 *
 * @param {object[]} userOps  one entry per winning USER, as gameEngine groups them
 * @param {object[]} txOps    Transaction-log inserts, one per user (see below)
 * @param {{onPg?: boolean}} routing
 *   `onPg` is the settlement pass's SINGLE authority decision, read once by
 *   gameEngine and passed down. It is a parameter rather than a second call to
 *   the resolver so that one pass cannot settle its losing side in one store and
 *   its winning side in the other — the split docs/BETS_SETTLEMENT_ROUTING.md
 *   exists to prevent, and which no reconciliation can distinguish from the two
 *   stores genuinely disagreeing. The default is there for callers outside a
 *   pass; gameEngine always passes it.
 *
 * @returns {{refused: Array<{betId,userId,outcome,reason}>}} bets Postgres would
 *   not transition. Never empty-and-silent: the caller alerts on them, because a
 *   refused bet still has its stake locked.
 */
export async function executeSettlementBatch(userOps, txOps, { onPg = betsOnPostgres() } = {}) {
    const refused = [];

    if (onPg) {
        // ── Postgres owns the transition AND the money ────────────────────────
        // betPg.winBet consumes the locked stake and credits the payout in ONE
        // transaction under one wallet lock, so creditWinnings and
        // releaseLockedStake must NOT also run: BETS dependsOn WALLET, so the
        // wallet path is already on Postgres by the time this branch is live,
        // and calling them too would credit the payout twice and release the
        // stake twice.
        //
        // Per BET rather than per user. The Mongo branch below already performs
        // two awaited wallet operations per USER and then a bulk stamp; this
        // replaces both with one transaction per bet that does the state change
        // and the money together. docs/BETS_SETTLEMENT_ROUTING.md proposed
        // batching per user for throughput and that remains the better shape at
        // scale — it is recorded there as measured-when-needed rather than
        // implemented on an assumption, because per-bet is what makes a settled
        // bet with no ledger row structurally unrepresentable.
        for (const op of userOps) {
            const reason = op.feePercent > 0
                ? `Cycle win payout (2x minus ${op.feePercent}% platform fee)`
                : `Cycle win payout (2x)`;
            for (const s of (op.betStamps || [])) {
                const r = await settleBetOnPostgres({
                    bet: s.bet,
                    outcome: 'WON',
                    payoutRupees: s.payout,
                    platformFeeRupees: s.platformFee,
                    reason,
                });
                if (!r.handled) {
                    throw new Error(
                        '[Settlement] bets authority changed mid-batch — refusing to settle the '
                        + 'winning side in a different store from the losing side',
                    );
                }
                if (!r.ok) {
                    refused.push({
                        betId: String(s.betId), userId: String(op.userId),
                        outcome: 'WON', reason: r.reason,
                    });
                }
            }
        }
    } else {
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
    }

    // ── The Transaction log runs on BOTH branches. This is blocker (c) ────────
    // docs/BETS_SETTLEMENT_ROUTING.md named this a decision rather than an
    // oversight, and the decision is: it stays MONGO-SIDE and is not routed.
    //
    // It is not the accounting ledger. Double entry lives in `accounting_events`
    // and the per-wallet movement in `wallet_ledger`, and on the Postgres branch
    // betPg writes BOTH inside the settling transaction via
    // walletPg.applyMovementWithin — so the auditable record of the payout is
    // already authoritative there. This collection is the user-facing history
    // feed the wallet screen reads.
    //
    // Skipping it under Postgres authority would therefore buy no consistency
    // and would delete winners' payouts from their own transaction history — a
    // visible regression in exchange for nothing. It reaches Postgres anyway by
    // the ordinary dual-write leg (dualWrite.mirrorTransaction, in reconcile's
    // TABLES), which is the correct relationship for a projection.
    //
    // KNOWN, PRE-EXISTING, UNCHANGED BY THIS ROUTING: these are bare inserts
    // with no idempotency key and no unique index behind them, so a settlement
    // resumed mid-batch writes a SECOND BET_WIN row for users the first pass had
    // already credited (the money is safe — creditWinnings is keyed — only the
    // history duplicates). It is not fixed here because the honest fix is a
    // product decision, not a key: a resumed pass pays a DIFFERENT, smaller
    // amount for the remaining bets, so upserting on (user, cycle) would replace
    // the first row with a partial one, which is worse than a duplicate.
    if (txOps.length > 0) {
        try { await Transaction.bulkWrite(txOps); }
        catch (e) { console.warn('[Settlement] Transaction log write failed (non-critical):', e.message); }
    }

    // Stamp each winning bet with its exact NET payout and retained fee
    // (idempotent: status guard skips bets a recovery re-run already stamped).
    //
    // MONGO BRANCH ONLY. Under Postgres authority the reverse mirror has already
    // written each bet's status, payout and fee, and re-stamping here would
    // overwrite the bets Postgres deliberately REFUSED — turning a reported
    // failure into a silent one, and marking WON a bet whose payout never moved.
    if (!onPg) {
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

    return { refused };
}
