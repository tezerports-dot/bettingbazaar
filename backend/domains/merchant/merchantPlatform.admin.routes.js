// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * merchantPlatform.admin.routes.js — Merchant Platform analytics surface
 * (BBEPS Phase 008): leaderboard, funding statistics, performance history,
 * wallet ledger, and an on-demand bonus-engine trigger. Read-only except the
 * engine trigger, which is idempotent by construction.
 * Mounted at /api/admin via routes/admin/index.js.
 */
import { express, authenticate, isAdmin, isAdminOrSubAdmin } from '../../routes/admin/_adminShared.js';
import { getMerchantLeaderboard, getMerchantFundingStats, getMerchantPerformanceHistory } from './merchantAnalytics.service.js';
import { getMerchantWalletLedger } from './merchantWallet.service.js';
import { runBonusEngine } from './merchantBonus.service.js';

const router = express.Router();

// GET /api/admin/merchant-platform/leaderboard?days=30&limit=20&sortBy=volume
router.get('/merchant-platform/leaderboard', authenticate, isAdminOrSubAdmin, async (req, res) => {
  try {
    const days   = Math.min(365, Math.max(1, parseInt(req.query.days) || 30));
    const limit  = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    const sortBy = ['volume', 'orders', 'successRate', 'bonus'].includes(req.query.sortBy) ? req.query.sortBy : 'volume';
    const leaderboard = await getMerchantLeaderboard({ days, limit, sortBy });
    res.json({ success: true, days, sortBy, leaderboard });
  } catch (error) {
    console.error('Merchant leaderboard error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch merchant leaderboard' });
  }
});

// GET /api/admin/merchant-platform/:merchantId/funding-stats
router.get('/merchant-platform/:merchantId/funding-stats', authenticate, isAdminOrSubAdmin, async (req, res) => {
  try {
    const stats = await getMerchantFundingStats(req.params.merchantId);
    if (!stats) return res.status(404).json({ success: false, message: 'Merchant not found' });
    res.json({ success: true, stats });
  } catch (error) {
    console.error('Merchant funding stats error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch funding stats' });
  }
});

// GET /api/admin/merchant-platform/:merchantId/performance-history?days=30
router.get('/merchant-platform/:merchantId/performance-history', authenticate, isAdminOrSubAdmin, async (req, res) => {
  try {
    const days = Math.min(365, Math.max(1, parseInt(req.query.days) || 30));
    const history = await getMerchantPerformanceHistory(req.params.merchantId, { days });
    res.json({ success: true, days, history });
  } catch (error) {
    console.error('Merchant performance history error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch performance history' });
  }
});

// GET /api/admin/merchant-platform/:merchantId/wallet-ledger?page=&limit=
router.get('/merchant-platform/:merchantId/wallet-ledger', authenticate, isAdminOrSubAdmin, async (req, res) => {
  try {
    const page  = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 50));
    const ledger = await getMerchantWalletLedger(req.params.merchantId, { page, limit });
    res.json({ success: true, ...ledger });
  } catch (error) {
    console.error('Merchant wallet ledger error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch merchant wallet ledger' });
  }
});

// POST /api/admin/merchant-platform/bonus-engine/run — on-demand pass of the
// bonus engine (same code the 10-min cron runs; idempotent, pool-capped).
router.post('/merchant-platform/bonus-engine/run', authenticate, isAdmin, async (req, res) => {
  try {
    const outcome = await runBonusEngine();
    res.json({ success: true, ...outcome });
  } catch (error) {
    console.error('Bonus engine run error:', error);
    res.status(500).json({ success: false, message: 'Failed to run bonus engine' });
  }
});

export default router;
