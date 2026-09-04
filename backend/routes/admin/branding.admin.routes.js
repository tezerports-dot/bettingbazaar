// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/** branding.admin.routes.js — Branding config, CDN images, app assets */
import { express, authenticate, isAdmin, isAdminOrSubAdmin } from './_adminShared.js';
import { db } from '#db';
import { brandingPayload, broadcastBranding } from '../../domains/branding/brandingPayload.js';
import { generateBrandingUploadUrl, isS3Configured, uploadBufferToS3, deleteFile } from '../../services/cdn.service.js';
import path_node from 'path';
import fs_node from 'fs';

const router = express.Router();

// ── APP-ASSET SLOTS (PWA icons / logos / splash) ──────────────────────────────
// Fixed named slots the admin can upload. Bytes go to S3 when configured
// (shared across instances) or local disk as a graceful fallback; the
// `app_assets` table records where each slot lives so listing is
// multi-instance-correct.
// (Previously these consts lived in system.admin.routes.js while the routes lived
// here — a cross-module reference that threw at request time. Now self-contained.)
const ASSET_SLOTS = {
  'logo.png':           { label: 'App Logo (Loading & Share)',   w: 512,  h: 512,  hint: 'Square PNG, transparent bg. Loading screen + share modal.' },
  'logo-header.png':    { label: 'Header Banner Logo',           w: 600,  h: 120,  hint: 'Wide PNG, transparent bg. Shown in app header center.' },
  'icon-192.png':       { label: 'PWA Icon 192x192',             w: 192,  h: 192,  hint: 'Square PNG. Android home screen shortcut.' },
  'icon-512.png':       { label: 'PWA Icon 512x512 (Maskable)',  w: 512,  h: 512,  hint: 'Square PNG with safe zone. Splash + app store.' },
  'icon-apple-180.png': { label: 'Apple Touch Icon 180x180',     w: 180,  h: 180,  hint: 'Square PNG. iPhone home screen.' },
  'favicon-32.png':     { label: 'Favicon 32x32',                w: 32,   h: 32,   hint: 'Square PNG. Browser tab.' },
  'splash.png':         { label: 'PWA Splash Screen',            w: 1242, h: 2688, hint: 'Portrait PNG. PWA loading splash.' },
};
const isSafeAppAssetSlot = (slot) => /^[a-z0-9][a-z0-9-]*\.png$/.test(slot);

// Local-disk fallback dir (used only when S3 isn't configured). Served by
// server.js at GET /app-assets via express.static.
const appAssetsDir_r = path_node.join(path_node.dirname(new URL(import.meta.url).pathname), '../../app-assets');
fs_node.mkdirSync(appAssetsDir_r, { recursive: true });

// App-asset uploads accept only safe raster image byte signatures — never SVG
// (XSS via CDN) or anything executable. The declared data-URI type is not trusted.
function detectAppAssetMime(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return null;
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]))) return 'image/png';
  if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) return 'image/jpeg';
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (buffer.length >= 6 && ['GIF87a', 'GIF89a'].includes(buffer.toString('ascii', 0, 6))) return 'image/gif';
  return null;
}

