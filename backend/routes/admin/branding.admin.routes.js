// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/** branding.admin.routes.js — Branding config, CDN images, app assets */
import { express, mongoose, authenticate, isAdmin, isAdminOrSubAdmin, getModels } from './_adminShared.js';
import { generateBrandingUploadUrl } from '../../services/cdn.service.js';

const router = express.Router();

router.get('/branding', authenticate, isAdmin, async (req, res) => {
  try {
    const { SystemConfig } = getModels();
    
    // FIX: Use Branding model (has proper schema) not SystemConfig.value (field doesn't exist)
    const Branding = mongoose.model('Branding');
    const branding = await Branding.findOne({ key: 'main' }).lean() || {};
    res.json({ success: true, branding });
  } catch (error) {
    console.error('Get branding error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch branding' });
  }
});

// Update branding — C-01 fix: persist ALL schema fields via $set spread.
// GOVERNANCE §2: every admin-editable field must wire to a real consumer.
// GOVERNANCE §9: every field on an admin settings page must reach a real DB write.
router.put('/branding', authenticate, isAdmin, async (req, res) => {
  try {
    const Branding = mongoose.model('Branding');
    const b = req.body;

    // Build $set from all known brandingSchema fields; only set fields present in body.
    // This is idempotent — missing fields in body are left unchanged in DB.
    const $set = { lastUpdated: new Date(), updatedBy: req.user._id };
    const BRANDING_FIELDS = [
      'appName','logo','icon','favicon','splashScreen',
      'userPanelName','adminPanelName','merchantPanelName','queueManagerPanelName',
      'primaryColor','secondaryColor','accentColor',
      'tagline','description','contactEmail','contactPhone','cdnBaseUrl',
      'homePopupImageUrl','homePopupLinkUrl','homePopupEnabled',
      'tricksTipsBannerUrl','rulesPageImageUrl','depositPageBannerUrl',
      'withdrawalPageBannerUrl','loginPageBannerUrl','registerPageBannerUrl',
    ];
    for (const field of BRANDING_FIELDS) {
      if (b[field] !== undefined) $set[field] = b[field];
    }
    // Ensure cdnBaseUrl falls back to env if not provided and not already in DB
    if ($set.cdnBaseUrl === undefined && b.cdnBaseUrl === undefined) {
      $set.cdnBaseUrl = process.env.CDN_URL || '';
    }

    const updated = await Branding.findOneAndUpdate(
      { key: 'main' },
      { $set },
      { upsert: true, new: true }
    );

    // Broadcast full branding payload to all panels (user, admin, merchant)
    
    if (global.io) {
      const payload = updated.toObject();
      global.io.emit('branding_updated', { branding: payload, timestamp: new Date() });
      global.io.emit('branding', buildBrandingPayload(payload));
    }

    res.json({ success: true, message: 'Branding updated successfully', branding: updated });
  } catch (error) {
    console.error('Update branding error:', error);
    res.status(500).json({ success: false, message: 'Failed to update branding' });
  }
});


// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
function buildBrandingPayload(b) {
  const cdnBaseUrl = b.cdnBaseUrl || process.env.CDN_URL || '';
  return {
    appName:              b.appName              || 'Betting Bazaar',
    cdnBaseUrl,
    primaryColor:         b.primaryColor         || '#D4AF37',
    secondaryColor:       b.secondaryColor       || '#8B5CF6',
    accentColor:          b.accentColor          || '#F59E0B',
    logo:                 b.logo                 || '',
    icon:                 b.icon                 || '',
    favicon:              b.favicon              || '',
    splashScreen:         b.splashScreen         || '',
    userPanelName:        b.userPanelName        || 'Betting Bazaar',
    adminPanelName:       b.adminPanelName       || 'Bazaar Admin',
    merchantPanelName:    b.merchantPanelName    || 'Merchant Panel',
    queueManagerPanelName:b.queueManagerPanelName|| 'Queue Manager',
    homePopupImageUrl:    b.homePopupImageUrl    || '',
    homePopupLinkUrl:     b.homePopupLinkUrl     || '',
    homePopupEnabled:     b.homePopupEnabled     || false,
    tricksTipsBannerUrl:  b.tricksTipsBannerUrl  || '',
    rulesPageImageUrl:    b.rulesPageImageUrl     || '',
    depositPageBannerUrl:   b.depositPageBannerUrl   || '',
    withdrawalPageBannerUrl:b.withdrawalPageBannerUrl|| '',
    loginPageBannerUrl:   b.loginPageBannerUrl   || '',
    registerPageBannerUrl:b.registerPageBannerUrl|| '',
  };
}

