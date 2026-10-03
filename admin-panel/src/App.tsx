// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
import React, { useEffect } from 'react';
import { HashRouter as Router, Routes, Route, Navigate } from 'react-router';
import { Toaster } from 'react-hot-toast';
import { applyBranding, applyCachedBranding } from './services/branding';
import { Layout, firstPermittedPath } from './components/Layout';
import NoAccess from './components/NoAccess';
import { Login } from './Pages/Login';
import { Dashboard } from './Pages/Dashboard';
import { UsersList } from './Pages/Users/UsersList';
import { FlaggedPlayers } from './Pages/Users/FlaggedPlayers';
import { PhantomAgents } from './Pages/Users/PhantomAgents';
import { TeamsManager } from './Pages/Teams/TeamsManager';
import { MerchantsList } from './Pages/Merchants/MerchantsList';
import { LiveCycles } from './Pages/Cycles/LiveCycles';
import { CycleHistory } from './Pages/Cycles/CycleHistory';
import { DepositPolicy } from './Pages/BusinessPolicy/DepositPolicy';
import { TransactionsList } from './Pages/Finance/TransactionsList';
import { ProfitLoss } from './Pages/Finance/ProfitLoss';
import { TokenFlow } from './Pages/Finance/TokenFlow';
import { SupportAssistant } from './Pages/Support/SupportAssistant';
import { QueueDashboard } from './Pages/QueueManager/QueueDashboard';
import { TelegramConfig } from './Pages/Telegram/TelegramConfig';
import { ReferralProgramme } from './Pages/Referrals/ReferralProgramme';
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
import { CdmReceiptQueue } from './Pages/Disputes/CdmReceiptQueue';
import { StalledWithdrawals } from './Pages/Disputes/StalledWithdrawals';
import { UtrMonitor } from './Pages/Utr/UtrMonitor';
import { AppAssetsPage } from './Pages/AppAssets/AppAssetsPage';
import { AndroidAppPage } from './Pages/AndroidApp/AndroidAppPage';
import { BlockedIpsPage } from './Pages/Security/BlockedIpsPage';
// ── NEW FEATURE PAGES ──────────────────────────────────────────────────────
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
import type { PermissionKey } from './utils/permissions';
import sseService from './services/sse';
// The obligation gate. Wraps the whole route table rather than each guard —
// see the file header for why four copies of one rule is the wrong shape.
import MandatoryTwoFactor from './components/MandatoryTwoFactor';
import VerificationGate from './components/VerificationGate';
// Permission strings in PermRoute are PermissionKey — the server's list, held equal by check:staff-permissions.

// ─── Route Guards ─────────────────────────────────────────────────────────────

/**
 * AdminOnly — only full admins (isAdmin: true).
 */
const AdminOnly: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { isAuthenticated, admin } = useAuthStore();
  if (!isAuthenticated) return <Navigate to="/login" replace />;
  // Signed in but not a full admin: say so, rather than showing a sign-in
  // form to somebody who is already signed in (NoAccess.tsx).
  if (!admin) return <Navigate to="/login" replace />;
  if (!admin.isAdmin) return <Layout><NoAccess adminOnly /></Layout>;
  return <>{children}</>;
};

/**
 * PermRoute — a full admin, or a sub-admin holding the screen's permission (any
 * one of them, when the screen serves two areas). The server refuses the same
 * routes by the same keys (`staffPermissions.js`); this only decides whether
 * the screen is offered at all.
 */
const PermRoute: React.FC<{ permission: PermissionKey | PermissionKey[]; children: React.ReactNode }> = ({
  permission,
  children,
}) => {
  const { isAuthenticated, admin } = useAuthStore();
  const { canAny } = usePermissions();
  if (!isAuthenticated) return <Navigate to="/login" replace />;
  if (!admin) return <Navigate to="/login" replace />;
  if (!canAny(Array.isArray(permission) ? permission : [permission])) return <Layout><NoAccess /></Layout>;
  return <>{children}</>;
};

