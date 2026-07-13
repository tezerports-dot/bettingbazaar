// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * App.tsx
 *
 * L-03 fix: version comment removed — version literals in source files are forbidden.
 * GOVERNANCE: version is defined in package.json only, exposed via VITE_APP_VERSION.
 *
 * ARCH-FIX-002: Activate 3D Glassmorphism SceneBackground.
 *   - SceneBackground is injected directly into the Layout wrapper so it
 *     underlies every route. pointer-events:none — never intercepts clicks.
 *   - prefers-reduced-motion → SceneBackground auto-degrades to CSS gradient.
 *
 * ARCH-FIX-003: Dead route purge.
 *   - /winners route and WinnersPage import fully eliminated.
 *   - ResultsPage retained (it's a live, functioning page).
 *
 * All other routes, guards, and providers unchanged from v4.3.0.
 */
// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
import React, { Suspense, useEffect, useState } from 'react';
import { Routes, Route, Navigate, useLocation } from 'react-router';
import { HashRouter } from 'react-router-dom';
import { motion, MotionConfig } from 'framer-motion';
import { GameProvider } from './services/GameContext';
import { ToastProvider } from './components/ui/Toast';
import GamePage    from './pages/GamePage';
import { GameProviderProvider } from './services/GameProviderContext';
import ProfilePage from './pages/ProfilePage';
import HistoryPage from './pages/HistoryPage';
// WinnersPage RESTORED — live data now served by /api/v1/winners + leaderboard APIs
// (import is already present below or will be added)
import ResultsPage from './pages/ResultsPage';
import PromoPage   from './pages/PromoPage';
import RulesPage   from './pages/RulesPage';
import FaqPage     from './pages/FaqPage';
import MyBetsPage  from './pages/MyBetsPage';
import SupportPage from './pages/SupportPage';
// ── 3D BACKGROUND — lazy + capability-gated (perf 2026-07-11) ────────────────
// The WebGL scene pulls an ~832 KB three.js chunk and runs continuous GPU work
// behind every page. It is now LAZY (chunk fetched only if actually rendered)
// and only mounts on capable devices (desktop, fine pointer, enough memory, no
// reduced-motion). Phones — the mobile-first majority — get a cheap CSS gradient
// and never download three.js. Biggest single perceived-perf win.
const SceneBackground = React.lazy(() => import('./components/SceneBackground'));

function canRenderHeavyBackground(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  try {
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const finePointer = window.matchMedia('(pointer: fine)').matches;
    const wide = window.matchMedia('(min-width: 1024px)').matches;
    const mem = (navigator as any).deviceMemory;           // undefined on some browsers
    const enoughMem = mem === undefined || mem >= 4;
    return !reduced && finePointer && wide && enoughMem;
  } catch { return false; }
}

// Cheap static backdrop that always renders (no WebGL, no per-frame cost).
const BACKDROP_GRADIENT =
  'radial-gradient(1200px 600px at 50% -10%, rgba(212,175,55,0.06), transparent 60%),' +
  'radial-gradient(900px 500px at 100% 100%, rgba(30,136,229,0.05), transparent 55%),' +
  'linear-gradient(180deg, #0B0E14 0%, #090C12 100%)';
// ── LAZY GAME SECTIONS ────────────────────────────────────────────────────────
const CasinoPage          = React.lazy(() => import('./pages/CasinoPage'));
const CrashPage           = React.lazy(() => import('./pages/CrashPage'));
const SportsPage          = React.lazy(() => import('./pages/SportsPage'));
const WinnersPage         = React.lazy(() => import('./pages/WinnersPage'));
const WalletPage          = React.lazy(() => import('./pages/WalletPage'));
const InvitePage          = React.lazy(() => import('./pages/InvitePage'));
const VIPPage             = React.lazy(() => import('./pages/VIPPage'));
const GiftCodePage        = React.lazy(() => import('./pages/GiftCodePage'));
const PublicChatPage      = React.lazy(() => Promise.resolve({ default: () => null }));
const AccountRecoveryPage = React.lazy(() => import('./pages/AccountRecoveryPage'));
import ErrorBoundary from './components/ui/ErrorBoundary';
import Header from './components/Layout/Header';
import GameCategoryStrip from './components/Game/GameCategoryStrip';
import Footer from './components/Layout/Footer';
import MerchantApp from './MerchantApp';
import { getBackend } from './services/backend.service';
const APP_VERSION = import.meta.env.VITE_APP_VERSION ?? '0.0.0';

const backend = getBackend();

/**
 * Layout — root shell.
 * SceneBackground is fixed-position, z-index:-10, pointer-events:none.
 * It sits OUTSIDE all route children so it persists across every navigation.
 * The inner div holds all routed content above the 3D layer.
 */
const Layout: React.FC<React.PropsWithChildren<{}>> = ({ children }) => {
  // Decide once on the client whether this device can afford the WebGL scene.
  // Starts false so the three.js chunk is never fetched on mobile.
  const [heavyBg, setHeavyBg] = useState(false);
  useEffect(() => { setHeavyBg(canRenderHeavyBackground()); }, []);
  return (
    <div
      className="w-full h-[100dvh] text-white relative font-inter overflow-hidden"
      style={{ background: BACKDROP_GRADIENT }}
    >
      {/* Heavy 3D background only on capable devices; lazy so mobile never loads it. */}
      {heavyBg && (
        <Suspense fallback={<PageSkeleton />}>
          <SceneBackground />
        </Suspense>
      )}
      {/* All route content lives above the background layer */}
      <div className="relative z-10 w-full h-full">
        {children}
      </div>
    </div>
  );
};

const MerchantRedirect = () => { React.  
  // GOVERNANCE §12: all panels subscribe to branding events and apply CSS vars.
  useEffect(() => {
    function applyBranding(b: any) {
      if (!b || typeof b !== 'object') return;
      if (b.primaryColor) document.documentElement.style.setProperty('--brand-primary', b.primaryColor);
      if (b.secondaryColor) document.documentElement.style.setProperty('--brand-secondary', b.secondaryColor);
      if (b.accentColor) document.documentElement.style.setProperty('--brand-accent', b.accentColor);
      if (b.userPanelName) document.title = b.userPanelName;
      try { localStorage.setItem('app_branding', JSON.stringify(b)); } catch { /* ignore */ }
    }
    try {
      const cached = localStorage.getItem('app_branding');
      if (cached) applyBranding(JSON.parse(cached));
    } catch { /* ignore */ }
    // Import wsService lazily to avoid circular dependency
    import('./services/realBackend').then(({ default: backend }) => {
      (backend as any).on?.('branding', applyBranding);
      (backend as any).on?.('branding_updated', (d: any) => applyBranding(d?.branding ?? d));
    });
  }, []);

useEffect(() => { window.location.href = '/merchant'; }, []); return null; };

const AppShell: React.FC<{ children: React.ReactNode; isGame?: boolean }> = ({ children, isGame }) => {
  const [showAuth, setShowAuth] = useState(false);
  const location = useLocation();
  if (isGame) {
    // GamePage manages its own Header + CycleControl + Footer internally
    return <>{children}</>;
  }
  return (
    <div className="h-full flex flex-col">
      <Header onAuthRequired={() => setShowAuth(true)} />
      <GameCategoryStrip />
      {/* Quick opacity fade on navigation — compositor-only (no layout/transform),
          so it's smooth and cannot shift or clip page content. MotionConfig makes
          it collapse to instant under prefers-reduced-motion. */}
      <motion.div
        key={location.pathname}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.16, ease: 'easeOut' }}
        className="flex-1 overflow-y-auto min-h-0"
      >
        {children}
      </motion.div>
      <Footer />
    </div>
  );
};

