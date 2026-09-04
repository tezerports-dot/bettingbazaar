// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * payment-config.routes.js — which funding rail is open.
 *
 * P2P (a merchant sends the money) and a payment gateway are the two ways a
 * player funds an account. The row refuses to have BOTH off: an admin who
 * disables P2P and the gateway together leaves no way to deposit, and finds out
 * from the support queue rather than from the form.
 *
 * ── No handler here receives a credential ───────────────────────────────────
 * The admin read used to SELECT the gateway's API key and secret and blank them
 * out in JavaScript for sub-admins. One forgotten field, one new credential
 * column, or one caller that skipped the masking loop, and a payment gateway
 * secret is in a response body. The reader now reports only WHETHER each is
 * set; the write stores them without reading them back; the connectivity test
 * asks for them by name and returns a verdict.
 */
import express from 'express';
import { db } from '#db';
import { authenticate, isAdmin, isAdminOrSubAdmin } from '../domains/identity/auth.middleware.js';
import { sealCredential } from '../domains/casino/providerCredentials.js';

const router = express.Router();

/**
 * Public: which flow the user panel should show.
 *
 * Never 404s and never errors on a fresh install — a platform with no row
 * configured is P2P-only, which is what a fresh install genuinely is.
 */
router.get('/config', async (req, res) => {
  try {
    const cfg = await db.paymentConfig.getGatewayConfig();
    res.json({
      success: true,
      config: {
        activeMode: cfg.activeMode,
        gatewayProvider: cfg.gatewayProvider,
        gatewayEnabled: cfg.gatewayEnabled,
        p2pEnabled: cfg.p2pEnabled,
      },
    });
  } catch (err) {
    console.error('GET /payment/config error:', err);
    res.status(500).json({ success: false, message: 'Could not load payment configuration.' });
  }
});

// Admin: the full settings, with credential PRESENCE but no credentials.
router.get('/admin/config', authenticate, isAdminOrSubAdmin, async (req, res) => {
  try {
    res.json({ success: true, config: await db.paymentConfig.getGatewayConfigForAdmin() });
  } catch (err) {
    console.error('GET /payment/admin/config error:', err);
    res.status(500).json({ success: false, message: 'Could not load payment configuration.' });
  }
});

router.put('/admin/config', authenticate, isAdmin, async (req, res) => {
  try {
    const b = req.body || {};
    const patch = {
      activeMode: b.activeMode,
      p2pEnabled: b.p2pEnabled,
      gatewayEnabled: b.gatewayEnabled,
      gatewayProvider: b.gatewayProvider,
      callbackUrl: b.gatewayCallbackUrl,
      merchantId: b.gatewayMerchantId,
      updatedBy: req.user.userId,
    };
    // Accepted under their plain names from the form, stored encrypted. An
    // absent key leaves the stored credential alone — an admin editing the
    // callback URL must not wipe the API secret the form cannot show them.
    if (b.gatewayApiKey !== undefined) patch.apiKeyEncrypted = sealCredential(b.gatewayApiKey);
    if (b.gatewayApiSecret !== undefined) patch.apiSecretEncrypted = sealCredential(b.gatewayApiSecret);
    if (b.gatewayWebhookSecret !== undefined) patch.webhookSecretEncrypted = sealCredential(b.gatewayWebhookSecret);

    await db.paymentConfig.setGatewayConfig(patch);

    // Which rails are open decides whether players can fund accounts at all, so
    // a change to it is recorded — without the values, because an audit log is
    // not a place to put a gateway secret.
    await db.audit.recordDetailed({
      performedBy: req.user.userId, action: 'PAYMENT_CONFIG_UPDATED', category: 'CONFIG',
      targetType: 'PaymentGatewayConfig', targetId: 'main',
      details: {
        fields: Object.keys(patch).filter((k) => k !== 'updatedBy' && patch[k] !== undefined),
        activeMode: b.activeMode, p2pEnabled: b.p2pEnabled, gatewayEnabled: b.gatewayEnabled,
      },
    });

    res.json({ success: true, config: await db.paymentConfig.getGatewayConfigForAdmin() });
  } catch (err) {
    // The row refuses a configuration with no way to deposit. That is an
    // operator error with a specific answer, not a 500.
    if (err.code === '23514') {
      return res.status(400).json({
        success: false,
        message: 'At least one funding rail must stay enabled — turning off both P2P and the gateway leaves no way to deposit.',
      });
    }
    console.error('PUT /payment/admin/config error:', err);
    res.status(500).json({ success: false, message: 'Could not update payment configuration.' });
  }
});

/**
 * Admin: is the gateway configured?
 *
 * The credentials are fetched by name and stay in this function. The response
 * says configured or not; it never echoes what it checked.
 */
router.post('/admin/test-gateway', authenticate, isAdmin, async (req, res) => {
  try {
    const [cfg, secrets] = await Promise.all([
      db.paymentConfig.getGatewayConfig(),
      db.paymentConfig.getGatewaySecrets(),
    ]);
    if (!secrets?.apiKeyEncrypted) {
      return res.status(400).json({ success: false, message: 'No API key configured yet' });
    }
    res.json({
      success: true,
      message: `${cfg.gatewayProvider ?? 'Gateway'} credentials are saved. Configure the webhook in your gateway dashboard.`,
    });
  } catch (err) {
    console.error('POST /payment/admin/test-gateway error:', err);
    res.status(500).json({ success: false, message: 'Could not test the gateway.' });
  }
});

export default router;
