// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * SportsPage.tsx — Sports Betting (Betby widget or similar)
 * Only visible when admin enables a sports provider from Game Providers admin page.
 */
import React, { useEffect, useState, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router';
import { useGameProviders } from '../services/GameProviderContext';

const SPORTS = [
  { name: 'Cricket',    icon: '🏏', markets: '400+', live: true  },
  { name: 'Football',   icon: '⚽', markets: '800+', live: true  },
  { name: 'Kabaddi',    icon: '🤼', markets: '120+', live: true  },
  { name: 'Basketball', icon: '🏀', markets: '300+', live: true  },
  { name: 'Tennis',     icon: '🎾', markets: '500+', live: true  },
  { name: 'Esports',    icon: '🎮', markets: '200+', live: true  },
  { name: 'Badminton',  icon: '🏸', markets: '80+',  live: false },
  { name: 'Boxing',     icon: '🥊', markets: '60+',  live: false },
  { name: 'Hockey',     icon: '🏑', markets: '90+',  live: false },
  { name: 'Formula 1',  icon: '🏎️', markets: '50+',  live: false },
  { name: 'Chess',      icon: '♟️', markets: '30+',  live: false },
  { name: 'Volleyball', icon: '🏐', markets: '70+',  live: false },
];

const SportsPage: React.FC = () => {
  const navigate  = useNavigate();
  const { enabledSports, anySports } = useGameProviders();
  const [launching, setLaunching] = useState(false);
  const [sbUrl, setSbUrl]         = useState<string|null>(null);
  const [filter, setFilter]       = useState<'all'|'live'>('all');
  const iframeRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => { if (!anySports) navigate('/', { replace: true }); }, [anySports]);

  const provider = enabledSports[0]; // use first enabled sports provider

  const openSportsbook = useCallback(async (sportName?: string) => {
    if (!provider) return;
    setLaunching(true);
    try {
      const token = localStorage.getItem('auth_token') || '';
      const r = await fetch('/api/game/launch', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
          credentials: 'include',
        body: JSON.stringify({ providerKey: provider.key, gameId: sportName || 'sportsbook', gameName: sportName || 'Sportsbook' }),
      });
      const d = await r.json();
      if (d.success && d.launchUrl) setSbUrl(d.launchUrl);
      else alert(d.message || 'Could not launch sportsbook');
    } catch { alert('Launch failed'); } finally { setLaunching(false); }
  }, [provider]);

  if (sbUrl) return (
    <div className="fixed inset-0 bg-black z-50 flex flex-col">
      <div className="flex items-center justify-between bg-[#0A0F1C] px-4 h-10 flex-shrink-0 border-b border-dark-700">
        <span className="text-green-400 text-sm font-bold">⚽ Live Sportsbook</span>
        <button onClick={() => setSbUrl(null)} className="text-gray-400 text-xs border border-dark-600 px-3 py-1 rounded">✕ Close</button>
      </div>
      <iframe ref={iframeRef} src={sbUrl} className="flex-1 w-full border-0" allow="fullscreen" allowFullScreen title="Sportsbook"/>
    </div>
  );

  const visibleSports = filter === 'live' ? SPORTS.filter(s => s.live) : SPORTS;

  return (
    <div className="h-full overflow-y-auto bg-[#0A0F1C] text-white pb-4">
      {/* Header */}
      <div className="bg-gradient-to-b from-green-950/50 to-transparent px-4 pt-3 pb-4">
        <button onClick={() => navigate('/')} className="text-gray-500 text-xs mb-2 block">← Back</button>
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold">⚽ Sportsbook</h1>
            <p className="text-gray-500 text-xs mt-0.5">Live in-play · {SPORTS.length} sports · 125+ markets each</p>
          </div>
          <button onClick={() => openSportsbook()} disabled={launching}
            className="bg-green-600 hover:bg-green-500 text-white font-bold px-4 py-2 rounded-xl text-xs disabled:opacity-60 transition-all active:scale-95 flex items-center gap-1.5">
            {launching ? <div className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin"/> : '▶'}
            {launching ? 'Opening…' : 'Open All'}
          </button>
        </div>
      </div>

      {/* Live / All filter */}
      <div className="flex gap-2 px-4 mb-4">
        {(['all', 'live'] as const).map(f => (
          <button key={f} onClick={() => setFilter(f)}
            className={`px-4 py-1.5 rounded-full text-xs font-medium border transition-all ${
              filter === f ? 'bg-green-600 border-green-500 text-white' : 'bg-dark-800 border-dark-700 text-gray-400'
            }`}>
            {f === 'live' ? '🔴 LIVE' : '📋 All Sports'}
          </button>
        ))}
      </div>

      {/* Sports grid */}
      <div className="px-4 grid grid-cols-3 gap-2.5">
        {visibleSports.map(sport => (
          <button key={sport.name} onClick={() => openSportsbook(sport.name)} disabled={launching}
            className="relative bg-dark-800 border border-dark-700 hover:border-green-700/50 rounded-xl p-3 text-center active:scale-95 transition-all">
            {sport.live && (
              <span className="absolute top-1.5 right-1.5 flex items-center gap-0.5">
                <span className="w-1.5 h-1.5 bg-red-500 rounded-full animate-pulse"/>
              </span>
            )}
            <div className="text-3xl mb-1.5">{sport.icon}</div>
            <div className="text-xs font-semibold text-white">{sport.name}</div>
            <div className="text-[9px] text-green-400 mt-0.5">{sport.markets} markets</div>
          </button>
        ))}
      </div>

      {/* Provider info */}
      <div className="mx-4 mt-5 p-3 bg-dark-800/50 border border-dark-700 rounded-xl">
        <p className="text-[10px] text-gray-500 text-center">
          Powered by <span className="text-white font-medium">{provider?.name}</span> ·
          Live odds update every second · Settle within 30 seconds
        </p>
      </div>
    </div>
  );
};

export default SportsPage;
