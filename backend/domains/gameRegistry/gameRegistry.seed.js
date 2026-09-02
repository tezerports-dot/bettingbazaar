// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
// One-time seed of the Game Registry from the catalogue that used to be
// hardcoded in the React lobbies (CasinoPage.tsx GAME_CATALOGUE,
// CrashPage.tsx CRASH_GAMES) plus the in-house cycle game. Runs ONLY when the
// tables are empty, so it never overwrites admin edits — after the first boot
// the DB is the source of truth. This is what lets the frontend stop shipping
// hardcoded game arrays without any visual regression.
//
// ── The launch strategies below are the table's, not an invented set ────────
// This catalogue said INTERNAL_ROUTE and PROVIDER_GAME. `games_strategy_known`
// declares PROVIDER, URL and INTERNAL — so every row here would have been
// refused by the CHECK, and the seed's own `catch` would have swallowed the
// error and left the lobby permanently empty with a one-line warning.
import { db } from '#db';

const CATEGORIES = [
  { slug: 'bb-originals', name: 'BB Originals',    icon: '🎯', order: 0 },
  { slug: 'table-games',  name: 'Table Games',     icon: '🎲', order: 1 },
  { slug: 'game-shows',   name: 'Game Shows',      icon: '🎪', order: 2 },
  { slug: 'slots',        name: 'Slots',           icon: '🎰', order: 3 },
  { slug: 'indian-games', name: 'Indian Games',    icon: '🇮🇳', order: 4 },
  { slug: 'crash',        name: 'Crash & Instant', icon: '🚀', order: 5 },
];

// providerKey references GameProvider.key; externalGameId is what POST /launch
// forwards to the provider. In-house games use INTERNAL_ROUTE + launchUrl.
const GAMES = [
  // In-house — the live product plugs into the same registry.
  { slug: 'delhi-bombay', name: 'Delhi vs Bombay', providerKey: '', categorySlug: 'bb-originals',
    launchStrategy: 'INTERNAL', launchUrl: '/', badge: '🎯 Original', featured: true, order: 0, tags: ['original', 'live'] },

  // Evolution (table games + shows)
  { slug: 'live-roulette',      name: 'Live Roulette',      providerKey: 'evolution', categorySlug: 'table-games', externalGameId: 'roulette',           badge: '🔴 Live',    rtp: '97.3%', order: 1 },
  { slug: 'blackjack',          name: 'Blackjack',          providerKey: 'evolution', categorySlug: 'table-games', externalGameId: 'blackjack',          badge: '♠ Classic',  rtp: '99.5%', order: 2 },
  { slug: 'speed-baccarat',     name: 'Speed Baccarat',     providerKey: 'evolution', categorySlug: 'table-games', externalGameId: 'baccarat',           badge: '⚡ Fast',    rtp: '98.9%', order: 3 },
  { slug: 'lightning-roulette', name: 'Lightning Roulette', providerKey: 'evolution', categorySlug: 'table-games', externalGameId: 'lightning_roulette', badge: '⚡ 500x',    rtp: '97.1%', order: 4 },
  { slug: 'crazy-time',         name: 'Crazy Time',         providerKey: 'evolution', categorySlug: 'game-shows',  externalGameId: 'crazy_time',         badge: '🎪 Show',    rtp: '96.8%', order: 1, featured: true, tags: ['popular'] },
  { slug: 'monopoly-live',      name: 'Monopoly Live',      providerKey: 'evolution', categorySlug: 'game-shows',  externalGameId: 'monopoly_live',      badge: '🎩 Bonus',   rtp: '96.2%', order: 2 },

  // Pragmatic (slots)
  { slug: 'sweet-bonanza',   name: 'Sweet Bonanza',   providerKey: 'pragmatic', categorySlug: 'slots', externalGameId: 'vs20sugardance', badge: '🍬 21,175x',   rtp: '96.5%', order: 1, featured: true, tags: ['popular'] },
  { slug: 'gates-of-olympus', name: 'Gates of Olympus', providerKey: 'pragmatic', categorySlug: 'slots', externalGameId: 'vs20olympgate', badge: '⚡ 5,000x',   rtp: '96.5%', order: 2 },
  { slug: 'eye-of-cleopatra', name: 'Eye of Cleopatra', providerKey: 'pragmatic', categorySlug: 'slots', externalGameId: 'vs10egyptcls', badge: '🏺 Popular',  rtp: '96.1%', order: 3 },
  { slug: 'the-dog-house',   name: 'The Dog House',   providerKey: 'pragmatic', categorySlug: 'slots', externalGameId: 'vs20doghouse',  badge: '🐕 Free Spins', rtp: '96.5%', order: 4 },

  // Ezugi (Indian games)
  { slug: 'andar-bahar', name: 'Andar Bahar', providerKey: 'ezugi', categorySlug: 'indian-games', externalGameId: '1', badge: '🇮🇳 India',  rtp: '97.9%', order: 1, tags: ['indian'] },
  { slug: 'teen-patti',  name: 'Teen Patti',  providerKey: 'ezugi', categorySlug: 'indian-games', externalGameId: '2', badge: '🃏 India',  rtp: '98.3%', order: 2, tags: ['indian'] },
  { slug: 'lucky-7',     name: 'Lucky 7',     providerKey: 'ezugi', categorySlug: 'indian-games', externalGameId: '3', badge: '🎴 Indian', rtp: '96.7%', order: 3, tags: ['indian'] },

  // Spribe + Smartsoft (crash & instant)
  { slug: 'aviator',       name: 'Aviator',            providerKey: 'spribe',    categorySlug: 'crash', externalGameId: 'aviator', badge: '✈️ #1 Worldwide', featured: true, order: 1, tags: ['popular', 'crash'] },
  { slug: 'jetx',          name: 'JetX',               providerKey: 'smartsoft', categorySlug: 'crash', externalGameId: 'JetX',    badge: '🚀 Popular',     featured: true, order: 2, tags: ['crash'] },
  { slug: 'mines',         name: 'Mines',              providerKey: 'spribe',    categorySlug: 'crash', externalGameId: 'mines',   badge: '💣 Strategy',    order: 3, tags: ['crash'] },
  { slug: 'plinko',        name: 'Plinko',             providerKey: 'smartsoft', categorySlug: 'crash', externalGameId: 'plinko',  badge: '🎯 Casual',      order: 4, tags: ['crash'] },
  { slug: 'hi-lo',         name: 'Hi Lo',              providerKey: 'spribe',    categorySlug: 'crash', externalGameId: 'hilo',    badge: '🃏 Quick',       order: 5, tags: ['crash'] },
  { slug: 'turbo-dice',    name: 'Turbo Dice',         providerKey: 'spribe',    categorySlug: 'crash', externalGameId: 'dice',    badge: '🎲 Fast',        order: 6, tags: ['crash'] },
  { slug: 'penalty-shootout', name: 'Penalty Shoot-Out', providerKey: 'smartsoft', categorySlug: 'crash', externalGameId: 'Penalty', badge: '⚽ Sports',    order: 7, tags: ['crash'] },
  { slug: 'keno',          name: 'Keno',               providerKey: 'spribe',    categorySlug: 'crash', externalGameId: 'keno',    badge: '🔢 Lottery',     order: 8, tags: ['crash'] },
];

