// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
// Domain: Game Registry (Game Management). 2026-07-11.
//
// The catalogue authority: games and categories are DATA, not code. Before this
// domain, the casino/crash lobbies were hardcoded arrays inside React files
// (CasinoPage.tsx GAME_CATALOGUE, CrashPage.tsx CRASH_GAMES) — adding a game
// meant editing a component and redeploying. Now an admin creates a Game
// document and it appears immediately; the frontend renders generic cards from
// GET /api/game/games. This registry OWNS metadata + categories; it REFERENCES
// the existing GameProvider (domains/casino) by key and reuses the existing
// launch/session/wallet-callback spine (POST /api/game/launch, GameSession,
// GameTransaction) — it does not duplicate any of that.
import mongoose from 'mongoose';

// ── GAME CATEGORY ─────────────────────────────────────────────────────────────
// Admin-created, dynamic. Replaces the hardcoded CATEGORIES arrays and the fixed
// provider category enum for DISPLAY/navigation purposes. Categories build the
// user-panel nav + filters at runtime.
const gameCategorySchema = new mongoose.Schema({
  slug:    { type: String, required: true, unique: true, index: true }, // 'live-casino'
  name:    { type: String, required: true },                            // 'Live Casino'
  icon:    { type: String, default: '' },                               // emoji or CDN url
  order:   { type: Number, default: 0 },                                // nav sort
  enabled: { type: Boolean, default: true },                            // hide without deleting
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
});
export const GameCategory = mongoose.model('GameCategory', gameCategorySchema);

// ── GAME ──────────────────────────────────────────────────────────────────────
// One document per game. Everything the UI needs to render a card + launch the
// game lives here — no per-game React page.
const gameSchema = new mongoose.Schema({
  slug:  { type: String, required: true, unique: true, index: true },   // 'live-roulette'
  name:  { type: String, required: true },

  // Linkage (by key/slug — soft refs, so a game can outlive a provider rename).
  providerKey:  { type: String, default: '', index: true },   // GameProvider.key ('' = in-house)
  categorySlug: { type: String, default: '', index: true },   // GameCategory.slug

  // How to launch. PROVIDER_GAME/PROVIDER_LOBBY reuse POST /api/game/launch with
  // the existing session/wallet spine; INTERNAL_ROUTE points at an in-house page
  // (e.g. the cycle game); EXTERNAL_URL opens a direct link.
  launchStrategy:  { type: String, enum: ['PROVIDER_GAME', 'PROVIDER_LOBBY', 'INTERNAL_ROUTE', 'EXTERNAL_URL'], default: 'PROVIDER_GAME' },
  externalGameId:  { type: String, default: '' },  // provider's game id (passed to /launch)
  launchUrl:       { type: String, default: '' },  // for INTERNAL_ROUTE ('/cycle') or EXTERNAL_URL

  // Display metadata.
  thumbnail: { type: String, default: '' },
  banner:    { type: String, default: '' },
  badge:     { type: String, default: '' },   // '🔴 Live', '#1 Worldwide', …
  rtp:       { type: String, default: '' },   // '97.3%' (display string; providers quote differently)
  tags:      { type: [String], default: [] }, // 'popular','new','jackpot','live'

  // Business limits (display + client-side guard; server still enforces its own).
  minBet: { type: Number, default: 0 },
  maxBet: { type: Number, default: 0 },

  // Lifecycle / visibility. ACTIVE shows + playable; MAINTENANCE shows but is
  // locked; INACTIVE is hidden from users entirely (admin still sees it).
  status:   { type: String, enum: ['ACTIVE', 'MAINTENANCE', 'INACTIVE'], default: 'ACTIVE', index: true },
  featured: { type: Boolean, default: false },
  order:    { type: Number, default: 0 },     // sort within a category

  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
});

// Common query: active games in a category, in display order.
gameSchema.index({ status: 1, categorySlug: 1, order: 1 });

export const Game = mongoose.model('Game', gameSchema);
