// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
import React, { useEffect } from 'react';
import { Routes, Route, Navigate } from 'react-router';
import { AuthProvider, useAuth } from './services/AuthContext';
import { ThemeProvider } from './services/ThemeContext';
import sseService from './services/sse';
import LoginPage from './pages/LoginPage';
import Dashboard from './pages/Dashboard';
import OrderManagement from './pages/OrderManagement';
import TeamPage from './pages/TeamPage';
import HistoryViews from './pages/HistoryViews';
import ProfileSettings from './pages/ProfileSettings';
import PaymentAccountsPage from './pages/account/PaymentAccountsPage';
import SubMembersPage from './pages/account/SubMembersPage';
import PoolPage from './pages/account/PoolPage';
import ReportsPage from './pages/account/ReportsPage';
import FlagsPage from './pages/account/FlagsPage';
import { firstAccountTab } from './pages/account/accountTabs';
import Layout from './components/Layout';
import { Spinner } from './components/ui';
import { PlatformUnreachable } from './components/PlatformUnreachable';
import { useOrders } from './hooks/useOrders';
import { ROUTES } from './constants';

/**
 * ── "No profile" and "not signed in" are different facts ────────────────────
 * This guard read them as one: no `merchant`, go to the login form. A merchant
 * on a new device whose first profile call was refused — a 429 from the global
 * limiter, which every merchant behind one office NAT shares, or a 502 while
 * the gateway restarts — holds a perfectly VALID session and was shown the
 * sign-in screen. The obvious thing to do there is type your password, at a
 * platform that already knows who you are and is merely busy. S14.
 *
 * So the guard now asks which of the two it is. No token at all is a login. A
 * token with no profile behind it is the platform being unreachable, and says
 * so, with the one action that can help.
 */
const ProtectedRoute: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { merchant, loading, unreachable, refreshProfile } = useAuth();

  if (loading) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg)' }}>
        <Spinner size={34} />
      </div>
    );
  }

  if (!merchant && unreachable) return <PlatformUnreachable onRetry={refreshProfile} />;

  if (!merchant) return <Navigate to={ROUTES.LOGIN} replace />;
  return <>{children}</>;
};

/**
 * Shell — Layout plus the one number it needs from the queue (how many orders
 * want action), so the nav badge is live on every screen.
 */
const Shell: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { counts } = useOrders();
  return <Layout actionable={counts.actionable}>{children}</Layout>;
};

const RealtimeManager: React.FC = () => {
  const { merchant } = useAuth();

  // GOVERNANCE §12: every panel subscribes to branding events and applies the
  // CSS variables. --brand-primary feeds --brand in index.css, so the operator's
  // brand colour drives the whole panel when Branding sets one.
  useEffect(() => {
    function applyBranding(b: any) {
      if (!b || typeof b !== 'object') return;
      const root = document.documentElement;
      // The palette (owner, 2026-10-15). Under STAKE index.css declares the
      // colours, so the brand colours come OFF the root: inline would win.
      // A document without `palette` (the stream's 8 s placeholder, an old cache)
      // keeps the palette already on the page rather than flipping it to gold.
      const palette = typeof b.palette === 'string' && b.palette
        ? b.palette.toLowerCase()
        : (root.getAttribute('data-palette') || 'gold'); // schema default: GOLD
      root.setAttribute('data-palette', palette);
      if (palette !== 'gold') {
        for (const v of ['--brand-primary', '--brand-secondary', '--brand-accent']) root.style.removeProperty(v);
      } else {
        if (b.primaryColor) root.style.setProperty('--brand-primary', b.primaryColor);
        if (b.secondaryColor) root.style.setProperty('--brand-secondary', b.secondaryColor);
        if (b.accentColor) root.style.setProperty('--brand-accent', b.accentColor);
      }
      if (b.merchantPanelName) document.title = b.merchantPanelName;
      try { localStorage.setItem('app_branding', JSON.stringify({ ...b, palette: palette.toUpperCase() })); } catch { /* ignore */ }
    }
    try {
      const cached = localStorage.getItem('app_branding');
      if (cached) applyBranding(JSON.parse(cached));
    } catch { /* ignore */ }
    sseService.on('branding', applyBranding);
    sseService.on('branding_updated', (d: any) => applyBranding(d?.branding ?? d));
    return () => {
      sseService.off('branding', applyBranding);
      sseService.off('branding_updated', applyBranding);
    };
  }, []);

  useEffect(() => {
    if (!merchant) return undefined;
    sseService.connect();
    return () => sseService.disconnect();
  }, [merchant]);

  return null;
};

/** The Account entry itself: the first tab this person may open. */
const AccountHome: React.FC = () => {
  const { merchant } = useAuth();
  return <Navigate to={firstAccountTab(merchant)} replace />;
};

function AppRoutes() {
  return (
    <Routes>
      <Route path={ROUTES.LOGIN} element={<LoginPage />} />
      <Route path={ROUTES.DASHBOARD} element={<ProtectedRoute><Shell><Dashboard /></Shell></ProtectedRoute>} />
      <Route path={ROUTES.ORDERS} element={<ProtectedRoute><Shell><OrderManagement /></Shell></ProtectedRoute>} />
      <Route path={ROUTES.TEAM} element={<ProtectedRoute><Shell><TeamPage /></Shell></ProtectedRoute>} />
      <Route path={ROUTES.HISTORY} element={<ProtectedRoute><Shell><HistoryViews /></Shell></ProtectedRoute>} />
      <Route path={ROUTES.PROFILE} element={<ProtectedRoute><Shell><ProfileSettings /></Shell></ProtectedRoute>} />
      {/* A merchant account's screens (owner, 2026-10-11); each says so to a session it is not for. */}
      <Route path={ROUTES.ACCOUNT} element={<ProtectedRoute><AccountHome /></ProtectedRoute>} />
      <Route path={ROUTES.ACCOUNT_PAYMENT_ACCOUNTS} element={<ProtectedRoute><Shell><PaymentAccountsPage /></Shell></ProtectedRoute>} />
      <Route path={ROUTES.ACCOUNT_SUB_MEMBERS} element={<ProtectedRoute><Shell><SubMembersPage /></Shell></ProtectedRoute>} />
      <Route path={ROUTES.ACCOUNT_POOL} element={<ProtectedRoute><Shell><PoolPage /></Shell></ProtectedRoute>} />
      <Route path={ROUTES.ACCOUNT_REPORTS} element={<ProtectedRoute><Shell><ReportsPage /></Shell></ProtectedRoute>} />
      <Route path={ROUTES.ACCOUNT_FLAGS} element={<ProtectedRoute><Shell><FlagsPage /></Shell></ProtectedRoute>} />
      <Route path="*" element={<Navigate to={ROUTES.LOGIN} replace />} />
    </Routes>
  );
}

function App() {
  return (
    <ThemeProvider>
      <AuthProvider>
        <RealtimeManager />
        <AppRoutes />
      </AuthProvider>
    </ThemeProvider>
  );
}

export default App;
