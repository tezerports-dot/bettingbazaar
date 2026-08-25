// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
import React, { useEffect } from 'react';
import { HashRouter as Router, Routes, Route, Navigate } from 'react-router';
import { Toaster } from 'react-hot-toast';
import { Layout } from './components/Layout';
import { Login } from './Pages/Login';
import { Dashboard } from './Pages/Dashboard';
import { UsersList } from './Pages/Users/UsersList';
import { MerchantsList } from './Pages/Merchants/MerchantsList';
import { LiveCycles } from './Pages/Cycles/LiveCycles';
import { CycleHistory } from './Pages/Cycles/CycleHistory';
import { DepositPolicy } from './Pages/BusinessPolicy/DepositPolicy';
import { TransactionsList } from './Pages/Finance/TransactionsList';
import { ProfitLoss } from './Pages/Finance/ProfitLoss';
import { QueueDashboard } from './Pages/QueueManager/QueueDashboard';
import { KYCQueue } from './Pages/KYC/KYCQueue';
import { SubAdminsList } from './Pages/SubAdmins/SubAdminsList';
import { BrandingSettings } from './Pages/Branding/BrandingSettings';
import { FAQManager } from './Pages/Content/FAQManager';
import { SupportLinks } from './Pages/Content/SupportLinks';
import { CDNManager } from './Pages/Content/CDNManager';
import { ContentSlideManager } from './Pages/Content/ContentSlideManager';
import { SystemSettings } from './Pages/Settings/SystemSettings';
import { AuditLogs } from './Pages/Settings/AuditLogs';
import ErrorLogs from './Pages/Settings/ErrorLogs';
import { DisputeManager } from './Pages/Disputes/DisputeManager';
import { AppAssetsPage } from './Pages/AppAssets/AppAssetsPage';
// UTR REMOVED: import { UTRManager } from './Pages/Finance/UTRManager';
// ── NEW FEATURE PAGES ──────────────────────────────────────────────────────
import { PaymentControlCenter } from './Pages/Payment/PaymentControlCenter';
import { GiftCodes }      from './Pages/Promotions/GiftCodes';
import { AnnouncementsPage } from './Pages/Promotions/AnnouncementsPage';
import { BalanceAdjustment } from './Pages/Users/BalanceAdjustment';
import { GameProviders }           from './Pages/GameProviders/GameProviders';
import { GamesManager }            from './Pages/Games/GamesManager';
import { FakeWinnersManager }  from './Pages/Winners/FakeWinnersManager';
import { ChatSupport }         from './Pages/Chat/ChatSupport';
// ── ENTERPRISE PLATFORM CONSOLES (Phase C, 2026-07-10) ─────────────────────
import { RevenueLedger }      from './Pages/Enterprise/RevenueLedger';
import { OperationsOverview } from './Pages/Enterprise/OperationsOverview';
import { Reports }            from './Pages/Enterprise/Reports';
import { MerchantPlatform }   from './Pages/Enterprise/MerchantPlatform';
import { useAuthStore } from './services/auth';
import { usePermissions } from './hooks/usePermission';
import sseService from './services/sse';
// Permission strings in PermRoute must exist in PERMISSION_KEYS (utils/permissions.ts) — GOVERNANCE.md M-1

// ─── Route Guards ─────────────────────────────────────────────────────────────

/**
 * AdminOnly — only full admins (isAdmin: true).
 */
const AdminOnly: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { isAuthenticated, admin } = useAuthStore();
  if (!isAuthenticated) return <Navigate to="/login" replace />;
  if (!admin?.isAdmin) return <Navigate to="/login" replace />;
  return <>{children}</>;
};

/**
 * PermRoute — accessible if user has the given permission OR is a full admin.
 * Sub-admins without the permission are redirected to /login (shows "Access Denied").
 */
const PermRoute: React.FC<{ permission: string; children: React.ReactNode }> = ({
  permission,
  children,
}) => {
  const { isAuthenticated, admin } = useAuthStore();
  if (!isAuthenticated) return <Navigate to="/login" replace />;
  if (!admin) return <Navigate to="/login" replace />;
  if (admin.isAdmin) return <>{children}</>;
  if (!admin.isSubAdmin) return <Navigate to="/login" replace />;
  const perms = admin.permissions || {};
  if (!(perms as any)[permission]) return <Navigate to="/login" replace />;
  return <>{children}</>;
};

/**
 * QueueRoute — accessible to queue_managers AND full admins.
 */
const QueueRoute: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { isAuthenticated, admin } = useAuthStore();
  if (!isAuthenticated) return <Navigate to="/login" replace />;
  if (!admin) return <Navigate to="/login" replace />;
  if (!admin.isAdmin && !admin.isSubAdmin && !admin.isQueueManager)
    return <Navigate to="/login" replace />;
  return <>{children}</>;
};

