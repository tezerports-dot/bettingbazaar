// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
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
import SignInFirst from './redesign/SignInFirst';
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
import PromoCardPage from './pages/PromoCardPage';
import RulesPage   from './pages/RulesPage';
import FaqPage     from './pages/FaqPage';
import MyBetsPage  from './pages/MyBetsPage';
import SupportPage from './pages/SupportPage';
import TelegramTicketPage from './pages/TelegramTicketPage';
import { recoveringLoader } from './services/chunkRecovery';

// ── LAZY GAME SECTIONS ────────────────────────────────────────────────────────
// Each loader is kept so the chunks can be fetched while the phone is idle
// after the first screen: otherwise the first tap on Wallet or Casino waited
// on the network behind a skeleton, which read as a laggy button.
// A loader whose chunk a deploy has replaced reloads for the new build
// (`recoveringLoader`, services/chunkRecovery.ts) instead of an error screen.
const LAZY_PAGES = {
  casino:      recoveringLoader(() => import('./pages/CasinoPage')),
  crash:       recoveringLoader(() => import('./pages/CrashPage')),
  sports:      recoveringLoader(() => import('./pages/SportsPage')),
  cricket:     recoveringLoader(() => import('./pages/CricketPage')),
  winners:     recoveringLoader(() => import('./pages/WinnersPage')),
  leaderboard: recoveringLoader(() => import('./pages/LeaderboardPage')),
  wallet:      recoveringLoader(() => import('./pages/WalletPage')),
  referral:    recoveringLoader(() => import('./pages/ReferralPage')),
};
const CasinoPage          = React.lazy(LAZY_PAGES.casino);
const CrashPage           = React.lazy(LAZY_PAGES.crash);
const SportsPage          = React.lazy(LAZY_PAGES.sports);
const CricketPage         = React.lazy(LAZY_PAGES.cricket);
const WinnersPage         = React.lazy(LAZY_PAGES.winners);
const LeaderboardPage     = React.lazy(LAZY_PAGES.leaderboard);
const WalletPage          = React.lazy(LAZY_PAGES.wallet);
const ReferralPage        = React.lazy(LAZY_PAGES.referral);
const preloadLazyPages = () => {
  const run = () => { Object.values(LAZY_PAGES).forEach((load) => { void load().catch(() => { /* fetched again on the tap */ }); }); };
  if (typeof window.requestIdleCallback === 'function') window.requestIdleCallback(run, { timeout: 4000 });
  else window.setTimeout(run, 1500);
};
import ErrorBoundary from './components/ui/ErrorBoundary';
import { applyBranding, applyCachedBranding } from './services/branding';
import { getBackend } from './services/backend.service';
import { platform } from './services/api';
import { startAppUpdate, webBundleOutdated } from './services/appUpdate';
import { brandLogo, fallBackToMark, uploadedAsset, useHeaderLogo } from './services/brandAssets';
import NativeUpdateGate from './components/NativeUpdateGate';
import { RejectedBuyPopup } from './components/DisputeWindow';
import { isNativeShell } from './services/nativeLifecycle';
import { bootstrapApiEndpoint, endpointState } from './services/originFailover';
import { refreshTelegramEntry, rememberedTelegramEntries } from './services/telegramEntry';
const APP_VERSION = import.meta.env.VITE_APP_VERSION ?? '0.0.0';

const backend = getBackend();

