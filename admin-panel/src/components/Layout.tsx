// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
//
// Command Center shell — collapsible grouped sidebar + top bar with ⌘K command
// palette, theme toggle, live status and account menu. Recreated from the
// design handoff "Betting Bazaar Admin.dc.html". All routing, permission
// filtering, auth and branding wiring is preserved from the previous shell.
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import {
  LayoutDashboard, Users, Store, Activity, Layers, Landmark,
  FileText, Palette, Settings, ChevronLeft, ChevronRight,
  TrendingUp, ShieldCheck, HelpCircle, Image as ImageIcon,
  MessageCircle, Shield, History, Scale, Search, Sun, Moon, Bell,
  SlidersHorizontal, Trophy, Star, Gamepad2, Bot, Share2,
  type LucideIcon, ArrowLeftRight, BookOpenCheck, Flag, Hourglass, Fingerprint,
  Ghost, Smartphone, ShieldBan, KeyRound, Wallet, ScrollText, Coins, Archive } from 'lucide-react';
import { useAuthStore } from '../services/auth';
import { usePermissions } from '../hooks/usePermission';
import { useThemeStore } from '../services/theme';
import { LogoMark, getBrand } from './Logo';
import { CommandPalette, type PaletteItem } from './CommandPalette';
import { ConfirmDialog } from './ConfirmDialog';
import api from '../services/api';
import type { PermissionKey } from '../utils/permissions';

interface LayoutProps {
  children: React.ReactNode;
}

type BadgeKind = 'queue';

interface MenuItem {
  path: string;
  icon: LucideIcon;
  label: string;          // short label shown in the sidebar
  title: string;          // page title shown in the header
  sub: string;            // page subtitle shown in the header
  /** The area this screen belongs to — or several, when it serves more than one. */
  permission?: PermissionKey | PermissionKey[];
  adminOnly?: boolean;
  queueManagerAccess?: boolean;
  badge?: BadgeKind;      // live count badge (resolved from stats)
}

interface MenuGroup {
  key: string;
  label: string;
  items: MenuItem[];
}

