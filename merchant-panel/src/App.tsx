// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
import React, { useEffect } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './services/AuthContext';
import sseService from './services/sse';
import LoginPage from './pages/LoginPage';
import Dashboard from './pages/Dashboard';
import OrderManagement from './pages/OrderManagement';
import HistoryViews from './pages/HistoryViews';
import ProfileSettings from './pages/ProfileSettings';
// BulkPayouts removed — withdrawals are now instant per-order, not batch (Section 4B)
import Layout from './components/Layout';

const ProtectedRoute: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { merchant, loading } = useAuth();

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary-600"></div>
      </div>
    );
  }

  if (!merchant) {
    return <Navigate to="/" replace />;
  }

  return <>{children}</>;
};

const WebSocketManager: React.FC = () => {
  const { merchant } = useAuth();

  
  // GOVERNANCE §12: all panels subscribe to branding events and apply CSS vars.
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
    if (merchant) {
      sseService.connect();
      sseService.connect();
    }
    return () => {
      sseService.disconnect();
      sseService.disconnect();
    };
  }, [merchant]);

  return null;
};

function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<LoginPage />} />
      <Route
        path="/dashboard"
        element={
          <ProtectedRoute>
            <Layout>
              <Dashboard />
            </Layout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/orders"
        element={
          <ProtectedRoute>
            <Layout>
              <OrderManagement />
            </Layout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/history"
        element={
          <ProtectedRoute>
            <Layout>
              <HistoryViews />
            </Layout>
          </ProtectedRoute>
        }
      />
      {/* /bulk-payouts route removed — withdrawals are instant per-order (Section 4B) */}
      <Route
        path="/profile"
        element={
          <ProtectedRoute>
            <Layout>
              <ProfileSettings />
            </Layout>
          </ProtectedRoute>
        }
      />
      {/* PUBLIC: user opens this URL from their wallet — no merchant login needed */}
      
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

function App() {
  return (
    <AuthProvider>
      <WebSocketManager />
      <AppRoutes />
    </AuthProvider>
  );
}

export default App;
