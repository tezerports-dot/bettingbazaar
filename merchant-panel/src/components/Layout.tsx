// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
//
// Merchant panel shell — design handoff "BB Merchant Panel.dc.html".
// Three forms of the same navigation, per viewport:
//   mobile  → bottom tab bar
//   tablet  → 72px icon rail
//   desktop → 236px labelled sidebar with the availability card
// The top bar carries the screen title, the online toggle, notifications and
// (on desktop) the profile chip and sign-out.
import React, { useMemo } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { Home, Package, History, User, LogOut, Power, Bell, Sun, Moon, Users, Landmark, LifeBuoy } from 'lucide-react';
import toast from 'react-hot-toast';
import { useAuth } from '../services/AuthContext';
import { availabilityOf } from '../utils/availability';
import { api } from '../services/api';
import { ROUTES, SUCCESS_MESSAGES } from '../constants';
import { useViewport } from '../hooks/useViewport';
import { PAYMENT_COPY } from '../utils/rail';
import { Avatar, Logo } from './ui';
import InstallAppButton from './InstallAppButton';
import { useTheme } from '../services/ThemeContext';
import { actorOf, isMerchantAccountSession } from '../utils/actor';
import { firstAccountTab } from '../pages/account/accountTabs';
import type { MerchantProfile } from '../types';

const NAV_ALL = [
  { path: ROUTES.DASHBOARD, icon: Home,     label: 'Dashboard', title: 'Dashboard',        sub: 'Settlement operations' },
  { path: ROUTES.ORDERS,    icon: Package,  label: 'Orders',    title: 'Order Management', sub: 'Live queue' },
  { path: ROUTES.HISTORY,   icon: History,  label: 'History',   title: 'History',          sub: 'Reports & completed orders' },
  { path: ROUTES.TEAM,      icon: Users,    label: 'Team',      title: 'Team',             sub: 'Your team, or the agent teams you supervise' },
  // A merchant account's own screens (owner, 2026-10-11): accounts,
  // sub-members, pool, reports and flags, one tab each.
  { path: ROUTES.ACCOUNT,   icon: Landmark, label: 'Account',   title: 'Merchant account', sub: 'Payment accounts, sub-members, pool, reports' },
  { path: ROUTES.PROFILE,   icon: User,     label: 'Profile',   title: 'Profile',          sub: 'Identity & payment details' },
  { path: ROUTES.SUPPORT,   icon: LifeBuoy, label: 'Support',   title: 'Support',          sub: 'Open a ticket · chat with us on Telegram' },
];

/**
 * The nav a session gets. Teams are agents' and supervisors' (a merchant
 * account has no supervisor and no team page); the Account screens are a
 * merchant account's, for its owner and its sub-members (by role, inside).
 */
export function navFor(merchant: MerchantProfile | null) {
  const merchantAccount = isMerchantAccountSession(merchant);
  return NAV_ALL.filter((item) => (item.path === ROUTES.ACCOUNT ? merchantAccount
    : item.path === ROUTES.TEAM ? !merchantAccount : true));
}

interface LayoutProps {
  children: React.ReactNode;
  /** Count of orders needing merchant action — badged on the Orders tab. */
  actionable?: number;
}