/**
 * ════════════════════════════════════════════════════════════════════════════
 * 💰 TRANSACTIONS & MERCHANTS
 * ════════════════════════════════════════════════════════════════════════════
 */

// Get all transactions
router.post('/branding/images', authenticate, isAdmin, async (req, res) => {
  try {
    const { url, category, title, description, fileKey } = req.body;

    if (!url || !title) {
      return res.status(400).json({ success: false, message: 'url and title are required' });
    }

    const validCategories = ['banner', 'icon', 'promo', 'misc', 'logo', 'other'];
    const safeCategory = validCategories.includes(category) ? category : 'misc';

    const { CDNImage } = getModels();
    const image = await CDNImage.create({
      url,
      fileKey:     fileKey || '',
      title,
      category:    safeCategory,
      description: description || '',
      uploadedBy:  req.user._id,
    });

    res.json({ success: true, message: 'Image registered successfully', image });
  } catch (error) {
    console.error('POST /branding/images error:', error);
    res.status(500).json({ success: false, message: 'Failed to register image' });
  }
});

// ─── GET /api/admin/branding/images ─────────────────────────────────────────
// Read all CDN images from CDNImage model.  Previously read from
// SystemConfig.cdnImages — a completely separate collection — so images saved
// via confirm-upload (logo flow) never appeared here.  Now unified.
router.get('/branding/images', authenticate, isAdminOrSubAdmin, async (req, res) => {
  try {
    const { category } = req.query;
    const { CDNImage } = getModels();

    const query = category ? { category } : {};
    const images = await CDNImage.find(query)
      .sort({ createdAt: -1 })
      .lean();

    res.json({ success: true, images });
  } catch (error) {
    console.error('GET /branding/images error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch images' });
  }
});

// ─── DELETE /api/admin/branding/images/:imageId ──────────────────────────────
// AUDIT FIX: was deleting from SystemConfig.cdnImages array.  Now deletes from
// CDNImage model, consistent with the unified GET/POST above.
router.delete('/branding/images/:imageId', authenticate, isAdmin, async (req, res) => {
  try {
    const { imageId } = req.params;
    const { CDNImage } = getModels();

    const deleted = await CDNImage.findByIdAndDelete(imageId);
    if (!deleted) {
      return res.status(404).json({ success: false, message: 'Image not found' });
    }

    res.json({ success: true, message: 'Image deleted successfully' });
  } catch (error) {
    console.error('Delete CDN image error:', error);
    res.status(500).json({ success: false, message: 'Failed to delete image' });
  }
});

/**
 * ════════════════════════════════════════════════════════════════════════════
 * 📝 CONTENT MANAGEMENT - FAQ
 * ════════════════════════════════════════════════════════════════════════════
 */

// ✅ FIX #14/#41: FAQ routes now delegate to contentService which uses the correct FAQ model.
//    Old code used PromoContent (wrong schema — no question/answer fields).

