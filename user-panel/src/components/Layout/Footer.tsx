// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * Footer.tsx — the bottom tab bar, now ADMIN-EDITABLE (2026-07-13).
 *
 * Which tabs appear (and their order) comes from SystemConfig.footerPages,
 * delivered live in the system_config payload (GameContext.sysConfig). This
 * PAGE_CATALOG owns the display side only — route strings, labels, icons —
 * which stay in code per BUSINESS_CONFIG_AUDIT.md §4; the SELECTION is the
 * admin's business decision. Keys here MUST mirror FOOTER_PAGE_KEYS in
 * backend/routes/admin/system.admin.routes.js. Unknown keys are skipped
 * (forward-compat), and an empty/missing config falls back to the schema
 * default (the historical five tabs) — behavior unchanged until an admin edits.
 */
import React from 'react';
import { useNavigate, useLocation } from 'react-router';
import { useGame } from '../../services/GameContext';
import { useGameProviders } from '../../services/GameProviderContext';

const PAGE_CATALOG: Record<string, { label: string; path: string; icon: string }> = {
  'home':      { label: 'Game',      path: '/',           icon: '🎲' },
  'results':   { label: 'Results',   path: '/results',    icon: '📊' },
  'winners':   { label: 'Winners',   path: '/winners',    icon: '🏆' },
  'promo':     { label: 'Pro Tips',  path: '/promo',      icon: '💡' },
  'profile':   { label: 'Profile',   path: '/profile',    icon: '👤' },
  'wallet':    { label: 'Wallet',    path: '/wallet',     icon: '💰' },
  'gift-code': { label: 'Gifts',     path: '/gift-code',  icon: '🎁' },
  'my-bets':   { label: 'My Bets',   path: '/my-bets',    icon: '📜' },
  'history':   { label: 'History',   path: '/history',    icon: '🕘' },
  'rules':     { label: 'Rules',     path: '/rules',      icon: '📖' },
  'faq':       { label: 'FAQ',       path: '/faq',        icon: '❓' },
  'support':   { label: 'Support',   path: '/support',    icon: '🛟' },
  'casino':    { label: 'Casino',    path: '/casino',     icon: '🎰' },
  'crash':     { label: 'Crash',     path: '/crash',      icon: '🚀' },
  'sports':    { label: 'Sports',    path: '/sports',     icon: '⚽' },
};

const DEFAULT_KEYS = ['home', 'results', 'winners', 'promo', 'profile'];

const Footer: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const { sysConfig } = useGame();
  // Provider-gated pages only render when their provider group is live —
  // mirrors the pages' own redirect guards (CasinoPage etc.). Safe outside
  // the provider too: the context default reports everything disabled.
  const { anyCasino, anyCrash, anySports } = useGameProviders();
  const gated: Record<string, boolean> = { casino: anyCasino, crash: anyCrash, sports: anySports };

  const keys = (sysConfig.footerPages?.length ? sysConfig.footerPages : DEFAULT_KEYS)
    .filter(k => PAGE_CATALOG[k])            // skip unknown keys (forward-compat)
    .filter(k => !(k in gated) || gated[k])  // hide provider tabs when no provider is enabled
    .slice(0, 5);                            // layout holds at most 5 tabs
  const nav = (keys.length >= 2 ? keys : DEFAULT_KEYS).map(k => ({ key: k, ...PAGE_CATALOG[k] }));

  return (
    <div className="mobile-sticky-footer flex-none relative z-40" style={{ background:"#0D1120", borderTop:"1px solid rgba(212,175,55,0.18)" }}>
      <div style={{ height:"1px", background:"linear-gradient(90deg,transparent,rgba(212,175,55,0.6) 38.2%,rgba(245,199,122,0.8) 61.8%,transparent)" }} />

      <footer className="h-[56px] flex items-stretch">
        {nav.map(item => {
          const isActive = item.path === "/" ? location.pathname === "/" : location.pathname.startsWith(item.path);
          return (
            <button key={item.key} onClick={() => navigate(item.path)}
              className="relative flex flex-col items-center justify-center flex-1 h-full gap-0.5 transition-all"
              style={{ color: isActive ? "#D4AF37" : "#5a6478" }}>
              <span className={"text-[17px] leading-none transition-transform" + (isActive ? " scale-110" : "")}>{item.icon}</span>
              <span className="text-[8px] font-semibold uppercase tracking-wide leading-none">{item.label}</span>
              {isActive && <span className="absolute bottom-0 left-1/2 -translate-x-1/2 w-5 h-[2px] rounded-full" style={{ background:"linear-gradient(90deg,#B8860B,#F5C77A,#B8860B)" }} />}
            </button>
          );
        })}
      </footer>
    </div>
  );
};

export default Footer;
