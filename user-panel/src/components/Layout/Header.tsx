/**
 * Header.tsx  v5.1.0
 *
 * ARCH-FIX-001: Wallet button now navigates directly to /wallet via React Router.
 *   - WalletModal fully eliminated — zero dead UI layer.
 *   - "Winners Board" and dead navigation items purged from menuSections.
 *   - ShareModal and AuthModal retained (standalone utilities, not dead routes).
 */
// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
import React, { useState } from 'react';
import { useGame } from '../../services/GameContext';
import AuthModal from '../Modals/AuthModal';
import ShareModal from '../Modals/ShareModal';
import { useNavigate } from 'react-router';
import { Show } from '../ui/Show';

interface HeaderProps { onAuthRequired?: () => void; }
type MenuItem = { label: string; icon: string; path: string; requireAuth?: boolean };
type MenuSection = { title: string; auth?: boolean; items: MenuItem[] };

const menuSections: MenuSection[] = [
  {
    title: 'PLAY',
    items: [
      { label: 'Home',           icon: '🎲', path: '/' },
      { label: 'Results',        icon: '📊', path: '/results' },
    ],
  },
  {
    title: 'MY ACCOUNT',
    auth: true,
    items: [
      { label: 'Profile',        icon: '👤', path: '/profile',   requireAuth: true },
      { label: 'My Bets',        icon: '📜', path: '/my-bets',   requireAuth: true },
      { label: 'Game History',   icon: '🕒', path: '/history',   requireAuth: true },
    ],
  },
  {
    title: 'FINANCE',
    auth: true,
    items: [
      { label: 'Wallet',         icon: '💳', path: '/wallet',    requireAuth: true },
      { label: 'Gift Code',      icon: '🎁', path: '/gift-code', requireAuth: true },
    ],
  },
  {
    title: 'COMMUNITY',
    items: [
      { label: 'Support',        icon: '🛟', path: '/support' },
      { label: 'Pro Tips',       icon: '💡', path: '/promo' },
    ],
  },
  {
    title: 'INFO',
    items: [
      { label: 'Refer & Earn',        icon: '🎁', path: '/referrals' },
      { label: 'Rules & How to Play', icon: '📋', path: '/rules' },
      { label: 'FAQ / Help',          icon: '❓', path: '/faq' },
      { label: 'Support',             icon: '💬', path: '/support' },
    ],
  },
];