// Lightweight skeleton shown while a lazy page chunk loads — matches the content
// region and pulses subtly, so navigation reads as "loading fast" instead of a
// blank flash or a spinner. Cheap (opacity pulse only).
const PageSkeleton: React.FC = () => (
  <div className="p-4 space-y-3 animate-pulse" aria-hidden="true">
    <div className="h-28 rounded-2xl bg-white/5" />
    <div className="grid grid-cols-2 gap-3">
      <div className="h-24 rounded-xl bg-white/5" />
      <div className="h-24 rounded-xl bg-white/5" />
      <div className="h-24 rounded-xl bg-white/5" />
      <div className="h-24 rounded-xl bg-white/5" />
    </div>
    <div className="h-4 w-1/3 rounded bg-white/5" />
    <div className="h-4 w-2/3 rounded bg-white/5" />
  </div>
);

const LoadingScreen = () => (
  <div className="flex flex-col items-center justify-center h-full bg-[#0B0E14] text-[#D4AF37]">
    <img
      src="/app-assets/logo.png"
      alt="Betting Bazaar"
      className="h-44 w-auto object-contain mb-6"
      onError={(e) => { (e.target as HTMLImageElement).src = '/logo.png'; }}
      style={{ filter: 'drop-shadow(0 4px 24px rgba(212,175,55,0.45))' }}
    />
    <div className="w-10 h-10 border-4 border-[#D4AF37]/20 border-t-[#D4AF37] rounded-full animate-spin mb-4" />
    <div className="text-[10px] font-black tracking-[0.3em] uppercase opacity-70">Synchronizing...</div>
  </div>
);

