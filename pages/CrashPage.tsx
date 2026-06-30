// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * CrashPage.tsx — Crash & Instant Games lobby
 * Only visible when admin enables Spribe or Smartsoft from Game Providers admin page.
 * Each game has its own card; Aviator gets featured hero placement.
 */
import React, { useEffect, useState, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router';
import { useGameProviders } from '../services/GameProviderContext';

const CRASH_GAMES = [
  {
    id: 'aviator', name: 'Aviator', provider: 'spribe',
    thumb: 'https://spribe.co/assets/images/games/aviator-preview.jpg',
    color: 'from-red-900 to-red-950', icon: '✈️',
    badge: '#1 Worldwide', desc: 'Cash out before the plane flies away',
    multiplier: 'Up to 100x', hot: true,
    stats: '10M+ players/month',
  },
  {
    id: 'JetX', name: 'JetX', provider: 'smartsoft',
    thumb: 'https://smartsoft.ge/wp-content/uploads/jetx-preview.jpg',
    color: 'from-blue-900 to-blue-950', icon: '🚀',
    badge: 'Popular', desc: 'Rocket multiplier game — predict the crash',
    multiplier: 'Up to 50,000x', hot: true,
    stats: 'Instant rounds',
  },
  {
    id: 'mines', name: 'Mines', provider: 'spribe',
    thumb: '', color: 'from-gray-800 to-gray-900', icon: '💣',
    badge: 'Strategy', desc: 'Open squares, avoid mines',
    multiplier: 'Up to 5,000x', hot: false, stats: 'Risk vs Reward',
  },
  {
    id: 'plinko', name: 'Plinko', provider: 'smartsoft',
    thumb: '', color: 'from-indigo-900 to-indigo-950', icon: '🎯',
    badge: 'Casual', desc: 'Drop the ball, watch it bounce',
    multiplier: 'Up to 1,000x', hot: false, stats: 'Classic game',
  },
  {
    id: 'hilo', name: 'Hi Lo', provider: 'spribe',
    thumb: '', color: 'from-emerald-900 to-emerald-950', icon: '🃏',
    badge: 'Quick', desc: 'Higher or lower card game',
    multiplier: 'Up to 200x', hot: false, stats: 'Fast rounds',
  },
  {
    id: 'dice', name: 'Turbo Dice', provider: 'spribe',
    thumb: '', color: 'from-yellow-900 to-yellow-950', icon: '🎲',
    badge: 'Fast', desc: 'Predict the dice range',
    multiplier: 'Up to 990x', hot: false, stats: 'Instant win',
  },
  {
    id: 'Penalty', name: 'Penalty Shoot-Out', provider: 'smartsoft',
    thumb: '', color: 'from-green-900 to-green-950', icon: '⚽',
    badge: 'Sports', desc: 'Score penalties for multipliers',
    multiplier: 'Up to 100x', hot: false, stats: 'Sports theme',
  },
  {
    id: 'keno', name: 'Keno', provider: 'spribe',
    thumb: '', color: 'from-purple-900 to-purple-950', icon: '🔢',
    badge: 'Lottery', desc: 'Pick your numbers and win',
    multiplier: 'Up to 10,000x', hot: false, stats: 'Instant draws',
  },
];

const CrashPage: React.FC = () => {
  const navigate = useNavigate();
  const { enabledCrash, anyCrash } = useGameProviders();
  const [launching, setLaunching] = useState<string|null>(null);
  const [gameUrl, setGameUrl]     = useState<string|null>(null);
  const [gameName, setGameName]   = useState('');
  const iframeRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => { if (!anyCrash) navigate('/', { replace: true }); }, [anyCrash]);

  const enabledKeys = enabledCrash.map(p => p.key);
  const visibleGames = CRASH_GAMES.filter(g => enabledKeys.includes(g.provider));
  const featured = visibleGames.find(g => g.hot);
  const rest     = visibleGames.filter(g => !g.hot || g !== featured);

  const launch = useCallback(async (game: typeof CRASH_GAMES[0]) => {
    setLaunching(game.id);
    try {
      const token = localStorage.getItem('auth_token') || '';
      const r = await fetch('/api/game/launch', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
          credentials: 'include',
        body: JSON.stringify({ providerKey: game.provider, gameId: game.id, gameName: game.name }),
      });
      const d = await r.json();
      if (d.success && d.launchUrl) { setGameUrl(d.launchUrl); setGameName(game.name); }
      else alert(d.message || 'Could not launch');
    } catch { alert('Launch failed'); } finally { setLaunching(null); }
  }, []);

  if (gameUrl) return (
    <div className="fixed inset-0 bg-black z-50 flex flex-col">
      <div className="flex items-center justify-between bg-[#0A0F1C] px-4 h-10 flex-shrink-0 border-b border-dark-700">
        <span className="text-orange-400 text-sm font-bold">🚀 {gameName}</span>
        <button onClick={() => setGameUrl(null)} className="text-gray-400 text-xs border border-dark-600 px-3 py-1 rounded">✕ Close</button>
      </div>
      <iframe ref={iframeRef} src={gameUrl} className="flex-1 w-full border-0" allow="fullscreen autoplay" allowFullScreen title={gameName}/>
    </div>
  );

  return (
    <div className="h-full overflow-y-auto bg-[#0A0F1C] text-white pb-4">
      {/* Header */}
      <div className="bg-gradient-to-b from-orange-950/50 to-transparent px-4 pt-3 pb-4">
        <button onClick={() => navigate('/')} className="text-gray-500 text-xs mb-2 block">← Back</button>
        <h1 className="text-xl font-bold">🚀 Crash & Instant Games</h1>
        <p className="text-gray-500 text-xs mt-0.5">{visibleGames.length} games · Cash out anytime</p>
      </div>

      {/* Featured game (Aviator) */}
      {featured && (
        <div className="mx-4 mb-5">
          <div className={`relative rounded-2xl overflow-hidden bg-gradient-to-br ${featured.color} border border-orange-800/30`}>
            {featured.thumb && (
              <img src={featured.thumb} alt={featured.name}
                className="absolute inset-0 w-full h-full object-cover opacity-20"
                onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }}/>
            )}
            <div className="relative p-5 flex items-center justify-between">
              <div>
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-3xl">{featured.icon}</span>
                  <span className="text-xl font-bold">{featured.name}</span>
                  <span className="text-[10px] bg-orange-500/30 text-orange-300 px-2 py-0.5 rounded-full font-semibold">
                    {featured.badge}
                  </span>
                </div>
                <p className="text-gray-400 text-xs mb-1">{featured.desc}</p>
                <div className="flex items-center gap-3 text-[10px]">
                  <span className="text-yellow-400 font-semibold">{featured.multiplier}</span>
                  <span className="text-gray-500">{featured.stats}</span>
                </div>
              </div>
              <button onClick={() => launch(featured)} disabled={!!launching}
                className="bg-orange-500 hover:bg-orange-400 active:bg-orange-600 text-white font-bold px-5 py-3 rounded-xl text-sm transition-all active:scale-95 disabled:opacity-60 flex items-center gap-2">
                {launching === featured.id
                  ? <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin"/>
                  : '▶ Play'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Remaining games grid */}
      <div className="px-4 grid grid-cols-2 gap-3">
        {rest.map(game => (
          <button key={`${game.provider}_${game.id}`} onClick={() => launch(game)} disabled={!!launching}
            className="relative text-left rounded-xl overflow-hidden bg-dark-800 border border-dark-700 hover:border-orange-700/50 active:scale-95 transition-all">
            <div className={`h-24 bg-gradient-to-br ${game.color} flex items-center justify-center relative`}>
              {game.thumb && (
                <img src={game.thumb} alt={game.name}
                  className="absolute inset-0 w-full h-full object-cover opacity-30"
                  onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }}/>
              )}
              <span className="text-4xl relative z-10 opacity-80">{game.icon}</span>
              {game.hot && (
                <span className="absolute top-1.5 right-1.5 bg-orange-500 text-white text-[8px] font-bold px-1.5 py-0.5 rounded-full">HOT</span>
              )}
              {launching === game.id && (
                <div className="absolute inset-0 bg-black/60 flex items-center justify-center">
                  <div className="w-6 h-6 border-2 border-orange-400 border-t-transparent rounded-full animate-spin"/>
                </div>
              )}
            </div>
            <div className="px-3 py-2">
              <p className="text-xs font-semibold text-white">{game.name}</p>
              <p className="text-[9px] text-orange-400 font-medium mt-0.5">{game.multiplier}</p>
              <p className="text-[9px] text-gray-600 mt-0.5">{game.badge}</p>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
};

export default CrashPage;
