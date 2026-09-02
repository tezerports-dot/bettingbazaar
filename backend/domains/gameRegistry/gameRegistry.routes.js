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
import { db } from '#db';
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
/*
 * PUBLIC_FIELDS is gone. It was a projection string listing every field the
 * repository already returns, so it selected everything and protected nothing —
 * a name that reads like a safety boundary and is not one. If a game ever
 * carries something a player must not see, it belongs in a separate reader like
 * `getProviderSecrets`, not in a string a future field is forgotten from.
 */

// ── PUBLIC: catalogue ─────────────────────────────────────────────────────────
// Query: category, provider, featured=true, tag, q (name search), limit.
// Users see ACTIVE + MAINTENANCE (MAINTENANCE renders locked). INACTIVE hidden.
router.get('/games', async (req, res) => {
  try {
    const { category, provider, featured, tag, q, limit } = req.query;

    // Visible means ACTIVE or MAINTENANCE. A game under maintenance is still
    // shown, greyed out — removing the tile makes players think it is gone for
    // good. Only INACTIVE is hidden.
    //
    // The name search is ANCHORED in the repository, so a search box cannot be
    // turned into a leading-wildcard scan of the whole catalogue.
    const games = await db.games.listGames({
      categorySlug: category || null,
      providerKey: provider || null,
      featuredOnly: featured === 'true',
      tag: tag || null,
      search: q || null,
      limit: Math.min(parseInt(limit, 10) || 200, 500),
    });

    res.json({ success: true, games });
  } catch (err) {
    console.error('[gameRegistry] list games error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to load games' });
  }
});

// ── PUBLIC: categories (enabled), with a live count of visible games ──────────
router.get('/categories', async (req, res) => {
  try {
    // ONE query. It was a category fetch plus a separate aggregation, so a
    // category created between them appeared with a count of zero, and a game
    // moved between categories could be counted twice or not at all.
    const categories = await db.games.listCategoriesWithCounts({ enabledOnly: true });
    res.json({ success: true, categories });
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
    const { category, provider, status } = req.query;
    const games = await db.games.listGames({
      categorySlug: category || null,
      providerKey: provider || null,
      status: status || null,
      visibleOnly: false,          // the admin list shows INACTIVE games too
      limit: 1000,
    });
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
    const data = pickGameFields(req.body);
    if (!data.name) return res.status(400).json({ success: false, message: 'name is required' });

    const slug = slugify(req.body.slug || data.name);
    if (!slug) return res.status(400).json({ success: false, message: 'A valid slug/name is required' });

    // The slug's uniqueness is decided by the primary key, not by an `exists`
    // check two simultaneous creations both pass. The launchability rule is a
    // CHECK on the row, so an ACTIVE game that nothing can launch is refused
    // here as well as on every other path that could set the status.
    if (await db.games.getGame(slug)) {
      return res.status(409).json({ success: false, message: `A game with slug "${slug}" already exists` });
    }
    let game;
    try {
      game = await db.games.upsertGame({
        ...data, slug, createdBy: req.user.userId, updatedBy: req.user.userId,
      });
    } catch (e) {
      if (e.code === '23514') {
        return res.status(400).json({
          success: false,
          message: 'An ACTIVE game must be launchable — a provider game needs a provider and an external id, a URL game needs a URL.',
        });
      }
      throw e;
    }
    res.json({ success: true, game });
  } catch (err) {
    console.error('[gameRegistry] create game error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to create game' });
  }
});

router.put('/admin/games/:id', authenticate, isAdmin, async (req, res) => {
  try {
    const existing = await db.games.getGame(req.params.id);
    if (!existing) return res.status(404).json({ success: false, message: 'Game not found' });

    // The slug IS the identity — renaming one is creating a different game and
    // orphaning every reference to the old one, so it is not offered. The
    // display name is what an admin actually wants to change.
    const updates = pickGameFields(req.body);
    let game;
    try {
      game = await db.games.upsertGame({
        ...existing, ...updates, slug: existing.slug, updatedBy: req.user.userId,
      });
    } catch (e) {
      if (e.code === '23514') {
        return res.status(400).json({
          success: false,
          message: 'An ACTIVE game must be launchable — a provider game needs a provider and an external id, a URL game needs a URL.',
        });
      }
      throw e;
    }
    res.json({ success: true, game });
  } catch (err) {
    console.error('[gameRegistry] update game error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to update game' });
  }
});

router.delete('/admin/games/:id', authenticate, isAdmin, async (req, res) => {
  try {
    if (!await db.games.deleteGame(req.params.id)) {
      return res.status(404).json({ success: false, message: 'Game not found' });
    }
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
    res.json({ success: true, categories: await db.games.listCategoriesWithCounts({ enabledOnly: false }) });
  } catch (err) {
    console.error('[gameRegistry] admin list categories error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to load categories' });
  }
});

router.post('/admin/categories', authenticate, isAdmin, async (req, res) => {
  try {
    const { name, icon = '', order = 0, enabled = true } = req.body;
    if (!name) return res.status(400).json({ success: false, message: 'name is required' });
    const slug = slugify(req.body.slug || name);
    if (!slug) return res.status(400).json({ success: false, message: 'A valid slug/name is required' });

    const category = await db.games.upsertCategory({
      slug, name, icon, order, enabled, updatedBy: req.user.userId,
    });
    res.json({ success: true, category });
  } catch (err) {
    console.error('[gameRegistry] create category error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to create category' });
  }
});

router.put('/admin/categories/:id', authenticate, isAdmin, async (req, res) => {
  try {
    const existing = (await db.games.listCategories({ enabledOnly: false }))
      .find((c) => c.slug === req.params.id);
    if (!existing) return res.status(404).json({ success: false, message: 'Category not found' });

    const updates = { ...existing };
    for (const f of ['name', 'icon', 'order', 'enabled']) {
      if (req.body[f] !== undefined) updates[f] = req.body[f];
    }
    const category = await db.games.upsertCategory({ ...updates, updatedBy: req.user.userId });
    res.json({ success: true, category });
  } catch (err) {
    console.error('[gameRegistry] update category error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to update category' });
  }
});

router.delete('/admin/categories/:id', authenticate, isAdmin, async (req, res) => {
  try {
    // The refusal and the delete are ONE statement: a count followed by a
    // delete lets a game be assigned in between, and the games are then
    // pointing at a category that no longer exists.
    const result = await db.games.deleteCategory(req.params.id);
    if (!result.ok) {
      if (result.reason === 'NOT_FOUND') {
        return res.status(404).json({ success: false, message: 'Category not found' });
      }
      return res.status(409).json({
        success: false,
        message: `${result.gameCount} game(s) still use this category. Reassign them first.`,
      });
    }
    res.json({ success: true, message: 'Category deleted' });
  } catch (err) {
    console.error('[gameRegistry] delete category error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to delete category' });
  }
});

export default router;
