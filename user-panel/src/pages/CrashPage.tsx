// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * CrashPage.tsx — 2026 "Bazaar" redesign. Metadata-driven Crash & Instant lobby.
 *
 * GOVERNANCE §1: games are DATA from the Game Registry
 * (GET /api/game/games?category=crash) — no hardcoded arrays. Provider gating +
 * the POST /api/game/launch spine are unchanged; only presentation is rebuilt.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { useGameProviders } from '../services/GameProviderContext';
import ScreenShell, { card } from '../redesign/Screen';

interface RegistryGame {
  slug: string; name: string; providerKey: string; categorySlug: string;
  externalGameId: string; thumbnail: string; badge: string; rtp: string;
  tags: string[]; status: 'ACTIVE' | 'MAINTENANCE'; featured: boolean; order: number;
}
function splitBadge(badge: string): { emoji: string; text: string } {
  const m = (badge || '').match(/^(\p{Extended_Pictographic}️?)\s*(.*)$/u);
  return m ? { emoji: m[1], text: m[2] } : { emoji: '🚀', text: badge || '' };
}

const CrashPage: React.FC = () => {
  const navigate = useNavigate();
  const { enabledCrash, anyCrash } = useGameProviders();
  const [games, setGames] = useState<RegistryGame[]>([]);
  const [launching, setLaunching] = useState<string | null>(null);
  const [gameUrl, setGameUrl] = useState<string | null>(null);
  const [gameName, setGameName] = useState('');
  const iframeRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => { if (!anyCrash) navigate('/', { replace: true }); }, [anyCrash]);
  useEffect(() => {
    (async () => {
      try { const d = await window.fetch('/api/game/games?category=crash').then(r => r.json()); if (d.success) setGames(d.games || []); }
      catch (e) { console.warn('[CrashPage] catalogue fetch failed:', e instanceof Error ? e.message : e); }
    })();
  }, []);

  const enabledKeys = enabledCrash.map(p => p.key);
  const visibleGames = games.filter(g => enabledKeys.includes(g.providerKey));
  const featured = visibleGames.find(g => g.featured);
  const rest = visibleGames.filter(g => g !== featured);

  const launch = useCallback(async (game: RegistryGame) => {
    if (game.status === 'MAINTENANCE') { alert(`${game.name} is under maintenance`); return; }
    setLaunching(game.slug);
    try {
      const token = localStorage.getItem('auth_token') || '';
      const r = await fetch('/api/game/launch', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ providerKey: game.providerKey, gameId: game.externalGameId, gameName: game.name }) });
      const d = await r.json();
      if (d.success && d.launchUrl) { setGameUrl(d.launchUrl); setGameName(game.name); }
      else alert(d.message || 'Could not launch');
    } catch { alert('Launch failed'); } finally { setLaunching(null); }
  }, []);

  if (gameUrl) return (
    <div style={{ position: 'fixed', inset: 0, background: '#000', zIndex: 200, display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: 'var(--bg)', padding: '0 14px', height: 44, flex: 'none', borderBottom: '1px solid var(--line)' }}>
        <span style={{ color: 'var(--text)', fontSize: 12, fontWeight: 700 }}>🚀 {gameName}</span>
        <button onClick={() => setGameUrl(null)} style={{ color: 'var(--text2)', fontSize: 12, border: '1px solid var(--line2)', padding: '4px 12px', borderRadius: 8, background: 'var(--surface2)', cursor: 'pointer' }}>✕ Close</button>
      </div>
      <iframe ref={iframeRef} src={gameUrl} style={{ flex: 1, width: '100%', border: 0 }} allow="fullscreen autoplay" allowFullScreen title={gameName} />
    </div>
  );

  const heroBadge = featured ? splitBadge(featured.badge) : null;

  return (
    <ScreenShell icon="✈️" title="Cash or Crash" sub={`${visibleGames.length} games · cash out anytime`}>
      {featured && heroBadge && (
        <div style={{ position: 'relative', borderRadius: 18, overflow: 'hidden', background: 'linear-gradient(135deg,#2A0A0A,#140406)', border: '1px solid rgba(240,120,60,.3)', marginBottom: 16 }}>
          {featured.thumbnail && <img src={featured.thumbnail} alt={featured.name} onError={e => ((e.target as HTMLImageElement).style.display = 'none')} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', opacity: .2 }} />}
          <div style={{ position: 'relative', padding: 18, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}><span style={{ fontSize: 28 }}>{heroBadge.emoji}</span><span className="font-grotesk" style={{ fontSize: 20, fontWeight: 700, color: '#fff' }}>{featured.name}</span></div>
              {featured.rtp && <p style={{ color: 'rgba(255,255,255,.6)', fontSize: 11, margin: 0 }}>RTP {featured.rtp}</p>}
            </div>
            <button onClick={() => launch(featured)} disabled={!!launching} style={{ background: '#F0783C', color: '#1a1200', fontWeight: 800, padding: '12px 20px', borderRadius: 12, fontSize: 14, border: 'none', cursor: 'pointer', opacity: launching ? .6 : 1 }}>{launching === featured.slug ? '…' : '▶ Play'}</button>
          </div>
        </div>
      )}

      {visibleGames.length === 0 ? (
        <div style={{ ...card, textAlign: 'center', padding: '40px 16px', color: 'var(--text3)' }}><div style={{ fontSize: 40, marginBottom: 8 }}>🚀</div>No crash games available yet</div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(150px,1fr))', gap: 12 }}>
          {rest.map(game => {
            const { emoji, text } = splitBadge(game.badge);
            const maint = game.status === 'MAINTENANCE';
            return (
              <button key={game.slug} onClick={() => launch(game)} disabled={!!launching || maint} style={{ textAlign: 'left', borderRadius: 14, overflow: 'hidden', background: 'var(--surface)', border: '1px solid var(--line)', cursor: maint ? 'default' : 'pointer', opacity: maint ? .6 : 1, padding: 0 }}>
                <div style={{ height: 96, background: 'linear-gradient(160deg,var(--surface2),var(--surface3))', display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative' }}>
                  {game.thumbnail && <img src={game.thumbnail} alt={game.name} onError={e => ((e.target as HTMLImageElement).style.display = 'none')} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', opacity: .3 }} />}
                  <span style={{ fontSize: 34, position: 'relative', zIndex: 2, opacity: .85 }}>{emoji}</span>
                  {launching === game.slug && <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,.6)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><span className="bb-spin" style={{ width: 24, height: 24, border: '2px solid #F0783C', borderTopColor: 'transparent', borderRadius: '50%' }} /></div>}
                </div>
                <div style={{ padding: '8px 12px' }}><p style={{ fontSize: 12, fontWeight: 700, color: 'var(--text)', margin: 0 }}>{game.name}</p>{text && <p style={{ fontSize: 9, color: 'var(--text3)', margin: '2px 0 0' }}>{text}</p>}</div>
              </button>
            );
          })}
        </div>
      )}
    </ScreenShell>
  );
};

export default CrashPage;
