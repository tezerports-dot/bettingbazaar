// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * config/security.config.js — Central Security Configuration (plan item 19)
 * + explicit security-header decisions (plan item 21). 2026-07-13.
 *
 * ONE file holds security policy AS DATA: CSP directives, CORS shape, and
 * rate-limit tiers. server.js and middleware/security.js consume these instead
 * of defining values inline. This is a refactor of working code — every value
 * below is IDENTICAL to what shipped scattered before; changing policy now
 * means editing THIS file only.
 *
 * Item 21 header audit (helmet v7/v8 defaults we explicitly RELY on — set by
 * `helmet()` without extra config; listed so the decision is recorded, not
 * implicit):
 *   X-Content-Type-Options: nosniff        — stop MIME sniffing
 *   X-Frame-Options: SAMEORIGIN            — no cross-site framing of panels
 *   Referrer-Policy: no-referrer           — don't leak bet/wallet URLs
 *   Strict-Transport-Security (prod https) — pin https once seen
 *   X-DNS-Prefetch-Control: off, X-Download-Options: noopen,
 *   Cross-Origin-Opener-Policy: same-origin, X-XSS-Protection: 0 (modern)
 * Non-default choices we make explicitly: CSP directives below and
 * crossOriginEmbedderPolicy=false (provider iframes/CDN images break under
 * COEP require-corp — deliberate).
 */

// ── Content-Security-Policy — the only non-default helmet section ────────────
export const CSP_DIRECTIVES = {
  defaultSrc: ["'self'"], scriptSrc: ["'self'"],
  styleSrc:   ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
  fontSrc:    ["'self'", "https://fonts.gstatic.com", "data:"],
  imgSrc:     ["'self'", 'data:', 'https:'],
  connectSrc: ["'self'", 'wss:', 'ws:', 'https:'],
  objectSrc:  ["'none'"], manifestSrc: ["'self'"],
};

export const HELMET_OPTIONS = {
  contentSecurityPolicy: { directives: CSP_DIRECTIVES },
  crossOriginEmbedderPolicy: false, // provider game iframes + CDN images
};

// ── CORS ──────────────────────────────────────────────────────────────────────
// The origin check function stays in server.js (it closes over env parsing);
// the static shape lives here.
export const CORS_SHAPE = {
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  optionsSuccessStatus: 200,
};

// ── Rate-limit tiers (values unchanged from middleware/security.js + server.js)
export const RATE_LIMIT_TIERS = {
  // Global backstop on /api/* (server.js)
  global:     { windowMs: 15 * 60 * 1000, max: 1000 },
  // ── Login tiers ───────────────────────────────────────────────────────────
  // IMPORTANT: every login limiter sets `skipSuccessfulRequests: true`, so
  // these count FAILED attempts only. "4 per 30 minutes" does not stop someone
  // logging in five times a day — it stops the fifth WRONG password. Counting
  // successes would lock out the legitimate user who switches devices, while
  // doing nothing extra against a brute-forcer (who is only ever failing).
  //
  // Player login — 4 failures / 30 min (2026-07-28, owner-set).
  auth:       { windowMs: 30 * 60 * 1000, max: 4 },
  // Admin and sub-admin login — 4 failures / hour. Privileged accounts move
  // money and, per §F, are the highest-value credential on the platform.
  adminAuth:  { windowMs: 60 * 60 * 1000, max: 4 },
  // Merchant login — 4 failures / hour. Same tier as admin: a merchant account
  // settles real INR and USDT, so it is not a player-grade credential.
  merchantAuth: { windowMs: 60 * 60 * 1000, max: 4 },
  // Second-factor submission, once the password is already correct. Separate
  // and tighter than the password tier: at this point an attacker is guessing
  // a 6-digit code, where 10 tries is 1-in-100,000 rather than 1-in-a-million.
  twoFactor:  { windowMs: 15 * 60 * 1000, max: 5 },
  // Bet placement bursts
  bet:        { windowMs: 1 * 60 * 1000,  max: 30 },
  // Withdrawal creation
  withdrawal: { windowMs: 60 * 60 * 1000, max: 5 },
  // Account recovery / Aadhaar lookup. These endpoints take a national ID and
  // are the one place the platform can be asked "does THIS person have an
  // account here?" — on a gambling site that answer is sensitive on its own,
  // independently of any balance. Tight, and keyed on IP: keying on a field
  // from the request body (the mobile number) let a caller reset their own
  // budget at will, which is no limit at all.
  // General API tier used by security.js's apiLimiter
  api:        { windowMs: 1 * 60 * 1000,  max: 100 },
};

// ── Global-limiter exemption for phantom (ghost) bet placement ──────────────
// Phantom managers fire many equalizer bets in quick succession to keep the
// display pool balanced, so their placements must NOT be throttled by the
// global /api/* backstop. The POST /api/bet/phantom route is itself gated
// (authenticate + phantomAccess → 403 for everyone else) and loadShed still
// bounds total in-flight work, so exempting it removes no real DoS protection.
export const PHANTOM_BET_PATH = '/api/bet/phantom';
// Skip predicate for the global limiter. Matches on the untouched originalUrl
// (immune to app.use() mount-path stripping), drops any query string, and
// normalises a trailing slash so /api/bet/phantom/ is treated identically.
export const isPhantomBetPlacement = (req) =>
  req.method === 'POST' &&
  String(req.originalUrl || '').split('?')[0].replace(/\/+$/, '') === PHANTOM_BET_PATH;