const Header: React.FC<HeaderProps> = ({ onAuthRequired }) => {
  const { user, isAuthenticated, logout } = useGame();
  const [isShareOpen, setIsShareOpen]     = useState(false);
  const [isMenuOpen, setIsMenuOpen]       = useState(false);
  const [isAuthOpen, setIsAuthOpen]       = useState(false);
  const [isAuthMode, setIsAuthMode]       = useState<'login'|'register'>('login');
  const [showBalanceDetail, setShowBalanceDetail] = useState(false);
  const [logoFailed, setLogoFailed]       = useState(false);
  const navigate = useNavigate();

  const openAuth     = () => { setIsMenuOpen(false); setIsAuthMode('login');    setIsAuthOpen(true); };
  const openRegister = () => { setIsMenuOpen(false); setIsAuthMode('register'); setIsAuthOpen(true); };
  const handleLogout = () => { logout(); setIsMenuOpen(false); navigate('/'); };
  const toggleMenu   = () => setIsMenuOpen(v => !v);

  // ARCH-FIX-001: Direct router navigation — no modal layer.
  const handleWalletClick = () => {
    if (!isAuthenticated && onAuthRequired) { onAuthRequired(); return; }
    navigate('/wallet');
  };

  
  const branding        = (() => { try { return JSON.parse(localStorage.getItem('app_branding') || '{}'); } catch { return {}; } })();
  const cdnBase         = branding.cdnBaseUrl || '';
  // C-07 fix: normalise both sides to avoid double-slash when cdnBase ends with /
  const brandLogo       = branding.logo
    ? (branding.logo.startsWith('http')
        ? branding.logo
        : cdnBase.replace(/\/+$/, '') + '/' + branding.logo.replace(/^\/+/, ''))
    : '';
  const logoSrc         = brandLogo || '/app-assets/logo-header.png';
  // WL-003: recompute from source fields — never trust stored walletBalance (stale risk)
  const totalDisplay    = isAuthenticated ? ((user?.depositBalance ?? 0) + (user?.winningsBalance ?? 0)) : null;
  const depositDisplay  = user?.depositBalance  ?? 0;
  const winningsDisplay = user?.winningsBalance ?? 0;
  const lockedDisplay   = user?.lockedBalance   ?? 0;

  const handleNav = (item: any) => {
    if (item.requireAuth && !isAuthenticated && onAuthRequired) {
      setIsMenuOpen(false); onAuthRequired(); return;
    }
    if (item.path)   { navigate(item.path); setIsMenuOpen(false); }
    if (item.action) item.action();
  };

  return (
    <>
      {/* UX-2 fix (Phase D, 2026-07-10): sticky + flex-shrink-0 — on short
          viewports where the game column overflows and the page scrolls, the
          header used to scroll away ("header hides") or get squashed. */}
      <header className="h-[9%] min-h-[60px] flex-shrink-0 flex items-center justify-between px-4 bg-[#0B0E14]/90 backdrop-blur-md sticky top-0 z-50 border-b border-[#D4AF37]/15 shadow-lg">
        {/* Wallet pill — navigates directly to /wallet */}
        <div
          className="flex items-center gap-2 bg-[#121826] px-3 py-1.5 rounded-full border border-[#D4AF37]/30 cursor-pointer active:scale-95 transition-transform hover:border-[#D4AF37]/60 shadow-[0_0_10px_rgba(0,0,0,0.5)] relative"
          onClick={handleWalletClick}
          onDoubleClick={() => setShowBalanceDetail(v => !v)}
        >
          <div className="w-5 h-5 rounded-full bg-gradient-to-br from-[#F5C77A] to-[#D4AF37] flex items-center justify-center text-black border border-white/20 shadow-inner">
            <span className="font-black text-[10px] tracking-tighter">₹</span>
          </div>
          <span className="text-[#D4AF37] font-bold text-xs tracking-wide">
            {totalDisplay !== null ? `₹${totalDisplay.toLocaleString()}` : '---'}
          </span>
          {showBalanceDetail && isAuthenticated && (
            <div className="absolute top-full left-0 mt-2 bg-[#1A1F2E] border border-[#D4AF37]/30 rounded-xl p-3 w-52 z-50 shadow-xl" onClick={e => e.stopPropagation()}>
              <div className="text-[9px] text-slate-500 uppercase font-black mb-2 tracking-widest">Balance Breakdown</div>
              <div className="space-y-2">
                <div className="flex justify-between text-xs"><span className="text-slate-400">Deposit</span><span className="text-white font-bold">₹{depositDisplay.toLocaleString()}</span></div>
                <div className="flex justify-between text-xs"><span className="text-slate-400">Winnings</span><span className="text-[#25D366] font-bold">₹{winningsDisplay.toLocaleString()}</span></div>
                <div className="flex justify-between text-xs border-t border-white/10 pt-2"><span className="text-slate-400">In Play</span><span className="text-[#E53935] font-bold">₹{lockedDisplay.toLocaleString()}</span></div>
                <div className="flex justify-between text-xs border-t border-white/10 pt-2"><span className="text-[#D4AF37] font-black">Available</span><span className="text-[#D4AF37] font-black">₹{Math.max(0, (depositDisplay + winningsDisplay) - lockedDisplay).toLocaleString()}</span></div>
              </div>
              <button className="mt-2 w-full text-[9px] text-slate-500 hover:text-[#D4AF37]" onClick={() => setShowBalanceDetail(false)}>close ✕</button>
            </div>
          )}
        </div>

        {/* Center logo */}
        <div className="absolute left-1/2 transform -translate-x-1/2 flex items-center justify-center cursor-pointer select-none" style={{ width: 'calc(100% - 180px)', maxWidth: '340px' }} onClick={() => navigate('/')}>
          {!logoFailed
            ? <img src={logoSrc} alt="Betting Bazaar" style={{ height: '48px', width: '100%', objectFit: 'contain', objectPosition: 'center' }} onError={() => setLogoFailed(true)} />
            : <span className="text-[#D4AF37] font-black text-sm tracking-widest uppercase" style={{ textShadow: '0 0 14px rgba(212,175,55,0.7)' }}>BB</span>
          }
        </div>

        {/* Hamburger */}
        <button onClick={toggleMenu} className="w-10 h-10 flex items-center justify-center text-[#EAEAEA] hover:text-[#D4AF37] transition-colors">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            {isMenuOpen
              ? <><line x1="5" y1="5" x2="19" y2="19"/><line x1="19" y1="5" x2="5" y2="19"/></>
              : <><line x1="4" y1="7" x2="20" y2="7"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="17" x2="20" y2="17"/></>
            }
          </svg>
        </button>
      </header>

      {/* Overlay */}
      {isMenuOpen && <div className="fixed inset-0 bg-black/70 z-40 backdrop-blur-sm" onClick={toggleMenu} />}

      {/* Slide-in drawer */}
      <div className={`fixed top-0 right-0 h-full z-50 flex flex-col transition-transform duration-300 ease-out ${isMenuOpen ? 'translate-x-0' : 'translate-x-full'}`}
           style={{ width: 'min(85vw, 320px)', background: 'linear-gradient(180deg, #0D1120 0%, #0B0E17 100%)', borderLeft: '1px solid rgba(212,175,55,0.2)' }}>

        {/* Drawer header */}
        <div style={{ background: 'linear-gradient(135deg, #12192b 0%, #0d1120 61.8%)', borderBottom: '1px solid rgba(212,175,55,0.15)' }} className="px-6 py-5 flex items-center justify-between flex-shrink-0">
          <div>
            <div className="text-[#D4AF37] font-black text-base tracking-widest uppercase" style={{ letterSpacing: '0.2em' }}>Menu</div>
            {isAuthenticated && user && (
              <div className="text-[10px] text-slate-500 mt-0.5 font-medium">@{user.username || 'Player'}</div>
            )}
          </div>
          <button onClick={toggleMenu} className="w-8 h-8 rounded-full bg-white/5 hover:bg-white/10 flex items-center justify-center text-slate-400 hover:text-white transition-all text-xs">✕</button>
        </div>

        {/* Golden divider */}
        <div style={{ height: '2px', background: 'linear-gradient(90deg, transparent 0%, #D4AF37 38.2%, #F5C77A 61.8%, transparent 100%)' }} />

        {/* Nav sections */}
        <nav className="flex-1 overflow-y-auto py-3" style={{ scrollbarWidth: 'none' }}>
          {menuSections.map((section, si) => (
            <div key={si} className="mb-1">
              <div className="px-5 py-2 flex items-center gap-2">
                <span className="text-[9px] font-black tracking-[0.18em] text-[#D4AF37]/50 uppercase">{section.title}</span>
                <div className="flex-1 h-px" style={{ background: 'linear-gradient(90deg, rgba(212,175,55,0.25) 0%, transparent 100%)' }} />
              </div>
              {section.items.map((item, ii) => {
                const locked = item.requireAuth && !isAuthenticated;
                return (
                  <button key={ii} onClick={() => handleNav(item)}
                    className="w-full flex items-center gap-3 px-5 py-2.5 text-left group transition-all hover:bg-white/[0.04] active:bg-white/[0.07]"
                    style={{ borderLeft: '2px solid transparent' }}
                    onMouseEnter={e => (e.currentTarget.style.borderLeftColor = 'rgba(212,175,55,0.5)')}
                    onMouseLeave={e => (e.currentTarget.style.borderLeftColor = 'transparent')}
                  >
                    <span className="w-7 h-7 rounded-lg flex items-center justify-center text-sm flex-shrink-0"
                          style={{ background: 'rgba(212,175,55,0.08)', border: '1px solid rgba(212,175,55,0.12)' }}>
                      {item.icon}
                    </span>
                    <span className={`text-sm font-medium flex-1 ${locked ? 'text-slate-500' : 'text-slate-200 group-hover:text-white'}`}>
                      {item.label}
                    </span>
                    <span className="text-[10px] text-slate-600 group-hover:text-[#D4AF37] transition-colors">
                      {locked ? '🔒' : '›'}
                    </span>
                  </button>
                );
              })}
            </div>
          ))}

          {/* Share CTA */}
          <div className="px-4 pt-2 pb-3">
            <button onClick={() => { setIsShareOpen(true); setIsMenuOpen(false); }}
              className="w-full py-3 rounded-xl text-sm font-bold text-black transition-all active:scale-95"
              style={{ background: 'linear-gradient(135deg, #F5C77A 0%, #D4AF37 61.8%, #B8860B 100%)', boxShadow: '0 4px 20px rgba(212,175,55,0.3)' }}>
              📲 Download & Share
            </button>
          </div>
        </nav>

        {/* Golden divider */}
        <div style={{ height: '1px', background: 'linear-gradient(90deg, transparent 0%, #D4AF37 38.2%, #F5C77A 61.8%, transparent 100%)' }} />

        {/* Auth footer */}
        <div className="px-4 py-4 flex-shrink-0" style={{ background: 'rgba(10,12,20,0.8)' }}>
          {!isAuthenticated ? (
            <div className="grid grid-cols-2 gap-2">
              <button onClick={openAuth} className="py-2.5 rounded-xl text-sm font-bold text-black transition-all active:scale-95"
                style={{ background: 'linear-gradient(135deg, #F5C77A 0%, #D4AF37 100%)' }}>
                Sign In
              </button>
              <button onClick={openRegister} className="py-2.5 rounded-xl text-sm font-bold transition-all active:scale-95"
                style={{ border: '1px solid rgba(212,175,55,0.4)', color: '#D4AF37', background: 'rgba(212,175,55,0.06)' }}>
                Register
              </button>
            </div>
          ) : (
            <button onClick={handleLogout} className="w-full py-2.5 rounded-xl text-sm font-bold text-red-400 transition-all active:scale-95"
              style={{ border: '1px solid rgba(239,68,68,0.3)', background: 'rgba(239,68,68,0.05)' }}>
              🚪 Sign Out
            </button>
          )}
          <div className="text-[9px] text-slate-700 text-center mt-2 tracking-widest">BETTING BAZAAR v5.1</div>
        </div>
      </div>

      {isShareOpen  && <ShareModal  onClose={() => setIsShareOpen(false)} />}
      {isAuthOpen   && <AuthModal   onClose={() => setIsAuthOpen(false)} initialMode={isAuthMode} />}
    </>
  );
};

export default Header;
