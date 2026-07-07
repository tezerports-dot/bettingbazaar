// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
import React, { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import {
  LayoutDashboard, Users, Store, Activity, DollarSign, Layers, Landmark,
  UserCheck, FileText, Palette, Settings, LogOut, Menu, X,
  TrendingUp, ShieldCheck, HelpCircle, Image as ImageIcon,
  MessageCircle, Shield, History, Scale, AlertOctagon, Upload,
  Zap, Gift, Calendar, Bell, SlidersHorizontal, Trophy, Star,
  type LucideIcon,
} from 'lucide-react';
import { useAuthStore } from '../services/auth';
import { usePermissions } from '../hooks/usePermission';
import type { PermissionKey } from '../utils/permissions'; // GOVERNANCE.md M-1: type-check nav permission strings

interface LayoutProps {
  children: React.ReactNode;
}

interface MenuItem {
  path: string;
  icon: LucideIcon;
  label: string;
  permission?: PermissionKey | string; // use PermissionKey for all new nav entries
  adminOnly?: boolean;
  queueManagerAccess?: boolean;
  group?: string;
}

const ALL_MENU_ITEMS: MenuItem[] = [
  // ── CORE ──────────────────────────────────────────────────────────────────
  { path: '/',              icon: LayoutDashboard, label: 'Dashboard',        group: 'core' },
  { path: '/live-cycles',   icon: Activity,        label: 'Live Cycles',      permission: 'canViewAnalytics',    group: 'core' },
  { path: '/cycle-history', icon: History,         label: 'Cycle History',    permission: 'canViewAnalytics',    group: 'core' },
  { path: '/profit-loss',   icon: TrendingUp,      label: 'Profit & Loss',    permission: 'canViewAnalytics',    group: 'core' },

  // ── USERS & MERCHANTS ──────────────────────────────────────────────────────
  { path: '/users',              icon: Users,      label: 'Users',            permission: 'canManageUsers',      group: 'people' },
  { path: '/users/balance-adjust',icon: SlidersHorizontal, label: 'Balance Adjust', permission: 'canManageUsers', group: 'people' },
  { path: '/merchants',          icon: Store,      label: 'Merchants',        permission: 'canManageMerchants',  group: 'people' },
  { path: '/kyc',                icon: UserCheck,  label: 'KYC Queue',        permission: 'canVerifyKYC',        group: 'people' },

  // ── PAYMENTS & QUEUE ───────────────────────────────────────────────────────
  { path: '/queue-manager',  icon: Layers,         label: 'Queue Manager',    queueManagerAccess: true,          group: 'payments' },
  // UTR Monitor nav item removed
  { path: '/transactions',   icon: FileText,       label: 'Transactions',     permission: 'canViewTransactions', group: 'payments' },
  { path: '/token-rates',    icon: DollarSign,     label: 'Token Rates',      adminOnly: true,                   group: 'payments' },
  { path: '/payment-control',icon: Zap,            label: 'Payment System',   adminOnly: true,                   group: 'payments' },
  { path: '/disputes',       icon: Scale,          label: 'Disputes',         permission: 'canResolveDisputes',  group: 'payments' },

  // ── BUSINESS POLICY PLATFORM (BBEPS Phase 006) ──────────────────────────────
  // New 'policy' group, deliberately separate from 'payments' — future
  // siblings (Withdrawal Policy, Risk Policy, Merchant Policy, Settlement
  // Policy...) belong here too, not scattered across other groups. See
  // ENTERPRISE_DECISIONS.md 2026-07-07 "Platform-oriented architecture".
  { path: '/business-policy/deposit', icon: Landmark, label: 'Deposit Policy', adminOnly: true, group: 'policy' },

  // ── GAME PROVIDERS (Casino / Crash / Sports API config) ────────────────────
  { path: '/game-providers', icon: Star,           label: 'Game Providers',   adminOnly: true,                   group: 'games' },

  // ── PROMOTIONS (sub-admins with canManageContent) ──────────────────────────
  { path: '/account-recovery', icon: ShieldCheck, label: 'Account Recovery', adminOnly: true, group: 'admin' },
  { path: '/winners-manager',  icon: Trophy,         label: 'Winners Manager',  permission: 'canManageContent', group: 'promos' },
  { path: '/chat-management',  icon: MessageCircle,  label: 'Chat & Support',   permission: 'canModerateChatPublic', group: 'promos' },
  { path: '/promotions/announcements', icon: Bell,     label: 'Announcements',  permission: 'canManageContent', group: 'promos' },
  { path: '/promotions/gift-codes',    icon: Gift,     label: 'Gift Codes',     permission: 'canManageContent', group: 'promos' },

  // ── CONTENT & BRANDING ────────────────────────────────────────────────────
  { path: '/content/faq',    icon: HelpCircle,    label: 'FAQ Manager',       permission: 'canManageContent',    group: 'content' },
  { path: '/content/slides', icon: ImageIcon,     label: 'Page Slides',       permission: 'canManageContent',    group: 'content' },
  { path: '/content/support',icon: MessageCircle, label: 'Support Links',     permission: 'canManageContent',    group: 'content' },
  { path: '/content/cdn',    icon: ImageIcon,     label: 'CDN Library',       permission: 'canManageContent',    group: 'content' },
  { path: '/branding',       icon: Palette,       label: 'Branding',          permission: 'canManageContent',    group: 'content' },
  { path: '/app-assets',     icon: Upload,        label: 'App Assets (PWA)',  adminOnly: true,                   group: 'content' },

  // ── ADMIN ONLY ─────────────────────────────────────────────────────────────
  { path: '/sub-admins',     icon: ShieldCheck,   label: 'Sub-Admins',        adminOnly: true,                   group: 'admin' },
  { path: '/settings',       icon: Settings,      label: 'System Settings',   adminOnly: true,                   group: 'admin' },
  { path: '/audit-logs',     icon: Shield,        label: 'Audit Logs',        adminOnly: true,                   group: 'admin' },
  { path: '/error-logs',     icon: Shield,        label: 'Error Logs',        adminOnly: true,                   group: 'admin' },
];

export const Layout: React.FC<LayoutProps> = ({ children }) => {
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const location  = useLocation();
  const navigate  = useNavigate();
  const { admin, logout } = useAuthStore();
  const { can, isAdmin, isQueueManager } = usePermissions();

  const handleLogout = async () => {
    await logout();
    navigate('/login');
  };

  // Filter menu to only items this user can access
  const visibleItems = ALL_MENU_ITEMS.filter((item) => {
    if (isAdmin) return true;                          // admin sees everything
    if (item.adminOnly) return false;                  // admin-only items hidden
    if (item.queueManagerAccess && isQueueManager) return true;
    if (item.permission) return can(item.permission);
    // Dashboard (no permission/adminOnly flag) — visible to all authenticated
    return true;
  });

  const roleBadge = () => {
    if (admin?.isAdmin) return (
      <span className="inline-block mt-1 px-2 py-0.5 text-xs font-medium bg-gold-500/20 text-gold-500 rounded">
        Super Admin
      </span>
    );
    if (admin?.isSubAdmin) return (
      <span className="inline-block mt-1 px-2 py-0.5 text-xs font-medium bg-purple-500/20 text-purple-400 rounded">
        Sub-Admin
      </span>
    );
    if (admin?.isQueueManager) return (
      <span className="inline-block mt-1 px-2 py-0.5 text-xs font-medium bg-blue-500/20 text-blue-400 rounded">
        Queue Manager
      </span>
    );
    return null;
  };

  return (
    <div className="flex h-screen bg-dark-900">
      {/* Sidebar */}
      <aside className={`${sidebarOpen ? 'w-64' : 'w-20'} bg-dark-800 border-r border-dark-700 transition-all duration-300 flex flex-col overflow-hidden`}>
        {/* Logo */}
        <div className="h-16 flex items-center justify-between px-4 border-b border-dark-700 flex-shrink-0">
          {sidebarOpen ? (
            <h1 className="text-xl font-bold bg-gradient-to-r from-gold-400 to-gold-600 bg-clip-text text-transparent">
              {/* C-02: admin panel name from branding — GOVERNANCE §3 */}
              {(() => { try { return JSON.parse(localStorage.getItem('app_branding') || '{}').adminPanelName || 'Betting Bazaar'; } catch { return 'Betting Bazaar'; } })()}
            </h1>
          ) : (
            <div className="w-8 h-8 bg-gradient-to-br from-gold-400 to-gold-600 rounded-lg" />
          )}
          <button onClick={() => setSidebarOpen(!sidebarOpen)} className="p-2 hover:bg-dark-700 rounded-lg transition-colors">
            {sidebarOpen ? <X size={20} /> : <Menu size={20} />}
          </button>
        </div>

        {/* Navigation */}
        <nav className="flex-1 overflow-y-auto py-4">
          {(() => {
            const groupLabels: Record<string, string> = {
              core: 'Analytics', people: 'Users & Merchants',
              payments: 'Payments & Queue', games: 'Game Providers',
              promos: 'Promotions', content: 'Content & Branding', admin: 'Admin',
              policy: 'Business Policy Platform',
            };
            let lastGroup = '';
            return visibleItems.map((item) => {
              const Icon = item.icon;
              const isActive = location.pathname === item.path;
              const showGroupHeader = sidebarOpen && item.group && item.group !== lastGroup;
              if (item.group) lastGroup = item.group;
              return (
                <React.Fragment key={item.path}>
                  {showGroupHeader && (
                    <div className="px-4 pt-4 pb-1">
                      <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-600">
                        {groupLabels[item.group!] || item.group}
                      </p>
                    </div>
                  )}
                  <Link
                    key={item.path}
                to={item.path}
                className={`flex items-center px-4 py-3 mx-2 rounded-lg mb-1 transition-colors ${
                  isActive
                    ? 'bg-gold-500 text-dark-900'
                    : 'text-gray-300 hover:bg-dark-700'
                }`}
                title={!sidebarOpen ? item.label : undefined}
              >
                <Icon size={20} className="flex-shrink-0" />
                {sidebarOpen && <span className="ml-3 font-medium">{item.label}</span>}
              </Link>
                </React.Fragment>
              );
            });
          })()}
        </nav>

        {/* User Info & Logout */}
        <div className="p-4 border-t border-dark-700 flex-shrink-0">
          {sidebarOpen && (
            <div className="mb-3">
              <p className="text-sm font-medium text-gray-100 truncate">{admin?.username || 'User'}</p>
              <p className="text-xs text-gray-400 truncate">{admin?.mobile || ''}</p>
              {roleBadge()}
            </div>
          )}
          <button
            onClick={handleLogout}
            className="w-full flex items-center justify-center px-4 py-2 bg-red-600 hover:bg-red-700 rounded-lg transition-colors text-white font-medium"
            title={!sidebarOpen ? 'Logout' : undefined}
          >
            <LogOut size={20} />
            {sidebarOpen && <span className="ml-2">Logout</span>}
          </button>
        </div>
      </aside>

      {/* Main Content */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Header */}
        <header className="h-16 bg-dark-800 border-b border-dark-700 flex items-center justify-between px-6 flex-shrink-0">
          <h2 className="text-xl font-semibold text-gray-100">
            {ALL_MENU_ITEMS.find((item) => item.path === location.pathname)?.label || 'Admin Panel'}
          </h2>
          <div className="flex items-center space-x-4">
            <div className="text-sm text-gray-400">
              {new Date().toLocaleDateString('en-US', {
                weekday: 'short', year: 'numeric', month: 'short', day: 'numeric',
              })}
            </div>
            <div className="w-px h-6 bg-dark-700" />
            <div className="flex items-center space-x-2">
              <div className="w-2 h-2 bg-green-500 rounded-full animate-pulse" />
              <span className="text-sm text-gray-400">System Online</span>
            </div>
          </div>
        </header>

        {/* Page Content */}
        <main className="flex-1 overflow-y-auto p-6 bg-dark-900">{children}</main>
      </div>
    </div>
  );
};

