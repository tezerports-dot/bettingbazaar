// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * admin-panel/src/utils/constants.ts
 *
 * Admin panel route constants and permission key list.
 * GOVERNANCE §8: each frontend has exactly one route-constants module.
 * All <Route> tables, nav menus, and route guards MUST import path strings from here.
 *
 * L-02 fix: this file was empty (0 bytes). Populated with admin-only constants.
 */

/** Route path constants for admin panel navigation.
 *  Layout.tsx sidebar and App.tsx routes should import from here.
 */
// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
export const ADMIN_ROUTES = {
  HOME:            '/',
  LOGIN:           '/login',
  LIVE_CYCLES:     '/live-cycles',
  CYCLE_HISTORY:   '/cycle-history',
  PROFIT_LOSS:     '/profit-loss',
  USERS:           '/users',
  BALANCE_ADJUST:  '/users/balance-adjust',
  MERCHANTS:       '/merchants',
  KYC:             '/kyc',
  TRANSACTIONS:    '/transactions',
  QUEUE_MANAGER:   '/queue-manager',
  FAQ:             '/content/faq',
  SLIDES:          '/content/slides',
  SUPPORT:         '/content/support',
  CDN:             '/content/cdn',
  BRANDING:        '/branding',
  APP_ASSETS:      '/app-assets',
  // TOKEN_RATES removed 2026-07-08 — conversion is fixed 1:1 (Phase 006 flattening)
  SUB_ADMINS:      '/sub-admins',
  SETTINGS:        '/settings',
  AUDIT_LOGS:      '/audit-logs',
  ERROR_LOGS:      '/error-logs',
  DISPUTES:        '/disputes',
  WINNERS_MANAGER: '/winners-manager',
  CHAT_MANAGEMENT: '/chat-management',
  GAME_PROVIDERS:  '/game-providers',
  PAYMENT_CONTROL: '/payment-control',
  GIFT_CODES:      '/promotions/gift-codes',
  ANNOUNCEMENTS:   '/promotions/announcements',
} as const;

/** App version — defined here only; never type it in component files.
 *  GOVERNANCE §8: version is a deploy-time constant from package.json.
 *  Read via: import.meta.env.VITE_APP_VERSION (set by Vite from package.json).
 *  H-07: version literals in component source files are forbidden.
 */
export const APP_VERSION_HINT = '(see VITE_APP_VERSION env var set from package.json)';
