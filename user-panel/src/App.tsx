// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * App.tsx
 *
 * 2026 "Bazaar" redesign:
 *   - ThemeProvider (redesign/ThemeContext) wraps the whole app so `data-theme`
 *     (dark/light) is set on <html> before first paint.
 *   - RedesignShell (redesign/RedesignShell) is the single persistent shell —
 *     top bar, category strip, mobile bottom tabs, menu drawer, shared AuthModal.
 *     It wraps <Routes> once; each route now renders page CONTENT only (the old
 *     per-route AppShell / Header / Footer / GameCategoryStrip layer is gone).
 *   - The heavy WebGL SceneBackground is retired in favor of the redesign's CSS
 *     gradient background (--app-bg), matching the handoff prototype.
 *
 * All routes, guards, and providers are otherwise unchanged.
 */
import React, { Suspense, useEffect, useState } from 'react';
import { Routes, Route, Navigate } from 'react-router';
import { HashRouter } from 'react-router';
import { MotionConfig } from 'framer-motion';
import { ThemeProvider } from './redesign/ThemeContext';
import RedesignShell from './redesign/RedesignShell';
import { GameProvider } from './services/GameContext';
import { ToastProvider } from './components/ui/Toast';
import GamePage    from './pages/GamePage';
import { GameProviderProvider } from './services/GameProviderContext';
import ProfilePage from './pages/ProfilePage';
import HistoryPage from './pages/HistoryPage';
import ResultsPage from './pages/ResultsPage';
import PromoPage   from './pages/PromoPage';
import RulesPage   from './pages/RulesPage';
import FaqPage     from './pages/FaqPage';
import MyBetsPage  from './pages/MyBetsPage';
import SupportPage from './pages/SupportPage';

// ── LAZY GAME SECTIONS ────────────────────────────────────────────────────────
const CasinoPage          = React.lazy(() => import('./pages/CasinoPage'));
const CrashPage           = React.lazy(() => import('./pages/CrashPage'));
const SportsPage          = React.lazy(() => import('./pages/SportsPage'));
const WinnersPage         = React.lazy(() => import('./pages/WinnersPage'));
const LeaderboardPage     = React.lazy(() => import('./pages/LeaderboardPage'));
const WalletPage          = React.lazy(() => import('./pages/WalletPage'));
const InvitePage          = React.lazy(() => import('./pages/InvitePage'));
const VIPPage             = React.lazy(() => import('./pages/VIPPage'));
const GiftCodePage        = React.lazy(() => import('./pages/GiftCodePage'));
const AccountRecoveryPage = React.lazy(() => import('./pages/AccountRecoveryPage'));
import ErrorBoundary from './components/ui/ErrorBoundary';
import { getBackend } from './services/backend.service';
const APP_VERSION = import.meta.env.VITE_APP_VERSION ?? '0.0.0';

const backend = getBackend();

const MerchantRedirect = () => {
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
    return backend.subscribeToBranding(applyBranding);
  }, []);

  useEffect(() => { window.location.href = '/merchant'; }, []); return null;
};

// Lightweight skeleton shown while a lazy page chunk loads.
const PageSkeleton: React.FC = () => (
  <div className="p-4 space-y-3 animate-pulse" aria-hidden="true" style={{ color: 'var(--text)' }}>
    <div className="h-28 rounded-2xl" style={{ background: 'var(--skel)' }} />
    <div className="grid grid-cols-2 gap-3">
      <div className="h-24 rounded-xl" style={{ background: 'var(--skel)' }} />
      <div className="h-24 rounded-xl" style={{ background: 'var(--skel)' }} />
      <div className="h-24 rounded-xl" style={{ background: 'var(--skel)' }} />
      <div className="h-24 rounded-xl" style={{ background: 'var(--skel)' }} />
    </div>
    <div className="h-4 w-1/3 rounded" style={{ background: 'var(--skel)' }} />
    <div className="h-4 w-2/3 rounded" style={{ background: 'var(--skel)' }} />
  </div>
);

const LoadingScreen = () => (
  <div className="flex flex-col items-center justify-center h-full text-[#D4AF37]" style={{ background: 'var(--app-bg, #0A0E17)' }}>
    <img
      src="/app-assets/logo.png"
      alt="Betting Bazaar"
      className="h-40 w-auto object-contain mb-6"
      onError={(e) => { (e.target as HTMLImageElement).src = '/logo.png'; }}
      style={{ filter: 'drop-shadow(0 4px 24px rgba(212,175,55,0.45))' }}
    />
    <div className="w-10 h-10 border-4 border-[#D4AF37]/20 border-t-[#D4AF37] rounded-full animate-spin mb-4" />
    <div className="text-[10px] font-black tracking-[0.3em] uppercase opacity-70">Synchronizing...</div>
  </div>
);