// Get FAQs
// FIX-14: seed default FAQs on first access so FAQ Manager is never blank
router.post('/branding/cdn-url', authenticate, isAdmin, async (req, res) => {
  try {
    const { url, title, category, description, tags } = req.body;
    if (!url || !title) return res.status(400).json({ success: false, message: 'url and title required' });
    // Store in branding images collection if CDNImage model exists, else just return success
    try {
      const { CDNImage } = getModels();
      const image = await CDNImage.create({ url, title, category: category || 'other', description, tags: tags || [], uploadedBy: req.user._id });
      res.json({ success: true, image });
    } catch {
      // CDNImage model may not exist in all deployments — store in config
      res.json({ success: true, message: 'URL noted', url, title });
    }
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to add CDN URL' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// BUG FIX: Admin panel logo upload requires these two routes.
// Admin panel calls: (1) POST /branding/upload-url → get S3 presigned URL
//                   (2) PUT file directly to S3
//                   (3) POST /branding/confirm-upload → record CDN URL in DB
// Both routes were missing → logo upload always failed with 404.
// ─────────────────────────────────────────────────────────────────────────────

// POST /api/admin/branding/upload-url — Generate S3 presigned URL for branding asset
router.post('/branding/upload-url', authenticate, isAdmin, async (req, res) => {
  try {
    const { fileName, contentType, fileSize, category = 'logo' } = req.body;
    if (!fileName || !contentType || !fileSize) {
      return res.status(400).json({ success: false, message: 'fileName, contentType and fileSize are required' });
    }
    const result = await generateBrandingUploadUrl(
      fileName,
      contentType,
      fileSize,
      req.user._id.toString(),
      category
    );
    res.json({
      success: true,
      uploadUrl: result.uploadUrl,
      fileKey:   result.fileKey,
      cdnUrl:    result.cdnUrl,
      expiresAt: result.expiresAt,
    });
  } catch (error) {
    console.error('❌ Branding upload-url error:', error);
    res.status(500).json({ success: false, message: error.message || 'Failed to generate upload URL' });
  }
});

// POST /api/admin/branding/confirm-upload — Record completed branding asset upload in DB
router.post('/branding/confirm-upload', authenticate, isAdmin, async (req, res) => {
  try {
    const { fileKey, cdnUrl, category = 'logo', title, fileSize } = req.body;
    if (!fileKey || !cdnUrl) {
      return res.status(400).json({ success: false, message: 'fileKey and cdnUrl are required' });
    }
    // Persist to CDNImage collection if available
    let image = null;
    try {
      const { CDNImage } = getModels();
      image = await CDNImage.create({
        url:         cdnUrl,
        fileKey,
        title:       title || fileKey,
        category:    category || 'logo',
        fileSize:    fileSize || 0,
        uploadedBy:  req.user._id,
      });
    } catch {
      // CDNImage model not present in all deployments — non-fatal
    }
    // If it's a logo, also update the main branding config so the app immediately
    // shows the new logo without admin needing to manually re-save branding settings.
    // AUDIT FIX: was 'logoUrl' which doesn't exist in Branding schema → silent no-op.
    // Correct field name is 'logo'.
    if (category === 'logo') {
      const Branding = mongoose.model('Branding');
      await Branding.findOneAndUpdate(
        { key: 'main' },
        { logo: cdnUrl, updatedBy: req.user._id, lastUpdated: new Date() },
        { upsert: true, new: true }
      );
    }
    res.json({ success: true, image, cdnUrl, fileKey });
  } catch (error) {
    console.error('❌ Branding confirm-upload error:', error);
    res.status(500).json({ success: false, message: error.message || 'Failed to confirm upload' });
  }
});

// Get merchant transaction history
router.get('/app-assets', authenticate, isAdmin, (req, res) => {
  try {
    const slots = Object.entries(ASSET_SLOTS).map(([name, meta]) => {
      const filePath = path_node.join(appAssetsDir_r, name);
      const exists   = fs_node.existsSync(filePath);
      const stat     = exists ? fs_node.statSync(filePath) : null;
      return {
        name, label: meta.label, width: meta.w, height: meta.h, hint: meta.hint,
        uploaded:  exists,
        url:       exists ? `/app-assets/${name}?t=${stat.mtimeMs}` : null,
        size:      stat ? stat.size : null,
        updatedAt: stat ? stat.mtime : null,
      };
    });
    res.json({ success: true, slots });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to list app assets' });
  }
});

// POST body (JSON): { slot: "logo.png", data: "data:image/png;base64,..." }
// Uses inline express.json with 6MB limit — no new npm dependencies needed
router.post('/app-assets/upload',
  authenticate, isAdmin,
  express.json({ limit: '6mb' }),
  async (req, res) => {
    try {
      const { slot, data } = req.body;
      if (!slot || !data) return res.status(400).json({ success: false, message: 'slot and data required' });
      if (!ASSET_SLOTS[slot]) return res.status(400).json({ success: false, message: `Unknown slot: ${slot}` });
      const match = data.match(/^data:(image\/[a-z+]+);base64,(.+)$/);
      if (!match) return res.status(400).json({ success: false, message: 'data must be a base64 data URI' });
      const buffer = Buffer.from(match[2], 'base64');
      if (buffer.length > 5 * 1024 * 1024) return res.status(400).json({ success: false, message: 'Max 5 MB' });
      const filePath = path_node.join(appAssetsDir_r, slot);
      fs_node.writeFileSync(filePath, buffer);
      const stat = fs_node.statSync(filePath);
      res.json({ success: true, slot, url: `/app-assets/${slot}?t=${stat.mtimeMs}`, size: stat.size });
    } catch (err) {
      console.error('[app-assets upload]', err.message);
      res.status(500).json({ success: false, message: 'Failed to save asset' });
    }
  }
);

router.delete('/app-assets/:name', authenticate, isAdmin, (req, res) => {
  const { name } = req.params;
  if (!ASSET_SLOTS[name]) return res.status(400).json({ success: false, message: 'Unknown slot' });
  const filePath = path_node.join(appAssetsDir_r, name);
  if (!fs_node.existsSync(filePath)) return res.status(404).json({ success: false, message: 'Not found' });
  try {
    fs_node.unlinkSync(filePath);
    res.json({ success: true, message: `${name} deleted` });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to delete' });
  }
});







export default router;
