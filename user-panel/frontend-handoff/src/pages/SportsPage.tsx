// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * SportsPage.tsx — 2026 "Bazaar" redesign. Sportsbook lobby (Betby-style widget).
 * Only visible when admin enables a sports provider (useGameProviders); launch
 * goes through the standard POST /api/game/launch spine. Logic unchanged.
 *
 * GOVERNANCE §10: the SPORTS list below is a UI-only set of category tiles for
 * the lobby — it is never used for server-side validation; the actual markets
 * come from the enabled provider's sportsbook.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { useGameProviders } from '../services/GameProviderContext';
import ScreenShell, { card } from '../redesign/Screen';

const SPORTS = [
  { name: 'Cricket', icon: '🏏', markets: '400+', live: true }, { name: 'Football', icon: '⚽', markets: '800+', live: true },
  { name: 'Kabaddi', icon: '🤼', markets: '120+', live: true }, { name: 'Basketball', icon: '🏀', markets: '300+', live: true },
  { name: 'Tennis', icon: '🎾', markets: '500+', live: true }, { name: 'Esports', icon: '🎮', markets: '200+', live: true },
  { name: 'Badminton', icon: '🏸', markets: '80+', live: false }, { name: 'Boxing', icon: '🥊', markets: '60+', live: false },
  { name: 'Hockey', icon: '🏑', markets: '90+', live: false }, { name: 'Formula 1', icon: '🏎️', markets: '50+', live: false },
  { name: 'Chess', icon: '♟️', markets: '30+', live: false }, { name: 'Volleyball', icon: '🏐', markets: '70+', live: false },
];

const SportsPage: React.FC = () => {
  const navigate = useNavigate();
  const { enabledSports, anySports } = useGameProviders();
  const [launching, setLaunching] = useState(false);
  const [sbUrl, setSbUrl] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'live'>('all');
  const iframeRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => { if (!anySports) navigate('/', { replace: true }); }, [anySports]);
  const provider = enabledSports[0];

  const openSportsbook = useCallback(async (sportName?: string) => {
    if (!provider) return;
    setLaunching(true);
    try {
      const token = localStorage.getItem('auth_token') || '';
      const r = await fetch('/api/game/launch', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ providerKey: provider.key, gameId: sportName || 'sportsbook', gameName: sportName || 'Sportsbook' }) });
      const d = await r.json();
      if (d.success && d.launchUrl) setSbUrl(d.launchUrl);
      else alert(d.message || 'Could not launch sportsbook');
    } catch { alert('Launch failed'); } finally { setLaunching(false); }
  }, [provider]);

  if (sbUrl) return (
    <div style={{ position: 'fixed', inset: 0, background: '#000', zIndex: 200, display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: 'var(--bg)', padding: '0 14px', height: 44, flex: 'none', borderBottom: '1px solid var(--line)' }}>
        <span style={{ color: 'var(--text)', fontSize: 12, fontWeight: 700 }}>⚽ Live Sportsbook</span>
        <button onClick={() => setSbUrl(null)} style={{ color: 'var(--text2)', fontSize: 12, border: '1px solid var(--line2)', padding: '4px 12px', borderRadius: 8, background: 'var(--surface2)', cursor: 'pointer' }}>✕ Close</button>
      </div>
      <iframe ref={iframeRef} src={sbUrl} style={{ flex: 1, width: '100%', border: 0 }} allow="fullscreen" allowFullScreen title="Sportsbook" />
    </div>
  );

  const visibleSports = filter === 'live' ? SPORTS.filter(s => s.live) : SPORTS;

  return (
    <ScreenShell icon="🏇" title="Sports" sub="Live & pre-match betting">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 14 }}>
        <div style={{ display: 'flex', gap: 8 }}>
          {(['all', 'live'] as const).map(f => (
            <button key={f} onClick={() => setFilter(f)} style={{ padding: '7px 14px', borderRadius: 999, fontSize: 12, fontWeight: 700, cursor: 'pointer', border: `1px solid ${filter === f ? 'var(--green)' : 'var(--line)'}`, background: filter === f ? 'var(--green)' : 'var(--surface)', color: filter === f ? '#fff' : 'var(--text2)' }}>{f === 'live' ? '🔴 LIVE' : 'All'}</button>
          ))}
        </div>
        <button onClick={() => openSportsbook()} disabled={launching} style={{ background: 'var(--green)', color: '#fff', fontWeight: 800, padding: '9px 16px', borderRadius: 12, fontSize: 12, border: 'none', cursor: 'pointer', opacity: launching ? .6 : 1 }}>{launching ? 'Opening…' : '▶ Open All'}</button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(104px,1fr))', gap: 10 }}>
        {visibleSports.map(sport => (
          <button key={sport.name} onClick={() => openSportsbook(sport.name)} disabled={launching} style={{ position: 'relative', ...card, padding: 12, textAlign: 'center', cursor: 'pointer' }}>
            {sport.live && <span style={{ position: 'absolute', top: 8, right: 8, width: 6, height: 6, background: 'var(--red)', borderRadius: '50%' }} />}
            <div style={{ fontSize: 28, marginBottom: 6 }}>{sport.icon}</div>
            <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text)' }}>{sport.name}</div>
            <div style={{ fontSize: 9, color: 'var(--green)', marginTop: 2 }}>{sport.markets} markets</div>
          </button>
        ))}
      </div>

      {provider && <div style={{ ...card, marginTop: 16, textAlign: 'center' }}><p style={{ fontSize: 10, color: 'var(--text3)', margin: 0 }}>Powered by <b style={{ color: 'var(--text2)' }}>{provider?.name}</b> · Live odds update every second</p></div>}
    </ScreenShell>
  );
};

export default SportsPage;
