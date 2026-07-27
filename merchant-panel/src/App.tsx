// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
import React, { useEffect } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './services/AuthContext';
import { ThemeProvider } from './services/ThemeContext';
import sseService from './services/sse';
import LoginPage from './pages/LoginPage';
import Dashboard from './pages/Dashboard';
import OrderManagement from './pages/OrderManagement';
import HistoryViews from './pages/HistoryViews';
import ProfileSettings from './pages/ProfileSettings';
import Layout from './components/Layout';
import { Spinner } from './components/ui';
import { useOrders } from './hooks/useOrders';
import { ROUTES } from './constants';

const ProtectedRoute: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { merchant, loading } = useAuth();

  if (loading) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg)' }}>
        <Spinner size={34} />
      </div>
    );
  }

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
      if (b.primaryColor) document.documentElement.style.setProperty('--brand-primary', b.primaryColor);
      if (b.secondaryColor) document.documentElement.style.setProperty('--brand-secondary', b.secondaryColor);
      if (b.accentColor) document.documentElement.style.setProperty('--brand-accent', b.accentColor);
      if (b.merchantPanelName) document.title = b.merchantPanelName;
      try { localStorage.setItem('app_branding', JSON.stringify(b)); } catch { /* ignore */ }
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

function AppRoutes() {
  return (
    <Routes>
      <Route path={ROUTES.LOGIN} element={<LoginPage />} />
      <Route path={ROUTES.DASHBOARD} element={<ProtectedRoute><Shell><Dashboard /></Shell></ProtectedRoute>} />
      <Route path={ROUTES.ORDERS} element={<ProtectedRoute><Shell><OrderManagement /></Shell></ProtectedRoute>} />
      <Route path={ROUTES.HISTORY} element={<ProtectedRoute><Shell><HistoryViews /></Shell></ProtectedRoute>} />
      <Route path={ROUTES.PROFILE} element={<ProtectedRoute><Shell><ProfileSettings /></Shell></ProtectedRoute>} />
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