const MaintenanceScreen = ({ message }: { message?: string }) => (
  <div className="flex flex-col items-center justify-center h-full p-8 text-center" style={{ background: 'var(--app-bg, #0A0E17)', color: 'var(--text)' }}>
    <div className="w-24 h-24 bg-orange-500/10 rounded-full flex items-center justify-center text-5xl mb-6 border border-orange-500/20">🛠️</div>
    <h1 className="text-2xl font-black uppercase tracking-tight mb-2">Under Maintenance</h1>
    <p className="text-sm mb-8 leading-relaxed max-w-xs mx-auto" style={{ color: 'var(--text2)' }}>
      {message || "We're currently fine-tuning the marketplace. Please check back in a few minutes."}
    </p>
    <div className="text-[10px] uppercase font-bold tracking-widest" style={{ color: 'var(--text3)' }}>System Stability Update</div>
  </div>
);

const UpdateRequiredScreen = ({ latest }: { latest: string }) => (
  <div className="flex flex-col items-center justify-center h-full p-8 text-center" style={{ background: 'var(--app-bg, #0A0E17)', color: 'var(--text)' }}>
    <img
      src="/app-assets/logo.png"
      alt="Betting Bazaar"
      className="h-40 w-auto object-contain mb-6"
      onError={(e) => { (e.target as HTMLImageElement).src = '/logo.png'; }}
      style={{ filter: 'drop-shadow(0 4px 24px rgba(212,175,55,0.4))' }}
    />
    <div className="w-20 h-20 bg-[#D4AF37]/10 rounded-3xl flex items-center justify-center text-4xl mb-6 border border-[#D4AF37]/20 animate-bounce">🚀</div>
    <h1 className="text-2xl font-black uppercase tracking-tighter mb-2">Update Available</h1>
    <p className="text-sm mb-8 leading-relaxed max-w-xs mx-auto" style={{ color: 'var(--text2)' }}>
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

const lazy = (node: React.ReactNode) => <Suspense fallback={<PageSkeleton />}>{node}</Suspense>;

const App: React.FC = () => (
  <ThemeProvider>
    <ErrorBoundary panel="user">
      <SystemGuard>
        <Suspense fallback={<LoadingScreen />}>
          <ToastProvider>
            <GameProvider>
              <GameProviderProvider>
                <MotionConfig reducedMotion="user">
                  <HashRouter>
                    <RedesignShell>
                      <ErrorBoundary panel="user">
                        <Routes>
                          <Route path="/"                element={<GamePage />} />
                          <Route path="/casino"          element={lazy(<CasinoPage />)} />
                          <Route path="/crash"           element={lazy(<CrashPage />)} />
                          <Route path="/sports"          element={lazy(<SportsPage />)} />

                          {/* Finance */}
                          <Route path="/wallet"          element={lazy(<WalletPage />)} />
                          <Route path="/invite"          element={lazy(<InvitePage />)} />
                          <Route path="/vip"             element={lazy(<VIPPage />)} />
                          <Route path="/gift-code"       element={lazy(<GiftCodePage />)} />

                          {/* Community */}
                          <Route path="/recover-account" element={lazy(<AccountRecoveryPage />)} />

                          {/* Account */}
                          <Route path="/profile"         element={<ProfilePage />} />
                          <Route path="/history"         element={<HistoryPage />} />
                          <Route path="/my-bets"         element={<MyBetsPage />} />

                          {/* Info */}
                          <Route path="/results"         element={<ResultsPage />} />
                          <Route path="/promo"           element={<PromoPage />} />
                          <Route path="/rules"           element={<RulesPage />} />
                          <Route path="/faq"             element={<FaqPage />} />
                          <Route path="/support"         element={<SupportPage />} />

                          <Route path="/winners"         element={lazy(<WinnersPage />)} />
                          <Route path="/leaderboard"     element={lazy(<LeaderboardPage />)} />

                          {/* Panel redirects */}
                          <Route path="/merchant/*"      element={<MerchantRedirect />} />

                          <Route path="*" element={<Navigate to="/" replace />} />
                        </Routes>
                      </ErrorBoundary>
                    </RedesignShell>
                  </HashRouter>
                </MotionConfig>
              </GameProviderProvider>
            </GameProvider>
          </ToastProvider>
        </Suspense>
      </SystemGuard>
    </ErrorBoundary>
  </ThemeProvider>
);

export default App;