const MaintenanceScreen = ({ message }: { message?: string }) => (
  <div className="flex flex-col items-center justify-center h-full bg-[#0B0E14] p-8 text-center">
    <div className="w-24 h-24 bg-orange-500/10 rounded-full flex items-center justify-center text-5xl mb-6 border border-orange-500/20">🛠️</div>
    <h1 className="text-2xl font-black text-white uppercase tracking-tight mb-2">Under Maintenance</h1>
    <p className="text-slate-400 text-sm mb-8 leading-relaxed max-w-xs mx-auto">
      {message || "We're currently fine-tuning the marketplace. Please check back in a few minutes."}
    </p>
    <div className="text-[10px] text-slate-600 uppercase font-bold tracking-widest">System Stability Update</div>
  </div>
);

const UpdateRequiredScreen = ({ latest }: { latest: string }) => (
  <div className="flex flex-col items-center justify-center h-full bg-[#0B0E14] p-8 text-center">
    <img
      src="/app-assets/logo.png"
      alt="Betting Bazaar"
      className="h-40 w-auto object-contain mb-6"
      onError={(e) => { (e.target as HTMLImageElement).src = '/logo.png'; }}
      style={{ filter: 'drop-shadow(0 4px 24px rgba(212,175,55,0.4))' }}
    />
    <div className="w-20 h-20 bg-[#D4AF37]/10 rounded-3xl flex items-center justify-center text-4xl mb-6 border border-[#D4AF37]/20 animate-bounce">🚀</div>
    <h1 className="text-2xl font-black text-white uppercase tracking-tighter mb-2">Update Available</h1>
    <p className="text-slate-400 text-sm mb-8 leading-relaxed max-w-xs mx-auto">
      Version <span className="text-[#D4AF37] font-bold">{latest}</span> is ready with critical security patches.
    </p>
    <button
      onClick={() => {
        if ('serviceWorker' in navigator) {
          navigator.serviceWorker.getRegistrations().then(regs => {
            for (const reg of regs) reg.unregister();
            window.location.reload();
          });
        } else { window.location.reload(); }
      }}
      className="w-full max-w-xs bg-[#D4AF37] hover:bg-[#F5C77A] text-black font-black py-4 rounded-2xl shadow-xl transition-all active:scale-95"
    >
      UPDATE & RESTART
    </button>
  </div>
);

// ── SystemGuard ─────────────────────────────────────────────────────────────
const SystemGuard: React.FC<{ children: React.ReactElement }> = ({ children }) => {
  const [status, setStatus]         = useState<'OK' | 'OUTDATED' | 'MAINTENANCE' | 'LOADING'>('LOADING');
  const [latestVer, setLatestVer]   = useState('');
  const [maintenanceMsg, setMaintenanceMsg] = useState('');

  const compareVersions = (v1: string, v2: string) => {
    if (!v1 || !v2) return 0;
    const p1 = v1.split('.').map(Number);
    const p2 = v2.split('.').map(Number);
    for (let i = 0; i < 3; i++) {
      if ((p1[i] || 0) < (p2[i] || 0)) return -1;
      if ((p1[i] || 0) > (p2[i] || 0)) return 1;
    }
    return 0;
  };

  useEffect(() => {
    const applyConfig = (config: any) => {
      if (!config) { setStatus(prev => prev === 'LOADING' ? 'OK' : prev); return; }
      if (config.maintenanceMode && !window.location.hash.includes('admin')) {
        setMaintenanceMsg(config.maintenanceMessage || '');
        setStatus('MAINTENANCE');
        return;
      }
      const minRequired = config.minVersion || APP_VERSION;
      // §FIX: skip version gate when APP_VERSION is the '0.0.0' fallback —
      // VITE_APP_VERSION was not injected at build time (dev or unversioned deploy).
      // Never block the UI for an unversioned build.
      const isVersioned = APP_VERSION !== '0.0.0';
      if (isVersioned && compareVersions(APP_VERSION, minRequired) < 0) {
        setLatestVer(config.latestVersion || 'Unknown');
        setStatus('OUTDATED');
        return;
      }
      setStatus('OK');
    };

    const checkSystem = async () => {
      try {
        try {
          const branding = await (backend as any).getBranding?.();
          if (branding?.cdnBaseUrl) localStorage.setItem('app_branding', JSON.stringify(branding));
        } catch { /* non-critical */ }
        const config = await backend.getSystemConfig();
        applyConfig(config);
      } catch {
        setStatus(prev => prev === 'LOADING' ? 'OK' : prev);
      }
    };

    const socket = (backend as any).socket;
    if (socket) socket.on('system_config', applyConfig);

    checkSystem();
    // §FIX: hard 10s timeout — if socket is slow/offline, unblock the UI
    // rather than leaving a permanent LoadingScreen (dim wall) over all panels
    const loadingGuard = setTimeout(() => {
      setStatus(prev => prev === 'LOADING' ? 'OK' : prev);
    }, 10000);
    const interval = setInterval(checkSystem, 60000);
    return () => {
      clearTimeout(loadingGuard);
      clearInterval(interval);
      if (socket) socket.off('system_config', applyConfig);
    };
  }, []);

  if (status === 'LOADING')     return <LoadingScreen />;
  if (status === 'MAINTENANCE') return <MaintenanceScreen message={maintenanceMsg} />;
  if (status === 'OUTDATED')    return <UpdateRequiredScreen latest={latestVer} />;
  return children;
};

