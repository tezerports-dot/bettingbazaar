// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * gameRegistry.routes.js — the Game Registry (Game Management) API.
 *
 * Public (users):
 *   GET /api/game/games              — the catalogue (filterable), users see
 *                                      ACTIVE + MAINTENANCE only.
 *   GET /api/game/categories         — enabled categories for nav/filters.
 * Admin:
 *   GET/POST/PUT/DELETE /api/game/admin/games[/:id]
 *   GET/POST/PUT/DELETE /api/game/admin/categories[/:id]
 *
 * Games are DATA. Admin creates one → it appears in the user panel immediately,
 * no deploy. Launching reuses the existing POST /api/game/launch spine
 * (GameProvider + GameSession + GameTransaction) — see gameProvider.routes.js.
 */
import express from 'express';
import mongoose from 'mongoose';
import { authenticate, isAdmin, isAdminOrSubAdmin } from '../identity/auth.middleware.js';

const router = express.Router();

// slugify — deterministic, URL-safe. Used when an admin doesn't supply a slug.
function slugify(s) {
  return String(s || '')
    .toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

// Public projection — never leak internal-only fields (there are none sensitive
// today, but keep the contract explicit so future admin-only fields don't leak).
const PUBLIC_FIELDS = 'slug name providerKey categorySlug launchStrategy externalGameId launchUrl thumbnail banner badge rtp tags minBet maxBet status featured order';

// ── PUBLIC: catalogue ─────────────────────────────────────────────────────────
// Query: category, provider, featured=true, tag, q (name search), limit.
// Users see ACTIVE + MAINTENANCE (MAINTENANCE renders locked). INACTIVE hidden.
router.get('/games', async (req, res) => {
  try {
    const Game = mongoose.model('Game');
    const { category, provider, featured, tag, q, limit } = req.query;

    const filter = { status: { $in: ['ACTIVE', 'MAINTENANCE'] } };
    if (category) filter.categorySlug = category;
    if (provider) filter.providerKey = provider;
    if (featured === 'true') filter.featured = true;
    if (tag) filter.tags = tag;
    if (q) filter.name = { $regex: String(q).slice(0, 60), $options: 'i' };

    const games = await Game.find(filter)
      .select(PUBLIC_FIELDS)
      .sort({ featured: -1, order: 1, name: 1 })
      .limit(Math.min(parseInt(limit) || 200, 500))
      .lean();

    res.json({ success: true, games });
  } catch (err) {
    console.error('[gameRegistry] list games error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to load games' });
  }
});