// Grouped nav model — order, labels and grouping mirror the design handoff.
// Grouped by the work an operator does (owner, 2026-10-14): people, money,
// games, content, platform. Each item is the one screen for its job, so a
// small task is one click from the menu.
const NAV_GROUPS: MenuGroup[] = [
  { key: 'core', label: 'Overview', items: [
    { path: '/',              icon: LayoutDashboard, label: 'Dashboard',      title: 'Operations Command', sub: 'Real-time platform health across finance, cycles, risk & queues' },
    { path: '/live-cycles',   icon: Activity,        label: 'Live Cycles',    title: 'Live Cycles',        sub: 'Active Delhi vs Bombay betting cycles & phantom book control', permission: 'canViewAnalytics' },
    { path: '/cycle-history', icon: History,         label: 'Cycle History',  title: 'Cycle History',      sub: 'Settled cycles, results and house profit', permission: 'canViewAnalytics' },
    { path: '/profit-loss',   icon: TrendingUp,      label: 'Profit & Loss',  title: 'Profit & Loss',      sub: 'Gross & net gaming revenue over time', permission: 'canViewAnalytics' },
    { path: '/token-flow',    icon: ArrowLeftRight,  label: 'Token Flow',     title: 'Token Flow',         sub: 'Player purchases, player sells and team pool funding — never summed', permission: 'canViewAnalytics' },
  ] },
  { key: 'people', label: 'People', items: [
    { path: '/users',               icon: Users,            label: 'Players',        title: 'Players',            sub: 'Every player with deposits, net win or loss and wallets; a row opens the player', permission: 'canManageUsers' },
    { path: '/users/flagged',       icon: Flag,             label: 'Flagged Players',title: 'Flagged Players',    sub: "A merchant disputed their payment — reason, proof, and the block decision", permission: 'canManageUsers' },
    { path: '/merchants',           icon: Store,            label: 'Agents & Merchants', title: 'Agents & Merchants', sub: 'Agents, supervisors and merchants with volume, pool and commission; a row opens the merchant', permission: 'canManageMerchants' },
    { path: '/teams',               icon: Users,            label: 'Teams',          title: 'Supervisors & Teams', sub: 'Supervisors, their agent teams, agents waiting for approval, red flags', permission: 'canManageTeams' },
    { path: '/users/phantom-agents',icon: Ghost,            label: 'Phantom Bettors',  title: 'Phantom Bettors',      sub: 'Who can place cosmetic bets, and on which boards', permission: 'canManagePhantomAgents' },
    { path: '/staff',               icon: ShieldCheck,      label: 'Staff',          title: 'Staff',              sub: 'Admins, sub-admins, queue managers and mediators; a row opens the account', adminOnly: true },
  ] },
  { key: 'payments', label: 'Payments', items: [
    { path: '/payments',        icon: Wallet,   label: 'Pools & Requests', title: 'Pools & Requests', sub: 'Every pool and pool request: agents\' teams and merchants behind one switch', permission: ['canFundMerchants', 'canManageTeams', 'canManageMerchants'] },
    { path: '/queue-manager',   icon: Layers,   label: 'Queue Manager',  title: 'Queue Manager', sub: 'Live payment order queue — orders are routed to agent teams or merchants', queueManagerAccess: true, permission: 'canManageMerchants', badge: 'queue' },
    { path: '/disputes',        icon: Scale,    label: 'Disputes',       title: 'Disputes',      sub: 'Payment order disputes & resolution', permission: 'canResolveDisputes' },
    { path: '/disputes/stalled-withdrawals', icon: Hourglass, label: 'Stalled Payouts', title: 'Stalled Withdrawals', sub: 'Payouts no merchant has taken, and the tokens locked behind them', permission: 'canResolveDisputes' },
    { path: '/transactions',    icon: FileText, label: 'Transactions',   title: 'Transactions',  sub: 'Ledger of deposits, withdrawals, bets & adjustments', permission: 'canViewTransactions' },
    { path: '/usdt-deposits', icon: Coins, label: 'USDT Deposits', title: 'USDT Deposits', sub: 'USDT buys paid to the platform on BNB Smart Chain: late or overpaid money, and the sweep', permission: 'canManageUsdtDeposits' },
    { path: '/payment-references', icon: Fingerprint, label: 'Payment References', title: 'Payment References', sub: 'UTRs and chain hashes: who claimed what, and who tried to reuse one', permission: 'canManageUtr' },
    { path: '/users/balance-adjust',icon: SlidersHorizontal,label: 'Balance Adjust', title: 'Balance Adjustment', sub: 'Manual credit / debit with mandatory audit note', permission: 'canAdjustBalances' },
  ] },
  { key: 'finance', label: 'Finance & Reports', items: [
    { path: '/revenue',           icon: Landmark, label: 'Revenue & Ledger',  title: 'Revenue & Ledger',    sub: 'Enterprise revenue ledger & settlements', permission: 'canViewAnalytics' },
    { path: '/business-policy/deposit', icon: Landmark, label: 'Deposit Policy', title: 'Deposit Policy', sub: 'Versioned deposit / reserve allocation policy', permission: 'canManageBusinessPolicy' },
    { path: '/reports',           icon: FileText, label: 'Reports',           title: 'Reports',             sub: 'Executive reporting & exports', permission: 'canViewAnalytics' },
    { path: '/operations',        icon: Activity, label: 'Operations',        title: 'Operations Overview', sub: 'Cross-domain operational health', permission: 'canViewAnalytics' },
    { path: '/merchant-platform', icon: Store,    label: 'Merchant Platform', title: 'Merchant Platform',   sub: 'Merchant onboarding, tiers & performance', permission: 'canManageMerchants' },
  ] },
  { key: 'games', label: 'Games', items: [
    { path: '/boards',         icon: Gamepad2, label: 'Boards',         title: 'Boards',         sub: 'Board games: timers, stakes and home-page order', permission: 'canManageGames' },
    { path: '/cricket',        icon: Trophy,   label: 'Cricket',        title: 'Cricket',        sub: 'Opinion polls on live matches: feed, matches, polls and report', permission: 'canManageGames' },
    { path: '/games',          icon: Gamepad2, label: 'Game Registry',  title: 'Game Registry',  sub: 'Game catalogue & categories', permission: 'canManageGames' },
    { path: '/game-providers', icon: Star,     label: 'Game Providers', title: 'Game Providers', sub: 'Casino / crash / sports API providers', permission: 'canManageGames' },
  ] },
  { key: 'support', label: 'Support', items: [
    { path: '/chat-management',          icon: MessageCircle, label: 'Chat & Support',  title: 'Chat & Support',  sub: 'Public chat moderation & support console', permission: ['canModerateChat', 'canManageSupportTickets'] },
    { path: '/support-assistant',        icon: BookOpenCheck, label: 'Support Assistant', title: 'Support Assistant', sub: 'Knowledge base the assistant answers players from', permission: 'canManageSupportAssistant' },
    { path: '/content/faq',              icon: HelpCircle,    label: 'FAQ Manager',     title: 'FAQ Manager',     sub: 'Help centre questions & categories', permission: 'canManageContent' },
    { path: '/content/support',          icon: MessageCircle, label: 'Support Links',   title: 'Support Links',   sub: 'Contact & social channels', permission: 'canManageContent' },
  ] },
  { key: 'content', label: 'Content & Promotions', items: [
    { path: '/promotions/announcements', icon: Bell,          label: 'Announcements',   title: 'Announcements',   sub: 'Platform-wide notices & popups', permission: 'canManageContent' },
    { path: '/winners-manager',          icon: Trophy,        label: 'Winners Manager', title: 'Winners Manager', sub: 'Real & phantom winner surfacing', permission: 'canManageContent' },
    { path: '/referrals',                icon: Share2,        label: 'Referrals',       title: 'Referral Programme', sub: 'Fund the payout queue in joining order', permission: 'canManageReferrals' },
    { path: '/images',                   icon: ImageIcon,     label: 'Images',          title: 'Images',          sub: 'Every image of the player app: promo cards per screen, board, logo, banners', permission: 'canManageContent' },
    { path: '/content/rules-popup',      icon: ScrollText,    label: 'Rules Pop-up',    title: 'Rules Pop-up',    sub: 'The board rules players read and accept before betting', permission: 'canManageContent' },
    { path: '/branding',                 icon: Palette,       label: 'Branding',        title: 'Branding',        sub: 'App name, colours, tagline & panel names', permission: 'canManageContent' },
    { path: '/android-app',              icon: Smartphone,    label: 'Android App',     title: 'Android App',     sub: 'Upload, publish & force updates', permission: 'canManageAndroidApp' },
  ] },
  // Platform control. Every staff sign-in ends with an authenticator code
  // (owner, 2026-10-13); "My Authenticator" is every account's own and needs
  // no area.
  { key: 'admin', label: 'Platform', items: [
    { path: '/settings',         icon: Settings,    label: 'System Settings',  title: 'System Settings',  sub: 'Platform configuration', permission: 'canManageSystemSettings' },
    { path: '/player-screen',    icon: SlidersHorizontal, label: 'Player Screen', title: 'Player Screen', sub: 'Show or hide the player app extras', permission: 'canManageSystemSettings' },
    { path: '/telegram',         icon: Bot,         label: 'Telegram Setup',   title: 'Telegram Setup',   sub: 'The bot and its standbys: replace one without a deploy', permission: 'canManageTelegram' },
    { path: '/blocked-ips',      icon: ShieldBan,   label: 'Blocked IPs',      title: 'Blocked IPs',      sub: 'Refuse every request from an address or range', permission: 'canManageIpBlocks' },
    { path: '/audit-logs',       icon: Shield,      label: 'Audit Logs',       title: 'Audit Logs',       sub: 'Administrative action trail', permission: 'canViewAuditLogs' },
    { path: '/error-logs',       icon: Shield,      label: 'Error Logs',       title: 'Error Logs',       sub: 'Runtime errors & failed jobs', permission: 'canViewAuditLogs' },
    { path: '/cold-storage',     icon: Archive,     label: 'Cold Storage',     title: 'Cold Storage',     sub: 'Old rounds, chats and notifications kept off every live screen', adminOnly: true },
    { path: '/account/security', icon: KeyRound,    label: 'My Authenticator', title: 'My Authenticator', sub: 'Your authenticator app and recovery codes' },
  ] },
];

