// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)

import express from 'express';
import mongoose from 'mongoose';
import { authenticate, isAdmin, isAdminOrSubAdmin } from '../domains/identity/auth.middleware.js';

const router = express.Router();

// Public: used by user panel to know which flow to show
router.get('/config', async (req, res) => {
  try {
    const PaymentGatewayConfig = mongoose.model('PaymentGatewayConfig');
    let cfg = await PaymentGatewayConfig.findOne({ key: 'main' })
      .select('activeMode gatewayProvider gatewayEnabled p2pEnabled')
      .lean();
    if (!cfg) cfg = { activeMode: 'P2P', p2pEnabled: true, gatewayEnabled: false };
    res.json({ success: true, config: cfg });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Admin: full config
router.get('/admin/config', authenticate, isAdminOrSubAdmin, async (req, res) => {
  try {
    const PaymentGatewayConfig = mongoose.model('PaymentGatewayConfig');
    let cfg = await PaymentGatewayConfig.findOne({ key: 'main' }).lean();
    if (!cfg) { cfg = (await PaymentGatewayConfig.create({ key: 'main' })).toObject(); }
    // Mask secrets for sub-admins
    if (!req.user.isAdmin) {
      if (cfg.gatewayApiKey)    cfg.gatewayApiKey    = cfg.gatewayApiKey.slice(0, 6) + '••••••';
      if (cfg.gatewayApiSecret) cfg.gatewayApiSecret = '••••••••••••';
      if (cfg.gatewayWebhookSecret) cfg.gatewayWebhookSecret = '••••••••••••';
    }
    res.json({ success: true, config: cfg });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Admin: update
router.put('/admin/config', authenticate, isAdmin, async (req, res) => {
  try {
    const PaymentGatewayConfig = mongoose.model('PaymentGatewayConfig');
    const allowed = [
      'activeMode', 'p2pEnabled', 'gatewayEnabled',
      'gatewayProvider', 'gatewayApiKey', 'gatewayApiSecret',
      'gatewayWebhookSecret', 'gatewayCallbackUrl', 'gatewayMerchantId',
    ];
    const update = { updatedBy: req.user.userId, updatedAt: new Date() };
    for (const k of allowed) if (req.body[k] !== undefined) update[k] = req.body[k];
    const cfg = await PaymentGatewayConfig.findOneAndUpdate(
      { key: 'main' }, update, { upsert: true, new: true }
    );
    res.json({ success: true, config: cfg });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Admin: test gateway connection
router.post('/admin/test-gateway', authenticate, isAdmin, async (req, res) => {
  try {
    const PaymentGatewayConfig = mongoose.model('PaymentGatewayConfig');
    const cfg = await PaymentGatewayConfig.findOne({ key: 'main' });
    if (!cfg?.gatewayApiKey) {
      return res.status(400).json({ success: false, message: 'No API key configured yet' });
    }
    // TODO: replace with real gateway ping call for chosen provider
    res.json({ success: true, message: `${cfg.gatewayProvider} credentials are saved. Configure webhook in your gateway dashboard.` });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

export default router;
