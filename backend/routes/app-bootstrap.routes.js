// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * Public bootstrap metadata for first-party desktop, Android, and iOS shells.
 *
 * This endpoint deliberately advertises the official web origin only. Native
 * wrappers must not ship hidden proxy/VPN bypass behavior; app transport has to
 * use the same licensed, jurisdiction-aware HTTPS origin as the web product.
 */
import express from 'express';

const router = express.Router();

function csv(value) {
  return String(value || '').split(',').map((v) => v.trim()).filter(Boolean);
}

router.get('/bootstrap', (req, res) => {
  const officialOrigin = process.env.PUBLIC_APP_ORIGIN || `${req.protocol}://${req.get('host')}`;
  res.json({
    success: true,
    app: {
      name: process.env.PUBLIC_APP_NAME || 'Betting Bazaar',
      officialOrigin,
      allowedOrigins: csv(process.env.PUBLIC_APP_ALLOWED_ORIGINS || officialOrigin),
      androidPackage: process.env.ANDROID_PACKAGE_ID || null,
      iosBundleId: process.env.IOS_BUNDLE_ID || null,
      desktopAppId: process.env.DESKTOP_APP_ID || null,
    },
    compliance: {
      geofenceRequired: true,
      kycRequired: true,
      hiddenProxyOrVpn: false,
      networkBypassSupported: false,
      responsibleGamblingRequired: true,
    },
  });
});

export default router;