/**
 * The first screen this account may open, in sidebar order — where a sub-admin
 * lands after signing in. Derived from the same items the sidebar shows, so a
 * new area is a landing page with no second list to update.
 */
export function firstPermittedPath(canAny: (keys: PermissionKey[]) => boolean): string | null {
  for (const group of NAV_GROUPS) {
    for (const item of group.items) {
      if (item.adminOnly || !item.permission) continue;
      if (canAny(Array.isArray(item.permission) ? item.permission : [item.permission])) return item.path;
    }
  }
  return null;
}

const ROLE_IDENTITY = (admin: { username?: string; role?: string; isAdmin?: boolean; isSubAdmin?: boolean; isQueueManager?: boolean } | null) => {
  if (admin?.isAdmin) return { role: 'Super Admin', color: 'var(--gold-ink)' };
  if (admin?.isSubAdmin) return { role: 'Sub-Admin', color: 'var(--risk)' };
  if (admin?.isQueueManager) return { role: 'Queue Manager', color: 'var(--info)' };
  return { role: 'Admin', color: 'var(--text-2)' };
};

function initialsOf(name?: string): string {
  if (!name) return 'BB';
  return name.trim().split(/\s+/).map((w) => w[0]).join('').toUpperCase().slice(0, 2) || 'BB';
}

