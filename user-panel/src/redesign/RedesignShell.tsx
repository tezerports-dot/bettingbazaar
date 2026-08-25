// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * RedesignShell.tsx — persistent app shell for the 2026 "Bazaar" redesign.
 *
 * Renders the theme-painted root, the top bar (balance pill · centered logo ·
 * theme toggle · menu), the category strip, the routed <main>, and the mobile
 * bottom tab bar. Hosts the slide-in menu drawer and the shared AuthModal, and
 * exposes { openAuth, openMenu, isAuthenticated } via ShellContext so screens
 * (e.g. the game screen's bet action) can request sign-in without mounting their
 * own auth modal.
 *
 * GOVERNANCE §3/§12: logo + brand hues come from Branding (localStorage
 * app_branding / --brand-* variables). §8: route paths flow through here as the
 * single nav table for the redesigned shell.
 */
import React, { createContext, useContext, useMemo, useState } from 'react';
import { useNavigate, useLocation } from 'react-router';
import { useGame } from '../services/GameContext';
import { useTheme } from './ThemeContext';
import { useViewport } from './useViewport';
import { fmt } from './format';
import AuthModal from '../components/Modals/AuthModal';

interface ShellContextValue {
  isAuthenticated: boolean;
  openAuth: (mode?: 'login' | 'register') => void;
  openMenu: () => void;
}
const ShellContext = createContext<ShellContextValue | undefined>(undefined);
export const useShell = (): ShellContextValue => {
  const ctx = useContext(ShellContext);
  if (!ctx) throw new Error('useShell must be used within RedesignShell');
  return ctx;
};

// ── brand logo resolution (mirrors Header.tsx / GOVERNANCE §12) ────────────────
function resolveLogo(): string {
  try {
    const b = JSON.parse(localStorage.getItem('app_branding') || '{}');
    const cdn = (b.cdnBaseUrl || '').replace(/\/+$/, '');
    if (b.logo) return b.logo.startsWith('http') ? b.logo : cdn + '/' + String(b.logo).replace(/^\/+/, '');
  } catch { /* ignore */ }
  return '/app-assets/logo-header.png';
}

const CATEGORIES = [
  { title: 'DELHI BAZAAR', sub: 'vs Bombay', icon: '🎯', accent: 'var(--gold)', path: '/' },
  { title: 'CASH OR CRASH', sub: 'Take the flight', icon: '✈️', accent: '#60a5fa', path: '/crash' },
  { title: 'CASINO', sub: 'Play to win big', icon: '🃏', accent: '#a78bfa', path: '/casino' },
  { title: 'SPORTS', sub: 'Bet anytime', icon: '🏇', accent: '#34d399', path: '/sports' },
];

const TABS = [
  { label: 'Game', icon: '🎲', path: '/' },
  { label: 'Results', icon: '📊', path: '/results' },
  { label: 'Wallet', icon: '💰', path: '/wallet' },
  { label: 'Promo', icon: '💡', path: '/promo' },
  { label: 'Profile', icon: '👤', path: '/profile' },
];

const MENU_SECTIONS = [
  { title: 'Play', items: [
    { label: 'Home', icon: '🎲', path: '/' },
    { label: 'Results', icon: '📊', path: '/results' },
    { label: 'Top Winners', icon: '🏆', path: '/winners' },
  ] },
  { title: 'My Account', items: [
    { label: 'Profile', icon: '👤', path: '/profile' },
    { label: 'My Bets', icon: '📜', path: '/my-bets' },
    { label: 'Game History', icon: '🕒', path: '/history' },
  ] },
  { title: 'Finance', items: [
    { label: 'Wallet', icon: '💳', path: '/wallet' },
    { label: 'Gift Code', icon: '🎁', path: '/gift-code' },
  ] },
  { title: 'Info', items: [
    { label: 'Pro Tips', icon: '💡', path: '/promo' },
    { label: 'Rules & How to Play', icon: '📋', path: '/rules' },
    { label: 'FAQ / Help', icon: '❓', path: '/faq' },
    { label: 'Support', icon: '🛟', path: '/support' },
  ] },
];

const APP_VERSION = import.meta.env.VITE_APP_VERSION ?? '';

const RedesignShell: React.FC<React.PropsWithChildren<{}>> = ({ children }) => {
  const { user, isAuthenticated, logout } = useGame();
  const { theme, toggleTheme } = useTheme();
  const { desktop } = useViewport();
  const navigate = useNavigate();
  const location = useLocation();

  const [menuOpen, setMenuOpen] = useState(false);
  const [authOpen, setAuthOpen] = useState(false);
  const [authMode, setAuthMode] = useState<'login' | 'register'>('login');
  const [logoFailed, setLogoFailed] = useState(false);

  const logoSrc = resolveLogo();
  const totalBal = isAuthenticated ? (user?.depositBalance ?? 0) + (user?.winningsBalance ?? 0) : null;

  const openAuth = (mode: 'login' | 'register' = 'login') => { setAuthMode(mode); setAuthOpen(true); setMenuOpen(false); };
  const openMenu = () => setMenuOpen(true);

  const ctx = useMemo<ShellContextValue>(() => ({ isAuthenticated, openAuth, openMenu }), [isAuthenticated]);

  const go = (path: string) => { navigate(path); setMenuOpen(false); };
  const isActive = (path: string) => (path === '/' ? location.pathname === '/' : location.pathname.startsWith(path));

  const iconBtn: React.CSSProperties = {
    width: 40, height: 40, borderRadius: 12, border: '1px solid var(--line)',
    background: 'var(--surface2)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
  };

  return (
    <ShellContext.Provider value={ctx}>
      <div className="bb-app" data-theme={theme}>
        {/* ░░ TOP BAR ░░ */}
        <header style={{
          flex: 'none', height: 60, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
          padding: '0 14px', background: 'color-mix(in srgb, var(--bg) 82%, transparent)', backdropFilter: 'blur(14px)',
          borderBottom: '1px solid var(--line)', position: 'relative', zIndex: 60,
        }}>
          <button onClick={() => go(isAuthenticated ? '/wallet' : '/wallet')} style={{
            display: 'flex', alignItems: 'center', gap: 9, background: 'var(--pill)', border: '1px solid var(--pill-line)',
            padding: '7px 13px 7px 8px', borderRadius: 999, cursor: 'pointer', boxShadow: 'var(--shadow-sm)',
          }}>
            <span style={{
              flex: 'none', width: 26, height: 26, borderRadius: '50%',
              background: 'linear-gradient(to bottom right,#F5C77A,#D4AF37)', display: 'flex', alignItems: 'center',
              justifyContent: 'center', color: '#1a1200', fontWeight: 900, fontSize: 13, border: '1px solid rgba(255,255,255,.2)',
            }}>₹</span>
            <span style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.05, textAlign: 'left' }}>
              <span className="font-grotesk" style={{ fontWeight: 700, fontSize: 15, color: 'var(--text)', letterSpacing: '.01em' }}>
                {totalBal !== null ? `₹${fmt(totalBal)}` : 'Sign in'}
              </span>
              <span style={{ fontSize: 8, fontWeight: 700, letterSpacing: '.12em', textTransform: 'uppercase', color: 'var(--green)' }}>
                {totalBal !== null ? 'Wallet' : 'to play'}
              </span>
            </span>
          </button>

          <button onClick={() => go('/')} style={{
            position: 'absolute', left: '50%', transform: 'translateX(-50%)', background: 'none', border: 'none',
            cursor: 'pointer', height: '100%', display: 'flex', alignItems: 'center', padding: '0 10px',
          }}>
            {!logoFailed ? (
              <img src={logoSrc} alt="Betting Bazaar" onError={() => setLogoFailed(true)} style={{
                height: desktop ? 46 : 40, width: 'auto', maxWidth: desktop ? 320 : 240, objectFit: 'contain',
                filter: 'drop-shadow(0 2px 8px var(--glow))',
              }} />
            ) : (
              <span className="font-grotesk" style={{ color: 'var(--gold-ink)', fontWeight: 700, fontSize: 20, letterSpacing: '.14em' }}>
                BETTING&nbsp;BAZAAR
              </span>
            )}
          </button>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button onClick={toggleTheme} aria-label="Toggle theme" style={{ ...iconBtn, color: 'var(--gold-ink)', fontSize: 17 }}>
              {theme === 'dark' ? '☀️' : '🌙'}
            </button>
            <button onClick={openMenu} aria-label="Menu" style={{ ...iconBtn, color: 'var(--text)' }}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
                <line x1="4" y1="7" x2="20" y2="7" /><line x1="4" y1="12" x2="20" y2="12" /><line x1="4" y1="17" x2="20" y2="17" />
              </svg>
            </button>
          </div>
        </header>

        {/* ░░ MAIN + CATEGORY STRIP ░░ */}
        <main style={{ flex: 1, minHeight: 0, position: 'relative', overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
          <div className="bb-noscroll" style={{
            flex: 'none', display: 'flex', gap: 10, padding: '8px 14px', overflowX: 'auto',
            background: 'color-mix(in srgb, var(--bg) 55%, transparent)', borderBottom: '1px solid var(--line)',
          }}>
            {CATEGORIES.map(cat => {
              const active = isActive(cat.path);
              return (
                <button key={cat.path} onClick={() => go(cat.path)} style={{
                  flex: 'none', width: 158, height: 60, borderRadius: 14, padding: '0 14px', display: 'flex',
                  alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer',
                  background: active ? 'linear-gradient(135deg,var(--surface2),var(--surface3))' : 'var(--surface)',
                  border: `1.5px solid ${active ? cat.accent : 'var(--line)'}`,
                  boxShadow: active ? `0 0 18px -4px ${cat.accent}` : 'var(--shadow-sm)', position: 'relative', overflow: 'hidden',
                }}>
                  <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', lineHeight: 1.15, textAlign: 'left', minWidth: 0 }}>
                    <span className="font-grotesk" style={{ fontWeight: 700, fontSize: 12, letterSpacing: '.03em', color: cat.accent, whiteSpace: 'nowrap' }}>{cat.title}</span>
                    <span style={{ fontSize: 9, fontWeight: 600, color: 'var(--text2)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 96 }}>{cat.sub}</span>
                  </span>
                  <span style={{ fontSize: 26, lineHeight: 1, filter: `drop-shadow(0 0 8px ${cat.accent})` }}>{cat.icon}</span>
                </button>
              );
            })}
          </div>

          <div key={location.pathname} className="bb-rise" style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
            {children}
          </div>
        </main>

        {/* ░░ BOTTOM TAB BAR (mobile/tablet) ░░ */}
        {!desktop && (
          <nav style={{
            flex: 'none', display: 'flex', background: 'color-mix(in srgb, var(--bg) 92%, transparent)',
            backdropFilter: 'blur(14px)', borderTop: '1px solid var(--line2)', paddingBottom: 'env(safe-area-inset-bottom)',
            position: 'relative', zIndex: 60,
          }}>
            {TABS.map(tab => {
              const active = isActive(tab.path);
              return (
                <button key={tab.path} onClick={() => go(tab.path)} style={{
                  flex: 1, height: 58, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                  gap: 3, border: 'none', background: 'none', cursor: 'pointer', color: active ? 'var(--gold-ink)' : 'var(--text3)',
                  position: 'relative',
                }}>
                  {active && <span style={{ position: 'absolute', top: 0, left: '50%', transform: 'translateX(-50%)', width: 26, height: 3, borderRadius: '0 0 4px 4px', background: 'linear-gradient(90deg,var(--gold3),var(--gold2))' }} />}
                  <span style={{ fontSize: 18, transform: active ? 'scale(1.14)' : 'scale(1)', transition: 'transform .15s' }}>{tab.icon}</span>
                  <span style={{ fontSize: 8, fontWeight: 800, letterSpacing: '.06em', textTransform: 'uppercase' }}>{tab.label}</span>
                </button>
              );
            })}
          </nav>
        )}

        {/* ░░ MENU DRAWER ░░ */}
        {menuOpen && (
          <>
            <div onClick={() => setMenuOpen(false)} style={{ position: 'absolute', inset: 0, zIndex: 100, background: 'rgba(0,0,0,.6)', backdropFilter: 'blur(3px)' }} />
            <div className="bb-rise" style={{
              position: 'absolute', top: 0, right: 0, bottom: 0, zIndex: 101, width: 'min(86vw,340px)', display: 'flex',
              flexDirection: 'column', background: 'var(--surface)', borderLeft: '1px solid var(--line2)',
              boxShadow: '-20px 0 50px -12px rgba(0,0,0,.6)',
            }}>
              <div style={{ flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '20px 20px 16px', borderBottom: '1px solid var(--line)' }}>
                <span className="font-grotesk" style={{ fontWeight: 700, fontSize: 15, letterSpacing: '.14em', color: 'var(--gold-ink)', textTransform: 'uppercase' }}>Menu</span>
                <button onClick={() => setMenuOpen(false)} style={{ width: 32, height: 32, borderRadius: '50%', border: '1px solid var(--line)', background: 'var(--surface3)', color: 'var(--text2)', cursor: 'pointer', fontSize: 13 }}>✕</button>
              </div>
              <nav className="bb-noscroll" style={{ flex: 1, overflowY: 'auto', padding: '12px 10px' }}>
                {MENU_SECTIONS.map(sec => (
                  <div key={sec.title}>
                    <div style={{ padding: '10px 10px 4px', fontSize: 9, fontWeight: 800, letterSpacing: '.16em', textTransform: 'uppercase', color: 'var(--text3)' }}>{sec.title}</div>
                    {sec.items.map(it => {
                      const active = isActive(it.path);
                      return (
                        <button key={it.path + it.label} onClick={() => go(it.path)} style={{
                          width: '100%', display: 'flex', alignItems: 'center', gap: 12, padding: '11px 12px', border: 'none',
                          borderRadius: 11, background: active ? 'color-mix(in srgb,var(--gold) 12%,transparent)' : 'transparent',
                          cursor: 'pointer', textAlign: 'left', marginBottom: 2,
                        }}>
                          <span style={{ width: 30, height: 30, flex: 'none', borderRadius: 9, background: 'var(--surface3)', border: '1px solid var(--line)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 15 }}>{it.icon}</span>
                          <span style={{ flex: 1, fontSize: 13, fontWeight: 600, color: active ? 'var(--gold-ink)' : 'var(--text)' }}>{it.label}</span>
                          <span style={{ color: 'var(--text3)', fontSize: 13 }}>›</span>
                        </button>
                      );
                    })}
                  </div>
                ))}
              </nav>
              <div style={{ flex: 'none', padding: '12px 16px 14px', borderTop: '1px solid var(--line)' }}>
                {!isAuthenticated ? (
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button onClick={() => openAuth('login')} style={{ flex: 1, padding: 11, borderRadius: 12, border: 'none', cursor: 'pointer', fontWeight: 800, fontSize: 13, color: '#1a1200', background: 'linear-gradient(135deg,var(--gold2),var(--gold))' }}>Sign In</button>
                    <button onClick={() => openAuth('register')} style={{ flex: 1, padding: 11, borderRadius: 12, border: '1px solid var(--line2)', cursor: 'pointer', fontWeight: 800, fontSize: 13, color: 'var(--gold-ink)', background: 'color-mix(in srgb,var(--gold) 8%,transparent)' }}>Register</button>
                  </div>
                ) : (
                  <button onClick={() => { logout(); setMenuOpen(false); navigate('/'); }} style={{ width: '100%', padding: 11, borderRadius: 12, border: '1px solid color-mix(in srgb,var(--red) 35%,transparent)', cursor: 'pointer', fontWeight: 800, fontSize: 13, color: 'var(--red)', background: 'color-mix(in srgb,var(--red) 8%,transparent)' }}>🚪 Sign Out</button>
                )}
                <div style={{ textAlign: 'center', fontSize: 9, letterSpacing: '.2em', color: 'var(--text3)', marginTop: 12 }}>BETTING BAZAAR{APP_VERSION ? ` · v${APP_VERSION}` : ''}</div>
              </div>
            </div>
          </>
        )}

        {authOpen && !isAuthenticated && <AuthModal onClose={() => setAuthOpen(false)} initialMode={authMode} />}
      </div>
    </ShellContext.Provider>
  );
};

export default RedesignShell;
