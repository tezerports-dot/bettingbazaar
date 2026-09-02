// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file.
/**
 * repositories/content.js — what the panels render.
 *
 * Announcements, promo slots, the FAQ, the CDN image library and the named app
 * asset slots. None of it carries money, so the rules here are about a reader
 * never seeing a half-configured thing: a published promo has media, a live
 * announcement has not expired, and one slot holds one asset.
 *
 * Expiry is enforced by the READ throughout, as everywhere else in this folder.
 * PostgreSQL has no TTL index, and that is the better answer: a sweep that is
 * late must not leave an expired banner on the home page.
 */
import { pgQuery } from '../client.js';
import { randomBytes } from 'node:crypto';

const newId = () => randomBytes(12).toString('hex');

// ── Announcements ───────────────────────────────────────────────────────────

const toAnnouncement = (r) => (r ? {
  announcementId: r.announcement_id, _id: r.announcement_id,
  title: r.title, body: r.body, type: r.kind, kind: r.kind,
  priority: r.priority, isActive: r.is_active, expiresAt: r.expires_at,
  createdBy: r.created_by, createdAt: r.created_at,
} : null);

export async function createAnnouncement({
  title, body = '', kind = 'INFO', priority = 0, expiresAt = null, createdBy = null,
}) {
  if (!title) throw new Error('createAnnouncement requires a title');
  const { rows } = await pgQuery(
    `INSERT INTO announcements (announcement_id, title, body, kind, priority, expires_at, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [newId(), String(title), String(body), String(kind), Number(priority) || 0,
      expiresAt, createdBy], 'announcement_create',
  );
  return toAnnouncement(rows[0]);
}

/** Live announcements, most important first. Expiry is in the query. */
export async function listLiveAnnouncements({ limit = 20 } = {}) {
  const { rows } = await pgQuery(
    `SELECT * FROM announcements
      WHERE is_active AND (expires_at IS NULL OR expires_at > now())
      ORDER BY priority DESC, created_at DESC LIMIT $1`,
    [Math.min(Math.max(Number(limit) || 20, 1), 100)], 'announcement_list_live',
  );
  return rows.map(toAnnouncement);
}

export async function listAnnouncements({ limit = 100 } = {}) {
  const { rows } = await pgQuery(
    'SELECT * FROM announcements ORDER BY created_at DESC LIMIT $1',
    [Math.min(Math.max(Number(limit) || 100, 1), 500)], 'announcement_list',
  );
  return rows.map(toAnnouncement);
}

export async function setAnnouncementActive(announcementId, isActive) {
  const { rows } = await pgQuery(
    'UPDATE announcements SET is_active = $2 WHERE announcement_id = $1 RETURNING *',
    [String(announcementId), Boolean(isActive)], 'announcement_set_active',
  );
  return toAnnouncement(rows[0]);
}

export async function deleteAnnouncement(announcementId) {
  const { rowCount } = await pgQuery(
    'DELETE FROM announcements WHERE announcement_id = $1', [String(announcementId)],
    'announcement_delete',
  );
  return rowCount > 0;
}

// ── Promo content ───────────────────────────────────────────────────────────

const toPromo = (r) => (r ? {
  promoId: r.promo_id, _id: r.promo_id,
  title: r.title, description: r.description,
  type: r.kind, location: r.location, mediaType: r.media_type,
  fileUrl: r.file_url, priority: r.priority, status: r.status,
  isActive: r.is_active, createdBy: r.created_by,
  createdAt: r.created_at, updatedAt: r.updated_at,
} : null);

export async function upsertPromo({
  promoId = null, title = '', description = '', kind = 'BANNER', location = 'HOME',
  mediaType = 'IMAGE', fileUrl = null, priority = 0, status = 'DRAFT',
  isActive = false, createdBy = null,
}) {
  const id = String(promoId || newId());
  const { rows } = await pgQuery(
    `INSERT INTO promo_content (promo_id, title, description, kind, location,
       media_type, file_url, priority, status, is_active, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (promo_id) DO UPDATE SET
       title = EXCLUDED.title, description = EXCLUDED.description,
       kind = EXCLUDED.kind, location = EXCLUDED.location,
       media_type = EXCLUDED.media_type, file_url = EXCLUDED.file_url,
       priority = EXCLUDED.priority, status = EXCLUDED.status,
       is_active = EXCLUDED.is_active, updated_at = now()
     RETURNING *`,
    [id, String(title), String(description), String(kind), String(location),
      String(mediaType), fileUrl, Number(priority) || 0, String(status),
      Boolean(isActive), createdBy], 'promo_upsert',
  );
  return toPromo(rows[0]);
}

/** What a panel actually shows in one slot. */
export async function listLivePromos(location = 'HOME', { limit = 20 } = {}) {
  const { rows } = await pgQuery(
    `SELECT * FROM promo_content
      WHERE status = 'PUBLISHED' AND is_active AND location = $1
      ORDER BY priority DESC, created_at DESC LIMIT $2`,
    [String(location), Math.min(Math.max(Number(limit) || 20, 1), 100)], 'promo_list_live',
  );
  return rows.map(toPromo);
}

export async function listPromos({ status = null, limit = 100 } = {}) {
  const params = []; let where = '';
  if (status) { params.push(String(status)); where = 'WHERE status = $1'; }
  const { rows } = await pgQuery(
    `SELECT * FROM promo_content ${where} ORDER BY priority DESC, created_at DESC
      LIMIT ${Math.min(Math.max(Number(limit) || 100, 1), 500)}`,
    params, 'promo_list',
  );
  return rows.map(toPromo);
}

export async function deletePromo(promoId) {
  const { rowCount } = await pgQuery(
    'DELETE FROM promo_content WHERE promo_id = $1', [String(promoId)], 'promo_delete',
  );
  return rowCount > 0;
}

// ── FAQ ─────────────────────────────────────────────────────────────────────

const toFaq = (r) => (r ? {
  faqId: r.faq_id, _id: r.faq_id,
  question: r.question, answer: r.answer, category: r.category,
  order: r.sort_order, isPublished: r.is_published,
  views: Number(r.views), tags: r.tags,
  createdBy: r.created_by, createdAt: r.created_at, updatedAt: r.updated_at,
} : null);

export async function upsertFaq({
  faqId = null, question, answer, category = 'GENERAL', order = 0,
  isPublished = false, tags = [], createdBy = null,
}) {
  if (!question || !answer) throw new Error('upsertFaq requires a question and an answer');
  const id = String(faqId || newId());
  const { rows } = await pgQuery(
    `INSERT INTO faqs (faq_id, question, answer, category, sort_order, is_published, tags, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (faq_id) DO UPDATE SET
       question = EXCLUDED.question, answer = EXCLUDED.answer,
       category = EXCLUDED.category, sort_order = EXCLUDED.sort_order,
       is_published = EXCLUDED.is_published, tags = EXCLUDED.tags, updated_at = now()
     RETURNING *`,
    [id, String(question), String(answer), String(category), Number(order) || 0,
      Boolean(isPublished), tags, createdBy], 'faq_upsert',
  );
  return toFaq(rows[0]);
}

export async function listFaqs({ category = null, publishedOnly = true } = {}) {
  const where = []; const params = [];
  if (publishedOnly) where.push('is_published');
  if (category) { params.push(String(category)); where.push(`category = $${params.length}`); }
  const { rows } = await pgQuery(
    `SELECT * FROM faqs ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY category, sort_order, created_at`,
    params, 'faq_list',
  );
  return rows.map(toFaq);
}

/**
 * Count a view.
 *
 * The arithmetic is in the statement. A read-modify-write loses one of two
 * concurrent views — harmless individually, and wrong by a growing margin on
 * the article everybody reads, which is the one an editor is judging.
 */
export async function recordFaqView(faqId) {
  const { rows } = await pgQuery(
    'UPDATE faqs SET views = views + 1 WHERE faq_id = $1 RETURNING views',
    [String(faqId)], 'faq_view',
  );
  return rows[0] ? Number(rows[0].views) : 0;
}

export async function deleteFaq(faqId) {
  const { rowCount } = await pgQuery('DELETE FROM faqs WHERE faq_id = $1', [String(faqId)], 'faq_delete');
  return rowCount > 0;
}

// ── CDN images ──────────────────────────────────────────────────────────────

const toImage = (r) => (r ? {
  imageId: r.image_id, _id: r.image_id, url: r.url, category: r.category,
  title: r.title, description: r.description, tags: r.tags,
  mimeType: r.mime_type, fileSize: r.file_size === null ? null : Number(r.file_size),
  dimensions: { width: r.width, height: r.height },
  isPublic: r.is_public, usageCount: Number(r.usage_count),
  uploadedBy: r.uploaded_by, uploadedAt: r.uploaded_at,
} : null);

export async function addImage({
  url, category = 'GENERAL', title = '', description = '', tags = [],
  mimeType = null, fileSize = null, width = null, height = null,
  isPublic = true, uploadedBy = null,
}) {
  if (!url) throw new Error('addImage requires a url');
  const { rows } = await pgQuery(
    `INSERT INTO cdn_images (image_id, url, category, title, description, tags,
       mime_type, file_size, width, height, is_public, uploaded_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (url) DO UPDATE SET
       category = EXCLUDED.category, title = EXCLUDED.title,
       description = EXCLUDED.description, tags = EXCLUDED.tags
     RETURNING *`,
    [newId(), String(url), String(category), String(title), String(description), tags,
      mimeType, fileSize, width, height, Boolean(isPublic), uploadedBy], 'image_add',
  );
  return toImage(rows[0]);
}

export async function listImages({ category = null, limit = 200 } = {}) {
  const params = []; let where = '';
  if (category) { params.push(String(category)); where = 'WHERE category = $1'; }
  const { rows } = await pgQuery(
    `SELECT * FROM cdn_images ${where} ORDER BY uploaded_at DESC
      LIMIT ${Math.min(Math.max(Number(limit) || 200, 1), 1000)}`,
    params, 'image_list',
  );
  return rows.map(toImage);
}

/** Note that something started or stopped referencing an image. */
export async function adjustImageUsage(imageId, by = 1) {
  const { rows } = await pgQuery(
    `UPDATE cdn_images SET usage_count = GREATEST(0, usage_count + $2)
      WHERE image_id = $1 RETURNING usage_count`,
    [String(imageId), Number(by) || 0], 'image_usage',
  );
  return rows[0] ? Number(rows[0].usage_count) : 0;
}

/**
 * Delete an image.
 *
 * Refuses while anything still references it, in ONE statement — a check
 * followed by a delete lets a reference land in between, and the result is a
 * broken image on a page nobody is looking at yet.
 */
export async function deleteImage(imageId) {
  const { rows } = await pgQuery(
    'DELETE FROM cdn_images WHERE image_id = $1 AND usage_count = 0 RETURNING image_id',
    [String(imageId)], 'image_delete',
  );
  if (rows.length) return { ok: true };
  const { rows: still } = await pgQuery(
    'SELECT usage_count FROM cdn_images WHERE image_id = $1', [String(imageId)], 'image_delete_check',
  );
  return still.length
    ? { ok: false, reason: 'IN_USE', usageCount: Number(still[0].usage_count) }
    : { ok: false, reason: 'NOT_FOUND' };
}

// ── App asset slots ─────────────────────────────────────────────────────────

const toAsset = (r) => (r ? {
  slot: r.slot, url: r.url, storage: r.storage, fileKey: r.file_key,
  size: r.file_size === null ? null : Number(r.file_size),
  contentType: r.content_type, updatedAt: r.updated_at, updatedBy: r.updated_by,
} : null);

/** One asset per named slot. `slot` is the key: two splash screens is not a state. */
export async function setAsset(slot, { url, storage = 'CDN', fileKey = null, size = null, contentType = null, updatedBy = null }) {
  if (!slot || !url) throw new Error('setAsset requires a slot and a url');
  const { rows } = await pgQuery(
    `INSERT INTO app_assets (slot, url, storage, file_key, file_size, content_type, updated_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (slot) DO UPDATE SET
       url = EXCLUDED.url, storage = EXCLUDED.storage, file_key = EXCLUDED.file_key,
       file_size = EXCLUDED.file_size, content_type = EXCLUDED.content_type,
       updated_by = EXCLUDED.updated_by, updated_at = now()
     RETURNING *`,
    [String(slot), String(url), String(storage), fileKey, size, contentType, updatedBy],
    'asset_set',
  );
  return toAsset(rows[0]);
}

export async function getAsset(slot) {
  const { rows } = await pgQuery('SELECT * FROM app_assets WHERE slot = $1', [String(slot)], 'asset_get');
  return toAsset(rows[0]);
}

/** Every slot at once — what the app bootstrap endpoint returns. */
export async function getAllAssets() {
  const { rows } = await pgQuery('SELECT * FROM app_assets ORDER BY slot', [], 'asset_all');
  return Object.fromEntries(rows.map((r) => [r.slot, toAsset(r)]));
}

export async function deleteAsset(slot) {
  const { rowCount } = await pgQuery('DELETE FROM app_assets WHERE slot = $1', [String(slot)], 'asset_delete');
  return rowCount > 0;
}
