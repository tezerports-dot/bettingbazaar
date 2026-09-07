// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * domains/configuration/systemConfigPayload.js — the one system-config payload.
 *
 * ── Why this file exists ────────────────────────────────────────────────────
 * The same object was assembled twice: once in `startup/socketHandlers.js` to
 * push over Socket.IO on connect, once in `GET /api/v1/system/config` to answer
 * over HTTP. Copies drift, and these already had:
 *
 *   only the socket sent  webUrl, androidUrl, iosUrl
 *   only the HTTP route sent  kycRequired, registrationEnabled
 *
 * So the answer to "what is this platform configured to do" depended on which
 * transport a client happened to ask over. §1 — one owner per value. This is
 * the owner; both callers now derive from it.
 *
 * ── `??`, never `||` ────────────────────────────────────────────────────────
 * The HTTP copy wrote `config?.minDeposit || 100` for every numeric limit. `||`
 * treats a legitimate **0** as absent, so an operator who set a limit to zero —
 * "no minimum" — was silently served the default instead, and the panel
 * enforced a floor the admin had explicitly removed. The socket copy used `??`
 * and did not have this bug, which is precisely the kind of divergence two
 * copies produce. It is the same defect the bet-funding mutation M23 exists to
 * catch, in a different file.
 *
 * Every fallback below matches the config spec's declared default exactly. A
 * server-side fallback that differs from the declared default is a second,
 * invisible configuration: the client is told one number while the engine uses
 * another.
 */

/** The historical five tabs — the schema default for an unset footer. */
const DEFAULT_FOOTER_PAGES = Object.freeze(['home', 'results', 'winners', 'promo', 'profile']);

/**
 * Build the payload every client receives, over any transport.
 *
 * @param {object|null} cfg the SystemConfig row, or null when it cannot be read
 * @returns {object} the full field set — never a partial one
 */
export function systemConfigPayload(cfg) {
  return {
    // Bet limits live in the betLimits subdoc, not on config.value.
    minBet:              cfg?.betLimits?.thirtyMin?.min ?? 10,
    maxBet:              cfg?.betLimits?.thirtyMin?.max ?? 100000,
    maxFullDayBet:       cfg?.betLimits?.fullDay?.max   ?? 500000,

    minDeposit:          cfg?.minDeposit    ?? 100,
    maxDeposit:          cfg?.maxDeposit    ?? 50000,
    minWithdrawal:       cfg?.minWithdrawal ?? 500,
    maxWithdrawal:       cfg?.maxWithdrawal ?? 50000,

    // Fixed 1:1 conversion (Phase 006 flattening, 2026-07-08). Not admin-owned,
    // so it is a constant here rather than a fallback.
    tokenBuyRate:        1,
    tokenSellRate:       1,

    // Admin-owned (Business Config Audit 2026-07-11) — was once hardcoded 2.
    payoutMultiplier:    cfg?.payoutMultiplier ?? 2,

    maintenanceMode:     cfg?.maintenanceMode    ?? false,
    maintenanceMessage:  cfg?.maintenanceMessage ?? '',

    // Footer navigation (2026-07-13). An empty list means "unset", not "no
    // tabs" — a panel with no navigation is not a state an admin can intend.
    footerPages:         cfg?.footerPages?.length ? cfg.footerPages : [...DEFAULT_FOOTER_PAGES],

    minVersion:          cfg?.minVersion    ?? '1.0.0',
    latestVersion:       cfg?.latestVersion ?? '1.0.0',

    // Native-shell download targets. Only the socket used to carry these.
    webUrl:              cfg?.webUrl     ?? '',
    androidUrl:          cfg?.androidUrl ?? '',
    iosUrl:              cfg?.iosUrl     ?? '',

    // Signup gating. Only the HTTP route used to carry these. `!== false` keeps
    // an unset flag meaning "on", which is what both copies already did.
    kycRequired:         cfg?.kycRequired         !== false,
    registrationEnabled: cfg?.registrationEnabled !== false,
  };
}

/**
 * The payload when the config row cannot be read at all.
 *
 * Deliberately the same builder with no row, rather than a hand-written subset:
 * the socket's old catch block emitted seven fields, so a client that connected
 * during a database blip was told the platform had no deposit limits and no
 * footer. Every field is present here, every value is its declared default.
 */
export function systemConfigFallback() {
  return systemConfigPayload(null);
}

export default systemConfigPayload;
