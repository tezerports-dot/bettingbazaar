// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * merchantPlatform.admin.routes.js — Merchant Platform analytics surface
 * (BBEPS Phase 008): leaderboard, funding statistics and performance history.
 * Read-only.
 * Mounted at /api/admin via routes/admin/index.js.
 */
import {
  authenticate, express, hasPermission,
} from '../../routes/admin/_adminShared.js';
import { getMerchantLeaderboard, getMerchantFundingStats, getMerchantPerformanceHistory } from './merchantAnalytics.service.js';

const router = express.Router();

// GET /api/admin/merchant-platform/leaderboard?days=30&limit=20&sortBy=volume
router.get('/merchant-platform/leaderboard', authenticate, hasPermission('canManageMerchants'), async (req, res) => {
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
// Same screen as `/merchant-platform/leaderboard`.
router.get('/merchant-platform/:merchantId/funding-stats', authenticate, hasPermission('canManageMerchants'), async (req, res) => {
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
// Same screen as `/merchant-platform/leaderboard`.
router.get('/merchant-platform/:merchantId/performance-history', authenticate, hasPermission('canManageMerchants'), async (req, res) => {
  try {
    const days = Math.min(365, Math.max(1, parseInt(req.query.days) || 30));
    const history = await getMerchantPerformanceHistory(req.params.merchantId, { days });
    res.json({ success: true, days, history });
  } catch (error) {
    console.error('Merchant performance history error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch performance history' });
  }
});

export default router;
