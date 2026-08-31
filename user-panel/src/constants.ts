// ─── App identity ─────────────────────────────────────────────────────────────

// These are fallback constants only — used when branding hasn't loaded yet.
// GOVERNANCE §3: any name shown to end-users must originate from Branding.
// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
export const APP_NAME_FALLBACK = 'Betting Bazaar';  // use branding.userPanelName at runtime
// APP_VERSION: read from import.meta.env.VITE_APP_VERSION (set from package.json by Vite).
// Do not add a literal version string here — GOVERNANCE §8.

// CHIP_VALUES — quick-bet chip denominations per cycle type
// 30-MIN uses smaller denominations; FULL DAY uses larger ones.
// The user's selected cycle type is persisted in localStorage so chips
// don't appear to randomly reset on page reload.
export const CHIP_VALUES = {
  // The 1-minute block deliberately shares the 30-minute ladder: it is the same
  // game at a faster clock, and its stake bounds are the same server-side
  // (SystemConfig.betLimits.oneMin defaults to betLimits.thirtyMin), so a
  // different ladder here would offer chips the server rejects.
  '1_MIN':    [10, 30, 90, 270, 810],
  '30_MIN':   [10, 30, 90, 270, 810],
  'FULL_DAY': [100, 300, 900, 2700, 8100],
};

// M-03 fix: MIN_BET constant removed — GOVERNANCE §2 forbids frontend hardcoded
// business values with backend config equivalents. sysConfig.minBet is the
// runtime authority (SystemConfig.betLimits.thirtyMin.min / fullDay.min).
// If you need a display placeholder while config loads, use 0 or '' — never a typed number.
