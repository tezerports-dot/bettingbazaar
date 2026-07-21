// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * CasinoPage.tsx — metadata-driven casino lobby.
 *
 * Games and categories are DATA, fetched from the Game Registry
 * (GET /api/game/games, GET /api/game/categories) — NOT a hardcoded array.
 * Admin adds a game in the panel → it appears here with no deploy. Rendering is
 * one generic GameCard for every game. Provider gating is preserved: a game only
 * shows/launches when its provider is enabled (useGameProviders). Launch reuses
 * the existing POST /api/game/launch session/wallet spine.
 */
import React, { useEffect, useState, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router';
import { useGameProviders } from '../services/GameProviderContext';

// Registry shapes (mirror backend PUBLIC_FIELDS / categories payload).
interface RegistryGame {
  slug: string; name: string; providerKey: string; categorySlug: string;
  launchStrategy: 'PROVIDER_GAME' | 'PROVIDER_LOBBY' | 'INTERNAL_ROUTE' | 'EXTERNAL_URL';
  externalGameId: string; launchUrl: string;
  thumbnail: string; banner: string; badge: string; rtp: string; tags: string[];
  minBet: number; maxBet: number; status: 'ACTIVE' | 'MAINTENANCE'; featured: boolean; order: number;
}
interface RegistryCategory { slug: string; name: string; icon: string; order: number; gameCount: number; }

// Categories owned by other surfaces (home / crash lobby) — excluded here.
const NON_CASINO = new Set(['crash', 'bb-originals']);

const CATEGORY_EMOJI: Record<string, string> = {
  'slots': '🎰', 'game-shows': '🎪', 'indian-games': '🃏', 'table-games': '🎲',
};

const GameCard: React.FC<{ game: RegistryGame; providerLabel: string; onPlay: () => void; loading: boolean }> = ({ game, providerLabel, onPlay, loading }) => {
  const [imgErr, setImgErr] = useState(false);
  const maint = game.status === 'MAINTENANCE';
  return (
    <div className={`relative rounded-xl overflow-hidden bg-dark-800 border border-dark-700 group transition-transform ${maint ? 'opacity-60' : 'active:scale-95 cursor-pointer'}`}
      onClick={maint ? undefined : onPlay}>
      <div className="relative h-32 bg-gradient-to-br from-dark-700 to-dark-800 overflow-hidden">
        {game.thumbnail && !imgErr ? (
          <img src={game.thumbnail} alt={game.name} className="w-full h-full object-cover opacity-90" onError={() => setImgErr(true)} />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <span className="text-5xl opacity-60">{CATEGORY_EMOJI[game.categorySlug] || '🎲'}</span>
          </div>
        )}
        <div className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 group-active:opacity-100 transition-opacity flex items-center justify-center">
          {maint
            ? <div className="bg-yellow-600 text-black font-bold text-[10px] px-3 py-1 rounded-full">🔧 MAINTENANCE</div>
            : loading
              ? <div className="w-8 h-8 border-2 border-white border-t-transparent rounded-full animate-spin" />
              : <div className="bg-yellow-500 text-black font-bold text-xs px-4 py-2 rounded-full">▶ PLAY</div>}
        </div>
        {game.badge && <span className="absolute top-1.5 left-1.5 bg-black/70 text-white text-[9px] font-semibold px-1.5 py-0.5 rounded-full">{game.badge}</span>}
        {game.rtp && <span className="absolute top-1.5 right-1.5 bg-black/50 text-green-400 text-[9px] font-mono px-1.5 py-0.5 rounded">RTP {game.rtp}</span>}
      </div>
      <div className="px-2.5 py-2">
        <p className="text-xs font-semibold text-white truncate">{game.name}</p>
        <p className="text-[9px] text-gray-500 mt-0.5">{providerLabel}</p>
      </div>
    </div>
  );
};

const CasinoPage: React.FC = () => {
  const navigate  = useNavigate();
  const { enabledCasino, anyCasino } = useGameProviders();
  const [games, setGames]           = useState<RegistryGame[]>([]);
  const [categories, setCategories] = useState<RegistryCategory[]>([]);
  const [category, setCategory]     = useState('All');
  const [search, setSearch]         = useState('');
  const [launching, setLaunching]   = useState<string | null>(null);
  const [gameUrl, setGameUrl]       = useState<string | null>(null);
  const [activeGameName, setActiveGameName] = useState('');
  const iframeRef = useRef<HTMLIFrameElement>(null);

  // Redirect if no casino provider is enabled (unchanged behavior).
  useEffect(() => { if (!anyCasino) navigate('/', { replace: true }); }, [anyCasino]);

  // Fetch catalogue from the registry on mount.
  useEffect(() => {
    (async () => {
      try {
        const [g, c] = await Promise.all([
          window.fetch('/api/game/games').then(r => r.json()),
          window.fetch('/api/game/categories').then(r => r.json()),
        ]);
        if (g.success) setGames(g.games || []);
        if (c.success) setCategories((c.categories || []).filter((x: RegistryCategory) => !NON_CASINO.has(x.slug)));
      } catch (e) { console.warn('[CasinoPage] catalogue fetch failed:', e instanceof Error ? e.message : e); }
    })();
  }, []);

  const enabledKeys  = enabledCasino.map(p => p.key);
  const providerName = (key: string) => enabledCasino.find(p => p.key === key)?.name.split(' ')[0] || key;

  const visibleGames = games.filter(g => {
    if (NON_CASINO.has(g.categorySlug)) return false;         // not the casino lobby
    if (!enabledKeys.includes(g.providerKey)) return false;   // provider must be live
    if (category !== 'All' && g.categorySlug !== category) return false;
    if (search && !g.name.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  const launch = useCallback(async (game: RegistryGame) => {
    setLaunching(game.slug);
    try {
      const token = localStorage.getItem('auth_token') || '';
      const r = await fetch('/api/game/launch', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ providerKey: game.providerKey, gameId: game.externalGameId, gameName: game.name }),
      });
      const data = await r.json();
      if (data.success && data.launchUrl) {
        setGameUrl(data.launchUrl);
        setActiveGameName(game.name);
      } else {
        alert(data.message || 'Could not launch game');
      }
    } catch { alert('Launch failed'); } finally { setLaunching(null); }
  }, []);

  if (gameUrl) return (
    <div className="fixed inset-0 bg-black z-50 flex flex-col">
      <div className="flex items-center justify-between bg-[#0A0F1C] px-4 h-10 flex-shrink-0 border-b border-dark-700">
        <div className="flex items-center gap-2">
          <span className="text-yellow-400 text-sm font-bold">🎰</span>
          <span className="text-white text-xs font-medium">{activeGameName}</span>
        </div>
        <button onClick={() => setGameUrl(null)}
          className="text-gray-400 hover:text-white text-xs border border-dark-600 hover:border-dark-400 px-3 py-1 rounded transition-colors">
          ✕ Close
        </button>
      </div>
      <iframe ref={iframeRef} src={gameUrl} className="flex-1 w-full border-0"
        allow="fullscreen autoplay camera microphone" allowFullScreen title={activeGameName} />
    </div>
  );

  // Category chips: 'All' + the registry categories that actually have visible games.
  const chipCats = ['All', ...categories.filter(c => games.some(g => g.categorySlug === c.slug && enabledKeys.includes(g.providerKey))).map(c => c.slug)];
  const chipLabel = (slug: string) => slug === 'All' ? 'All' : (categories.find(c => c.slug === slug)?.name || slug);

  return (
    <div className="h-full overflow-y-auto bg-[#0A0F1C] text-white pb-4">
      <div className="bg-gradient-to-b from-purple-950/60 to-transparent px-4 pt-3 pb-4">
        <button onClick={() => navigate('/')} className="text-gray-500 text-xs mb-2 block">← Back</button>
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold">🎰 Live Casino</h1>
            <p className="text-gray-500 text-xs mt-0.5">{visibleGames.length} games · Real dealers</p>
          </div>
          <div className="flex items-center gap-1.5">
            {enabledCasino.map(p => (
              <span key={p.key} className="text-[9px] bg-purple-900/50 text-purple-300 border border-purple-700/50 px-2 py-0.5 rounded-full">
                {p.name.split(' ')[0]}
              </span>
            ))}
          </div>
        </div>
      </div>

      <div className="px-4 mb-3">
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="🔍 Search games..."
          className="w-full bg-dark-800 border border-dark-700 rounded-xl px-4 py-2.5 text-sm text-white placeholder-gray-600 outline-none focus:border-purple-500/50" />
      </div>

      <div className="flex gap-2 px-4 pb-4 overflow-x-auto scrollbar-hide">
        {chipCats.map(cat => (
          <button key={cat} onClick={() => setCategory(cat)}
            className={`px-4 py-1.5 rounded-full text-xs font-medium whitespace-nowrap transition-all border ${
              category === cat ? 'bg-purple-600 border-purple-500 text-white' : 'bg-dark-800 border-dark-700 text-gray-400 hover:border-dark-600'
            }`}>
            {chipLabel(cat)}
          </button>
        ))}
      </div>

      {visibleGames.length === 0
        ? <div className="text-center py-16 text-gray-600"><p className="text-4xl mb-3">🎰</p><p>No games found</p></div>
        : <div className="px-4 grid grid-cols-2 gap-3">
            {visibleGames.map(game => (
              <GameCard key={game.slug} game={game} providerLabel={providerName(game.providerKey)}
                loading={launching === game.slug} onPlay={() => launch(game)} />
            ))}
          </div>}

      <p className="text-center text-[9px] text-gray-700 px-6 mt-8">
        18+ · Gamble responsibly · All games use certified RNG
      </p>
    </div>
  );
};

export default CasinoPage;
