// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * CasinoPage.tsx — 2026 "Bazaar" redesign. Metadata-driven casino lobby.
 *
 * GOVERNANCE §1: games & categories remain DATA from the Game Registry
 * (GET /api/game/games, /categories) — no hardcoded arrays. Provider gating
 * (useGameProviders) and the launch spine (POST /api/game/launch) are unchanged.
 * Only the presentation is rebuilt on the redesign theme tokens.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { useGameProviders } from '../services/GameProviderContext';
import ScreenShell, { card } from '../redesign/Screen';
import { apiUrl } from '../services/apiUrl';

interface RegistryGame {
  slug: string; name: string; providerKey: string; categorySlug: string;
  launchStrategy: string; externalGameId: string; launchUrl: string;
  thumbnail: string; banner: string; badge: string; rtp: string; tags: string[];
  minBet: number; maxBet: number; status: 'ACTIVE' | 'MAINTENANCE'; featured: boolean; order: number;
}
interface RegistryCategory { slug: string; name: string; icon: string; order: number; gameCount: number; }

const NON_CASINO = new Set(['crash', 'bb-originals']);
const CATEGORY_EMOJI: Record<string, string> = { slots: '🎰', 'game-shows': '🎪', 'indian-games': '🃏', 'table-games': '🎲' };