// ── PUBLIC: categories (enabled), with a live count of visible games ──────────
router.get('/categories', async (req, res) => {
  try {
    const GameCategory = mongoose.model('GameCategory');
    const Game = mongoose.model('Game');
    const cats = await GameCategory.find({ enabled: true }).sort({ order: 1, name: 1 }).lean();

    const counts = await Game.aggregate([
      { $match: { status: { $in: ['ACTIVE', 'MAINTENANCE'] } } },
      { $group: { _id: '$categorySlug', count: { $sum: 1 } } },
    ]);
    const countBySlug = Object.fromEntries(counts.map(c => [c._id, c.count]));

    res.json({
      success: true,
      categories: cats.map(c => ({
        slug: c.slug, name: c.name, icon: c.icon, order: c.order,
        gameCount: countBySlug[c.slug] || 0,
      })),
    });
  } catch (err) {
    console.error('[gameRegistry] list categories error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to load categories' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// ADMIN — GAMES
// ═══════════════════════════════════════════════════════════════════════════
router.get('/admin/games', authenticate, isAdminOrSubAdmin, async (req, res) => {
  try {
    const Game = mongoose.model('Game');
    const { category, provider, status } = req.query;
    const filter = {};
    if (category) filter.categorySlug = category;
    if (provider) filter.providerKey = provider;
    if (status) filter.status = status;
    const games = await Game.find(filter).sort({ order: 1, name: 1 }).lean();
    res.json({ success: true, games });
  } catch (err) {
    console.error('[gameRegistry] admin list games error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to load games' });
  }
});

// Whitelisted writable fields (never trust the whole body).
const GAME_FIELDS = [
  'name', 'providerKey', 'categorySlug', 'launchStrategy', 'externalGameId', 'launchUrl',
  'thumbnail', 'banner', 'badge', 'rtp', 'tags', 'minBet', 'maxBet', 'status', 'featured', 'order',
];

function pickGameFields(body) {
  const out = {};
  for (const f of GAME_FIELDS) if (body[f] !== undefined) out[f] = body[f];
  return out;
}

router.post('/admin/games', authenticate, isAdmin, async (req, res) => {
  try {
    const Game = mongoose.model('Game');
    const data = pickGameFields(req.body);
    if (!data.name) return res.status(400).json({ success: false, message: 'name is required' });

    const slug = slugify(req.body.slug || data.name);
    if (!slug) return res.status(400).json({ success: false, message: 'A valid slug/name is required' });
    if (await Game.exists({ slug })) {
      return res.status(409).json({ success: false, message: `A game with slug "${slug}" already exists` });
    }

    const game = await Game.create({
      ...data, slug,
      createdBy: req.user._id, updatedBy: req.user._id,
      createdAt: new Date(), updatedAt: new Date(),
    });
    res.json({ success: true, game });
  } catch (err) {
    console.error('[gameRegistry] create game error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to create game' });
  }
});

router.put('/admin/games/:id', authenticate, isAdmin, async (req, res) => {
  try {
    const Game = mongoose.model('Game');
    const updates = pickGameFields(req.body);
    // Allow slug rename with a uniqueness guard.
    if (req.body.slug !== undefined) {
      const slug = slugify(req.body.slug);
      if (!slug) return res.status(400).json({ success: false, message: 'Invalid slug' });
      const clash = await Game.findOne({ slug, _id: { $ne: req.params.id } }).select('_id').lean();
      if (clash) return res.status(409).json({ success: false, message: `slug "${slug}" is taken` });
      updates.slug = slug;
    }
    updates.updatedBy = req.user._id;
    updates.updatedAt = new Date();
    const game = await Game.findByIdAndUpdate(req.params.id, updates, { new: true });
    if (!game) return res.status(404).json({ success: false, message: 'Game not found' });
    res.json({ success: true, game });
  } catch (err) {
    console.error('[gameRegistry] update game error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to update game' });
  }
});

router.delete('/admin/games/:id', authenticate, isAdmin, async (req, res) => {
  try {
    const Game = mongoose.model('Game');
    const del = await Game.findByIdAndDelete(req.params.id);
    if (!del) return res.status(404).json({ success: false, message: 'Game not found' });
    res.json({ success: true, message: 'Game deleted' });
  } catch (err) {
    console.error('[gameRegistry] delete game error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to delete game' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// ADMIN — CATEGORIES
// ═══════════════════════════════════════════════════════════════════════════
router.get('/admin/categories', authenticate, isAdminOrSubAdmin, async (req, res) => {
  try {
    const GameCategory = mongoose.model('GameCategory');
    const cats = await GameCategory.find({}).sort({ order: 1, name: 1 }).lean();
    res.json({ success: true, categories: cats });
  } catch (err) {
    console.error('[gameRegistry] admin list categories error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to load categories' });
  }
});

router.post('/admin/categories', authenticate, isAdmin, async (req, res) => {
  try {
    const GameCategory = mongoose.model('GameCategory');
    const { name, icon = '', order = 0, enabled = true } = req.body;
    if (!name) return res.status(400).json({ success: false, message: 'name is required' });
    const slug = slugify(req.body.slug || name);
    if (!slug) return res.status(400).json({ success: false, message: 'A valid slug/name is required' });
    if (await GameCategory.exists({ slug })) {
      return res.status(409).json({ success: false, message: `Category "${slug}" already exists` });
    }
    const cat = await GameCategory.create({ slug, name, icon, order, enabled, updatedBy: req.user._id });
    res.json({ success: true, category: cat });
  } catch (err) {
    console.error('[gameRegistry] create category error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to create category' });
  }
});

router.put('/admin/categories/:id', authenticate, isAdmin, async (req, res) => {
  try {
    const GameCategory = mongoose.model('GameCategory');
    const updates = { updatedBy: req.user._id, updatedAt: new Date() };
    for (const f of ['name', 'icon', 'order', 'enabled']) if (req.body[f] !== undefined) updates[f] = req.body[f];
    const cat = await GameCategory.findByIdAndUpdate(req.params.id, updates, { new: true });
    if (!cat) return res.status(404).json({ success: false, message: 'Category not found' });
    res.json({ success: true, category: cat });
  } catch (err) {
    console.error('[gameRegistry] update category error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to update category' });
  }
});

router.delete('/admin/categories/:id', authenticate, isAdmin, async (req, res) => {
  try {
    const GameCategory = mongoose.model('GameCategory');
    const Game = mongoose.model('Game');
    const cat = await GameCategory.findById(req.params.id);
    if (!cat) return res.status(404).json({ success: false, message: 'Category not found' });
    // Refuse to orphan games — reassign or delete them first.
    const inUse = await Game.countDocuments({ categorySlug: cat.slug });
    if (inUse > 0) {
      return res.status(409).json({ success: false, message: `${inUse} game(s) still use this category. Reassign them first.` });
    }
    await GameCategory.deleteOne({ _id: cat._id });
    res.json({ success: true, message: 'Category deleted' });
  } catch (err) {
    console.error('[gameRegistry] delete category error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to delete category' });
  }
});

export default router;
