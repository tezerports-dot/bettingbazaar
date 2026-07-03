// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * startup/cronJobs.js — All scheduled background jobs.
 * Single responsibility: register cron intervals, nothing else.
 * Import and call registerCronJobs(rebuildLeaderboard) from server.js after DB init.
 */
import mongoose from 'mongoose';
import { creditWinnings } from '../domains/wallet/walletAuthority.service.js';
import { emitOrderUpdate, emitAdminUpdate } from '../services/realtimeEmitters.js';

export function registerCronJobs(rebuildLeaderboard) {

  // ── Leaderboard rebuild every 10 minutes ────────────────────────────────────
  setInterval(async () => {
    try { await rebuildLeaderboard(); }
    catch (e) { console.error('Leaderboard rebuild error:', e.message); }
  }, 10 * 60 * 1000);

  rebuildLeaderboard().catch(e => console.error('Initial leaderboard:', e.message));

  // ── Referral commission credit every 5 minutes ──────────────────────────────
  setInterval(async () => {
    try {
      const CommissionRecord = mongoose.model('CommissionRecord');
      const pending = await CommissionRecord.find({ credited: false }).limit(100);
      for (const rec of pending) {
        try {
          await creditWinnings(
            rec.beneficiaryId, rec.amount,
            `F${rec.level} referral commission`, 'Commission', rec._id,
            `comm_${rec._id}`
          );
          await CommissionRecord.findByIdAndUpdate(rec._id, { credited: true, creditedAt: new Date() });
        } catch (e) { console.error('Commission credit failed:', rec._id, e.message); }
      }
      if (pending.length > 0) console.log(`💰 Credited ${pending.length} commission records`);
    } catch (e) { console.error('Commission credit error:', e.message); }
  }, 5 * 60 * 1000);


  // ── Order expiry worker — runs every 60 seconds ──────────────────────────────
  // Delegates to paymentProcessing.service.js (domain service owns this logic).
  setInterval(async () => {
    try {
      const { expireOrders } = await import('../domains/payment/paymentProcessing.service.js');
      const count = await expireOrders();
      if (count > 0) console.log(`[expiry-worker] Expired ${count} order(s)`);
    } catch (e) { console.error('[expiry-worker] cron error:', e.message); }
  }, 60 * 1000);

  console.log('✅ Cron jobs registered');
}