const GameCard: React.FC<{ game: RegistryGame; providerLabel: string; onPlay: () => void; loading: boolean }> = ({ game, providerLabel, onPlay, loading }) => {
  const [imgErr, setImgErr] = useState(false);
  const maint = game.status === 'MAINTENANCE';
  return (
    <div onClick={maint ? undefined : onPlay} style={{ position: 'relative', borderRadius: 14, overflow: 'hidden', background: 'var(--surface)', border: '1px solid var(--line)', boxShadow: 'var(--shadow-sm)', opacity: maint ? .6 : 1, cursor: maint ? 'default' : 'pointer' }}>
      <div style={{ position: 'relative', height: 120, background: 'linear-gradient(160deg,var(--surface2),var(--surface3))', overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        {game.thumbnail && !imgErr ? <img src={game.thumbnail} alt={game.name} onError={() => setImgErr(true)} style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : <span style={{ fontSize: 44, opacity: .6 }}>{CATEGORY_EMOJI[game.categorySlug] || '🎲'}</span>}
        {game.badge && <span style={{ position: 'absolute', top: 6, left: 6, background: 'rgba(0,0,0,.7)', color: '#fff', fontSize: 9, fontWeight: 700, padding: '2px 7px', borderRadius: 999 }}>{game.badge}</span>}
        {game.rtp && <span className="font-grotesk" style={{ position: 'absolute', top: 6, right: 6, background: 'rgba(0,0,0,.5)', color: 'var(--green)', fontSize: 9, padding: '2px 6px', borderRadius: 6 }}>RTP {game.rtp}</span>}
        {loading && <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,.5)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><span className="bb-spin" style={{ width: 26, height: 26, border: '2px solid #fff', borderTopColor: 'transparent', borderRadius: '50%' }} /></div>}
        {maint && <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,.55)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><span style={{ background: '#FB8C00', color: '#1a1200', fontWeight: 800, fontSize: 10, padding: '3px 10px', borderRadius: 999 }}>🔧 MAINTENANCE</span></div>}
      </div>
      <div style={{ padding: '8px 10px' }}>
        <p style={{ fontSize: 12, fontWeight: 700, color: 'var(--text)', margin: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{game.name}</p>
        <p style={{ fontSize: 9, color: 'var(--text3)', margin: '2px 0 0' }}>{providerLabel}</p>
      </div>
    </div>
  );
};

const CasinoPage: React.FC = () => {
  const navigate = useNavigate();
  const { enabledCasino, anyCasino } = useGameProviders();
  const [games, setGames] = useState<RegistryGame[]>([]);
  const [categories, setCategories] = useState<RegistryCategory[]>([]);
  const [category, setCategory] = useState('All');
  const [search, setSearch] = useState('');
  const [launching, setLaunching] = useState<string | null>(null);
  const [gameUrl, setGameUrl] = useState<string | null>(null);
  const [activeGameName, setActiveGameName] = useState('');
  const iframeRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => { if (!anyCasino) navigate('/', { replace: true }); }, [anyCasino]);

  useEffect(() => {
    (async () => {
      try {
        const [g, c] = await Promise.all([
          window.fetch(apiUrl('/api/game/games')).then(r => r.json()),
          window.fetch(apiUrl('/api/game/categories')).then(r => r.json()),
        ]);
        if (g.success) setGames(g.games || []);
        if (c.success) setCategories((c.categories || []).filter((x: RegistryCategory) => !NON_CASINO.has(x.slug)));
      } catch (e) { console.warn('[CasinoPage] catalogue fetch failed:', e instanceof Error ? e.message : e); }
    })();
  }, []);

  const enabledKeys = enabledCasino.map(p => p.key);
  const providerName = (key: string) => enabledCasino.find(p => p.key === key)?.name.split(' ')[0] || key;
  const visibleGames = games.filter(g => !NON_CASINO.has(g.categorySlug) && enabledKeys.includes(g.providerKey) && (category === 'All' || g.categorySlug === category) && (!search || g.name.toLowerCase().includes(search.toLowerCase())));

  const launch = useCallback(async (game: RegistryGame) => {
    setLaunching(game.slug);
    try {
      const token = localStorage.getItem('auth_token') || '';
      const r = await fetch(apiUrl('/api/game/launch'), { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ providerKey: game.providerKey, gameId: game.externalGameId, gameName: game.name }) });
      const data = await r.json();
      if (data.success && data.launchUrl) { setGameUrl(data.launchUrl); setActiveGameName(game.name); }
      else alert(data.message || 'Could not launch game');
    } catch { alert('Launch failed'); } finally { setLaunching(null); }
  }, []);

  if (gameUrl) return (
    <div style={{ position: 'fixed', inset: 0, background: '#000', zIndex: 200, display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: 'var(--bg)', padding: '0 14px', height: 44, flex: 'none', borderBottom: '1px solid var(--line)' }}>
        <span style={{ color: 'var(--text)', fontSize: 12, fontWeight: 700 }}>🎰 {activeGameName}</span>
        <button onClick={() => setGameUrl(null)} style={{ color: 'var(--text2)', fontSize: 12, border: '1px solid var(--line2)', padding: '4px 12px', borderRadius: 8, background: 'var(--surface2)', cursor: 'pointer' }}>✕ Close</button>
      </div>
      <iframe ref={iframeRef} src={gameUrl} style={{ flex: 1, width: '100%', border: 0 }} allow="fullscreen autoplay camera microphone" allowFullScreen title={activeGameName} />
    </div>
  );

  const chipCats = ['All', ...categories.filter(c => games.some(g => g.categorySlug === c.slug && enabledKeys.includes(g.providerKey))).map(c => c.slug)];
  const chipLabel = (slug: string) => slug === 'All' ? 'All' : (categories.find(c => c.slug === slug)?.name || slug);

  return (
    <ScreenShell icon="🃏" title="Casino" sub={`${visibleGames.length} games · certified RNG`}>
      <input value={search} onChange={e => setSearch(e.target.value)} placeholder="🔍 Search games…" style={{ width: '100%', height: 44, background: 'var(--surface2)', border: '1px solid var(--line2)', borderRadius: 12, padding: '0 15px', color: 'var(--text)', fontSize: 14, outline: 'none', marginBottom: 12 }} />
      <div className="bb-noscroll" style={{ display: 'flex', gap: 8, overflowX: 'auto', marginBottom: 14 }}>
        {chipCats.map(cat => (
          <button key={cat} onClick={() => setCategory(cat)} style={{ flex: 'none', padding: '7px 14px', borderRadius: 999, fontSize: 12, fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap', border: `1px solid ${category === cat ? 'var(--gold)' : 'var(--line)'}`, background: category === cat ? 'var(--gold)' : 'var(--surface)', color: category === cat ? '#1a1200' : 'var(--text2)' }}>{chipLabel(cat)}</button>
        ))}
      </div>
      {visibleGames.length === 0 ? (
        <div style={{ ...card, textAlign: 'center', padding: '40px 16px', color: 'var(--text3)' }}><div style={{ fontSize: 40, marginBottom: 8 }}>🎰</div>No games available yet</div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(150px,1fr))', gap: 12 }}>
          {visibleGames.map(game => <GameCard key={game.slug} game={game} providerLabel={providerName(game.providerKey)} loading={launching === game.slug} onPlay={() => launch(game)} />)}
        </div>
      )}
      <p style={{ textAlign: 'center', fontSize: 9, color: 'var(--text3)', marginTop: 20 }}>18+ · Gamble responsibly · All games use certified RNG</p>
    </ScreenShell>
  );
};

export default CasinoPage;