export const Layout: React.FC<LayoutProps> = ({ children }) => {
  const location = useLocation();
  const navigate = useNavigate();
  const { admin, logout } = useAuthStore();
  const { can, canAny, isAdmin, isQueueManager } = usePermissions();
  const { theme, toggleTheme, collapsed, toggleCollapsed } = useThemeStore();

  const [paletteOpen, setPaletteOpen] = useState(false);
  const [signOutOpen, setSignOutOpen] = useState(false);
  const [counts, setCounts] = useState<{ queue: number }>({ queue: 0 });

  // ── Live nav badge counts (queue). Real source, no faked numbers:
  //    pulled from the same dashboard analytics the Dashboard page uses.
  //    Depend on a stable boolean so this fetches once, not every render. ──
  const canSeeAnalytics = isAdmin || can('canViewAnalytics');
  useEffect(() => {
    let alive = true;
    if (!canSeeAnalytics) return;
    api.analytics.getDashboard()
      .then((res: any) => {
        if (alive && res?.success && res.data) {
          setCounts({
            queue: res.data.queue?.pendingOrders ?? 0,
          });
        }
      })
      .catch(() => { /* badges are best-effort */ });
    return () => { alive = false; };
  }, [canSeeAnalytics]);

  // ── ⌘K / Ctrl-K opens the command palette ──
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      } else if (e.key === 'Escape') {
        setPaletteOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const canSee = useCallback((item: MenuItem): boolean => {
    if (isAdmin) return true;
    if (item.adminOnly) return false;
    if (item.queueManagerAccess && isQueueManager) return true;
    if (item.permission) return canAny(Array.isArray(item.permission) ? item.permission : [item.permission]);
    return true; // dashboard etc. — any authenticated user
  }, [isAdmin, isQueueManager, canAny]);

  const visibleGroups = useMemo(
    () => NAV_GROUPS.map((g) => ({ ...g, items: g.items.filter(canSee) })).filter((g) => g.items.length),
    [canSee]
  );

  const paletteItems: PaletteItem[] = useMemo(
    () => visibleGroups.flatMap((g) => g.items.map((it) => ({ label: it.label, path: it.path, group: g.label, Icon: it.icon }))),
    [visibleGroups]
  );

  const allItems = NAV_GROUPS.flatMap((g) => g.items);
  // A screen's own page (/users/:id, /merchants/:id) belongs to the screen it
  // opened from: the longest sidebar path it sits under names it.
  const current = allItems.find((it) => it.path === location.pathname)
    ?? allItems
      .filter((it) => it.path !== '/' && location.pathname.startsWith(`${it.path}/`))
      .sort((a, b) => b.path.length - a.path.length)[0];
  const headTitle = current?.title || 'Admin Panel';
  const headSub = current?.sub || '';

  const brand = getBrand();
  const identity = ROLE_IDENTITY(admin);
  const badgeCount = (kind?: BadgeKind): number => (kind === 'queue' ? counts.queue : 0);
  const badgeTone = (_kind?: BadgeKind) => 'info';

  const doLogout = async () => {
    await logout();
    navigate('/login');
  };

  const sideWidth = collapsed ? 76 : 266;

  return (
    <div style={{ display: 'flex', height: '100vh', width: '100vw', overflow: 'hidden', background: 'var(--bg)', color: 'var(--text)' }}>
      {/* ── SIDEBAR ─────────────────────────────────────────────────────── */}
      <aside
        style={{
          width: sideWidth, flex: 'none', background: 'var(--sidebar)',
          borderRight: '1px solid var(--border)', display: 'flex', flexDirection: 'column',
          position: 'relative', zIndex: 20, transition: 'width .22s cubic-bezier(.4,0,.2,1)',
        }}
      >
        {/* Brand */}
        <div style={{ height: 60, flex: 'none', display: 'flex', alignItems: 'center', gap: 11, padding: '0 16px', borderBottom: '1px solid var(--border)' }}>
          <LogoMark size={36} />
          {!collapsed && (
            <div style={{ minWidth: 0, overflow: 'hidden' }}>
              <div style={{ fontSize: 15.5, fontWeight: 800, letterSpacing: '-.01em', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{brand.appName}</div>
              <div style={{ fontSize: 9.5, color: 'var(--muted)', fontWeight: 700, letterSpacing: '.16em', textTransform: 'uppercase', whiteSpace: 'nowrap', marginTop: 1 }}>{brand.adminPanelName}</div>
            </div>
          )}
        </div>

        {/* Nav */}
        <nav style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', padding: '8px 12px 14px' }}>
          {visibleGroups.map((group) => (
            <div key={group.key}>
              {!collapsed && (
                <div style={{ fontSize: 9.5, fontWeight: 800, color: 'var(--muted)', letterSpacing: '.13em', textTransform: 'uppercase', padding: '15px 10px 6px', whiteSpace: 'nowrap' }}>
                  {group.label}
                </div>
              )}
              {group.items.map((item) => {
                const active = current?.path === item.path;
                const Icon = item.icon;
                const count = badgeCount(item.badge);
                const tone = badgeTone(item.badge);
                return (
                  <Link
                    key={item.path}
                    to={item.path}
                    title={item.label}
                    style={{
                      position: 'relative', display: 'flex', alignItems: 'center',
                      gap: 11, height: 38, padding: collapsed ? 0 : '0 10px',
                      justifyContent: collapsed ? 'center' : 'flex-start',
                      marginBottom: 2, borderRadius: 9, cursor: 'pointer',
                      color: active ? 'var(--text)' : 'var(--text-2)',
                      background: active ? 'var(--active)' : 'transparent',
                    }}
                    onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = 'var(--hover)'; }}
                    onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = 'transparent'; }}
                  >
                    {active && (
                      <div style={{ position: 'absolute', left: -12, top: 9, width: 3, height: 20, borderRadius: '0 3px 3px 0', background: 'var(--gold)' }} />
                    )}
                    <Icon size={17.5} style={{ flex: 'none', color: active ? 'var(--gold-ink)' : 'var(--muted)' }} />
                    {!collapsed && (
                      <span style={{ flex: 1, fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{item.label}</span>
                    )}
                    {!collapsed && item.badge && count > 0 && (
                      <span style={{
                        fontSize: 10, fontWeight: 800, fontFamily: "'JetBrains Mono',monospace",
                        minWidth: 20, height: 18, padding: '0 6px', borderRadius: 20,
                        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                        color: `var(--${tone})`, background: `var(--${tone}-bg)`,
                      }}>{count}</span>
                    )}
                  </Link>
                );
              })}
            </div>
          ))}
        </nav>

        {/* Collapse toggle */}
        <div style={{ padding: 12, borderTop: '1px solid var(--border)', flex: 'none' }}>
          {/* A `<div onClick>` until now, which is not a control: no keyboard
              user could reach it (no tab stop, no Enter/Space) and no screen
              reader announced it as anything. It is not in the 147 unnamed
              count either, because the inventory collects real controls and
              this was invisible to it — the quieter half of S24. */}
          <button
            type="button"
            onClick={toggleCollapsed}
            title={collapsed ? 'Expand the navigation' : 'Collapse the navigation'}
            aria-label={collapsed ? 'Expand the navigation' : 'Collapse the navigation'}
            aria-expanded={!collapsed}
            style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '9px 10px', borderRadius: 9, cursor: 'pointer', color: 'var(--text-2)', justifyContent: collapsed ? 'center' : 'flex-start', width: '100%', background: 'transparent', border: 'none', font: 'inherit', textAlign: 'left' }}
            onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--hover)')}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
          >
            {collapsed ? <ChevronRight size={17} /> : <ChevronLeft size={17} />}
            {!collapsed && <span style={{ fontSize: 12.5, fontWeight: 600, whiteSpace: 'nowrap' }}>Collapse</span>}
          </button>
        </div>
      </aside>

      {/* ── MAIN COLUMN ─────────────────────────────────────────────────── */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        {/* Header */}
        <header style={{ height: 60, flex: 'none', borderBottom: '1px solid var(--border)', background: 'var(--header)', display: 'flex', alignItems: 'center', gap: 16, padding: '0 20px', position: 'relative', zIndex: 15 }}>
          <div style={{ minWidth: 0, flex: 'none', maxWidth: '38%' }}>
            <div style={{ fontSize: 15, fontWeight: 800, letterSpacing: '-.01em', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{headTitle}</div>
            <div style={{ fontSize: 11.5, color: 'var(--muted)', fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', marginTop: 1 }}>{headSub}</div>
          </div>
          <div style={{ flex: 1 }} />

          {/* Command palette trigger */}
          <div
            onClick={() => setPaletteOpen(true)}
            className="bb-search"
            style={{ display: 'flex', alignItems: 'center', gap: 9, height: 38, width: 300, maxWidth: '34vw', padding: '0 12px', borderRadius: 10, background: 'var(--input)', border: '1px solid var(--border)', cursor: 'text', color: 'var(--muted)' }}
            onMouseEnter={(e) => (e.currentTarget.style.borderColor = 'var(--border-2)')}
            onMouseLeave={(e) => (e.currentTarget.style.borderColor = 'var(--border)')}
          >
            <Search size={15} />
            <span style={{ flex: 1, fontSize: 12.5, fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>Search or jump to…</span>
            <span style={{ fontSize: 10.5, fontWeight: 700, fontFamily: "'JetBrains Mono',monospace", padding: '2px 6px', borderRadius: 5, background: 'var(--surface-2)', border: '1px solid var(--border)', color: 'var(--text-2)' }}>⌘K</span>
          </div>

          {/* Theme toggle */}
          <button
            onClick={toggleTheme}
            title="Toggle theme"
            style={{ width: 38, height: 38, flex: 'none', borderRadius: 10, background: 'var(--surface-2)', border: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: 'var(--text-2)' }}
          >
            {theme === 'dark' ? <Moon size={17} /> : <Sun size={17} />}
          </button>

          {/* Notifications */}
          <button
            title="Notifications"
            style={{ position: 'relative', width: 38, height: 38, flex: 'none', borderRadius: 10, background: 'var(--surface-2)', border: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: 'var(--text-2)' }}
          >
            <Bell size={17} />
            {counts.queue > 0 && (
              <span style={{ position: 'absolute', top: 7, right: 8, width: 7, height: 7, borderRadius: '50%', background: 'var(--danger)', border: '2px solid var(--header)' }} />
            )}
          </button>

          <div style={{ width: 1, height: 26, background: 'var(--border)', flex: 'none' }} />

          {/* Status */}
          <div className="bb-hide-sm" style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 'none' }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--success)', boxShadow: '0 0 0 4px var(--success-bg)', animation: 'om-pulse 2.4s infinite' }} />
            <span style={{ fontSize: 11.5, color: 'var(--text-2)', fontWeight: 600, whiteSpace: 'nowrap' }}>Operational</span>
          </div>

          <div style={{ width: 1, height: 26, background: 'var(--border)', flex: 'none' }} />

          {/* Account / sign out */}
          <div
            onClick={() => setSignOutOpen(true)}
            title="Account · sign out"
            style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 'none', cursor: 'pointer' }}
          >
            <div className="bb-hide-sm" style={{ textAlign: 'right', lineHeight: 1.2 }}>
              <div style={{ fontSize: 12.5, fontWeight: 700, whiteSpace: 'nowrap' }}>{admin?.username || 'User'}</div>
              <div style={{ fontSize: 10.5, fontWeight: 700, color: identity.color }}>{identity.role}</div>
            </div>
            <div style={{ width: 36, height: 36, borderRadius: 10, background: 'linear-gradient(140deg,#3d6bd6,#7b4fe0)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, fontSize: 12.5, color: '#fff' }}>
              {initialsOf(admin?.username)}
            </div>
          </div>
        </header>

        {/* Page content */}
        <main style={{ flex: 1, overflowY: 'auto', background: 'var(--bg)' }}>
          <div style={{ padding: '22px 24px 72px', maxWidth: 1560, margin: '0 auto' }}>
            {children}
          </div>
        </main>
      </div>

      <CommandPalette
        open={paletteOpen}
        items={paletteItems}
        onClose={() => setPaletteOpen(false)}
        onNavigate={(path) => navigate(path)}
      />

      <ConfirmDialog
        isOpen={signOutOpen}
        onClose={() => setSignOutOpen(false)}
        onConfirm={doLogout}
        title="Sign out?"
        message="End your current admin session and return to the login screen."
        type="danger"
        confirmText="Sign out"
      />
    </div>
  );
};