const Layout: React.FC<LayoutProps> = ({ children, actionable = 0 }) => {
  const { merchant, logout, refreshProfile } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const location = useLocation();
  const navigate = useNavigate();
  const { isMobile, isTablet, isDesktop } = useViewport();

  const copy = PAYMENT_COPY;
  // One helper for every screen (§5). A supervisor has no online switch: they
  // take no orders (CLAUDE.md §2), and the server refuses it.
  const availability = availabilityOf(merchant);
  const { online, switchable } = availability;
  const NAV = useMemo(() => navFor(merchant), [merchant]);
  // A sub-member is named as themselves, never as the account's owner.
  const actor = actorOf(merchant);
  const signedInName = actor.isOwner ? merchant?.username : actor.name;
  const active = useMemo(
    () => NAV.find((item) => location.pathname.startsWith(item.path)) ?? NAV[0],
    [NAV, location.pathname]
  );
  // The Account entry opens the first of its tabs this person may see.
  const go = (path: string) => navigate(path === ROUTES.ACCOUNT ? firstAccountTab(merchant) : path);

  const toggleOnline = async () => {
    const next = !online;
    try {
      await api.toggleOnlineStatus(next);
      await refreshProfile();
      toast.success(next ? 'You are now online — accepting orders' : 'You are now offline');
    } catch (error: any) {
      toast.error(error.message || SUCCESS_MESSAGES.STATUS_UPDATED);
    }
  };

  const sidebarWidth = isTablet ? 72 : 236;
  const showSidebar = !isMobile;
  const gutter = isMobile ? 16 : 24;

  const navButtonStyle = (path: string): React.CSSProperties => {
    const on = active.path === path;
    return {
      display: 'flex', alignItems: 'center', gap: 12, width: '100%',
      justifyContent: isTablet ? 'center' : 'flex-start',
      padding: isTablet ? 12 : '11px 14px', borderRadius: 12, border: 0,
      cursor: 'pointer', textAlign: 'left', fontSize: 14,
      fontWeight: on ? 700 : 600,
      color: on ? 'var(--brand)' : 'var(--text-2)',
      background: on ? 'var(--brand-bg)' : 'transparent',
      transition: 'background .15s ease, color .15s ease',
    };
  };

  const iconButtonStyle: React.CSSProperties = {
    width: 38, height: 38, borderRadius: 11, border: '1px solid var(--border)',
    background: 'var(--surface)', color: 'var(--text-2)', cursor: 'pointer',
    display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
  };

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg)' }}>
      {showSidebar && (
        <aside
          style={{
            position: 'fixed', top: 0, bottom: 0, left: 0, width: sidebarWidth, zIndex: 20,
            background: 'var(--sidebar)', borderRight: '1px solid var(--border)',
            display: 'flex', flexDirection: 'column',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '20px 18px', height: 66, flexShrink: 0 }}>
            <Logo />
            {isDesktop && (
              <div>
                <div style={{ fontWeight: 800, fontSize: 15, color: 'var(--text)', lineHeight: 1.1 }}>BB Token</div>
                <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)' }}>Merchant Panel</div>
              </div>
            )}
          </div>

          <nav style={{ padding: '8px 12px', display: 'flex', flexDirection: 'column', gap: 4 }}>
            {NAV.map((item) => {
              const Icon = item.icon;
              const badge = item.path === ROUTES.ORDERS && actionable > 0;
              return (
                <button key={item.path} title={item.label} onClick={() => go(item.path)} style={navButtonStyle(item.path)}>
                  <Icon size={19} style={{ flexShrink: 0 }} />
                  {isDesktop && <span style={{ flex: 1 }}>{item.label}</span>}
                  {badge && isDesktop && (
                    <span style={{
                      minWidth: 20, height: 20, padding: '0 6px', borderRadius: 10,
                      background: 'var(--danger)', color: '#fff', fontSize: 11, fontWeight: 800,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                    }}>
                      {actionable}
                    </span>
                  )}
                </button>
              );
            })}
          </nav>

          <div style={{ marginTop: 'auto', padding: '14px 12px' }}>
            {isDesktop ? (
              <div style={{ padding: 13, background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 14 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 11 }}>
                  <span style={{
                    width: 9, height: 9, borderRadius: '50%',
                    background: online ? 'var(--online)' : 'var(--offline)',
                    animation: online ? 'bb-pulse 2s ease infinite' : 'none',
                  }} />
                  <span style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--text)' }}>
                    {availability.short}
                  </span>
                </div>
                {switchable && (
                  <button
                    onClick={toggleOnline}
                    style={{
                      display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, width: '100%',
                      padding: 10, borderRadius: 11, border: 0, cursor: 'pointer', fontSize: 12.5,
                      fontWeight: 700, color: '#fff', background: online ? 'var(--offline)' : 'var(--ok)',
                    }}
                  >
                    <Power size={15} /> {online ? 'Go offline' : 'Go online'}
                  </button>
                )}
                <div style={{ marginTop: 11, fontSize: 11, fontWeight: 600, color: 'var(--muted)' }}>
                  {switchable ? `${copy.name} ${isMerchantAccountSession(merchant) ? 'merchant' : 'agent'} · ${copy.credentialsLabel}`
                    : availability.subMember ? 'The account owner switches it online'
                    : 'Your agents go online from their own accounts'}
                </div>
              </div>
            ) : switchable && (
              <button
                onClick={toggleOnline}
                title={online ? 'Go offline' : 'Go online'}
                style={{
                  width: 40, height: 40, margin: '0 auto', borderRadius: 11, border: 0, cursor: 'pointer',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  background: online ? 'var(--ok-bg)' : 'var(--surface-2)',
                  color: online ? 'var(--ok)' : 'var(--offline)',
                }}
              >
                <Power size={17} />
              </button>
            )}
          </div>
        </aside>
      )}

      <div style={{ marginLeft: showSidebar ? sidebarWidth : 0, display: 'flex', flexDirection: 'column', minHeight: '100vh' }}>
        <header
          style={{
            position: 'sticky', top: 0, zIndex: 15, flexShrink: 0,
            height: isMobile ? 58 : 66, display: 'flex', alignItems: 'center', gap: 12,
            padding: `0 ${gutter}px`, background: 'var(--surface)', borderBottom: '1px solid var(--border)',
          }}
        >
          {isMobile && <Logo size={30} radius={9} />}
          <div style={{ marginRight: 'auto', minWidth: 0 }}>
            <div style={{
              fontWeight: 800, fontSize: isMobile ? 14 : 18, color: 'var(--text)',
              letterSpacing: '-.3px', lineHeight: 1.1, whiteSpace: 'nowrap',
              overflow: 'hidden', textOverflow: 'ellipsis',
            }}>
              {active.title}
            </div>
            <div style={{ fontSize: isMobile ? 10.5 : 12, fontWeight: 600, color: 'var(--muted)' }}>{active.sub}</div>
          </div>

          {switchable ? (
            <button
              onClick={toggleOnline}
              title={online ? 'Go offline' : 'Go online'}
              style={{
                display: 'flex', alignItems: 'center', gap: 7, padding: '8px 13px', borderRadius: 11,
                border: `1px solid ${online ? 'transparent' : 'var(--border)'}`,
                background: online ? 'var(--ok-bg)' : 'var(--surface-2)',
                color: online ? 'var(--ok)' : 'var(--offline)',
                fontSize: 12.5, fontWeight: 700, cursor: 'pointer', flexShrink: 0,
              }}
            >
              <span style={{
                width: 8, height: 8, borderRadius: '50%', background: 'currentColor',
                animation: online ? 'bb-pulse 2s ease infinite' : 'none',
              }} />
              {online ? 'Online' : 'Offline'}
            </button>
          ) : (
            // Not a control: a supervisor's account, and a sub-member, have no switch to press.
            <span style={{
              padding: '8px 13px', borderRadius: 11, border: '1px solid var(--border)',
              background: 'var(--surface-2)', color: 'var(--text-2)', fontSize: 12.5, fontWeight: 700, flexShrink: 0,
            }}>
              {availability.badge}
            </span>
          )}

          {/* In the browser only; nothing once installed (owner, 2026-10-21). */}
          <InstallAppButton />

          <button onClick={toggleTheme} title={`Switch to ${theme === 'light' ? 'dark' : 'light'} theme`} style={iconButtonStyle}>
            {theme === 'light' ? <Moon size={17} /> : <Sun size={17} />}
          </button>

          <button
            onClick={() => toast(actionable > 0 ? `${actionable} order${actionable === 1 ? '' : 's'} need your action` : 'Nothing needs your action')}
            title="Notifications"
            style={{ ...iconButtonStyle, position: 'relative' }}
          >
            <Bell size={18} />
            {actionable > 0 && (
              <span style={{
                position: 'absolute', top: 8, right: 9, width: 7, height: 7, borderRadius: '50%',
                background: 'var(--danger)', border: '1.5px solid var(--surface)',
              }} />
            )}
          </button>

          {isDesktop && (
            <>
              <button
                onClick={() => navigate(ROUTES.PROFILE)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 9, padding: '5px 12px 5px 5px',
                  border: '1px solid var(--border)', background: 'var(--surface)', borderRadius: 22, cursor: 'pointer',
                }}
              >
                <Avatar name={signedInName} />
                <span style={{ textAlign: 'left' }}>
                  <span style={{ display: 'block', fontSize: 12.5, fontWeight: 700, color: 'var(--text)', lineHeight: 1.1 }}>
                    {signedInName || 'Merchant'}
                  </span>
                  <span style={{ display: 'block', fontSize: 10.5, fontWeight: 600, color: 'var(--muted)' }}>
                    {availability.subMember ? `Sub-member of ${merchant?.username ?? 'the account'}` : `${copy.name} operator`}
                  </span>
                </span>
              </button>
              <button onClick={logout} title="Log out" style={iconButtonStyle}>
                <LogOut size={18} />
              </button>
            </>
          )}
        </header>

        <main
          className="bb-scroll"
          style={{
            flex: 1, padding: isMobile ? 16 : 22,
            paddingBottom: isMobile ? 'calc(80px + env(safe-area-inset-bottom))' : 28,
          }}
        >
          {children}
        </main>
      </div>

      {isMobile && (
        <nav
          style={{
            position: 'fixed', left: 0, right: 0, bottom: 0, zIndex: 25,
            display: 'flex', alignItems: 'stretch', background: 'var(--surface)',
            borderTop: '1px solid var(--border)', paddingBottom: 'env(safe-area-inset-bottom)',
            boxShadow: '0 -4px 20px rgba(16,23,38,.05)',
          }}
        >
          {NAV.map((item) => {
            const Icon = item.icon;
            const on = active.path === item.path;
            const badge = item.path === ROUTES.ORDERS && actionable > 0;
            return (
              <button
                key={item.path}
                onClick={() => go(item.path)}
                style={{
                  flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3,
                  padding: '9px 0 8px', border: 0, background: 'transparent', cursor: 'pointer',
                  color: on ? 'var(--brand)' : 'var(--muted)', fontSize: 10.5, fontWeight: on ? 800 : 600,
                }}
              >
                <span style={{ position: 'relative', display: 'flex' }}>
                  <Icon size={21} />
                  {badge && (
                    <span style={{
                      position: 'absolute', top: -6, right: -9, minWidth: 16, height: 16, padding: '0 4px',
                      borderRadius: 9, background: 'var(--danger)', color: '#fff', fontSize: 9.5, fontWeight: 800,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                    }}>
                      {actionable}
                    </span>
                  )}
                </span>
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>
      )}
    </div>
  );
};

export default Layout;