/**
 * AnyAuth — any authenticated user (admin, sub-admin with any perm, queue_manager).
 * Used for the main dashboard which is a safe read-only page.
 */
const AnyAuth: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { isAuthenticated } = useAuthStore();
  if (!isAuthenticated) return <Navigate to="/login" replace />;
  return <>{children}</>;
};

// ─── App ──────────────────────────────────────────────────────────────────────

const App: React.FC = () => {
  const { isAuthenticated, admin, verifySession } = useAuthStore();

  useEffect(() => {
    verifySession();
  }, [verifySession]);

  // C-02 fix: Admin panel applies its own branding — logo, title, primary colour.
  // GOVERNANCE §3 + §9: any name/colour shown to end-users must originate from Branding.
  useEffect(() => {
    function applyBranding(b: any) {
      if (!b || typeof b !== 'object') return;
      if (b.primaryColor) document.documentElement.style.setProperty('--brand-primary', b.primaryColor);
      if (b.adminPanelName) document.title = b.adminPanelName;
      try { localStorage.setItem('app_branding', JSON.stringify(b)); } catch { /* ignore */ }
    }
    // Apply cached branding immediately (avoids flash on load)
    try {
      const cached = localStorage.getItem('app_branding');
      if (cached) applyBranding(JSON.parse(cached));
    } catch { /* ignore */ }

    // Subscribe to live branding updates via SSE admin channel
    sseService.on('branding',         applyBranding);
    sseService.on('branding_updated', (d: any) => applyBranding(d?.branding ?? d));
    return () => {
      sseService.off('branding',         applyBranding);
      sseService.off('branding_updated', applyBranding);
    };
  }, []);

  useEffect(() => {
    if (isAuthenticated) {
      sseService.connect();
      return () => {
        sseService.disconnect();
      };
    }
  }, [isAuthenticated]);

  // Redirect queue-only users away from all routes except /queue-manager
  // This is enforced at route level above — but we also handle the root redirect
  const rootRedirect = () => {
    if (!admin) return <Navigate to="/login" replace />;
    if (admin.isQueueManager && !admin.isAdmin && !admin.isSubAdmin)
      return <Navigate to="/queue-manager" replace />;
    return (
      <AnyAuth>
        <Layout><Dashboard /></Layout>
      </AnyAuth>
    );
  };

  return (
    <Router>
      <Toaster
        position="top-right"
        toastOptions={{
          duration: 3000,
          style: { background: '#1E293B', color: '#F3F4F6', border: '1px solid #334155' },
          success: { iconTheme: { primary: '#D4AF37', secondary: '#0B0E14' } },
        }}
      />
      <Routes>
        <Route path="/login" element={<Login />} />

        {/* Dashboard — any authenticated role */}
        <Route path="/" element={rootRedirect()} />

        {/* Analytics — canViewAnalytics */}
        <Route path="/live-cycles" element={
          <PermRoute permission="canViewAnalytics">
            <Layout><LiveCycles /></Layout>
          </PermRoute>
        } />
        <Route path="/cycle-history" element={
          <PermRoute permission="canViewAnalytics">
            <Layout><CycleHistory /></Layout>
          </PermRoute>
        } />
        <Route path="/profit-loss" element={
          <PermRoute permission="canViewAnalytics">
            <Layout><ProfitLoss /></Layout>
          </PermRoute>
        } />

        {/* Users — canManageUsers */}
        <Route path="/users" element={
          <PermRoute permission="canManageUsers">
            <Layout><UsersList /></Layout>
          </PermRoute>
        } />

        {/* Merchants — canManageMerchants */}
        <Route path="/merchants" element={
          <PermRoute permission="canManageMerchants">
            <Layout><MerchantsList /></Layout>
          </PermRoute>
        } />

        {/* KYC — canVerifyKYC */}
        <Route path="/kyc" element={
          <PermRoute permission="canVerifyKYC">
            <Layout><KYCQueue /></Layout>
          </PermRoute>
        } />

        {/* Transactions — canViewTransactions */}
        <Route path="/transactions" element={
          <PermRoute permission="canViewTransactions">
            <Layout><TransactionsList /></Layout>
          </PermRoute>
        } />

        {/* Queue Manager — queue_manager role OR admin */}
        <Route path="/queue-manager" element={
          <QueueRoute>
            <Layout><QueueDashboard /></Layout>
          </QueueRoute>
        } />

        {/* Content — canManageContent */}
        <Route path="/content/faq" element={
          <PermRoute permission="canManageContent">
            <Layout><FAQManager /></Layout>
          </PermRoute>
        } />
        <Route path="/content/slides" element={
          <PermRoute permission="canManageContent">
            <Layout><ContentSlideManager /></Layout>
          </PermRoute>
        } />
        <Route path="/content/support" element={
          <PermRoute permission="canManageContent">
            <Layout><SupportLinks /></Layout>
          </PermRoute>
        } />
        <Route path="/content/cdn" element={
          <PermRoute permission="canManageContent">
            <Layout><CDNManager /></Layout>
          </PermRoute>
        } />
        <Route path="/branding" element={
          <PermRoute permission="canManageContent">
            <Layout><BrandingSettings /></Layout>
          </PermRoute>
        } />

        {/* App Assets — admin only */}
        <Route path="/app-assets" element={
          <AdminOnly><Layout><AppAssetsPage /></Layout></AdminOnly>
        } />

        {/* ── ENTERPRISE PLATFORM CONSOLES (Phase C) ── */}
        <Route path="/revenue" element={
          <PermRoute permission="canViewAnalytics">
            <Layout><RevenueLedger /></Layout>
          </PermRoute>
        } />
        <Route path="/operations" element={
          <PermRoute permission="canViewAnalytics">
            <Layout><OperationsOverview /></Layout>
          </PermRoute>
        } />
        <Route path="/reports" element={
          <PermRoute permission="canViewAnalytics">
            <Layout><Reports /></Layout>
          </PermRoute>
        } />
        <Route path="/merchant-platform" element={
          <PermRoute permission="canManageMerchants">
            <Layout><MerchantPlatform /></Layout>
          </PermRoute>
        } />

        {/* Admin-only routes */}
        {/* /token-rates removed 2026-07-08 — token conversion is fixed 1:1 (Phase 006 flattening) */}
        {/* Business Policy Platform (BBEPS Phase 006) — first sibling: DepositPolicy */}
        <Route path="/business-policy/deposit" element={
          <AdminOnly><Layout><DepositPolicy /></Layout></AdminOnly>
        } />
        <Route path="/sub-admins" element={
          <AdminOnly><Layout><SubAdminsList /></Layout></AdminOnly>
        } />
        <Route path="/settings" element={
          <AdminOnly><Layout><SystemSettings /></Layout></AdminOnly>
        } />
        <Route path="/audit-logs" element={
          <AdminOnly><Layout><AuditLogs /></Layout></AdminOnly>
        } />
        <Route path="/error-logs" element={
          <AdminOnly><Layout><ErrorLogs /></Layout></AdminOnly>
        } />

        <Route path="/disputes" element={
          <PermRoute permission="canResolveDisputes">
            <Layout><DisputeManager /></Layout>
          </PermRoute>
        } />
        {/* UTR REMOVED: route /utr-monitor stripped per product decision */}

        {/* Account recovery is no longer an admin queue. It runs unattended on a
            second Telegram bot that requires BOTH the registered phone (proved
            by a contact share) and the Aadhaar on file — see
            backend/domains/telegram/telegramRecovery.service.js. Every grant
            raises an alert. */}

        {/* ── WINNERS MANAGEMENT */}
        <Route path="/winners-manager" element={
          <PermRoute permission="canManageContent"><Layout><FakeWinnersManager /></Layout></PermRoute>
        } />

        {}
        <Route path="/chat-management" element={
          <PermRoute permission="canModerateChatPublic">
            <Layout><ChatSupport /></Layout>
          </PermRoute>
        } />

        {/* ── GAME PROVIDERS — admin only */}
        <Route path="/game-providers" element={
          <AdminOnly><Layout><GameProviders /></Layout></AdminOnly>
        } />

        {/* ── GAME REGISTRY (catalogue + categories) — admin only */}
        <Route path="/games" element={
          <AdminOnly><Layout><GamesManager /></Layout></AdminOnly>
        } />

        {}
        <Route path="/payment-control" element={
          <AdminOnly><Layout><PaymentControlCenter /></Layout></AdminOnly>
        } />

        {/* ── PROMOTIONS — canManageContent sub-admins can manage these ── */}
        <Route path="/promotions/gift-codes" element={
          <PermRoute permission="canManageContent">
            <Layout><GiftCodes /></Layout>
          </PermRoute>
        } />
        <Route path="/promotions/announcements" element={
          <PermRoute permission="canManageContent">
            <Layout><AnnouncementsPage /></Layout>
          </PermRoute>
        } />

        {/* ── BALANCE ADJUSTMENT — canManageUsers sub-admins with finance note ── */}
        <Route path="/users/balance-adjust" element={
          <PermRoute permission="canManageUsers">
            <Layout><BalanceAdjustment /></Layout>
          </PermRoute>
        } />

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Router>
  );
};

export default App;

