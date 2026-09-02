// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/** utr.admin.routes.js — UTR fraud detection and resolution  v6.0.0
 *
 * v6.0.0: Added UTRRegistry-backed routes per Migration Spec Section 9 / 16.1
 *   GET /utr-registry        — List all UTRRegistry entries (filterable by status)
 *   GET /utr-registry/:utr   — Lookup single UTR entry
 *   PUT /utr-registry/:utr/flag — Admin flags UTR as FRAUD
 */
import { express, mongoose, authenticate, isAdmin, getModels } from './_adminShared.js';
import { db } from '#db';

const router = express.Router();

// ─── GET /api/admin/utr-registry ─────────────────────────────────────────────
// List UTR registry entries. Supports ?status= filter (ACTIVE|RELEASED|FRAUD).
// Spec Section 16.1
router.get('/utr-registry', authenticate, isAdmin, async (req, res) => {
  try {
    const { status, limit = 50, page = 1 } = req.query;
    const UTRRegistry = mongoose.model('UTRRegistry');
    const query = {};
    if (status) query.status = status;
    const skip  = (parseInt(page) - 1) * parseInt(limit);
    const [entries, total] = await Promise.all([
      UTRRegistry.find(query)
        .sort({ registeredAt: -1 })
        .limit(parseInt(limit))
        .skip(skip)
        .populate('orderId', 'orderId type fiatAmount tokenAmount status')
        .populate('userId',  'username mobile')
        .lean(),
      UTRRegistry.countDocuments(query),
    ]);
    res.json({ success: true, entries, pagination: { total, page: parseInt(page), limit: parseInt(limit) } });
  } catch (error) {
    console.error('GET /utr-registry error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch UTR registry' });
  }
});

// ─── GET /api/admin/utr-registry/:utr ────────────────────────────────────────
// Lookup single UTR entry. Spec Section 16.1
router.get('/utr-registry/:utr', authenticate, isAdmin, async (req, res) => {
  try {
    const UTRRegistry = mongoose.model('UTRRegistry');
    const normalized  = req.params.utr.toUpperCase().replace(/\s+/g, '');
    const entry = await UTRRegistry.findOne({ utr: normalized })
      .populate('orderId', 'orderId type fiatAmount tokenAmount status proofScreenshot')
      .populate('userId',  'username mobile kycStatus')
      .lean();
    if (!entry) return res.status(404).json({ success: false, message: 'UTR not found in registry' });
    res.json({ success: true, entry });
  } catch (error) {
    console.error('GET /utr-registry/:utr error:', error);
    res.status(500).json({ success: false, message: 'Failed to lookup UTR' });
  }
});

// ─── PUT /api/admin/utr-registry/:utr/flag ───────────────────────────────────
// Admin flags a UTR as FRAUD. Does NOT auto-reverse the associated order.
// Spec Section 9.4 / 9.5
router.put('/utr-registry/:utr/flag', authenticate, isAdmin, async (req, res) => {
  try {
    const UTRRegistry = mongoose.model('UTRRegistry');
    const normalized  = req.params.utr.toUpperCase().replace(/\s+/g, '');
    const result = await UTRRegistry.findOneAndUpdate(
      { utr: normalized },
      { $set: { status: 'FRAUD' } },
      { new: true }
    );
    if (!result) return res.status(404).json({ success: false, message: 'UTR not found in registry' });
    res.json({ success: true, message: 'UTR flagged as FRAUD', entry: result });
  } catch (error) {
    console.error('PUT /utr-registry/:utr/flag error:', error);
    res.status(500).json({ success: false, message: 'Failed to flag UTR' });
  }
});


router.get('/utr/flagged', authenticate, isAdmin, async (req, res) => {
  try {
    const { page = 1, limit = 50, type } = req.query;
    const PaymentOrder = mongoose.model('PaymentOrder');
    const query = { requiresReview: true, utrWarning: { $exists: true, $ne: null } };
    if (type) query.utrWarning = type;
    const flaggedOrders = await PaymentOrder.find(query)
      .populate('userId', 'username mobile kycStatus')
      .populate('merchantId', 'username mobile')
      .sort({ createdAt: -1 })
      .limit(parseInt(limit))
      .skip((parseInt(page) - 1) * parseInt(limit));
    const total = await PaymentOrder.countDocuments(query);
    res.json({ success: true, flaggedOrders, pagination: { page: parseInt(page), limit: parseInt(limit), total } });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to fetch flagged orders' });
  }
});

// ─── GET /api/admin/utr/stats ─────────────────────────────────────────────────
router.get('/utr/stats', authenticate, isAdmin, async (req, res) => {
  try {
    const { getUTRStats } = await import('../../middleware/utrValidation.js');
    const stats = await getUTRStats();
    res.json({ success: true, stats });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to fetch UTR stats' });
  }
});

// ─── GET /api/admin/utr/user-history/:userId ─────────────────────────────────
router.get('/utr/user-history/:userId', authenticate, isAdmin, async (req, res) => {
  try {
    const { userId } = req.params;
    const UTRRegistry = mongoose.model('UTRRegistry');
    const history = await UTRRegistry.find({ userId })
      .sort({ registeredAt: -1 })
      .limit(100)
      .lean();
    res.json({ success: true, history, totalUTRs: history.length });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to fetch user UTR history' });
  }
});

// ─── POST /api/admin/utr/resolve/:orderId ────────────────────────────────────
router.post('/utr/resolve/:orderId', authenticate, isAdmin, async (req, res) => {
  try {
    const { orderId } = req.params;
    const { action, notes } = req.body;
    if (!['approve', 'reject'].includes(action)) {
      return res.status(400).json({ success: false, message: 'action must be approve or reject' });
    }
    const PaymentOrder = mongoose.model('PaymentOrder');
    const order    = await db.orders.getOrderRecord(orderId);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
    order.requiresReview = false;
    order.reviewedBy     = req.user.userId;
    order.reviewedAt     = new Date();
    order.reviewAction   = action;
    order.reviewNotes    = notes || '';
    if (action === 'reject') {
      order.status        = 'CANCELLED';
      order.cancelReason  = `UTR fraud: ${order.utrWarningMessage || 'admin review'}`;
      order.cancelledAt   = new Date();
    }
    await order.save();
    res.json({ success: true, message: `Order ${action}d`, order });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to resolve order' });
  }
});

export default router;