// Append a cache-busting token so a re-uploaded slot (same URL) refreshes.
function bust(url, ts) {
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}t=${ts}`;
}

router.get('/branding', authenticate, isAdmin, async (req, res) => {
  try {
    // Branding is a configuration scope. Every key reads as its declared
    // default when nothing has been set, so there is no `|| {}` here and no
    // per-field fallback below — a platform that has never been branded and one
    // branded back to the defaults answer identically, which is the truth.
    res.json({ success: true, branding: await db.config.getConfig('branding') });
  } catch (error) {
    console.error('Get branding error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch branding' });
  }
});

/**
 * Update branding.
 *
 * ── What the config store does that the old write did not ───────────────────
 * The old handler assembled a `$set` from a hand-listed field array and pushed
 * it through an upsert. Three things followed from that, all fixed by routing
 * the write through `applyConfig`:
 *
 *   • A field in the body that was not on the hand-written list was DROPPED,
 *     silently, and the response still said "Branding updated successfully".
 *     The list had drifted from the schema — `betCardDelhiImageUrl` and
 *     `betCardBombayImageUrl` were on it, `platformName` and `footerText` were
 *     not. Now an undeclared key is REFUSED with the path that caused it.
 *   • Nothing was audited. A branding change is an admin action on what every
 *     player sees; it is now versioned and attributed in the same transaction.
 *   • `cdnBaseUrl` was defaulted from the environment on every save, so an
 *     admin clearing the field got the env value written into storage as
 *     though they had typed it — and it then outranked a later env change.
 *     Empty is stored as empty; the env is consulted at READ time, in
 *     `brandingPayload`.
 */
router.put('/branding', authenticate, isAdmin, async (req, res) => {
  try {
    // `key`, `version`, `updatedAt` and `updatedBy` come back on every read;
    // an admin panel that PUTs the object it just GET'd would otherwise be
    // refused for writing settings that are not settings.
    const { key, version, updatedAt, updatedBy, lastUpdated, _id, ...patch } = req.body ?? {};

    const applied = await db.config.applyConfig({
      scope: 'branding', patch,
      actor: req.user.userId, reason: 'Branding updated',
    });

    broadcastBranding(brandingPayload(applied.config));
    res.json({ success: true, message: 'Branding updated successfully', branding: applied.config });
  } catch (error) {
    // A refused key or an out-of-range value is the admin's mistake to see, not
    // a server fault: the message names the exact path.
    if (/^config: /.test(error.message)) {
      return res.status(400).json({ success: false, message: error.message });
    }
    console.error('Update branding error:', error);
    res.status(500).json({ success: false, message: 'Failed to update branding' });
  }
});


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

    // `fileKey` was accepted here and stored on a column the image library
    // does not have: the CDN url IS the key, and `addImage` upserts on it, so
    // re-registering the same url updates its metadata rather than creating a
    // second row that the delete route would then leave behind.
    const image = await db.content.addImage({
      url, title,
      category:    safeCategory,
      description: description || '',
      uploadedBy:  req.user.userId,
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
    const images = await db.content.listImages({ category: category || null });
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
    const deleted = await db.content.deleteImage(imageId);
    if (deleted.ok) {
      return res.json({ success: true, message: 'Image deleted successfully' });
    }
    // An image something still points at is not deletable: removing it would
    // leave a broken banner on whatever references it. The refusal says how
    // many references are holding it, so the admin can go clear them.
    if (deleted.reason === 'IN_USE') {
      return res.status(409).json({
        success: false,
        message: `Image is used in ${deleted.usageCount} place(s) — remove those first`,
        usageCount: deleted.usageCount,
      });
    }
    res.status(404).json({ success: false, message: 'Image not found' });
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
    // The old shape wrapped this in a `try { … } catch { res.json({success:true}) }`
    // that reported success for a FAILED write — the catch existed for a
    // "model may not exist in some deployments" case that has never been true,
    // and it swallowed every real error with it. A failure is now a failure.
    const image = await db.content.addImage({
      url, title, category: category || 'other',
      description: description || '', tags: tags || [],
      uploadedBy: req.user.userId,
    });
    res.json({ success: true, image });
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
      req.user.userId.toString(),
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
    const image = await db.content.addImage({
      url:        cdnUrl,
      title:      title || fileKey,
      category:   category || 'logo',
      fileSize:   fileSize || null,
      uploadedBy: req.user.userId,
    });

    // A logo upload also becomes the live logo, so the admin does not have to
    // re-save the branding form to see the thing they just uploaded. The write
    // goes through the config store like every other branding change, which
    // means it is versioned and audited rather than a silent upsert — and the
    // panels are told, which the old handler never did.
    if (category === 'logo') {
      const applied = await db.config.applyConfig({
        scope: 'branding', patch: { logo: cdnUrl },
        actor: req.user.userId, reason: 'Logo uploaded',
      });
      broadcastBranding(brandingPayload(applied.config));
    }
    res.json({ success: true, image, cdnUrl, fileKey });
  } catch (error) {
    console.error('❌ Branding confirm-upload error:', error);
    res.status(500).json({ success: false, message: error.message || 'Failed to confirm upload' });
  }
});

// GET /app-assets — list every slot with its current upload state. Metadata
// comes from the AppAsset collection (multi-instance source of truth); if a slot
// has no record we fall back to a local-disk stat so pre-existing disk uploads
// still show (backward compatible).
router.get('/app-assets', authenticate, isAdmin, async (req, res) => {
  try {
    const byslot = await db.content.getAllAssets();

    const slots = Object.entries(ASSET_SLOTS).map(([name, meta]) => {
      const rec = byslot[name];
      if (rec) {
        const ts = new Date(rec.updatedAt).getTime();
        return {
          name, label: meta.label, width: meta.w, height: meta.h, hint: meta.hint,
          uploaded:  true,
          url:       bust(rec.url, ts),
          size:      rec.size || null,
          updatedAt: rec.updatedAt,
          storage:   rec.storage,
        };
      }
      // No record — check the local-disk fallback (legacy uploads).
      const filePath = path_node.join(appAssetsDir_r, name);
      const exists   = fs_node.existsSync(filePath);
      const stat     = exists ? fs_node.statSync(filePath) : null;
      return {
        name, label: meta.label, width: meta.w, height: meta.h, hint: meta.hint,
        uploaded:  exists,
        url:       exists ? `/app-assets/${name}?t=${stat.mtimeMs}` : null,
        size:      stat ? stat.size : null,
        updatedAt: stat ? stat.mtime : null,
        storage:   exists ? 'LOCAL' : null,
      };
    });
    res.json({ success: true, slots, storage: isS3Configured() ? 'S3' : 'LOCAL' });
  } catch (err) {
    console.error('[app-assets list]', err.message);
    res.status(500).json({ success: false, message: 'Failed to list app assets' });
  }
});

// POST body (JSON): { slot: "logo.png", data: "data:image/png;base64,..." }
// Uploads to S3 when configured (shared across instances) or local disk otherwise.
// Uses inline express.json with 6MB limit — no new npm dependencies needed.
router.post('/app-assets/upload',
  authenticate, isAdmin,
  express.json({ limit: '6mb' }),
  async (req, res) => {
    try {
      const { slot, data } = req.body;
      if (!slot || !data) return res.status(400).json({ success: false, message: 'slot and data required' });
      if (!isSafeAppAssetSlot(slot) || !ASSET_SLOTS[slot]) return res.status(400).json({ success: false, message: `Unknown slot: ${slot}` });
      const match = data.match(/^data:(image\/[a-z+]+);base64,(.+)$/);
      if (!match) return res.status(400).json({ success: false, message: 'data must be a base64 data URI' });
      const buffer = Buffer.from(match[2], 'base64');
      if (buffer.length > 5 * 1024 * 1024) return res.status(400).json({ success: false, message: 'Max 5 MB' });
      const detectedContentType = detectAppAssetMime(buffer);
      if (!detectedContentType) {
        return res.status(400).json({ success: false, message: 'Only PNG, JPEG, WebP or GIF image bytes are allowed.' });
      }

      let url, storage, fileKey = '';

      if (isS3Configured()) {
        // Deterministic key so the public URL stays stable across re-uploads.
        fileKey = `app-assets/${slot}`;
        url     = await uploadBufferToS3(fileKey, buffer, detectedContentType);
        storage = 'S3';
        // Best-effort: drop any stale local copy so GET doesn't prefer it.
        try { fs_node.unlinkSync(path_node.join(appAssetsDir_r, slot)); } catch { /* none */ }
      } else {
        const filePath = path_node.join(appAssetsDir_r, slot);
        fs_node.writeFileSync(filePath, buffer);
        url     = `/app-assets/${slot}`;
        storage = 'LOCAL';
      }

      // The cache-buster comes from the row the write returned, not from a
      // `new Date()` taken beside it: the two differ by however long the write
      // took, so a client that re-fetched on the earlier timestamp could be
      // handed the previous image from a CDN edge and keep it.
      const record = await db.content.setAsset(slot, {
        url, storage, fileKey, size: buffer.length,
        contentType: detectedContentType, updatedBy: req.user.userId,
      });

      res.json({
        success: true, slot, storage, size: buffer.length,
        url: bust(url, new Date(record.updatedAt).getTime()),
      });
    } catch (err) {
      console.error('[app-assets upload]', err.message);
      res.status(500).json({ success: false, message: 'Failed to save asset' });
    }
  }
);

router.delete('/app-assets/:name', authenticate, isAdmin, async (req, res) => {
  const { name } = req.params;
  if (!ASSET_SLOTS[name]) return res.status(400).json({ success: false, message: 'Unknown slot' });
  try {
    const rec = await db.content.getAsset(name);
    const filePath = path_node.join(appAssetsDir_r, name);
    const diskExists = fs_node.existsSync(filePath);

    if (!rec && !diskExists) return res.status(404).json({ success: false, message: 'Not found' });

    // Remove the bytes wherever they live.
    if (rec?.storage === 'S3' && rec.fileKey) {
      try { await deleteFile(rec.fileKey); } catch (e) { console.warn('[app-assets delete] S3 delete failed:', e.message); }
    }
    if (diskExists) {
      try { fs_node.unlinkSync(filePath); } catch { /* ignore */ }
    }
    if (rec) await db.content.deleteAsset(name);

    res.json({ success: true, message: `${name} deleted` });
  } catch (err) {
    console.error('[app-assets delete]', err.message);
    res.status(500).json({ success: false, message: 'Failed to delete' });
  }
});







export default router;
