// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
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
import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { useNavigate, useLocation } from 'react-router';
import { useGame, spendableBalance } from '../services/GameContext';
import { useGameProviders } from '../services/GameProviderContext';
import { useTheme } from './ThemeContext';
import { useViewport } from './useViewport';
import { fmt } from './format';
import AuthModal from '../components/Modals/AuthModal';
import NotificationBell from '../components/Layout/NotificationBell';
import ShareModal from '../components/Modals/ShareModal';
import AnnouncementBanner from '../components/AnnouncementBanner';
import { useHeaderLogo } from '../services/brandAssets';
import { ProfileSwitch, usePlayProfile } from './ProfileSwitch';

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


/**
 * ── A card is only shown when its destination has something behind it ──────
 * `needs` names the provider category the card leads to, and it is read from
 * the SAME owner the destination page reads (`useGameProviders`). That is the
 * whole point: this list and those pages were two halves of one decision and
 * neither knew about the other.
 *
 * `CrashPage` and `SportsPage` each end with
 *
 *     useEffect(() => { if (!anyCrash) navigate('/', { replace: true }); }, …)
 *
 * which is right — an empty category should not have a page. But this row went
 * on offering the cards regardless, so with no crash or sports provider
 * configured a player tapped a prominent card and was silently returned to the
 * screen they were already on. Measured in a browser, at phone width:
 *
 *     taps "CASH OR CRASH"     ->  hash #/ stays #/   (nothing happened)
 *     taps "SPORTS Bet anytime" ->  hash #/ stays #/   (nothing happened)
 *     taps "CASINO Play to win" ->  hash #/ -> #/casino (works)
 *
 * S22, in the shape CLAUDE.md already records for the Profile rows: two halves
 * of a hole, each looking like the other half's job. Nothing fails, so nothing
 * reports — the redirect is `replace: true`, so it does not even leave a back
 * entry a player could notice.
 *
 * DELHI BAZAAR is the platform's own board and has no provider, so it has no
 * `needs` and is always offered.
 */
const CATEGORIES: { title: string; sub: string; icon: string; accent: string; path: string; needs?: 'casino' | 'crash' | 'sports' }[] = [
  { title: 'DELHI BAZAAR', sub: 'vs Bombay', icon: '🎯', accent: 'var(--gold)', path: '/' },
  { title: 'CASH OR CRASH', sub: 'Take the flight', icon: '✈️', accent: '#60a5fa', path: '/crash', needs: 'crash' },
  { title: 'CASINO', sub: 'Play to win big', icon: '🃏', accent: '#a78bfa', path: '/casino', needs: 'casino' },
  { title: 'SPORTS', sub: 'Bet anytime', icon: '🏇', accent: '#34d399', path: '/sports', needs: 'sports' },
];

const TABS = [
  { label: 'Game', icon: '🎲', path: '/' },
  { label: 'Results', icon: '📊', path: '/results' },
  { label: 'Wallet', icon: '💰', path: '/wallet' },
  { label: 'Promo', icon: '💡', path: '/promo' },
  // The last tab opens the menu drawer (owner, 2026-10-10): the header lost
  // its bell to make room for the profile pill, and Profile lives in the menu.
  { label: 'Menu', icon: '☰', path: '#menu', action: 'menu' as const },
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
  ] },
  { title: 'Info', items: [
    { label: 'Pro Tips', icon: '💡', path: '/promo' },
    { label: 'Refer & Earn', icon: '🎁', path: '/referrals' },
    // Opens a modal rather than navigating. It is the ONLY way a player can
    // reach the app downloads: an admin publishes an Android release / sets `iosUrl` in system
    // config, `/api/download/android` and `/api/download/ios` 302 to them, and
    // before this entry existed nothing in the panel linked to either — the
    // fields were admin-editable with no consumer (§3) and the routes were a
    // backend feature with no UI (§28). `ShareModal` had been built for it and
    // hung off the old `Layout/Header`, which this shell replaced.
    { label: 'Share & Get the App', icon: '📲', path: '#share', action: 'share' as const },
    { label: 'Rules & How to Play', icon: '📋', path: '/rules' },
    { label: 'FAQ / Help', icon: '❓', path: '/faq' },
    { label: 'Support', icon: '🛟', path: '/support' },
  ] },
];

const APP_VERSION = import.meta.env.VITE_APP_VERSION ?? '';

