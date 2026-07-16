// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * CrashPage.tsx — metadata-driven Crash & Instant lobby.
 *
 * Games are DATA from the Game Registry (GET /api/game/games?category=crash) —
 * not a hardcoded CRASH_GAMES array. `featured` games get the hero placement;
 * the rest render in a generic grid. Provider gating + the POST /api/game/launch
 * spine are unchanged. Admin adds a crash game → it shows here, no deploy.
 */
import React, { useEffect, useState, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router';
import { useGameProviders } from '../services/GameProviderContext';

interface RegistryGame {
  slug: string; name: string; providerKey: string; categorySlug: string;
  externalGameId: string; thumbnail: string; badge: string; rtp: string;
  tags: string[]; status: 'ACTIVE' | 'MAINTENANCE'; featured: boolean; order: number;
}

// Split a leading pictographic emoji off a badge like "✈️ #1 Worldwide".
function splitBadge(badge: string): { emoji: string; text: string } {
  const m = (badge || '').match(/^(\p{Extended_Pictographic}️?)\s*(.*)$/u);
  return m ? { emoji: m[1], text: m[2] } : { emoji: '🚀', text: badge || '' };
}

const CrashPage: React.FC = () => {
  const navigate = useNavigate();
  const { enabledCrash, anyCrash } = useGameProviders();
  const [games, setGames]         = useState<RegistryGame[]>([]);
  const [launching, setLaunching] = useState<string | null>(null);
  const [gameUrl, setGameUrl]     = useState<string | null>(null);
  const [gameName, setGameName]   = useState('');
  const iframeRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => { if (!anyCrash) navigate('/', { replace: true }); }, [anyCrash]);

  useEffect(() => {
    (async () => {
      try {
        const d = await window.fetch('/api/game/games?category=crash').then(r => r.json());
        if (d.success) setGames(d.games || []);
      } catch (e) { console.warn('[CrashPage] catalogue fetch failed:', e instanceof Error ? e.message : e); }
    })();
  }, []);

  const enabledKeys  = enabledCrash.map(p => p.key);
  const visibleGames = games.filter(g => enabledKeys.includes(g.providerKey));
  const featured     = visibleGames.find(g => g.featured);
  const rest         = visibleGames.filter(g => g !== featured);

  const launch = useCallback(async (game: RegistryGame) => {
    if (game.status === 'MAINTENANCE') { alert(`${game.name} is under maintenance`); return; }
    setLaunching(game.slug);
    try {
      const token = localStorage.getItem('auth_token') || '';
      const r = await fetch('/api/game/launch', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ providerKey: game.providerKey, gameId: game.externalGameId, gameName: game.name }),
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
      <iframe ref={iframeRef} src={gameUrl} className="flex-1 w-full border-0" allow="fullscreen autoplay" allowFullScreen title={gameName} />
    </div>
  );

  const heroBadge = featured ? splitBadge(featured.badge) : null;

  return (
    <div className="h-full overflow-y-auto bg-[#0A0F1C] text-white pb-4">
      <div className="bg-gradient-to-b from-orange-950/50 to-transparent px-4 pt-3 pb-4">
        <button onClick={() => navigate('/')} className="text-gray-500 text-xs mb-2 block">← Back</button>
        <h1 className="text-xl font-bold">🚀 Crash & Instant Games</h1>
        <p className="text-gray-500 text-xs mt-0.5">{visibleGames.length} games · Cash out anytime</p>
      </div>

      {featured && heroBadge && (
        <div className="mx-4 mb-5">
          <div className="relative rounded-2xl overflow-hidden bg-gradient-to-br from-red-900 to-red-950 border border-orange-800/30">
            {featured.thumbnail && (
              <img src={featured.thumbnail} alt={featured.name}
                className="absolute inset-0 w-full h-full object-cover opacity-20"
                onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />
            )}
            <div className="relative p-5 flex items-center justify-between">
              <div>
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-3xl">{heroBadge.emoji}</span>
                  <span className="text-xl font-bold">{featured.name}</span>
                  {heroBadge.text && <span className="text-[10px] bg-orange-500/30 text-orange-300 px-2 py-0.5 rounded-full font-semibold">{heroBadge.text}</span>}
                </div>
                {featured.rtp && <p className="text-gray-400 text-xs mb-1">RTP {featured.rtp}</p>}
              </div>
              <button onClick={() => launch(featured)} disabled={!!launching}
                className="bg-orange-500 hover:bg-orange-400 active:bg-orange-600 text-white font-bold px-5 py-3 rounded-xl text-sm transition-all active:scale-95 disabled:opacity-60 flex items-center gap-2">
                {launching === featured.slug
                  ? <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  : '▶ Play'}
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="px-4 grid grid-cols-2 gap-3">
        {rest.map(game => {
          const { emoji, text } = splitBadge(game.badge);
          const maint = game.status === 'MAINTENANCE';
          return (
            <button key={game.slug} onClick={() => launch(game)} disabled={!!launching || maint}
              className="relative text-left rounded-xl overflow-hidden bg-dark-800 border border-dark-700 hover:border-orange-700/50 active:scale-95 transition-all disabled:opacity-60">
              <div className="h-24 bg-gradient-to-br from-dark-700 to-dark-900 flex items-center justify-center relative">
                {game.thumbnail && (
                  <img src={game.thumbnail} alt={game.name}
                    className="absolute inset-0 w-full h-full object-cover opacity-30"
                    onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                )}
                <span className="text-4xl relative z-10 opacity-80">{emoji}</span>
                {maint && <span className="absolute top-1.5 right-1.5 bg-yellow-600 text-black text-[8px] font-bold px-1.5 py-0.5 rounded-full">🔧</span>}
                {launching === game.slug && (
                  <div className="absolute inset-0 bg-black/60 flex items-center justify-center">
                    <div className="w-6 h-6 border-2 border-orange-400 border-t-transparent rounded-full animate-spin" />
                  </div>
                )}
              </div>
              <div className="px-3 py-2">
                <p className="text-xs font-semibold text-white">{game.name}</p>
                {text && <p className="text-[9px] text-gray-600 mt-0.5">{text}</p>}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
};

export default CrashPage;
