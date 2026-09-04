// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file.
/**
 * domains/branding/brandingPayload.js — the one branding payload.
 *
 * ── Why this file exists ────────────────────────────────────────────────────
 * The same twenty-three-field object was built in two places: once in
 * `branding.admin.routes.js` to broadcast after a save, once in
 * `startup/socketHandlers.js` to send on connect. They were copies, so they
 * drifted: only one of them could ever be updated by an edit, and a field added
 * to one reached admins-who-just-saved but not clients-who-just-connected.
 *
 * Both now call `brandingPayload()`. §1 — one owner per value.
 *
 * ── There are no `|| default` fallbacks here ────────────────────────────────
 * Both copies wrote `b.primaryColor || '#D4AF37'`, which is a THIRD declaration
 * of every default, beside the config spec's and the document schema's. The
 * spec fills every absent key with its declared default before this function
 * sees the object, so a fallback here could only ever disagree with it.
 *
 * `cdnBaseUrl` is the single exception, and it is not a default: an empty
 * setting means "use the deployment's CDN_URL", which is a real bootstrap
 * source rather than a fallback value.
 */
import { db } from '#db';

/** The field set every panel receives. Derived from the branding scope. */
export function brandingPayload(b) {
  return {
    appName:                 b.appName,
    cdnBaseUrl:              b.cdnBaseUrl || process.env.CDN_URL || '',
    primaryColor:            b.primaryColor,
    secondaryColor:          b.secondaryColor,
    accentColor:             b.accentColor,
    logo:                    b.logo,
    icon:                    b.icon,
    favicon:                 b.favicon,
    splashScreen:            b.splashScreen,
    userPanelName:           b.userPanelName,
    adminPanelName:          b.adminPanelName,
    merchantPanelName:       b.merchantPanelName,
    queueManagerPanelName:   b.queueManagerPanelName,
    tagline:                 b.tagline,
    description:             b.description,
    contactEmail:            b.contactEmail,
    contactPhone:            b.contactPhone,
    homePopupImageUrl:       b.homePopupImageUrl,
    homePopupLinkUrl:        b.homePopupLinkUrl,
    homePopupEnabled:        b.homePopupEnabled,
    tricksTipsBannerUrl:     b.tricksTipsBannerUrl,
    rulesPageImageUrl:       b.rulesPageImageUrl,
    depositPageBannerUrl:    b.depositPageBannerUrl,
    withdrawalPageBannerUrl: b.withdrawalPageBannerUrl,
    loginPageBannerUrl:      b.loginPageBannerUrl,
    registerPageBannerUrl:   b.registerPageBannerUrl,
    betCardDelhiImageUrl:    b.betCardDelhiImageUrl,
    betCardBombayImageUrl:   b.betCardBombayImageUrl,
  };
}

/** Read the branding scope and shape it for a panel. */
export async function currentBranding() {
  return brandingPayload(await db.config.getConfig('branding'));
}

/**
 * Broadcast branding to every connected panel.
 *
 * Emitted under two names because two generations of client listen for two
 * different ones. Both carry the same object, from the same read — the old
 * admin route sent `updated.toObject()` on one channel and the built payload on
 * the other, so the two events disagreed about what branding was.
 */
export function broadcastBranding(payload) {
  if (!global.io) return payload;
  global.cachedBranding = payload;
  global.io.emit('branding_updated', { branding: payload, timestamp: new Date() });
  global.io.emit('branding', payload);
  return payload;
}
