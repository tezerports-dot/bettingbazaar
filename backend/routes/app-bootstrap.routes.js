// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * Public bootstrap metadata for first-party desktop, Android, and iOS shells.
 *
 * This endpoint deliberately advertises the official web origin only. Native
 * wrappers must not ship hidden proxy/VPN bypass behavior; app transport has to
 * use the same licensed, jurisdiction-aware HTTPS origin as the web product.
 */
import express from 'express';
import { csv } from '../startup/validateEnv.js';

const router = express.Router();

router.get('/bootstrap', (req, res) => {
  const officialOrigin = process.env.PUBLIC_APP_ORIGIN;
  res.json({
    success: true,
    app: {
      name: process.env.PUBLIC_APP_NAME || 'Betting Bazaar',
      officialOrigin,
      allowedOrigins: csv(process.env.PUBLIC_APP_ALLOWED_ORIGINS),
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