let _seeded = false;

/**
 * Seed categories + games IF their collections are empty. Idempotent and safe to
 * call on every boot / first access; a no-op once anything exists. Never throws
 * into the caller — a seed failure must not take the server down.
 */
export async function seedGameRegistry() {
  if (_seeded) return;
  try {
    // Categories first: `games.category_slug` REFERENCES them, so seeding
    // games against an empty category table would either null every game's
    // category (ON DELETE SET NULL does not apply to inserts — the FK would
    // simply refuse) or leave the lobby with uncategorised tiles.
    const existingCategories = await db.games.listCategories({ enabledOnly: false });
    if (existingCategories.length === 0) {
      for (const category of CATEGORIES) {
        await db.games.upsertCategory({ ...category, enabled: true });
      }
      console.log(`🎮 Game Registry: seeded ${CATEGORIES.length} categories`);
    }

    const existingGames = await db.games.listGames({ visibleOnly: false, limit: 1 });
    if (existingGames.length === 0) {
      for (const game of GAMES) {
        await db.games.upsertGame({
          launchStrategy: 'PROVIDER', status: 'ACTIVE', featured: false, order: 0,
          ...game,
        });
      }
      console.log(`🎮 Game Registry: seeded ${GAMES.length} games`);
    }
    _seeded = true;
  } catch (e) {
    // A seed failure must not take the server down — but it MUST be loud. The
    // warning this replaced said "skipped", which reads like a decision rather
    // than a failure, and the empty lobby that followed looked like a
    // configuration choice for as long as nobody read the boot log carefully.
    console.error('[gameRegistry seed] FAILED — the lobby will be empty:', e.message);
  }
}