const RedesignShell: React.FC<React.PropsWithChildren> = ({ children }) => {
  const { user, isAuthenticated, logout, setAudience } = useGame();
  const { theme, toggleTheme } = useTheme();
  const { desktop, vw } = useViewport();
  // A phone narrower than this cannot hold the wallet pill, the wordmark and
  // four 40px buttons on one row, so the buttons shrink and the theme switch
  // moves into the menu (where it is always offered too).
  const compact = vw < 420;
  // A laptop gets a side rail instead of the bottom tab bar (owner,
  // 2026-10-10): a wide screen driven by a mouse. A tablet held sideways is
  // as wide but touch-first, so it keeps the bar under the thumb.
  const [finePointer] = useState(() => {
    try { return window.matchMedia('(pointer: fine)').matches; } catch { return true; }
  });
  const laptop = desktop && finePointer;
  const [railOpen, setRailOpen] = useState(() => {
    try { return localStorage.getItem('bb_rail') !== 'closed'; } catch { return true; }
  });
  const toggleRail = () => setRailOpen((o) => {
    try { localStorage.setItem('bb_rail', o ? 'closed' : 'open'); } catch { /* per-viewer nicety only */ }
    return !o;
  });
  const navigate = useNavigate();
  const location = useLocation();

  const [menuOpen, setMenuOpen] = useState(false);
  const [authOpen, setAuthOpen] = useState(false);
  const [authMode, setAuthMode] = useState<'login' | 'register'>('login');
  const [logoFailed, setLogoFailed] = useState(false);

  const logoSrc = useHeaderLogo();
  // ── DELIBERATELY deposit + winnings, and NOT the reserve ──────────────────
  // This pill is smaller than the total on the wallet screen, on purpose. The
  // reserve is not freely spendable — only `betReservePercent` of a stake may
  // be drawn from it — and `backend/routes.js` records what happened when a
  // headline figure included it: players tried bets the engine then refused.
  // The wallet screen can show the larger number because it shows the RESERVE
  // tile beside it and publishes the real ceiling from
  // `/api/user/bet-limits`; a bare pill in the header cannot.
  //
  // Left as a named helper rather than an inline sum so the next reader meets
  // this reasoning instead of "the header forgot a pocket" — which is exactly
  // how it was read once already.
  // On the General profile the pill shows the General (referral bonus)
  // balance instead: that is the money the player is playing with.
  const { general, choose, error: profileError } = usePlayProfile(!!isAuthenticated, location.pathname);
  // The boards on screen are the profile's own (VIP and GENERAL never share a
  // cycle); a visitor, and a player whose profile has not loaded, sees VIP's.
  const shownProfile = isAuthenticated && general ? general.profile : 'VIP';
  useEffect(() => { setAudience(shownProfile); }, [shownProfile, setAudience]);
  const onGeneral = general?.profile === 'GENERAL';
  const totalBal = isAuthenticated ? (onGeneral ? general!.promoBalance : spendableBalance(user)) : null;

  const openAuth = (mode: 'login' | 'register' = 'login') => { setAuthMode(mode); setAuthOpen(true); setMenuOpen(false); };
  const openMenu = () => setMenuOpen(true);

  const [shareOpen, setShareOpen] = useState(false);
  const ctx = useMemo<ShellContextValue>(() => ({ isAuthenticated, openAuth, openMenu }), [isAuthenticated]);

  const go = (path: string) => { navigate(path); setMenuOpen(false); };

  // Only the categories that have somewhere to go. Same owner the destination
  // pages read, so the row and the page cannot disagree about whether a
  // category exists (§2, §5).
  const { anyCasino, anyCrash, anySports } = useGameProviders();
  const liveCategories = useMemo(
    () => CATEGORIES.filter((c) => !c.needs
      || (c.needs === 'casino' ? anyCasino : c.needs === 'crash' ? anyCrash : anySports)),
    [anyCasino, anyCrash, anySports],
  );
  const isActive = (path: string) => (path === '/' ? location.pathname === '/' : location.pathname.startsWith(path));

  const iconSize = compact ? 34 : 40;
  const iconBtn: React.CSSProperties = {
    flex: 'none', width: iconSize, height: iconSize, borderRadius: 12, border: '1px solid var(--line)',
    background: 'var(--surface2)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
  };

  /** One handler for a menu entry, from the drawer or the laptop rail. */
  const pickMenuItem = (it: (typeof MENU_SECTIONS)[number]['items'][number]) => {
    if ('action' in it && it.action === 'share') { setMenuOpen(false); setShareOpen(true); return; }
    go(it.path);
  };

  // ░░ SIDE RAIL (laptop) ░░ The menu's own sections, always in view; it
  // folds to icons. Phones and tablets keep the bottom tab bar instead.
  const rail = laptop ? (
    <nav aria-label="Main menu" className="bb-noscroll" style={{
      flex: 'none', width: railOpen ? 232 : 68, transition: 'width .18s ease', overflowY: 'auto', overflowX: 'hidden',
      background: 'var(--surface)', borderRight: '1px solid var(--line)', display: 'flex', flexDirection: 'column', padding: '10px 10px 14px',
    }}>
      {MENU_SECTIONS.map(sec => (
        <div key={sec.title} style={{ marginTop: 6 }}>
          {railOpen
            ? <div style={{ padding: '8px 10px 4px', fontSize: 9, fontWeight: 800, letterSpacing: '.16em', textTransform: 'uppercase', color: 'var(--text3)' }}>{sec.title}</div>
            : <div style={{ height: 1, background: 'var(--line)', margin: '8px 6px' }} />}
          {sec.items.map(it => {
            const active = 'action' in it ? false : isActive(it.path);
            return (
              <button key={it.path + it.label} type="button" onClick={() => pickMenuItem(it)} title={railOpen ? undefined : it.label}
                aria-label={railOpen ? undefined : it.label} aria-current={active ? 'page' : undefined} style={{
                  width: '100%', display: 'flex', alignItems: 'center', gap: 11, padding: railOpen ? '9px 10px' : '9px 0',
                  justifyContent: railOpen ? 'flex-start' : 'center', border: 'none', borderRadius: 10, cursor: 'pointer', textAlign: 'left', marginBottom: 2,
                  background: active ? 'color-mix(in srgb,var(--gold) 14%,transparent)' : 'transparent',
                  boxShadow: active ? 'inset 3px 0 0 var(--gold)' : 'none',
                }}>
                <span aria-hidden="true" style={{ width: 30, height: 30, flex: 'none', borderRadius: 9, background: 'var(--surface3)', border: '1px solid var(--line)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 15 }}>{it.icon}</span>
                {railOpen && <span style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', color: active ? 'var(--gold-ink)' : 'var(--text)' }}>{it.label}</span>}
              </button>
            );
          })}
        </div>
      ))}
      <div style={{ flex: 1 }} />
      {isAuthenticated && (
        <button type="button" onClick={() => { logout(); navigate('/'); }} title={railOpen ? undefined : 'Sign Out'} aria-label={railOpen ? undefined : 'Sign Out'} style={{
          width: '100%', display: 'flex', alignItems: 'center', gap: 11, padding: railOpen ? '9px 10px' : '9px 0', justifyContent: railOpen ? 'flex-start' : 'center',
          border: 'none', borderRadius: 10, cursor: 'pointer', textAlign: 'left', marginTop: 12, background: 'transparent', color: 'var(--red)',
        }}>
          <span aria-hidden="true" style={{ width: 30, height: 30, flex: 'none', borderRadius: 9, background: 'color-mix(in srgb,var(--red) 8%,transparent)', border: '1px solid color-mix(in srgb,var(--red) 35%,transparent)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 15 }}>🚪</span>
          {railOpen && <span style={{ fontSize: 13, fontWeight: 700 }}>Sign Out</span>}
        </button>
      )}
      {!isAuthenticated && railOpen && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 12 }}>
          <button type="button" onClick={() => openAuth('login')} style={{ padding: 10, borderRadius: 11, border: 'none', cursor: 'pointer', fontWeight: 800, fontSize: 13, color: '#1a1200', background: 'linear-gradient(135deg,var(--gold2),var(--gold))' }}>Sign In</button>
          <button type="button" onClick={() => openAuth('register')} style={{ padding: 10, borderRadius: 11, border: '1px solid var(--line2)', cursor: 'pointer', fontWeight: 800, fontSize: 13, color: 'var(--gold-ink)', background: 'color-mix(in srgb,var(--gold) 8%,transparent)' }}>Register</button>
        </div>
      )}
    </nav>
  ) : null;

  return (
    <ShellContext.Provider value={ctx}>
      <div className="bb-app" data-theme={theme}>
        {/* ░░ TOP BAR ░░ */}
        {/*
          Three columns, not an absolutely-centred logo: the wordmark gets
          exactly the room the pill and the buttons leave, and scales down
          into it. Centred over the whole bar it was sized in pixels, so on a
          phone it grew under the buttons on both sides.
        */}
        <header style={{
          flex: 'none', height: 60, display: 'grid', gridTemplateColumns: laptop ? 'auto auto minmax(0,1fr) auto' : 'auto minmax(0,1fr) auto', alignItems: 'center',
          gap: compact ? 8 : 12, padding: compact ? '0 10px' : '0 14px', background: 'color-mix(in srgb, var(--bg) 82%, transparent)', backdropFilter: 'blur(14px)',
          borderBottom: '1px solid var(--line)', position: 'relative', zIndex: 60,
        }}>
          {/*
            Signed in, this is the wallet. Signed OUT it reads "Sign in / TO
            PLAY", so it OPENS THE SIGN-IN DOOR.

            It used to be `go(isAuthenticated ? '/wallet' : '/wallet')` — a
            ternary with two identical branches, which is the shape of an
            intention that never landed. A logged-out visitor clicking the most
            prominent control on the page, the one that says "Sign in", was
            navigated to the wallet instead: `/api/v1/user/profile` answered 401,
            the page logged "Session expired. Please log in again." and bounced
            them back to where they started. Nothing on screen explained it, and
            the site read as broken rather than as asking them to log in.

            `openAuth` and the modal behind it were already here and already
            working — the drawer's own Sign In button has always called it. Only
            this button was wired to the wrong half.
          */}
          {/* A laptop's menu is the side rail, so its one menu button sits on
              the same (left) side and folds the rail (owner, 2026-10-10). */}
          {laptop && (
            <button onClick={toggleRail} aria-label={railOpen ? 'Collapse menu' : 'Expand menu'} aria-expanded={railOpen} style={{ ...iconBtn, color: 'var(--text)' }}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
                <line x1="4" y1="7" x2="20" y2="7" /><line x1="4" y1="12" x2="20" y2="12" /><line x1="4" y1="17" x2="20" y2="17" />
              </svg>
            </button>
          )}
          <button onClick={() => (isAuthenticated ? go('/wallet') : openAuth('login'))} style={{
            display: 'flex', alignItems: 'center', gap: compact ? 6 : 9, background: 'var(--pill)', border: '1px solid var(--pill-line)',
            padding: compact ? '6px 10px 6px 6px' : '7px 13px 7px 8px', borderRadius: 999, cursor: 'pointer', boxShadow: 'var(--shadow-sm)',
          }}>
            {!compact && (
              <span style={{
                flex: 'none', width: 26, height: 26, borderRadius: '50%',
                background: 'linear-gradient(to bottom right,var(--gold2),var(--gold))', display: 'flex', alignItems: 'center',
                justifyContent: 'center', color: '#1a1200', fontWeight: 900, fontSize: 13, border: '1px solid rgba(255,255,255,.2)',
              }}>₹</span>
            )}
            <span style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.05, textAlign: 'left' }}>
              <span className="font-grotesk" style={{ fontWeight: 700, fontSize: compact ? 13 : 15, color: 'var(--text)', letterSpacing: '.01em', whiteSpace: 'nowrap' }}>
                {totalBal !== null ? `₹${fmt(totalBal)}` : 'Sign in'}
              </span>
              <span style={{ fontSize: 8, fontWeight: 700, letterSpacing: '.12em', textTransform: 'uppercase', color: 'var(--green)' }}>
                {totalBal !== null ? (onGeneral ? 'General' : 'Wallet') : 'to play'}
              </span>
            </span>
          </button>

          <button onClick={() => go('/')} aria-label="Home" style={{
            minWidth: 0, width: '100%', height: '100%', background: 'none', border: 'none', cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0,
          }}>
            {!logoFailed ? (
              <img src={logoSrc} alt="Betting Bazaar" onError={() => setLogoFailed(true)} style={{
                display: 'block', width: 'auto', height: 'auto', maxWidth: '100%', maxHeight: desktop ? 44 : 36,
                objectFit: 'contain',
              }} />
            ) : (
              <span className="font-grotesk" style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--gold-ink)', fontWeight: 700, fontSize: compact ? 15 : 20, letterSpacing: '.14em' }}>
                BETTING&nbsp;BAZAAR
              </span>
            )}
          </button>

          <div style={{ display: 'flex', alignItems: 'center', gap: compact ? 6 : 8 }}>
            {general && <ProfileSwitch general={general} choose={choose} error={profileError} />}
            {!compact && (
              <button onClick={toggleTheme} aria-label="Toggle theme" style={{ ...iconBtn, color: 'var(--gold-ink)', fontSize: 17 }}>
                {theme === 'dark' ? '☀️' : '🌙'}
              </button>
            )}
            {laptop
              ? <NotificationBell isAuthenticated={isAuthenticated} />
              : (
                <button onClick={openMenu} aria-label="Menu" style={{ ...iconBtn, color: 'var(--text)' }}>
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
                    <line x1="4" y1="7" x2="20" y2="7" /><line x1="4" y1="12" x2="20" y2="12" /><line x1="4" y1="17" x2="20" y2="17" />
                  </svg>
                </button>
              )}
          </div>
        </header>

        {/* ░░ RAIL (laptop) + MAIN + CATEGORY STRIP ░░ */}
        <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
        {rail}
        <main style={{ minWidth: 0, flex: 1, minHeight: 0, position: 'relative', overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
          {/*
            What the platform is telling everyone. `announcements` had an admin
            page that writes them and a route that serves them, and no screen
            here that read it — so an operator's "deposits are paused for an
            hour" reached nobody (§28, the third instance of that shape).

            Above the content rather than inside a page, because it applies to
            whatever the player is looking at, and rendered signed out too:
            the people who most need to read a service notice are the ones who
            cannot get in.
          */}
          <AnnouncementBanner />
          <div className="bb-noscroll" style={{
            flex: 'none', display: 'flex', gap: 10, padding: '8px 14px', overflowX: 'auto',
            background: 'color-mix(in srgb, var(--bg) 55%, transparent)', borderBottom: '1px solid var(--line)',
          }}>
            {liveCategories.map(cat => {
              const active = isActive(cat.path);
              return (
                <button key={cat.path} onClick={() => go(cat.path)}
                  // Which category you are IN, said out loud. It was a border
                  // colour and a glow and nothing else, so a screen reader read
                  // four identical buttons. `aria-current="page"` because these
                  // navigate — they are not a toggle.
                  aria-current={active ? 'page' : undefined}
                  style={{
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
        </div>

        {/* ░░ BOTTOM TAB BAR, phones and tablets (owner, 2026-10-10) ░░
            Fixed at the foot of the app, tablets included, so the main places
            are one tap away; a tablet held sideways keeps the tabs at a
            phone-like width in the middle. A laptop has the side rail. */}
        {!laptop && (
          <nav style={{
            flex: 'none', display: 'flex', justifyContent: 'center', background: 'color-mix(in srgb, var(--bg) 92%, transparent)',
            backdropFilter: 'blur(14px)', borderTop: '1px solid var(--line2)', paddingBottom: 'env(safe-area-inset-bottom)',
            position: 'relative', zIndex: 60,
          }}>
            {TABS.map(tab => {
              const isMenu = 'action' in tab && tab.action === 'menu';
              const active = isMenu ? menuOpen : isActive(tab.path);
              return (
                <button key={tab.path} onClick={() => (isMenu ? openMenu() : go(tab.path))} aria-label={isMenu ? 'Open menu' : undefined} style={{
                  flex: 1, maxWidth: desktop ? 150 : undefined, height: 58, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
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
                {/*
                  The notification inbox, moved here from the header (owner,
                  2026-10-10) so the header has room for the profile pill.
                  `notify()` persists real events (an admin blocking an account
                  writes the explanation meant for that player), so the inbox
                  must stay reachable (§28): it is the first thing in the menu.
                */}
                <div style={{ marginLeft: 'auto', marginRight: 8 }}>
                  <NotificationBell isAuthenticated={isAuthenticated} />
                </div>
                <button onClick={() => setMenuOpen(false)} style={{ width: 32, height: 32, borderRadius: '50%', border: '1px solid var(--line)', background: 'var(--surface3)', color: 'var(--text2)', cursor: 'pointer', fontSize: 13 }}>✕</button>
              </div>
              <nav className="bb-noscroll" style={{ flex: 1, overflowY: 'auto', padding: '12px 10px' }}>
                {MENU_SECTIONS.map(sec => (
                  <div key={sec.title}>
                    <div style={{ padding: '10px 10px 4px', fontSize: 9, fontWeight: 800, letterSpacing: '.16em', textTransform: 'uppercase', color: 'var(--text3)' }}>{sec.title}</div>
                    {sec.items.map(it => {
                      const active = isActive(it.path);
                      return (
                        <button key={it.path + it.label} onClick={() => pickMenuItem(it)} style={{
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
                <button onClick={toggleTheme} style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: 10, marginBottom: 10, borderRadius: 12, border: '1px solid var(--line)', background: 'var(--surface3)', color: 'var(--text)', cursor: 'pointer', fontWeight: 700, fontSize: 12 }}>
                  <span aria-hidden="true">{theme === 'dark' ? '☀️' : '🌙'}</span>{theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
                </button>
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
        {shareOpen && <ShareModal onClose={() => setShareOpen(false)} />}

      </div>
    </ShellContext.Provider>
  );
};

export default RedesignShell;