const MerchantRedirect = () => {
  // GOVERNANCE §12: all panels subscribe to branding events and apply CSS vars.
  useEffect(() => {
    applyCachedBranding();
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
    <div className="h-4 w-1/3 rounded-sm" style={{ background: 'var(--skel)' }} />
    <div className="h-4 w-2/3 rounded-sm" style={{ background: 'var(--skel)' }} />
  </div>
);

/**
 * The first thing the app draws after the native splash hides — so it is the
 * splash an operator controls. It covers the whole screen (fixed, not the
 * height of whatever holds it, which left it cut off half way; owner,
 * 2026-10-20) with the header's own wordmark (`useHeaderLogo`: the bundled
 * artwork at once, the uploaded `logo-header.png` once loaded) over the brand
 * glow. The admin's App Assets `splash.png`, when one is uploaded, fades in
 * over it full-bleed. An image that is not there simply never appears.
 */
const LoadingScreen = () => {
  const [splashShown, setSplashShown] = useState(false);
  const logo = useHeaderLogo();
  return (
    <div role="status" aria-label="Loading" className="fixed inset-0 z-9000 flex flex-col items-center justify-center overflow-hidden"
      style={{ background: 'var(--app-bg, #0A0E17)', color: 'var(--text)', minHeight: '100dvh', padding: 'env(safe-area-inset-top) 24px env(safe-area-inset-bottom)' }}>
      <div aria-hidden className="absolute inset-0 pointer-events-none"
        style={{ background: 'radial-gradient(70% 45% at 50% 42%, rgba(var(--brand-primary-rgb), 0.22), transparent 70%)' }} />
      <img
        src={logo}
        alt="Betting Bazaar"
        className="relative w-auto object-contain bb-rise"
        style={{ width: 'min(78vw, 360px)', maxHeight: '22vh', filter: 'drop-shadow(0 6px 28px rgba(var(--brand-primary-rgb), 0.45))' }}
      />
      <img
        src={uploadedAsset('splash.png')}
        alt=""
        aria-hidden="true"
        onLoad={() => setSplashShown(true)}
        onError={(e) => { e.currentTarget.style.display = 'none'; }}
        className="absolute inset-0 w-full h-full object-cover"
        style={{ opacity: splashShown ? 1 : 0, transition: 'opacity 0.25s' }}
      />
      <div aria-hidden className="relative mt-10 w-40 h-1 rounded-full overflow-hidden" style={{ background: 'rgba(var(--brand-primary-rgb), 0.18)' }}>
        <div className="h-full w-1/3 rounded-full bb-splash-bar" style={{ background: 'var(--gold-metal, var(--brand-primary, #D4AF37))' }} />
      </div>
    </div>
  );
};

// A maintenance tester signing in while maintenance is on (owner, 2026-10-20):
// remembered for the tab so the sign-in screen stays reachable. The server
// decides who is a tester; anyone else is sent back here by their first request.
const TESTER_SIGN_IN_KEY = 'bb_maintenance_sign_in';
const testerSigningIn = (): boolean => { try { return sessionStorage.getItem(TESTER_SIGN_IN_KEY) === '1'; } catch { return false; } };
const setTesterSigningIn = (on: boolean) => {
  try { if (on) sessionStorage.setItem(TESTER_SIGN_IN_KEY, '1'); else sessionStorage.removeItem(TESTER_SIGN_IN_KEY); } catch { /* storage blocked */ }
};

const MaintenanceScreen = ({ message, onTesterSignIn }: { message?: string; onTesterSignIn: () => void }) => (
  <div className="flex flex-col items-center justify-center h-full p-8 text-center" style={{ background: 'var(--app-bg, #0A0E17)', color: 'var(--text)' }}>
    <div className="w-24 h-24 bg-orange-500/10 rounded-full flex items-center justify-center text-5xl mb-6 border border-orange-500/20">🛠️</div>
    <h1 className="text-2xl font-black uppercase tracking-tight mb-2">Under Maintenance</h1>
    <p className="text-sm mb-8 leading-relaxed max-w-xs mx-auto" style={{ color: 'var(--text2)' }}>
      {message || "We're currently fine-tuning the marketplace. Please check back in a few minutes."}
    </p>
    <div className="text-[10px] uppercase font-bold tracking-widest" style={{ color: 'var(--text3)' }}>System Stability Update</div>
    {!platform.hasStoredSession() && (
      <button type="button" onClick={onTesterSignIn} className="mt-10 text-[11px] underline" style={{ color: 'var(--text3)' }}>
        Testing team sign in
      </button>
    )}
  </div>
);

const UpdateRequiredScreen = ({ latest }: { latest: string }) => (
  <div className="flex flex-col items-center justify-center h-full p-8 text-center" style={{ background: 'var(--app-bg, #0A0E17)', color: 'var(--text)' }}>
    <img
      src={brandLogo('logo.png')}
      alt="Betting Bazaar"
      className="h-40 w-auto object-contain mb-6"
      onError={fallBackToMark}
      style={{ filter: 'drop-shadow(0 4px 24px rgba(var(--brand-primary-rgb), 0.4))' }}
    />
    <div className="w-20 h-20 bg-[var(--brand-primary, #D4AF37)]/10 rounded-3xl flex items-center justify-center text-4xl mb-6 border border-[var(--brand-primary, #D4AF37)]/20 animate-bounce">🚀</div>
    <h1 className="text-2xl font-black uppercase tracking-tighter mb-2">Update Available</h1>
    <p className="text-sm mb-8 leading-relaxed max-w-xs mx-auto" style={{ color: 'var(--text2)' }}>
      Version <span className="text-[var(--brand-primary, #D4AF37)] font-bold">{latest}</span> is ready with critical security patches.
    </p>
    {/* Web only: the APK's updates are NativeUpdateGate's (services/appUpdate.ts). */}
    <button
      onClick={startAppUpdate}
      className="w-full max-w-xs bg-[var(--brand-primary, #D4AF37)] hover:bg-[var(--brand-accent, #F5C77A)] text-black font-black py-4 rounded-2xl shadow-xl transition-all active:scale-95"
    >
      UPDATE & RESTART
    </button>
  </div>
);

/**
 * Nothing trusted answered: the discovery service and every configured origin
 * failed. Say so and offer a retry — never connect somewhere unvalidated.
 */
const ConnectionErrorScreen = ({ onRetry, retrying }: { onRetry: () => void; retrying: boolean }) => {
  // Telegram's addresses, remembered from the last time we connected: they open
  // the app's way in even when every address of ours is blocked. The first is
  // the bot in use; the rest are standby bots, for when Telegram banned it.
  const [telegram, ...backups] = rememberedTelegramEntries();
  return (
  <div role="alert" className="flex flex-col items-center justify-center h-full p-8 text-center" style={{ background: 'var(--app-bg, #0A0E17)', color: 'var(--text)' }}>
    <img
      src={brandLogo('logo.png')}
      alt="Betting Bazaar"
      className="h-32 w-auto object-contain mb-6"
      onError={fallBackToMark}
    />
    <h1 className="text-2xl font-black uppercase tracking-tight mb-2">Can't connect</h1>
    <p className="text-sm mb-8 leading-relaxed max-w-xs mx-auto" style={{ color: 'var(--text2)' }}>
      We couldn't reach the Betting Bazaar servers. Check your internet connection and try again.
    </p>
    <button
      onClick={onRetry}
      disabled={retrying}
      className="w-full max-w-xs bg-[var(--brand-primary, #D4AF37)] text-black font-black py-4 rounded-2xl shadow-xl transition-all active:scale-95 disabled:opacity-60"
    >
      {retrying ? 'CONNECTING…' : 'TRY AGAIN'}
    </button>
    {telegram && (
      <p className="text-xs mt-6 leading-relaxed max-w-xs mx-auto" style={{ color: 'var(--text2)' }}>
        Still not connecting? This Telegram link always opens Betting Bazaar:{' '}
        <a href={telegram} target="_blank" rel="noopener noreferrer" className="font-bold underline" style={{ color: 'var(--brand-primary, #D4AF37)' }}>
          Open in Telegram
        </a>
        {backups.length > 0 && (
          <>
            <br />
            If that link doesn't open, try a backup:{' '}
            {backups.map((url, i) => (
              <React.Fragment key={url}>
                {i > 0 && ' · '}
                <a href={url} target="_blank" rel="noopener noreferrer" className="font-bold underline" style={{ color: 'var(--brand-primary, #D4AF37)' }}>
                  Backup {i + 1}
                </a>
              </React.Fragment>
            ))}
          </>
        )}
      </p>
    )}
  </div>
  );
};

// ── EndpointGate ─────────────────────────────────────────────────────────────
// Step one of the startup order (services/originFailover.ts): discover and
// validate the API origin while the LoadingScreen shows. Nothing below mounts
// — no API call, no session check, no socket — until it has.
const EndpointGate: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [phase, setPhase] = useState<'resolving' | 'ready' | 'failed'>(
    endpointState() === 'ready' ? 'ready' : 'resolving');
  const [retrying, setRetrying] = useState(false);

  const attempt = React.useCallback(async () => {
    setRetrying(true);
    const origin = await bootstrapApiEndpoint();
    // Learn (or refresh) the Telegram link the "Can't connect" screen offers next time.
    if (origin !== null) void refreshTelegramEntry();
    setRetrying(false);
    setPhase(origin === null ? 'failed' : 'ready');
  }, []);

  useEffect(() => { if (phase === 'resolving') void attempt(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (phase === 'ready') return <>{children}</>;
  if (phase === 'failed') return <ConnectionErrorScreen onRetry={attempt} retrying={retrying} />;
  return <LoadingScreen />;
};

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
        // Signed out: the maintenance screen, unless a tester is signing in.
        if (!platform.hasStoredSession()) { setStatus(testerSigningIn() ? 'OK' : 'MAINTENANCE'); return; }
        // Signed in: the server says whether this account is a tester.
        void platform.maintenancePass().then((pass) => setStatus(pass ? 'OK' : 'MAINTENANCE'));
        return;
      }
      setTesterSigningIn(false);
      const minRequired = config.minVersion || APP_VERSION;
      if (webBundleOutdated(APP_VERSION, minRequired, isNativeShell(), compareVersions)) {
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
          // The stream's opening `branding` payload, through the ONE applier
          // (§13), which also caches it. It used to be written to the cache
          // here and never applied, so colours and palette waited for a save.
          // The 8 s placeholder `getBranding` falls back to carries no
          // `palette`; the server's payload always does (brandingPayload.js).
          if (typeof branding?.palette === 'string') applyBranding(branding);
        } catch { /* non-critical */ }
        const config = await backend.getSystemConfig();
        applyConfig(config);
      } catch {
        setStatus(prev => prev === 'LOADING' ? 'OK' : prev);
      }
    };

    // Live config (maintenance, versions) arrives on the stream on every admin save.
    const stream = (backend as any).sseBridge as EventTarget | undefined;
    const onConfig = (e: Event) => applyConfig((e as any).data);
    stream?.addEventListener('system_config', onConfig);
    // Any request the server refused for maintenance (apiClient).
    const onMaintenance = (e: Event) => {
      setTesterSigningIn(false);
      const said = (e as CustomEvent<{ message?: string }>).detail?.message;
      if (said) setMaintenanceMsg(said);
      setStatus('MAINTENANCE');
    };
    window.addEventListener(platform.MAINTENANCE_EVENT, onMaintenance);

    checkSystem();
    const loadingGuard = setTimeout(() => {
      setStatus(prev => prev === 'LOADING' ? 'OK' : prev);
    }, 10000);
    const interval = setInterval(checkSystem, 60000);
    return () => {
      clearTimeout(loadingGuard);
      clearInterval(interval);
      stream?.removeEventListener('system_config', onConfig);
      window.removeEventListener(platform.MAINTENANCE_EVENT, onMaintenance);
    };
  }, []);

  const ready = status === 'OK';
  useEffect(() => { if (ready) preloadLazyPages(); }, [ready]);

  if (status === 'LOADING')     return <LoadingScreen />;
  if (status === 'MAINTENANCE') {
    return <MaintenanceScreen message={maintenanceMsg} onTesterSignIn={() => { setTesterSigningIn(true); setStatus('OK'); }} />;
  }
  if (status === 'OUTDATED')    return <UpdateRequiredScreen latest={latestVer} />;
  return children;
};