/**
 * QueueRoute — queue managers, and staff holding `canManageMerchants`: the same
 * rule every queue route applies on the server (`queueManagerOrPermission`). It
 * admitted ANY sub-admin, who then met a screen of refusals.
 */
const QueueRoute: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { isAuthenticated, admin } = useAuthStore();
  const { can } = usePermissions();
  if (!isAuthenticated) return <Navigate to="/login" replace />;
  if (!admin) return <Navigate to="/login" replace />;
  if (!admin.isQueueManager && !can('canManageMerchants')) return <Layout><NoAccess /></Layout>;
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
    // Apply cached branding immediately (avoids a flash on load).
    applyCachedBranding();

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
    // The dashboard is analytics. A sub-admin who was not given analytics lands
    // on the first area they WERE given, instead of a dashboard of refusals.
    if (!admin.isAdmin && !(admin.permissions as Record<string, boolean> | undefined)?.canViewAnalytics) {
      const first = firstPermittedPath((keys) => keys.some((k) => (admin.permissions as Record<string, boolean> | undefined)?.[k] === true));
      if (first) return <Navigate to={first} replace />;
      // Given NO area at all: say so. The dashboard would answer with
      // "Live metrics are unavailable right now", which reads as an outage
      // (measured as the `subadmin-none` browser profile).
      return <AnyAuth><Layout><NoAccess /></Layout></AnyAuth>;
    }
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
          // react-hot-toast applies these as CSS values, so the brand token resolves.
          success: { iconTheme: { primary: 'var(--gold)', secondary: '#0B0E14' } },
        }}
      />
      <MandatoryTwoFactor>
      {/* ── The staff verification gate ─────────────────────────────────────
          INSIDE MandatoryTwoFactor, so the session is finished before the
          account is asked about — a half-completed 2FA challenge cannot read
          this endpoint anyway, and asking would answer 401 on a screen that is
          already telling the operator what to do.

          Mounted above <Routes> rather than on Layout, because it must also
          cover the screens that render outside Layout, and because its other
          job is the BOOTSTRAP BANNER: a standing reminder, shown to a VERIFIED
          admin, that staff verification is not switched on yet. It renders
          nothing at all once a staff bot and channel exist and this account has
          verified. Signed out, the read 401s and it stays silent, so the login
          screen is untouched. */}
      <VerificationGate />
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

        {/* Flagged players — the review queue a merchant rejection feeds.
            The rejection warns and flags; the block is decided here. */}
        <Route path="/users/flagged" element={
          <PermRoute permission="canManageUsers">
            <Layout><FlaggedPlayers /></Layout>
          </PermRoute>
        } />

        {/* Merchants — canManageMerchants */}
        <Route path="/merchants" element={
          <PermRoute permission="canManageMerchants">
            <Layout><MerchantsList /></Layout>
          </PermRoute>
        } />

        {/* Reading back who can place cosmetic bets. The grant is made from the
            Users list; this is the roster and the way to take it away. */}
        <Route path="/teams" element={
          <PermRoute permission="canManageTeams"><Layout><TeamsManager /></Layout></PermRoute>
        } />
        <Route path="/users/phantom-agents" element={
          <PermRoute permission="canManagePhantomAgents"><Layout><PhantomAgents /></Layout></PermRoute>
        } />
        <Route path="/telegram" element={
          <PermRoute permission="canManageTelegram"><Layout><TelegramConfig /></Layout></PermRoute>
        } />
        <Route path="/referrals" element={
          <PermRoute permission="canManageReferrals"><Layout><ReferralProgramme /></Layout></PermRoute>
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
          <PermRoute permission="canManageContent"><Layout><AppAssetsPage /></Layout></PermRoute>
        } />

        {/* Android App — upload, publish and force updates. Admin only: a
            release is code that runs on every player's phone. */}
        <Route path="/android-app" element={
          <PermRoute permission="canManageAndroidApp"><Layout><AndroidAppPage /></Layout></PermRoute>
        } />

        {/* Blocked IPs — the deny-list. Admin only: a block refuses every request
            from a range, players and merchants included. */}
        <Route path="/blocked-ips" element={
          <PermRoute permission="canManageIpBlocks"><Layout><BlockedIpsPage /></Layout></PermRoute>
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
        <Route path="/token-flow" element={
          <PermRoute permission="canViewAnalytics">
            <Layout><TokenFlow /></Layout>
          </PermRoute>
        } />
        <Route path="/support-assistant" element={
          <PermRoute permission="canManageSupportAssistant"><Layout><SupportAssistant /></Layout></PermRoute>
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
          <PermRoute permission="canManageBusinessPolicy"><Layout><DepositPolicy /></Layout></PermRoute>
        } />
        <Route path="/sub-admins" element={
          <AdminOnly><Layout><SubAdminsList /></Layout></AdminOnly>
        } />
        <Route path="/settings" element={
          <PermRoute permission="canManageSystemSettings"><Layout><SystemSettings /></Layout></PermRoute>
        } />
        <Route path="/audit-logs" element={
          <PermRoute permission="canViewAuditLogs"><Layout><AuditLogs /></Layout></PermRoute>
        } />
        <Route path="/error-logs" element={
          <PermRoute permission="canViewAuditLogs"><Layout><ErrorLogs /></Layout></PermRoute>
        } />

        <Route path="/disputes" element={
          <PermRoute permission="canResolveDisputes">
            <Layout><DisputeManager /></Layout>
          </PermRoute>
        } />
        {/* Gated on the SAME permission as the dispute queue, because it is the
            same job: the slip is the evidence a cash-payout dispute is decided
            from, and reading one is audited either way. */}
        <Route path="/disputes/cdm-receipts" element={
          <PermRoute permission="canResolveDisputes">
            <Layout><CdmReceiptQueue /></Layout>
          </PermRoute>
        } />
        {/* Same gate again: a stalled withdrawal is a player's tokens locked
            with no deadline, which is what the disputes desk answers for. */}
        <Route path="/disputes/stalled-withdrawals" element={
          <PermRoute permission="canResolveDisputes">
            <Layout><StalledWithdrawals /></Layout>
          </PermRoute>
        } />
        {/* The payment-reference registry (§27). Its own area: a sub-admin can be
            given references without the disputes desk, and the reverse. */}
        <Route path="/payment-references" element={
          <PermRoute permission="canManageUtr">
            <Layout><UtrMonitor /></Layout>
          </PermRoute>
        } />
        {/* UTR REMOVED: route /utr-monitor stripped per product decision */}

        {/* Account recovery is not an admin queue: a forgotten password is
            reset through the panel's Telegram bot, which issues a link to a
            number Telegram has verified (passwordReset.service.js). */}

        {/* ── WINNERS MANAGEMENT */}
        <Route path="/winners-manager" element={
          <PermRoute permission="canManageContent"><Layout><FakeWinnersManager /></Layout></PermRoute>
        } />

        {}
        <Route path="/chat-management" element={
          <PermRoute permission={['canModerateChat', 'canManageSupportTickets']}>
            <Layout><ChatSupport /></Layout>
          </PermRoute>
        } />

        {/* ── GAME PROVIDERS — admin only */}
        <Route path="/game-providers" element={
          <PermRoute permission="canManageGames"><Layout><GameProviders /></Layout></PermRoute>
        } />

        {/* ── GAME REGISTRY (catalogue + categories) — admin only */}
        <Route path="/games" element={
          <PermRoute permission="canManageGames"><Layout><GamesManager /></Layout></PermRoute>
        } />

        {/* ── PROMOTIONS — canManageContent sub-admins can manage these ── */}
        <Route path="/promotions/announcements" element={
          <PermRoute permission="canManageContent">
            <Layout><AnnouncementsPage /></Layout>
          </PermRoute>
        } />

        {/* ── BALANCE ADJUSTMENT — canManageUsers sub-admins with finance note ── */}
        <Route path="/users/balance-adjust" element={
          <PermRoute permission="canAdjustBalances">
            <Layout><BalanceAdjustment /></Layout>
          </PermRoute>
        } />

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      </MandatoryTwoFactor>
    </Router>
  );
};

export default App;

