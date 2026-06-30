// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * CasinoPage.tsx
 *
 * Live casino lobby — only reachable when admin has enabled a casino provider.
 * Shows real game cards with provider thumbnails in a grid layout like Betway/10CRIC.
 * When no provider is enabled, this route is hidden (Footer removes the tab).
 */
import React, { useEffect, useState, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router';
import { useGameProviders } from '../services/GameProviderContext';

// ── Game catalogue with provider-CDN thumbnail patterns ──────────────────────
// Thumbnails follow the provider's standard marketing CDN.
// Once you have real API credentials, replace with the provider's game list API.
const GAME_CATALOGUE = [
  // Evolution Gaming
  { id: 'roulette',          name: 'Live Roulette',      provider: 'evolution', category: 'Tables',   thumb: '',      badge: '🔴 Live',    rtp: '97.3%' },
  { id: 'blackjack',         name: 'Blackjack',           provider: 'evolution', category: 'Tables',   thumb: '',     badge: '♠ Classic',  rtp: '99.5%' },
  { id: 'baccarat',          name: 'Speed Baccarat',      provider: 'evolution', category: 'Tables',   thumb: '',      badge: '⚡ Fast',    rtp: '98.9%' },
  { id: 'crazy_time',        name: 'Crazy Time',          provider: 'evolution', category: 'Shows',    thumb: '',    badge: '🎪 Show',    rtp: '96.8%' },
  { id: 'lightning_roulette',name: 'Lightning Roulette',  provider: 'evolution', category: 'Tables',   thumb: '',     badge: '⚡ 500x',   rtp: '97.1%' },
  { id: 'monopoly_live',     name: 'Monopoly Live',       provider: 'evolution', category: 'Shows',    thumb: '',      badge: '🎩 Bonus',  rtp: '96.2%' },
  // Pragmatic Play
  { id: 'vs20sugardance',    name: 'Sweet Bonanza',       provider: 'pragmatic', category: 'Slots',    thumb: '', badge: '🍬 21,175x', rtp: '96.5%' },
  { id: 'vs20olympgate',     name: 'Gates of Olympus',    provider: 'pragmatic', category: 'Slots',    thumb: '',  badge: '⚡ 5,000x', rtp: '96.5%' },
  { id: 'vs10egyptcls',      name: 'Eye of Cleopatra',    provider: 'pragmatic', category: 'Slots',    thumb: '',          badge: '🏺 Popular', rtp: '96.1%' },
  { id: 'vs20doghouse',      name: 'The Dog House',       provider: 'pragmatic', category: 'Slots',    thumb: '',        badge: '🐕 Free Spins', rtp: '96.5%' },
  // Ezugi — India focus
  { id: '1',                 name: 'Andar Bahar',         provider: 'ezugi',     category: 'India',    thumb: '', badge: '🇮🇳 India', rtp: '97.9%' },
  { id: '2',                 name: 'Teen Patti',          provider: 'ezugi',     category: 'India',    thumb: '', badge: '🃏 India',  rtp: '98.3%' },
  { id: '3',                 name: 'Lucky 7',             provider: 'ezugi',     category: 'India',    thumb: '', badge: '🎴 Indian', rtp: '96.7%' },
];

const CATEGORIES = ['All', 'Tables', 'Shows', 'Slots', 'India'];

const PROVIDER_COLORS: Record<string, string> = {
  evolution: 'from-amber-900/80 to-amber-950',
  pragmatic: 'from-red-900/80 to-red-950',
  ezugi:     'from-green-900/80 to-green-950',
};
const PROVIDER_BADGE: Record<string, string> = {
  evolution: '🎭 Evolution',
  pragmatic: '🎰 Pragmatic',
  ezugi:     '🎴 Ezugi',
};

const GameCard: React.FC<{ game: typeof GAME_CATALOGUE[0]; onPlay: () => void; loading: boolean }> = ({ game, onPlay, loading }) => {
  const [imgErr, setImgErr] = useState(false);

  return (
    <div className="relative rounded-xl overflow-hidden bg-dark-800 border border-dark-700 group active:scale-95 transition-transform cursor-pointer"
      onClick={onPlay}>
      {/* Thumbnail */}
      <div className={`relative h-32 bg-gradient-to-br ${PROVIDER_COLORS[game.provider] || 'from-dark-700 to-dark-800'} overflow-hidden`}>
        {game.thumb && !imgErr ? (
          <img src={game.thumb} alt={game.name} className="w-full h-full object-cover opacity-90"
            onError={() => setImgErr(true)}/>
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <span className="text-5xl opacity-60">
              {game.category === 'Slots' ? '🎰' : game.category === 'Shows' ? '🎪' : game.category === 'India' ? '🃏' : '🎲'}
            </span>
          </div>
        )}
        {/* Overlay on hover/active */}
        <div className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 group-active:opacity-100 transition-opacity flex items-center justify-center">
          {loading
            ? <div className="w-8 h-8 border-2 border-white border-t-transparent rounded-full animate-spin"/>
            : <div className="bg-yellow-500 text-black font-bold text-xs px-4 py-2 rounded-full">▶ PLAY</div>
          }
        </div>
        {/* Badge */}
        <span className="absolute top-1.5 left-1.5 bg-black/70 text-white text-[9px] font-semibold px-1.5 py-0.5 rounded-full">
          {game.badge}
        </span>
        {/* RTP */}
        <span className="absolute top-1.5 right-1.5 bg-black/50 text-green-400 text-[9px] font-mono px-1.5 py-0.5 rounded">
          RTP {game.rtp}
        </span>
      </div>

      {/* Info row */}
      <div className="px-2.5 py-2">
        <p className="text-xs font-semibold text-white truncate">{game.name}</p>
        <p className="text-[9px] text-gray-500 mt-0.5">{PROVIDER_BADGE[game.provider]}</p>
      </div>
    </div>
  );
};

const CasinoPage: React.FC = () => {
  const navigate  = useNavigate();
  const { enabledCasino, anyCasino } = useGameProviders();
  const [category, setCategory] = useState('All');
  const [search, setSearch]     = useState('');
  const [launching, setLaunching] = useState<string|null>(null);
  const [gameUrl, setGameUrl]     = useState<string|null>(null);
  const [activeGameName, setActiveGameName] = useState('');
  const iframeRef = useRef<HTMLIFrameElement>(null);

  // Redirect if no providers enabled
  useEffect(() => { if (!anyCasino) navigate('/', { replace: true }); }, [anyCasino]);

  const enabledKeys = enabledCasino.map(p => p.key);

  const visibleGames = GAME_CATALOGUE.filter(g => {
    if (!enabledKeys.includes(g.provider)) return false;
    if (category !== 'All' && g.category !== category) return false;
    if (search && !g.name.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  const launch = useCallback(async (game: typeof GAME_CATALOGUE[0]) => {
    setLaunching(game.id);
    try {
      const token = localStorage.getItem('auth_token') || '';
      const r = await fetch('/api/game/launch', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
          credentials: 'include',
        body: JSON.stringify({ providerKey: game.provider, gameId: game.id, gameName: game.name }),
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

  // Full-screen game
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
        allow="fullscreen autoplay camera microphone" allowFullScreen title={activeGameName}/>
    </div>
  );

  return (
    <div className="h-full overflow-y-auto bg-[#0A0F1C] text-white pb-4">
      {/* Header */}
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

      {/* Search */}
      <div className="px-4 mb-3">
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="🔍 Search games..."
          className="w-full bg-dark-800 border border-dark-700 rounded-xl px-4 py-2.5 text-sm text-white placeholder-gray-600 outline-none focus:border-purple-500/50"/>
      </div>

      {/* Category tabs */}
      <div className="flex gap-2 px-4 pb-4 overflow-x-auto scrollbar-hide">
        {CATEGORIES.map(cat => (
          <button key={cat} onClick={() => setCategory(cat)}
            className={`px-4 py-1.5 rounded-full text-xs font-medium whitespace-nowrap transition-all border ${
              category === cat
                ? 'bg-purple-600 border-purple-500 text-white'
                : 'bg-dark-800 border-dark-700 text-gray-400 hover:border-dark-600'
            }`}>
            {cat}
          </button>
        ))}
      </div>

      {/* Game grid */}
      {visibleGames.length === 0
        ? <div className="text-center py-16 text-gray-600"><p className="text-4xl mb-3">🎰</p><p>No games found</p></div>
        : <div className="px-4 grid grid-cols-2 gap-3">
            {visibleGames.map(game => (
              <GameCard key={`${game.provider}_${game.id}`} game={game}
                loading={launching === game.id}
                onPlay={() => launch(game)}/>
            ))}
          </div>
      }

      <p className="text-center text-[9px] text-gray-700 px-6 mt-8">
        18+ · Gamble responsibly · All games use certified RNG
      </p>
    </div>
  );
};

export default CasinoPage;