const lazy = (node: React.ReactNode) => <Suspense fallback={<PageSkeleton />}>{node}</Suspense>;

const App: React.FC = () => (
  <ThemeProvider>
    <ErrorBoundary>
      <EndpointGate>
      {/* Outside SystemGuard on purpose: a required update must show even
          during maintenance or while the web gate is loading. */}
      <NativeUpdateGate />
      <SystemGuard>
        <Suspense fallback={<LoadingScreen />}>
          <ToastProvider>
            <GameProvider>
              <GameProviderProvider>
                <MotionConfig reducedMotion="user">
                  <HashRouter>
                    <RedesignShell>
                      {/* The pop-up when a member rejects a buy as unpaid,
                          wherever the player is in the app (2c+). */}
                      <RejectedBuyPopup />
                      <ErrorBoundary>
                        <Routes>
                          <Route path="/"                element={<GamePage />} />
                          <Route path="/casino"          element={lazy(<CasinoPage />)} />
                          <Route path="/crash"           element={lazy(<CrashPage />)} />
                          <Route path="/sports"          element={lazy(<SportsPage />)} />
                          <Route path="/cricket"         element={lazy(<CricketPage />)} />

                          {/* Finance */}
                          <Route path="/wallet"          element={<SignInFirst what="wallet">{lazy(<WalletPage />)}</SignInFirst>} />

                          {/* Referral earnings live HERE, not on the wallet:
                              only the disbursed part reaches the winnings
                              balance, and the rest is a promise. */}
                          <Route path="/referrals"       element={<SignInFirst what="referrals">{lazy(<ReferralPage />)}</SignInFirst>} />

                          {/* Account */}
                          <Route path="/profile"         element={<SignInFirst what="profile"><ProfilePage /></SignInFirst>} />
                          <Route path="/history"         element={<SignInFirst what="game history"><HistoryPage /></SignInFirst>} />
                          <Route path="/my-bets"         element={<SignInFirst what="bets"><MyBetsPage /></SignInFirst>} />

                          {/* Info */}
                          <Route path="/results"         element={<ResultsPage />} />
                          {/* Where Verify in the Mini App sends a player: the one-time ticket, exchanged. */}
                          <Route path="/tg/:ticket"      element={<TelegramTicketPage />} />
                          <Route path="/promo"           element={<PromoPage />} />
                          {/* A tapped home promo card: its image, details and optional link. */}
                          <Route path="/card/:promoId"   element={<PromoCardPage />} />
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
      </EndpointGate>
    </ErrorBoundary>
  </ThemeProvider>
);

export default App;
