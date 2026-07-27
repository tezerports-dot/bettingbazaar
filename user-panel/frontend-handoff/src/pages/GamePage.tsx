// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * GamePage.tsx — 2026 "Bazaar" redesign.
 *
 * The full Delhi vs Bombay game experience now lives in redesign/GameScreen
 * (cycle control, betting card, chips, side panels, analytics drawer), rendered
 * inside the persistent RedesignShell. This page keeps the two page-level
 * concerns: the admin HOME_POPUP promo and the "openDeposit" navigation intercept.
 */
import React, { useState, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router';
import { useGame } from '../services/GameContext';
import GameScreen from '../redesign/GameScreen';
import { getBackend, getAssetUrl } from '../services/backend.service';
import { PromoContent } from '../types';

const backend = getBackend();

const GamePage: React.FC = () => {
  const { isAuthenticated } = useGame();
  const navigate = useNavigate();
  const location = useLocation();
  const [promoPopup, setPromoPopup] = useState<PromoContent | null>(null);

  // Admin HOME_POPUP — show once per browser.
  useEffect(() => {
    if (localStorage.getItem('hasSeenPromoPopup')) return;
    (async () => {
      try {
        const promos = await backend.getPublicContent('HOME_POPUP');
        if (promos.length > 0) {
          setPromoPopup(promos[0]);
          localStorage.setItem('hasSeenPromoPopup', 'true');
        }
      } catch { /* optional — skip if unavailable */ }
    })();
  }, []);

  // Deposit intercept: WalletPage "Buy Tokens" → navigate('/',{state:{openDeposit}}).
  useEffect(() => {
    const state = location.state as Record<string, unknown> | null;
    if (state?.openDeposit) {
      window.history.replaceState({}, document.title, window.location.href);
      navigate('/wallet');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <>
      <GameScreen />

      {promoPopup !== null && (
        <div onClick={() => setPromoPopup(null)} style={{ position: 'absolute', inset: 0, zIndex: 140, background: 'rgba(0,0,0,.6)', backdropFilter: 'blur(3px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px 16px' }}>
          <div onClick={e => e.stopPropagation()} className="bb-rise" style={{ width: '100%', maxWidth: 420, background: 'var(--surface)', border: '1px solid var(--line2)', borderRadius: 20, padding: 22, boxShadow: 'var(--shadow)', textAlign: 'center', position: 'relative' }}>
            <button onClick={() => setPromoPopup(null)} style={{ position: 'absolute', top: 12, right: 12, width: 30, height: 30, borderRadius: '50%', border: '1px solid var(--line)', background: 'var(--surface3)', color: 'var(--text2)', cursor: 'pointer', fontSize: 12 }}>✕</button>
            <h2 className="font-grotesk" style={{ fontWeight: 700, fontSize: 19, color: 'var(--gold-ink)', margin: '4px 0 12px', textTransform: 'uppercase', letterSpacing: '.06em' }}>{promoPopup.title}</h2>
            {!!promoPopup.fileUrl && (
              <div style={{ width: '100%', borderRadius: 14, overflow: 'hidden', border: '1px solid var(--line2)', marginBottom: 14, background: 'var(--bg)' }}>
                <img src={getAssetUrl(promoPopup.fileUrl, '')} alt="Promo" style={{ width: '100%', height: 'auto', objectFit: 'cover', maxHeight: 300 }} />
              </div>
            )}
            {!!promoPopup.description && (
              <div style={{ background: 'var(--surface2)', padding: 14, borderRadius: 12, border: '1px solid var(--line)', marginBottom: 16 }}>
                <p style={{ color: 'var(--text2)', fontSize: 13, lineHeight: 1.6, whiteSpace: 'pre-wrap', margin: 0 }}>{promoPopup.description}</p>
              </div>
            )}
            <button onClick={() => setPromoPopup(null)} style={{ width: '100%', padding: 14, borderRadius: 13, border: 'none', cursor: 'pointer', fontWeight: 800, fontSize: 14, color: '#1a1200', background: 'linear-gradient(135deg,var(--gold2),var(--gold))', textTransform: 'uppercase', letterSpacing: '.06em' }}>Enter Arena</button>
          </div>
        </div>
      )}
    </>
  );
};

export default GamePage;