const App: React.FC = () => (
  <ErrorBoundary panel="user">
    <SystemGuard>
      <Suspense fallback={<LoadingScreen />}>
        <ToastProvider>
          <GameProvider>
            {/* FIX (2026-07-13): GameProviderProvider was imported but never
                mounted — every useGameProviders() consumer got the frozen
                default context (all sections disabled), so Casino/Crash pages
                always redirected home even with providers enabled. */}
            <GameProviderProvider>
            <MotionConfig reducedMotion="user">
            <HashRouter>
              <Layout>
                <ErrorBoundary panel="user">
                  <Routes>
                    {/* GamePage manages its own Header/CycleControl/Footer */}
                    <Route path="/"       element={<AppShell isGame><GamePage /></AppShell>} />
                    <Route path="/casino" element={<AppShell><Suspense fallback={<PageSkeleton />}><CasinoPage /></Suspense></AppShell>} />
                    <Route path="/crash"  element={<AppShell><Suspense fallback={<PageSkeleton />}><CrashPage /></Suspense></AppShell>} />
                    <Route path="/sports" element={<AppShell><Suspense fallback={<PageSkeleton />}><SportsPage /></Suspense></AppShell>} />

                    {/* Finance */}
                    <Route path="/wallet"    element={<AppShell><Suspense fallback={<PageSkeleton />}><WalletPage /></Suspense></AppShell>} />
                    <Route path="/invite"    element={<AppShell><Suspense fallback={<PageSkeleton />}><InvitePage /></Suspense></AppShell>} />
                    <Route path="/vip"       element={<AppShell><Suspense fallback={<PageSkeleton />}><VIPPage /></Suspense></AppShell>} />
                    <Route path="/gift-code" element={<AppShell><Suspense fallback={<PageSkeleton />}><GiftCodePage /></Suspense></AppShell>} />

                    {/* Community */}
                    <Route path="/chat"             element={<AppShell><Suspense fallback={<PageSkeleton />}>{}</Suspense></AppShell>} />
                    <Route path="/recover-account"  element={<AppShell><Suspense fallback={<PageSkeleton />}><AccountRecoveryPage /></Suspense></AppShell>} />

                    {/* Account */}
                    <Route path="/profile"  element={<AppShell><ProfilePage /></AppShell>} />
                    <Route path="/history"  element={<AppShell><HistoryPage /></AppShell>} />
                    <Route path="/my-bets"  element={<AppShell><MyBetsPage /></AppShell>} />

                    {/* Info */}
                    <Route path="/results"  element={<AppShell><ResultsPage /></AppShell>} />
                    <Route path="/promo"    element={<AppShell><PromoPage /></AppShell>} />
                    <Route path="/rules"    element={<AppShell><RulesPage /></AppShell>} />
                    <Route path="/faq"      element={<AppShell><FaqPage /></AppShell>} />
                    <Route path="/support"  element={<AppShell><SupportPage /></AppShell>} />

                    <Route path="/winners" element={<AppShell><Suspense fallback={<PageSkeleton />}><WinnersPage /></Suspense></AppShell>} />

                    {/* Panel redirects */}
                    <Route path="/merchant/*" element={<MerchantRedirect />} />

                    <Route path="*" element={<Navigate to="/" replace />} />
                  </Routes>
                </ErrorBoundary>
              </Layout>
            </HashRouter>
            </MotionConfig>
            </GameProviderProvider>
          </GameProvider>
        </ToastProvider>
      </Suspense>
    </SystemGuard>
  </ErrorBoundary>
);

export default App;
